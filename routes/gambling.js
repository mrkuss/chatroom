const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { db } = require('../lib/db');
const { getCoins, addCoins, deductCoins, broadcastCoins } = require('../lib/coins');
const { DAILY_REWARD, formatNumber } = require('../lib/utils');

let _io = null;
function initGambling(io) { _io = io; }

async function broadcastGambling(msg) {
  try {
    await db.query(
      "INSERT INTO messages (room, sender, type, text) VALUES ($1, $2, $3, $4)",
      ['gambling', 'system', 'system', msg]
    );
  } catch (e) { console.error('broadcastGambling save error:', e); }
  if (_io) _io.to('gambling').emit('system message', msg);
}

// ─── Mark first gamble + big win on user row ──────────────────────────────────
async function recordGambleStats(username, winAmount) {
  if (winAmount > 1000) {
    await db.query(
      `UPDATE users SET first_gamble = true, big_win = true WHERE LOWER(username) = LOWER($1)`,
      [username]
    ).catch(() => {
      // big_win column might not exist yet if migration hasn't run — add it safely
    });
    // Safe fallback if big_win column doesn't exist yet
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS big_win BOOLEAN NOT NULL DEFAULT false`);
    await db.query(
      `UPDATE users SET first_gamble = true, big_win = true WHERE LOWER(username) = LOWER($1)`,
      [username]
    );
  } else {
    await db.query(
      `UPDATE users SET first_gamble = true WHERE LOWER(username) = LOWER($1)`,
      [username]
    );
  }
}

// ─── Daily Reward ─────────────────────────────────────────────────────────────
router.post('/daily', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  try {
    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const r = await db.query('SELECT last_daily, coins FROM users WHERE LOWER(username) = LOWER($1)', [req.session.username]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'User not found' });
    if (row.last_daily && new Date(row.last_daily) >= todayUTC) return res.status(400).json({ error: 'Already claimed today' });
    const result = await db.query(
      `UPDATE users SET coins = coins + $1, coins_earned = coins_earned + $1, last_daily = NOW()
       WHERE LOWER(username) = LOWER($2) RETURNING coins`,
      [DAILY_REWARD, req.session.username]
    );
    const newCoins = result.rows[0].coins;
    broadcastCoins(req.session.username, newCoins);
    res.json({ ok: true, coins: newCoins, reward: DAILY_REWARD });
  } catch (err) {
    console.error('Daily error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Leaderboard ──────────────────────────────────────────────────────────────
router.get('/leaderboard', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  try {
    const result = await db.query('SELECT username, coins FROM users ORDER BY coins DESC LIMIT 20');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Slots ────────────────────────────────────────────────────────────────────
router.post('/game/slots', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const betAmount = parseInt(req.body.bet, 10);
  if (!betAmount || betAmount < 1 || betAmount > 500) return res.status(400).json({ error: 'Bet must be 1-500' });

  const newBal = await deductCoins(req.session.username, betAmount);
  if (newBal === false) return res.status(400).json({ error: 'Not enough coins' });

  const symbols = ['🍒', '🍋', '🍊', '⭐', '💎', '7️⃣'];
  const weights  = [40, 35, 25, 20, 12, 8];

  function spin() {
    let r = Math.random() * 140, acc = 0;
    for (let i = 0; i < symbols.length; i++) { acc += weights[i]; if (r < acc) return symbols[i]; }
    return symbols[0];
  }

  const reels = [spin(), spin(), spin()];
  let multiplier = 0;
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    multiplier = [2, 3, 4, 6, 8, 20][symbols.indexOf(reels[0])];
  }

  let winAmount = 0;
  let finalCoins = newBal;
  if (multiplier > 0) {
    winAmount = betAmount * multiplier;
    finalCoins = await addCoins(req.session.username, winAmount);
  }

  await recordGambleStats(req.session.username, winAmount);
  broadcastCoins(req.session.username, finalCoins);

  if (winAmount > 0) {
    await broadcastGambling(`🎰 ${req.session.username} won ${formatNumber(winAmount)} coins on slots! [${reels.join('')}] ${multiplier}x bet of ${formatNumber(betAmount)}`);
  } else {
    await broadcastGambling(`🎰 ${req.session.username} lost ${formatNumber(betAmount)} coins on slots [${reels.join('')}]`);
  }
  res.json({ reels, multiplier, winAmount, coins: finalCoins });
});

// ─── Dice ─────────────────────────────────────────────────────────────────────
router.post('/game/dice', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const betAmount = parseInt(req.body.bet, 10);
  if (!betAmount || betAmount < 1 || betAmount > 500) return res.status(400).json({ error: 'Bet must be 1-500' });

  const newBal = await deductCoins(req.session.username, betAmount);
  if (newBal === false) return res.status(400).json({ error: 'Not enough coins' });

  const playerRoll = crypto.randomInt(1, 7) + crypto.randomInt(1, 7);
  const houseRoll  = crypto.randomInt(1, 7) + crypto.randomInt(1, 7);
  let finalCoins = newBal, winAmount = 0, result = 'lose';

  if (playerRoll > houseRoll) {
    winAmount = Math.floor(betAmount * 1.9);
    finalCoins = await addCoins(req.session.username, winAmount);
    result = 'win';
  } else if (playerRoll === houseRoll) {
    winAmount = betAmount;
    finalCoins = await addCoins(req.session.username, betAmount);
    result = 'tie';
  }

  await recordGambleStats(req.session.username, winAmount);
  broadcastCoins(req.session.username, finalCoins);

  if (result === 'win') {
    await broadcastGambling(`🎲 ${req.session.username} won ${formatNumber(winAmount)} coins on dice! (rolled ${playerRoll} vs house ${houseRoll})`);
  } else if (result === 'tie') {
    await broadcastGambling(`🎲 ${req.session.username} tied on dice (both rolled ${playerRoll}), bet of ${formatNumber(betAmount)} returned`);
  } else {
    await broadcastGambling(`🎲 ${req.session.username} lost ${formatNumber(betAmount)} coins on dice (rolled ${playerRoll} vs house ${houseRoll})`);
  }
  res.json({ playerRoll, houseRoll, result, winAmount, coins: finalCoins });
});

// ─── Roulette ─────────────────────────────────────────────────────────────────
router.post('/game/roulette', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const betAmount = parseInt(req.body.bet, 10);
  const betType = String(req.body.betType).toLowerCase(); // 'red', 'black', 'even', 'odd'
  
  if (!betAmount || betAmount < 1 || betAmount > 500) return res.status(400).json({ error: 'Bet must be 1-500' });
  if (!['red', 'black', 'even', 'odd'].includes(betType)) return res.status(400).json({ error: 'Invalid bet type' });

  const newBal = await deductCoins(req.session.username, betAmount);
  if (newBal === false) return res.status(400).json({ error: 'Not enough coins' });

  // Spin: 0-36 (0 is green, 1-36 are mixed red/black)
  const spin = crypto.randomInt(0, 37);
  
  // Define red and black numbers (standard roulette)
  const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
  const blackNumbers = [2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35];
  
  let won = false;
  if (betType === 'red' && redNumbers.includes(spin)) won = true;
  else if (betType === 'black' && blackNumbers.includes(spin)) won = true;
  else if (betType === 'even' && spin > 0 && spin % 2 === 0) won = true;
  else if (betType === 'odd' && spin > 0 && spin % 2 === 1) won = true;

  let winAmount = 0, finalCoins = newBal, result = 'lose';
  if (won) {
    winAmount = betAmount; // 1:1 payout
    finalCoins = await addCoins(req.session.username, winAmount);
    result = 'win';
  }

  await recordGambleStats(req.session.username, winAmount);
  broadcastCoins(req.session.username, finalCoins);

  const spinColor = spin === 0 ? '🟢' : redNumbers.includes(spin) ? '🔴' : '⚫';
  if (result === 'win') {
    await broadcastGambling(`🎡 ${req.session.username} won ${formatNumber(winAmount)} coins on roulette! (spin: ${spinColor} ${spin})`);
  } else {
    await broadcastGambling(`🎡 ${req.session.username} lost ${formatNumber(betAmount)} coins on roulette (spin: ${spinColor} ${spin})`);
  }

  res.json({ spin, spinColor, result, winAmount, coins: finalCoins, betType });
});

module.exports = { router, initGambling, broadcastGambling };