// ─── VALID FREE DEFAULTS ─────────────────────────────────────────────────────
const FREE_THEME = 'classic';
const FREE_COLOR = '#000080';

// ─── SHOP CATALOGUE ──────────────────────────────────────────────────────────
const SHOP_ITEMS = [
  // ── Themes ───────────────────────────────────────────────────────────────
  {
    id: 'theme_classic',
    type: 'theme',
    value: 'classic',
    name: 'Classic',
    description: 'The original Windows 95 blue. Free forever.',
    price: 0,
    preview: '#000080',
  },
  {
    id: 'theme_noir',
    type: 'theme',
    value: 'noir',
    name: 'Noir',
    description: 'Sleek charcoal. Easy on the eyes.',
    price: 200,
    preview: '#1a1a1a',
  },
  {
    id: 'theme_rose',
    type: 'theme',
    value: 'rose',
    name: 'Rose',
    description: 'Deep plum and blush pink. The best theme.',
    price: 350,
    preview: '#7a2d52',
  },
  {
    id: 'theme_forest',
    type: 'theme',
    value: 'forest',
    name: 'Forest',
    description: 'Deep greens and earthy browns. Easy on the eyes.',
    price: 300,
    preview: '#1a2010',
  },

  // ── Standard Colors (500 each) ───────────────────────────────────────────
  { id: 'color_navy',    type: 'color', value: '#000080', name: 'Navy',    price: 0,   preview: '#000080' },
  { id: 'color_red',     type: 'color', value: '#cc0000', name: 'Red',     price: 500, preview: '#cc0000' },
  { id: 'color_yellow',  type: 'color', value: '#ccaa00', name: 'Yellow',  price: 500, preview: '#ccaa00' },
  { id: 'color_green',   type: 'color', value: '#228b22', name: 'Green',   price: 500, preview: '#228b22' },
  { id: 'color_brown',   type: 'color', value: '#8b4513', name: 'Brown',   price: 500, preview: '#8b4513' },
  { id: 'color_orange',  type: 'color', value: '#cc6600', name: 'Orange',  price: 500, preview: '#cc6600' },
  { id: 'color_purple',  type: 'color', value: '#6a0dad', name: 'Purple',  price: 500, preview: '#6a0dad' },
  { id: 'color_pink',    type: 'color', value: '#cc0077', name: 'Pink',    price: 500, preview: '#cc0077' },

  // ── Premium Colors (5000 each) ───────────────────────────────────────────
  { id: 'color_gold',       type: 'color', value: '#ccaa00', name: 'Gold',         price: 5000, preview: '#ccaa00', effect: 'gold' },
  { id: 'color_rainbow',    type: 'color', value: '#ff6bcb', name: 'Rainbow',      price: 5000, preview: '#ff6bcb', effect: 'rainbow' },
  { id: 'color_neon_red',   type: 'color', value: '#ff0044', name: 'Neon Red',     price: 5000, preview: '#ff0044', effect: 'neon_red' },
  { id: 'color_neon_purple',type: 'color', value: '#cc00ff', name: 'Neon Purple',  price: 5000, preview: '#cc00ff', effect: 'neon_purple' },
];

function getItem(itemId) {
  return SHOP_ITEMS.find(i => i.id === itemId) || null;
}

function getValidColors() {
  return SHOP_ITEMS.filter(i => i.type === 'color').map(i => i.value);
}

function getValidThemes() {
  return SHOP_ITEMS.filter(i => i.type === 'theme').map(i => i.value);
}

module.exports = { SHOP_ITEMS, FREE_THEME, FREE_COLOR, getItem, getValidColors, getValidThemes };