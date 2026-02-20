const express = require('express');
const router = express.Router();

const { db } = require('../lib/db');
const { getValidColors, getValidThemes } = require('../lib/shopCatalogue');
const bcrypt = require('bcrypt');

// ─── Save Settings ────────────────────────────────────────────────────────────
// Color and theme must be owned before they can be applied.
// The shop purchase table is the source of truth for ownership.
router.post('/settings', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const { color, theme } = req.body;
  const updates = []; const values = []; let idx = 1;

  if (color !== undefined) {
    if (!getValidColors().includes(color)) return res.status(400).json({ error: 'Invalid color' });
    // Check ownership (price 0 = free, always owned)
    const owned = await isOwned(req.session.username, 'color', color);
    if (!owned) return res.status(403).json({ error: 'You do not own that color. Buy it in the shop first.' });
    updates.push(`color = $${idx++}`); values.push(color);
  }

  if (theme !== undefined) {
    if (!getValidThemes().includes(theme)) return res.status(400).json({ error: 'Invalid theme' });
    const owned = await isOwned(req.session.username, 'theme', theme);
    if (!owned) return res.status(403).json({ error: 'You do not own that theme. Buy it in the shop first.' });
    updates.push(`theme = $${idx++}`); values.push(theme);
  }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  values.push(req.session.username);

  try {
    await db.query(`UPDATE users SET ${updates.join(', ')} WHERE LOWER(username) = LOWER($${idx})`, values);
    res.json({ ok: true });
  } catch (err) {
    console.error('Settings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Helper: check if a user owns a given item value ─────────────────────────
async function isOwned(username, type, value) {
  const { SHOP_ITEMS } = require('../lib/shopCatalogue');
  const item = SHOP_ITEMS.find(i => i.type === type && i.value === value);
  if (!item) return false;
  if (item.price === 0) return true; // free items are always owned
  const r = await db.query(
    'SELECT 1 FROM shop_purchases WHERE LOWER(username) = LOWER($1) AND item_id = $2',
    [username, item.id]
  );
  return r.rows.length > 0;
}

module.exports = router;

// ─── Change password ───────────────────────────────────────────────────────
router.post('/settings/password', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const { oldPassword, newPassword, newPassword2 } = req.body || {};
  if (!oldPassword || !newPassword || !newPassword2) return res.status(400).json({ error: 'All fields are required' });
  if (newPassword !== newPassword2) return res.status(400).json({ error: 'New passwords do not match' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  try {
    const r = await db.query('SELECT password_hash FROM users WHERE LOWER(username) = LOWER($1)', [req.session.username]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(String(oldPassword), row.password_hash);
    if (!ok) return res.status(403).json({ error: 'Old password is incorrect' });
    const hash = await bcrypt.hash(String(newPassword), 12);
    await db.query('UPDATE users SET password_hash = $1 WHERE LOWER(username) = LOWER($2)', [hash, req.session.username]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});