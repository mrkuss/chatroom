const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { db } = require('../lib/db');
const { getCoins, addCoins, deductCoins, broadcastCoins } = require('../lib/coins');
const { DAILY_REWARD } = require('../lib/utils');

// ─── Broadcast a message to the gambling room ─────────────────────────────────
// io is injected at init time
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
      'UPDATE users SET coins = coins + $1, last_daily = NOW() WHERE LOWER(username) = LOWER($2) RETURNING coins',
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
  const weights  = [30, 25, 20, 14, 8, 3];

  function spin() {
    let r = Math.random() * 100, acc = 0;
    for (let i = 0; i < symbols.length; i++) { acc += weights[i]; if (r < acc) return symbols[i]; }
    return symbols[0];
  }

  const reels = [spin(), spin(), spin()];
  let multiplier = 0;
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    multiplier = [2, 3, 4, 6, 10, 25][symbols.indexOf(reels[0])];
  }

  let winAmount = 0;
  let finalCoins = newBal;
  if (multiplier > 0) {
    winAmount = betAmount * multiplier;
    finalCoins = await addCoins(req.session.username, winAmount);
  }

  broadcastCoins(req.session.username, finalCoins);
  if (winAmount > 0) {
    await broadcastGambling(`🎰 ${req.session.username} won ${winAmount} coins on slots! [${reels.join('')}] ${multiplier}x bet of ${betAmount}`);
  } else {
    await broadcastGambling(`🎰 ${req.session.username} lost ${betAmount} coins on slots [${reels.join('')}]`);
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

  broadcastCoins(req.session.username, finalCoins);
  if (result === 'win') {
    await broadcastGambling(`🎲 ${req.session.username} won ${winAmount} coins on dice! (rolled ${playerRoll} vs house ${houseRoll})`);
  } else if (result === 'tie') {
    await broadcastGambling(`🎲 ${req.session.username} tied on dice (both rolled ${playerRoll}), bet of ${betAmount} returned`);
  } else {
    await broadcastGambling(`🎲 ${req.session.username} lost ${betAmount} coins on dice (rolled ${playerRoll} vs house ${houseRoll})`);
  }
  res.json({ playerRoll, houseRoll, result, winAmount, coins: finalCoins });
});

module.exports = { router, initGambling, broadcastGambling };