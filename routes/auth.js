const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();

const { db } = require('../lib/db');
const { createSocketToken } = require('../lib/socketAuth');
const { FREE_COLOR, FREE_THEME } = require('../lib/shopCatalogue');

// ─── Register ─────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const hash = await bcrypt.hash(password, 12);
    await db.query(
      'INSERT INTO users (username, password_hash, color, theme, coins) VALUES ($1, $2, $3, $4, 100)',
      [username, hash, FREE_COLOR, FREE_THEME]
    );
    req.session.username = username;
    const token = createSocketToken(username);
    res.json({ ok: true, username, color: FREE_COLOR, theme: FREE_THEME, coins: 100, token, dailyAvailable: false });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  try {
    const result = await db.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid username or password' });
    req.session.username = user.username;
    const token = createSocketToken(user.username);
    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dailyAvailable = !user.last_daily || new Date(user.last_daily) < todayUTC;
    res.json({
      ok: true,
      username: user.username,
      color: user.color || FREE_COLOR,
      theme: user.theme || FREE_THEME,
      coins: user.coins || 0,
      token,
      dailyAvailable,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Logout ───────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Logout error:', err);
    res.json({ ok: true });
  });
});

// ─── /me ─────────────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  try {
    const result = await db.query(
      'SELECT color, theme, coins, last_daily FROM users WHERE LOWER(username) = LOWER($1)',
      [req.session.username]
    );
    const row = result.rows[0];
    const color = row?.color || FREE_COLOR;
    const theme = row?.theme || FREE_THEME;
    const coins = row?.coins ?? 0;
    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dailyAvailable = !row?.last_daily || new Date(row.last_daily) < todayUTC;
    const token = createSocketToken(req.session.username);
    res.json({ username: req.session.username, color, theme, coins, token, dailyAvailable });
  } catch (err) {
    console.error('/me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Rooms list ───────────────────────────────────────────────────────────────
router.get('/rooms', async (req, res) => {
  const result = await db.query('SELECT name FROM rooms ORDER BY id');
  res.json(result.rows.map(r => r.name));
});

module.exports = router;