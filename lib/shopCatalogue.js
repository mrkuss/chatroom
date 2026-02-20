// ─── VALID FREE DEFAULTS ─────────────────────────────────────────────────────
// These are what every user starts with for free — no purchase needed.
const FREE_THEME = 'classic';
const FREE_COLOR = '#000080';

// ─── SHOP CATALOGUE ──────────────────────────────────────────────────────────
// type: 'theme' | 'color'
// id:   the actual value stored on the user row
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
    id: 'theme_dark',
    type: 'theme',
    value: 'dark',
    name: 'Dark Mode',
    description: 'Easy on the eyes. Sleek charcoal interface.',
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
    id: 'theme_amber',
    type: 'theme',
    value: 'amber',
    name: 'Amber Terminal',
    description: 'Old-school orange CRT terminal glow.',
    price: 300,
    preview: '#1a0f00',
  },

  // ── Colors ───────────────────────────────────────────────────────────────
  { id: 'color_navy',    type: 'color', value: '#000080', name: 'Navy',        price: 0,   preview: '#000080' },
  { id: 'color_maroon',  type: 'color', value: '#800000', name: 'Maroon',      price: 50,  preview: '#800000' },
  { id: 'color_green',   type: 'color', value: '#008000', name: 'Forest',      price: 50,  preview: '#008000' },
  { id: 'color_purple',  type: 'color', value: '#800080', name: 'Purple',      price: 75,  preview: '#800080' },
  { id: 'color_teal',    type: 'color', value: '#008080', name: 'Teal',        price: 75,  preview: '#008080' },
  { id: 'color_blue',    type: 'color', value: '#0000cc', name: 'Royal Blue',  price: 100, preview: '#0000cc' },
  { id: 'color_red',     type: 'color', value: '#cc0000', name: 'Red',         price: 100, preview: '#cc0000' },
  { id: 'color_lime',    type: 'color', value: '#007700', name: 'Lime',        price: 100, preview: '#007700' },
  { id: 'color_magenta', type: 'color', value: '#aa00aa', name: 'Magenta',     price: 150, preview: '#aa00aa' },
  { id: 'color_cyan',    type: 'color', value: '#007777', name: 'Cyan',        price: 150, preview: '#007777' },
  { id: 'color_orange',  type: 'color', value: '#cc6600', name: 'Orange',      price: 150, preview: '#cc6600' },
  { id: 'color_steel',   type: 'color', value: '#006699', name: 'Steel Blue',  price: 175, preview: '#006699' },
  { id: 'color_crimson', type: 'color', value: '#990000', name: 'Crimson',     price: 175, preview: '#990000' },
  { id: 'color_emerald', type: 'color', value: '#009900', name: 'Emerald',     price: 200, preview: '#009900' },
  { id: 'color_violet',  type: 'color', value: '#660099', name: 'Violet',      price: 200, preview: '#660099' },
];

// Helpers
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