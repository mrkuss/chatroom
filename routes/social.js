const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();

const { db } = require('../lib/db');
const { getEarnedBadges, getBadgeById } = require('../lib/badges');

// ─── User count (public, shown on login page) ─────────────────────────────────
router.get('/user-count', async (req, res) => {
  try {
    const r = await db.query('SELECT COUNT(*) FROM users');
    res.json({ count: parseInt(r.rows[0].count, 10) });
  } catch { res.status(500).json({ count: 0 }); }
});

// ─── My Stats ─────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  try {
    const r = await db.query(
      `SELECT username, created_at, coins, coins_earned, coins_spent,
              messages_sent, time_online_seconds, first_gamble, active_badge
       FROM users WHERE LOWER(username) = LOWER($1)`,
      [req.session.username]
    );
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });

    // big_win is not a column — derive from coins_earned heuristic
    // We track it separately via the first_gamble flag pattern; for now pass false
    // (high roller badge earned via /stats/big-win endpoint called from gambling)
    const statsForBadges = { ...u, big_win: u.big_win || false };
    const earned = getEarnedBadges(statsForBadges);
    const activeBadge = u.active_badge ? getBadgeById(u.active_badge) : null;

    res.json({
      username: u.username,
      createdAt: u.created_at,
      coins: u.coins,
      coinsEarned: u.coins_earned,
      coinsSpent: u.coins_spent,
      messagesSent: u.messages_sent,
      timeOnlineSeconds: u.time_online_seconds,
      earnedBadges: earned,
      activeBadge,
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Public profile (anyone can view) ────────────────────────────────────────
router.get('/profile/:username', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  try {
    const r = await db.query(
      `SELECT username, created_at, coins, coins_earned, messages_sent,
              time_online_seconds, first_gamble, active_badge
       FROM users WHERE LOWER(username) = LOWER($1)`,
      [req.params.username]
    );
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    const statsForBadges = { ...u, big_win: u.big_win || false };
    const earned = getEarnedBadges(statsForBadges);
    const activeBadge = u.active_badge ? getBadgeById(u.active_badge) : null;
    res.json({
      username: u.username,
      createdAt: u.created_at,
      coins: u.coins,
      coinsEarned: u.coins_earned,
      messagesSent: u.messages_sent,
      timeOnlineSeconds: u.time_online_seconds,
      earnedBadges: earned,
      activeBadge,
    });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Set active badge ─────────────────────────────────────────────────────────
router.post('/badge/set', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const { badgeId } = req.body;
  try {
    // Verify they've earned it
    const r = await db.query(
      `SELECT coins_earned, messages_sent, first_gamble, active_badge
       FROM users WHERE LOWER(username) = LOWER($1)`,
      [req.session.username]
    );
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });

    if (badgeId !== null) {
      const statsForBadges = { ...u, big_win: u.big_win || false };
      const earned = getEarnedBadges(statsForBadges);
      const has = earned.find(b => b.id === badgeId);
      if (!has) return res.status(403).json({ error: 'You have not earned that badge' });
    }

    await db.query(
      'UPDATE users SET active_badge = $1 WHERE LOWER(username) = LOWER($2)',
      [badgeId || null, req.session.username]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Badge set error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Private rooms ────────────────────────────────────────────────────────────

// Create a private room
router.post('/rooms/create', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length < 2 || name.length > 20)
    return res.status(400).json({ error: 'Room name: 2-20 chars, letters/numbers/dash/underscore only' });
  if (password.length < 3) return res.status(400).json({ error: 'Password must be at least 3 characters' });

  try {
    // Check max 3 private rooms per user
    const owned = await db.query(
      `SELECT COUNT(*) FROM rooms WHERE LOWER(creator) = LOWER($1) AND is_private = true`,
      [req.session.username]
    );
    if (parseInt(owned.rows[0].count, 10) >= 3)
      return res.status(400).json({ error: 'You can only create 3 private rooms' });

    const hash = await bcrypt.hash(password, 10);
    await db.query(
      `INSERT INTO rooms (name, is_private, password_hash, creator) VALUES ($1, true, $2, $3)`,
      [name.toLowerCase(), hash, req.session.username]
    );
    res.json({ ok: true, name: name.toLowerCase() });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A room with that name already exists' });
    console.error('Create room error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a private room (creator only)
router.post('/rooms/delete', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const { name } = req.body;
  try {
    const r = await db.query(
      `SELECT creator FROM rooms WHERE name = $1 AND is_private = true`,
      [name]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Private room not found' });
    if (r.rows[0].creator.toLowerCase() !== req.session.username.toLowerCase())
      return res.status(403).json({ error: 'Only the creator can delete this room' });
    await db.query(`DELETE FROM rooms WHERE name = $1`, [name]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete room error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Join a private room (verify password)
router.post('/rooms/join', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const { name, password } = req.body;
  try {
    const r = await db.query(`SELECT password_hash FROM rooms WHERE name = $1 AND is_private = true`, [name]);
    if (!r.rows.length) return res.status(404).json({ error: 'Private room not found' });
    const match = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Wrong password' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Join room error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Reactions ────────────────────────────────────────────────────────────────

router.post('/reactions/add', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const { messageId, emoji } = req.body;
  const allowed = ['👍', '❤️', '😂', '😮'];
  if (!allowed.includes(emoji)) return res.status(400).json({ error: 'Invalid emoji' });
  try {
    // Upsert — change reaction if already reacted
    await db.query(
      `INSERT INTO reactions (message_id, username, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, username) DO UPDATE SET emoji = $3`,
      [messageId, req.session.username, emoji]
    );
    const counts = await getReactionCounts(messageId);
    res.json({ ok: true, messageId, reactions: counts });
  } catch (err) {
    console.error('Reaction add error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/reactions/remove', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const { messageId } = req.body;
  try {
    await db.query(
      `DELETE FROM reactions WHERE message_id = $1 AND LOWER(username) = LOWER($2)`,
      [messageId, req.session.username]
    );
    const counts = await getReactionCounts(messageId);
    res.json({ ok: true, messageId, reactions: counts });
  } catch (err) {
    console.error('Reaction remove error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

async function getReactionCounts(messageId) {
  const r = await db.query(
    `SELECT emoji, COUNT(*) as count FROM reactions WHERE message_id = $1 GROUP BY emoji`,
    [messageId]
  );
  const result = {};
  r.rows.forEach(row => { result[row.emoji] = parseInt(row.count, 10); });
  return result;
}

module.exports = { router, getReactionCounts };