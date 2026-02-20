const express = require('express');
const router = express.Router();

const { db } = require('../lib/db');
const { SHOP_ITEMS } = require('../lib/shopCatalogue');
const { deductCoins, broadcastCoins } = require('../lib/coins');

// ─── GET /shop ────────────────────────────────────────────────────────────────
// Returns all shop items with ownership flags for the logged-in user
router.get('/shop', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  try {
    const purchasesResult = await db.query(
      'SELECT item_id FROM shop_purchases WHERE LOWER(username) = LOWER($1)',
      [req.session.username]
    );
    const ownedIds = new Set(purchasesResult.rows.map(r => r.item_id));

    const items = SHOP_ITEMS.map(item => ({
      ...item,
      owned: item.price === 0 || ownedIds.has(item.id),
    }));

    res.json(items);
  } catch (err) {
    console.error('Shop list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /shop/buy ───────────────────────────────────────────────────────────
router.post('/shop/buy', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: 'itemId required' });

  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.price === 0) return res.status(400).json({ error: 'This item is free — no purchase needed' });

  try {
    // Check already owned
    const existing = await db.query(
      'SELECT 1 FROM shop_purchases WHERE LOWER(username) = LOWER($1) AND item_id = $2',
      [req.session.username, itemId]
    );
    if (existing.rows.length) return res.status(409).json({ error: 'You already own this item' });

    // Deduct coins
    const newBal = await deductCoins(req.session.username, item.price);
    if (newBal === false) return res.status(400).json({ error: 'Not enough coins' });

    // Record purchase
    await db.query(
      'INSERT INTO shop_purchases (username, item_id) VALUES ($1, $2)',
      [req.session.username, itemId]
    );

    broadcastCoins(req.session.username, newBal);
    res.json({ ok: true, coins: newBal, item: { ...item, owned: true } });
  } catch (err) {
    console.error('Shop buy error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;