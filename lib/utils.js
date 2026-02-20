function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0] : null;
}

const DAILY_REWARD = 50;

// ── Basic word filtering ────────────────────────────────────────────────────
const BANNED_WORDS = [ 'badword', 'anotherbadword' ]; // lowercase

function filterText(text) {
  if (!text) return text;
  let out = String(text);
  BANNED_WORDS.forEach(w => {
    const re = new RegExp(`\\b${w}\\b`, 'ig');
    out = out.replace(re, match => '*'.repeat(match.length));
  });
  return out;
}

module.exports = { escapeHtml, extractUrl, DAILY_REWARD };