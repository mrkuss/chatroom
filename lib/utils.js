function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0] : null;
}

const DAILY_REWARD = 50;

// ── Basic word filtering ───────────────────────────────────────────────────
const BANNED_WORDS = [
  // ── Racial / Ethnic Slurs ─────────────────────────────────────────────
  'nigger', 'nigga', 'chink', 'gook', 'spic', 'wetback', 'kike', 'raghead',
  'towelhead', 'cracker', 'beaner', 'zipperhead', 'coon', 'jigaboo',
  'porch monkey', 'darkie', 'sambo', 'sandnigger', 'camel jockey', 'redskin',
  'squaw', 'wog', 'curry muncher', 'paki', 'kraut', 'slant', 'slope', 'nip',
  'hymie', 'heeb', 'spook', 'jungle bunny', 'mud duck', 'greaseball', 'dago',
  'guido', 'ginzo', 'bohunk', 'polack', 'mick', 'spade',
  // ── Homophobic / Transphobic Slurs ────────────────────────────────────
  'faggot', 'fag', 'dyke', 'tranny', 'shemale', 'he-she', 'ladyboy',
  'sodomite', 'poofter', 'poof', 'pillow biter', 'carpet muncher', 'bulldyke',
  // ── Sexist / Misogynistic Slurs ───────────────────────────────────────
  'bitch', 'cunt', 'slut', 'whore', 'skank', 'thot', 'slag', 'trollop',
  'hussy', 'strumpet', 'floozy', 'minge', 'twat', 'skanky',
  // ── General Profanity ─────────────────────────────────────────────────
  'fuck', 'shit', 'asshole', 'bastard', 'piss', 'dick', 'cock', 'prick',
  'jackass', 'dumbass', 'dipshit', 'motherfucker', 'fucker', 'bullshit',
  'horseshit', 'douchebag', 'douche', 'wanker', 'tosser', 'bellend', 'knob',
  'numbnuts', 'shithead', 'fuckhead', 'arsehole', 'arse',
  // ── Sexual Terms / Porn ───────────────────────────────────────────────
  'pussy', 'blowjob', 'handjob', 'rimjob', 'cumshot', 'cum', 'jizz', 'spunk',
  'semen', 'boner', 'hardon', 'dildo', 'vibrator', 'masturbate', 'masturbation',
  'fingering', 'fisting', 'squirting', 'creampie', 'gangbang', 'threesome',
  'orgy', 'porn', 'porno', 'pornography', 'xxx', 'hentai', 'loli', 'shota',
  'futanari', 'futa', 'ahegao', 'bdsm', 'bondage', 'dominatrix', 'fetish',
  'deepthroat', 'facefuck', 'facefucking', 'throatfuck', 'clit', 'clitoris',
  'labia', 'scrotum', 'titfuck', 'boobjob', 'footjob', 'sexcam', 'stripper',
  'striptease', 'lapdance', 'prostitute', 'prostitution', 'hooker', 'brothel',
  'pimp', 'softcore', 'milf', 'gilf', 'incest', 'rape', 'rapist', 'molest',
  'molestation', 'groping', 'pedophile', 'pedophilia', 'pedo', 'jailbait',
  // ── Ableist Slurs ─────────────────────────────────────────────────────
  'retard', 'retarded', 'spaz', 'spastic', 'cripple', 'gimp', 'mong', 'mongoloid',
  // ── Violence / Extremism ──────────────────────────────────────────────
  'kill yourself', 'kys', 'neck yourself', 'rope yourself', 'hang yourself',
  'drink bleach', 'shoot yourself', 'genocide', 'ethnic cleansing',
  'white supremacy', 'white power', 'heil hitler', '1488', 'white nationalist',
  'kkk', 'ku klux klan', 'lynch', 'lynching',
  // ── Drug References ───────────────────────────────────────────────────
  'heroin', 'methamphetamine', 'crack cocaine', 'fentanyl',
].map(w => w.toLowerCase());

// Characters that are visually/phonetically similar to a–z.
// Each key is the "real" letter; the value is a character class string
// covering common substitutions seen in evasion attempts.
const LEET_MAP = {
  a: '[a@4áàâãä]',
  b: '[b8ß]',
  c: '[c¢(]',
  e: '[e3éèêë€]',
  f: '[f]',          // f rarely has leet variants but kept for structure
  g: '[g9]',
  h: '[h#]',
  i: '[i1!|íìîï]',
  k: '[k]',
  l: '[l1|£]',
  m: '[m]',
  n: '[nñ]',
  o: '[o0òóôõöø°]',
  p: '[pþ]',
  r: '[rя]',
  s: '[s5$§]',
  t: '[t7+†]',
  u: '[uúùûüµ]',
  v: '[v]',
  w: '[wω]',
  x: '[x×]',
  y: '[yýÿ¥]',
  z: '[z2]',
};

// Between any two letters in a banned word we allow an optional separator:
// a space, dash, dot, underscore, or a single non-alphanumeric punctuation char
// (covers "f*ck", "f_ck", "f.ck", "f ck", "f-ck", "f@ck", etc.)
const SEP = '[\\s\\-_\\.\\*@#^~]*';

/**
 * Build a regex for a single banned phrase that handles:
 *  - leet-speak substitutions  (f -> f, u -> [u0µ…], c -> [c¢(], k -> k)
 *  - separator insertion        (f*ck, f ck, f_c_k)
 *  - repeated letters           (fuuuck, shhhhit)
 *  - word-boundary anchoring
 *
 * Multi-word phrases (e.g. "kill yourself") are split on whitespace and each
 * word is treated independently with \s+ between them so "kill   yourself"
 * and "kill-yourself" are both caught.
 */
function buildPattern(phrase) {
  const words = phrase.split(/\s+/);
  const wordPatterns = words.map(word => {
    return word
      .split('')
      .map(ch => {
        const leet = LEET_MAP[ch] || `[${escapeRegex(ch)}]`;
        // Allow one or more of each character to catch elongation (fuuuck)
        return `${leet}+`;
      })
      .join(SEP);
  });
  // Between words allow flexible whitespace/punctuation
  return wordPatterns.join('[\\s\\-_\\.\\*@#^~]+');
}

function escapeRegex(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pre-compile all patterns once at startup
const BANNED_PATTERNS = BANNED_WORDS.map(phrase => ({
  phrase,
  re: new RegExp(`(?<![a-z0-9])${buildPattern(phrase)}(?![a-z0-9])`, 'gi'),
}));

/**
 * Strip the input of zero-width / invisible Unicode characters that are
 * commonly inserted to break naive pattern matching (e.g. f\u200buck).
 */
function stripInvisible(text) {
  // Removes zero-width space, zero-width non-joiner, soft hyphen, etc.
  return text.replace(/[\u00AD\u200B-\u200F\u2060\uFEFF]/g, '');
}

function filterText(text) {
  if (!text) return text;
  let out = stripInvisible(String(text));
  for (const { re } of BANNED_PATTERNS) {
    // Reset lastIndex in case the regex is reused (global flag)
    re.lastIndex = 0;
    out = out.replace(re, match => '*'.repeat(match.length));
  }
  return out;
}

function formatNumber(n) {
  if (n === null || n === undefined) return '0';
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  return num.toLocaleString();
}

module.exports = {
  escapeHtml,
  extractUrl,
  DAILY_REWARD,
  filterText,
  BANNED_WORDS,
  formatNumber,
};