// ─── Badge Definitions ────────────────────────────────────────────────────────
const BADGES = [
  // Message badges
  { id: 'lurker_no_more',  emoji: '💬', name: 'Lurker No More',  description: 'Send 10 messages',            condition: u => u.messages_sent >= 10   },
  { id: 'regular',         emoji: '🗣️', name: 'Regular',         description: 'Send 50 messages',            condition: u => u.messages_sent >= 50   },
  { id: 'chatterbox',      emoji: '📢', name: 'Chatterbox',       description: 'Send 100 messages',           condition: u => u.messages_sent >= 100  },
  { id: 'motormouth',      emoji: '🔊', name: 'Motormouth',       description: 'Send 500 messages',           condition: u => u.messages_sent >= 500  },
  { id: 'legendary',       emoji: '👑', name: 'Legendary',        description: 'Send 1,000 messages',         condition: u => u.messages_sent >= 1000 },

  // Gambling badges
  { id: 'feeling_lucky',   emoji: '🎲', name: 'Feeling Lucky',    description: 'Place your first gamble',     condition: u => u.first_gamble         },
  { id: 'high_roller',     emoji: '💰', name: 'High Roller',      description: 'Win over 1,000 coins at once', condition: u => u.big_win              },

  // Coin badges (based on all-time earned, not current balance)
  { id: 'loaded',          emoji: '🤑', name: 'Loaded',           description: 'Earn 5,000 coins total',      condition: u => u.coins_earned >= 5000  },
  { id: 'whale',           emoji: '🐋', name: 'Whale',            description: 'Earn 10,000 coins total',     condition: u => u.coins_earned >= 10000 },
  { id: 'tycoon',          emoji: '💎', name: 'Tycoon',           description: 'Earn 50,000 coins total',     condition: u => u.coins_earned >= 50000 },
  { id: 'mogul',           emoji: '🏆', name: 'Mogul',            description: 'Earn 100,000 coins total',    condition: u => u.coins_earned >= 100000},
];

function getBadgeById(id) {
  return BADGES.find(b => b.id === id) || null;
}

// Returns array of badge ids the user has earned
function getEarnedBadgeIds(userStats) {
  return BADGES.filter(b => b.condition(userStats)).map(b => b.id);
}

// Returns full badge objects the user has earned
function getEarnedBadges(userStats) {
  return BADGES.filter(b => b.condition(userStats));
}

module.exports = { BADGES, getBadgeById, getEarnedBadgeIds, getEarnedBadges };