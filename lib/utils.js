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
const BANNED_WORDS = [
  // ── Racial / Ethnic Slurs ──────────────────────────────────────────────
  'nigger', 'nigga', 'chink', 'gook', 'spic', 'wetback', 'kike',
  'raghead', 'towelhead', 'cracker', 'beaner', 'zipperhead',
  'coon', 'jigaboo', 'porch monkey', 'darkie', 'sambo',
  'sandnigger', 'camel jockey', 'redskin', 'squaw', 'wog', 'curry muncher',
  'paki', 'kraut', 'slant', 'slope', 'nip', 'hymie',
  'heeb', 'spook', 'jungle bunny', 'mud duck', 'greaseball', 'dago',
  'guido', 'ginzo', 'bohunk', 'polack', 'mick', 'spade',

  // ── Homophobic / Transphobic Slurs ────────────────────────────────────
  'faggot', 'fag', 'dyke', 'tranny', 'shemale', 'he-she',
  'ladyboy', 'sodomite', 'poofter', 'poof', 'pillow biter', 'carpet muncher',
  'bulldyke',

  // ── Sexist / Misogynistic Slurs ───────────────────────────────────────
  'bitch', 'cunt', 'slut', 'whore', 'skank', 'thot',
  'slag', 'trollop', 'hussy', 'strumpet', 'floozy',
  'minge', 'twat', 'skanky',

  // ── General Profanity ─────────────────────────────────────────────────
  'fuck', 'shit', 'asshole', 'bastard', 'piss',
  'dick', 'cock', 'prick', 'jackass', 'dumbass',
  'dipshit', 'motherfucker', 'fucker', 'bullshit', 'horseshit',
  'douchebag', 'douche', 'wanker', 'tosser', 'bellend', 'knob',
  'numbnuts', 'shithead', 'fuckhead', 'arsehole', 'arse',

  // ── Sexual Terms / Porn ───────────────────────────────────────────────
  'pussy', 'blowjob', 'handjob', 'rimjob', 'cumshot',
  'cum', 'jizz', 'spunk', 'semen', 'boner',
  'hardon', 'dildo', 'vibrator', 'masturbate', 'masturbation',
  'fingering', 'fisting', 'squirting', 'creampie', 'gangbang',
  'threesome', 'orgy', 'porn', 'porno', 'pornography',
  'xxx', 'hentai', 'loli', 'shota', 'futanari', 'futa', 'ahegao',
  'bdsm', 'bondage', 'dominatrix', 'fetish',
  'deepthroat', 'facefuck', 'facefucking', 'throatfuck',
  'clit', 'clitoris', 'labia', 'scrotum',
  'titfuck', 'boobjob', 'footjob', 'sexcam',
  'stripper', 'striptease', 'lapdance', 'prostitute',
  'prostitution', 'hooker', 'brothel', 'pimp',
  'softcore', 'milf', 'gilf', 'incest',
  'rape', 'rapist', 'molest', 'molestation', 'groping',
  'pedophile', 'pedophilia', 'pedo', 'jailbait',

  // ── Ableist Slurs ─────────────────────────────────────────────────────
  'retard', 'retarded', 'spaz', 'spastic', 'cripple', 'gimp',
  'mong', 'mongoloid',

  // ── Violence / Extremism ──────────────────────────────────────────────
  'kill yourself', 'kys', 'neck yourself', 'rope yourself',
  'hang yourself', 'drink bleach', 'shoot yourself',
  'genocide', 'ethnic cleansing', 'white supremacy', 'white power',
  'heil hitler', '1488', 'white nationalist',
  'kkk', 'ku klux klan', 'lynch', 'lynching',

  // ── Drug References ───────────────────────────────────────────────────
  'heroin', 'methamphetamine', 'crack cocaine', 'fentanyl',
].map(w => w.toLowerCase());

function filterText(text) {
  if (!text) return text;
  let out = String(text);
  BANNED_WORDS.forEach(w => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'ig');
    out = out.replace(re, match => '*'.repeat(match.length));
  });
  return out;
}

module.exports = { escapeHtml, extractUrl, DAILY_REWARD, filterText, BANNED_WORDS };