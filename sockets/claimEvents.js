const { addCoins, broadcastCoins } = require('../lib/coins');
const { formatNumber } = require('../lib/utils');
// ─── State ────────────────────────────────────────────────────────────────────
let activeClaim = null; // { expiresAt: timestamp } or null
// ─── Init ─────────────────────────────────────────────────────────────────────
function initClaimEvents(io) {
  // Fire a claim event every 15-45 minutes (randomised)
  function scheduleNext() {
    const delayMs = (15 + Math.floor(Math.random() * 31)) * 60 * 1000; // 15-45 min
    setTimeout(() => triggerClaimEvent(io, scheduleNext), delayMs);
  }
  scheduleNext();
  // Expire unclaimed events after 60 seconds
  setInterval(() => {
    if (activeClaim && Date.now() > activeClaim.expiresAt) {
      activeClaim = null;
      io.emit('system message', 'Nobody claimed the reward in time.');
    }
  }, 5000);
}
// ─── Trigger ──────────────────────────────────────────────────────────────────
function triggerClaimEvent(io, scheduleNext) {
  if (activeClaim) { scheduleNext(); return; } // don't overlap
  activeClaim = { expiresAt: Date.now() + 60000 };
  // Broadcast to ALL rooms
  io.emit('system message', `First to type /claim gets ${formatNumber(100)} coins!`);
  scheduleNext();
}
// ─── Handle a claim attempt ───────────────────────────────────────────────────
// Returns true if the claim was won, false otherwise
async function handleClaim(io, username) {
  if (!activeClaim) return false;
  if (Date.now() > activeClaim.expiresAt) { activeClaim = null; return false; }
  // Claim it immediately (clear first to prevent race)
  activeClaim = null;
  const newCoins = await addCoins(username, 100);
  broadcastCoins(username, newCoins);
  io.emit('system message', `${username} claimed the reward and won ${formatNumber(100)} coins!`);
  return true;
}
module.exports = { initClaimEvents, handleClaim };