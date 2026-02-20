const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ─── Database Setup ───────────────────────────────────────────────────────────

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#000080',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS session (
      sid TEXT NOT NULL COLLATE "default",
      sess JSON NOT NULL,
      expire TIMESTAMPTZ NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`INSERT INTO rooms (name) VALUES ('general'), ('random') ON CONFLICT (name) DO NOTHING`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room TEXT,
      sender TEXT NOT NULL,
      recipient TEXT,
      type TEXT NOT NULL DEFAULT 'chat',
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS IDX_messages_room ON messages (room, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS IDX_messages_dm ON messages (sender, recipient, created_at DESC)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY,
      room TEXT NOT NULL,
      question TEXT NOT NULL,
      options JSONB NOT NULL,
      votes JSONB NOT NULL DEFAULT '{}',
      creator TEXT NOT NULL,
      ends_at TIMESTAMPTZ,
      concluded BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Safe upgrades
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#000080'`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'classic'`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 100`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily TIMESTAMPTZ`);
  await db.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ`);
  await db.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS concluded BOOLEAN NOT NULL DEFAULT false`);

  console.log('Database initialised');
}

initDb().catch((err) => { console.error('Failed to initialise database:', err); process.exit(1); });

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);

app.use(session({
  store: new pgSession({ pool: db, tableName: 'session', pruneSessionInterval: 60 * 15 }),
  secret: process.env.SESSION_SECRET || 'change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

// ─── Socket Auth Tokens ───────────────────────────────────────────────────────

const socketTokens = {};

function createSocketToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  socketTokens[token] = { username, expires: Date.now() + 30000 };
  return token;
}

function consumeSocketToken(token) {
  const entry = socketTokens[token];
  if (!entry) return null;
  delete socketTokens[token];
  if (Date.now() > entry.expires) return null;
  return entry.username;
}

setInterval(() => {
  const now = Date.now();
  for (const token in socketTokens) { if (socketTokens[token].expires < now) delete socketTokens[token]; }
}, 60000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const VALID_COLORS = [
  '#000080','#800000','#008000','#800080','#008080',
  '#0000cc','#cc0000','#007700','#aa00aa','#007777',
  '#cc6600','#006699','#990000','#009900','#660099',
];
const VALID_THEMES = ['classic', 'dark', 'hacker', 'rose'];
const DAILY_REWARD = 50;

// ─── Link Preview ─────────────────────────────────────────────────────────────

const previewCache = new Map();

async function fetchLinkPreview(rawUrl) {
  if (previewCache.has(rawUrl)) return previewCache.get(rawUrl);
  return new Promise((resolve) => {
    try {
      const parsed = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) { resolve(null); return; }
      const lib = parsed.protocol === 'https:' ? https : require('http');
      const req = lib.get(rawUrl, { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0 (chatroom-preview)' } }, (res) => {
        if (res.statusCode !== 200) { resolve(null); return; }
        let body = '';
        res.on('data', (chunk) => { body += chunk; if (body.length > 50000) req.destroy(); });
        res.on('end', () => {
          const getMeta = (prop) => {
            const m = body.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
                     || body.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
            return m ? escapeHtml(m[1].slice(0, 200)) : null;
          };
          const titleM = body.match(/<title[^>]*>([^<]+)<\/title>/i);
          const result = {
            title: getMeta('og:title') || (titleM ? escapeHtml(titleM[1].slice(0, 100)) : null),
            image: getMeta('og:image'),
            description: getMeta('og:description') || getMeta('description'),
          };
          if (result.title || result.description) { previewCache.set(rawUrl, result); resolve(result); }
          else resolve(null);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0] : null;
}

// ─── Coin Helpers ─────────────────────────────────────────────────────────────

async function getCoins(username) {
  const r = await db.query('SELECT coins FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  return r.rows[0]?.coins ?? 0;
}

async function addCoins(username, amount) {
  const r = await db.query(
    'UPDATE users SET coins = coins + $1 WHERE LOWER(username) = LOWER($2) RETURNING coins',
    [amount, username]
  );
  return r.rows[0]?.coins ?? 0;
}

async function deductCoins(username, amount) {
  const r = await db.query(
    'UPDATE users SET coins = coins - $1 WHERE LOWER(username) = LOWER($2) AND coins >= $1 RETURNING coins',
    [amount, username]
  );
  if (!r.rows.length) return false;
  return r.rows[0].coins;
}

function broadcastCoins(username, coins) {
  const key = username.toLowerCase();
  const socketId = userSocketMap[key];
  if (socketId) {
    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit('coins update', { coins });
  }
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.post('/register', async (req, res) => {
  const { username, password, color } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const safeColor = VALID_COLORS.includes(color) ? color : '#000080';
  try {
    const hash = await bcrypt.hash(password, 12);
    await db.query('INSERT INTO users (username, password_hash, color, theme, coins) VALUES ($1, $2, $3, $4, 100)', [username, hash, safeColor, 'classic']);
    req.session.username = username;
    const token = createSocketToken(username);
    res.json({ ok: true, username, color: safeColor, theme: 'classic', coins: 100, token, dailyAvailable: false });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/login', async (req, res) => {
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
    res.json({ ok: true, username: user.username, color: user.color || '#000080', theme: user.theme || 'classic', coins: user.coins || 0, token, dailyAvailable });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy((err) => { if (err) console.error('Logout error:', err); res.json({ ok: true }); });
});

app.get('/me', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const result = await db.query('SELECT color, theme, coins, last_daily FROM users WHERE LOWER(username) = LOWER($1)', [req.session.username]);
  const row = result.rows[0];
  const color = row?.color || '#000080';
  const theme = row?.theme || 'classic';
  const coins = row?.coins ?? 0;
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dailyAvailable = !row?.last_daily || new Date(row.last_daily) < todayUTC;
  const token = createSocketToken(req.session.username);
  res.json({ username: req.session.username, color, theme, coins, token, dailyAvailable });
});

app.get('/rooms', async (req, res) => {
  const result = await db.query('SELECT name FROM rooms ORDER BY id');
  res.json(result.rows.map(r => r.name));
});

// ─── Settings ─────────────────────────────────────────────────────────────────

app.post('/settings', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const { color, theme } = req.body;
  const updates = []; const values = []; let idx = 1;
  if (color !== undefined) {
    if (!VALID_COLORS.includes(color)) return res.status(400).json({ error: 'Invalid color' });
    updates.push(`color = $${idx++}`); values.push(color);
  }
  if (theme !== undefined) {
    if (!VALID_THEMES.includes(theme)) return res.status(400).json({ error: 'Invalid theme' });
    updates.push(`theme = $${idx++}`); values.push(theme);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  values.push(req.session.username);
  try {
    await db.query(`UPDATE users SET ${updates.join(', ')} WHERE LOWER(username) = LOWER($${idx})`, values);
    if (color) {
      const key = req.session.username.toLowerCase();
      const socketId = userSocketMap[key];
      if (socketId && connectedUsers[socketId]) connectedUsers[socketId].color = color;
    }
    res.json({ ok: true });
  } catch (err) { console.error('Settings error:', err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Daily Reward ─────────────────────────────────────────────────────────────

app.post('/daily', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  try {
    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const r = await db.query('SELECT last_daily, coins FROM users WHERE LOWER(username) = LOWER($1)', [req.session.username]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'User not found' });
    if (row.last_daily && new Date(row.last_daily) >= todayUTC) return res.status(400).json({ error: 'Already claimed today' });
    const result = await db.query(
      'UPDATE users SET coins = coins + $1, last_daily = NOW() WHERE LOWER(username) = LOWER($2) RETURNING coins',
      [DAILY_REWARD, req.session.username]
    );
    const newCoins = result.rows[0].coins;
    broadcastCoins(req.session.username, newCoins);
    res.json({ ok: true, coins: newCoins, reward: DAILY_REWARD });
  } catch (err) { console.error('Daily error:', err); res.status(500).json({ error: 'Server error' }); }
});

// ─── Leaderboard ──────────────────────────────────────────────────────────────

app.get('/leaderboard', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  try {
    const result = await db.query('SELECT username, coins FROM users ORDER BY coins DESC LIMIT 20');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ─── Game: Slots ──────────────────────────────────────────────────────────────

app.post('/game/slots', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const betAmount = parseInt(req.body.bet, 10);
  if (!betAmount || betAmount < 1 || betAmount > 500) return res.status(400).json({ error: 'Bet must be 1-500' });

  const newBal = await deductCoins(req.session.username, betAmount);
  if (newBal === false) return res.status(400).json({ error: 'Not enough coins' });

  const symbols = ['🍒', '🍋', '🍊', '⭐', '💎', '7️⃣'];
  const weights  = [30, 25, 20, 14, 8, 3];

  function spin() {
    let r = Math.random() * 100, acc = 0;
    for (let i = 0; i < symbols.length; i++) { acc += weights[i]; if (r < acc) return symbols[i]; }
    return symbols[0];
  }

  const reels = [spin(), spin(), spin()];
  let multiplier = 0;

  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    multiplier = [2, 3, 4, 6, 10, 25][symbols.indexOf(reels[0])];
  }

  let winAmount = 0;
  let finalCoins = newBal;
  if (multiplier > 0) {
    winAmount = betAmount * multiplier;
    finalCoins = await addCoins(req.session.username, winAmount);
  }

  broadcastCoins(req.session.username, finalCoins);
  res.json({ reels, multiplier, winAmount, coins: finalCoins });
});

// ─── Game: Dice ───────────────────────────────────────────────────────────────

app.post('/game/dice', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Not logged in' });
  const betAmount = parseInt(req.body.bet, 10);
  if (!betAmount || betAmount < 1 || betAmount > 500) return res.status(400).json({ error: 'Bet must be 1-500' });

  const newBal = await deductCoins(req.session.username, betAmount);
  if (newBal === false) return res.status(400).json({ error: 'Not enough coins' });

  const playerRoll = crypto.randomInt(1, 7) + crypto.randomInt(1, 7);
  const houseRoll  = crypto.randomInt(1, 7) + crypto.randomInt(1, 7);
  let finalCoins = newBal, winAmount = 0, result = 'lose';

  if (playerRoll > houseRoll) {
    winAmount = Math.floor(betAmount * 1.9);
    finalCoins = await addCoins(req.session.username, winAmount);
    result = 'win';
  } else if (playerRoll === houseRoll) {
    winAmount = betAmount;
    finalCoins = await addCoins(req.session.username, betAmount);
    result = 'tie';
  }

  broadcastCoins(req.session.username, finalCoins);
  res.json({ playerRoll, houseRoll, result, winAmount, coins: finalCoins });
});

// ─── Socket State ─────────────────────────────────────────────────────────────

const connectedUsers  = {};
const userSocketMap   = {};
const rateLimits      = {};
const typingTimeouts  = {};
const typingByRoom    = {};
const pendingDuels    = {};

// ─── Broadcast Helpers ────────────────────────────────────────────────────────

function broadcastUserList(room) {
  const list = Object.values(connectedUsers)
    .filter(u => u.room === room)
    .map(({ username, color, joinedAt, lastActivity }) => ({
      username, color, joinedAt, idle: Date.now() - lastActivity > 5 * 60 * 1000,
    }));
  io.to(room).emit('user list', list);
}

function broadcastAllUserLists() {
  const rooms = new Set(Object.values(connectedUsers).map(u => u.room));
  rooms.forEach(r => broadcastUserList(r));
}

function broadcastTyping(room) {
  const ids = typingByRoom[room] ? [...typingByRoom[room]] : [];
  const names = ids.map((id) => connectedUsers[id]?.username).filter(Boolean);
  let text = '';
  if (names.length === 1) text = `${names[0]} is typing`;
  else if (names.length > 1) text = 'Multiple users are typing';
  io.to(room).emit('typing', { text });
}

function stopTypingForSocket(socket, room) {
  if (typingByRoom[room]) typingByRoom[room].delete(socket.id);
  clearTimeout(typingTimeouts[socket.id]);
  broadcastTyping(room);
}

// ─── Message History ──────────────────────────────────────────────────────────

async function saveMessage({ room, sender, recipient, type, text }) {
  await db.query('INSERT INTO messages (room, sender, recipient, type, text) VALUES ($1,$2,$3,$4,$5)', [room || null, sender, recipient || null, type, text]);
}

async function getHistory(room, username, limit = 50) {
  const result = await db.query(
    `SELECT sender, recipient, type, text, created_at FROM messages
     WHERE room = $1 OR (type = 'dm' AND (LOWER(sender) = LOWER($2) OR LOWER(recipient) = LOWER($2)))
     ORDER BY created_at DESC LIMIT $3`,
    [room, username, limit]
  );
  return result.rows.reverse();
}

async function enrichHistoryWithColors(rows) {
  const usernames = [...new Set(rows.map(r => r.sender))];
  if (!usernames.length) return rows;
  const result = await db.query(`SELECT username, color FROM users WHERE LOWER(username) = ANY($1)`, [usernames.map(u => u.toLowerCase())]);
  const colorMap = {};
  result.rows.forEach(r => { colorMap[r.username.toLowerCase()] = r.color; });
  return rows.map(r => ({ ...r, color: colorMap[r.sender.toLowerCase()] || '#000080' }));
}

function formatPollData(poll) {
  return { id: poll.id, question: poll.question, options: poll.options, votes: poll.votes, creator: poll.creator, endsAt: poll.ends_at, concluded: poll.concluded };
}

// ─── Poll Conclusion Job ──────────────────────────────────────────────────────

setInterval(async () => {
  try {
    const due = await db.query(`SELECT * FROM polls WHERE concluded = false AND ends_at <= NOW()`);
    for (const poll of due.rows) {
      const tally = {};
      poll.options.forEach(o => tally[o] = 0);
      Object.values(poll.votes || {}).forEach(v => { if (tally[v] !== undefined) tally[v]++; });
      const total = Object.values(tally).reduce((a, b) => a + b, 0);
      let msg;
      if (total === 0) {
        msg = `Poll "${poll.question}" ended with no votes.`;
      } else {
        const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
        const topCount = sorted[0][1];
        const tied = sorted.filter(([, v]) => v === topCount);
        msg = tied.length > 1
          ? `Poll "${poll.question}" ended in a tie between: ${tied.map(([k]) => `"${k}"`).join(', ')} (${topCount} vote${topCount !== 1 ? 's' : ''} each)`
          : `Poll "${poll.question}" — winner: "${sorted[0][0]}" with ${topCount} vote${topCount !== 1 ? 's' : ''} out of ${total}`;
      }
      await db.query(`UPDATE polls SET concluded = true WHERE id = $1`, [poll.id]);
      io.to(poll.room).emit('poll concluded', { pollId: poll.id, message: msg });
      io.to(poll.room).emit('system message', `🏆 ${msg}`);
    }
  } catch (err) { console.error('Poll conclusion error:', err); }
}, 15000);

setInterval(() => {
  const now = Date.now();
  for (const key in pendingDuels) { if (pendingDuels[key].expiresAt < now) delete pendingDuels[key]; }
}, 10000);

setInterval(() => { broadcastAllUserLists(); }, 30000);

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('join', async (token) => {
    const sessionUsername = consumeSocketToken(token);
    if (!sessionUsername) {
      socket.emit('system message', 'Authentication failed. Please refresh and log in again.');
      socket.disconnect(true);
      return;
    }

    const username = escapeHtml(sessionUsername.slice(0, 20));
    const key = username.toLowerCase();
    let color = '#000080';
    try {
      const r = await db.query('SELECT color FROM users WHERE LOWER(username) = LOWER($1)', [username]);
      color = r.rows[0]?.color || '#000080';
    } catch {}

    const existingId = userSocketMap[key];
    if (existingId && existingId !== socket.id) {
      const existingSocket = io.sockets.sockets.get(existingId);
      if (existingSocket) { existingSocket.emit('kicked', 'You were signed in from another device.'); existingSocket.disconnect(true); }
      const oldUser = connectedUsers[existingId];
      if (oldUser && typingByRoom[oldUser.room]) typingByRoom[oldUser.room].delete(existingId);
      delete connectedUsers[existingId]; delete rateLimits[existingId];
    }

    const defaultRoom = 'general';
    connectedUsers[socket.id] = { username, color, room: defaultRoom, joinedAt: Date.now(), lastActivity: Date.now() };
    userSocketMap[key] = socket.id;
    socket.join(defaultRoom);

    const roomsResult = await db.query('SELECT name FROM rooms ORDER BY id');
    socket.emit('rooms list', roomsResult.rows.map(r => r.name));

    const history = await getHistory(defaultRoom, username, 50);
    const historyWithColors = await enrichHistoryWithColors(history);
    socket.emit('history', historyWithColors);

    const pollsResult = await db.query('SELECT * FROM polls WHERE room = $1 ORDER BY created_at DESC LIMIT 20', [defaultRoom]);
    pollsResult.rows.reverse().forEach(poll => socket.emit('poll update', formatPollData(poll)));

    broadcastUserList(defaultRoom);
    io.to(defaultRoom).emit('system message', `${username} has joined #${defaultRoom}`);
  });

  socket.on('switch room', async (newRoom) => {
    const user = connectedUsers[socket.id];
    if (!user) return;
    const r = await db.query('SELECT name FROM rooms WHERE name = $1', [newRoom]);
    if (!r.rows.length) return;
    const oldRoom = user.room;
    stopTypingForSocket(socket, oldRoom);
    socket.leave(oldRoom);
    broadcastUserList(oldRoom);
    io.to(oldRoom).emit('system message', `${user.username} left #${oldRoom}`);
    user.room = newRoom;
    socket.join(newRoom);
    const history = await getHistory(newRoom, user.username, 50);
    const historyWithColors = await enrichHistoryWithColors(history);
    socket.emit('history', historyWithColors);
    const pollsResult = await db.query('SELECT * FROM polls WHERE room = $1 ORDER BY created_at DESC LIMIT 20', [newRoom]);
    pollsResult.rows.reverse().forEach(poll => socket.emit('poll update', formatPollData(poll)));
    broadcastUserList(newRoom);
    io.to(newRoom).emit('system message', `${user.username} joined #${newRoom}`);
    socket.emit('room changed', newRoom);
  });

  socket.on('chat message', async (msg) => {
    const user = connectedUsers[socket.id];
    if (!user) return;

    const now = Date.now();
    if (!rateLimits[socket.id] || now > rateLimits[socket.id].resetTime) rateLimits[socket.id] = { count: 0, resetTime: now + 3000 };
    rateLimits[socket.id].count++;
    if (rateLimits[socket.id].count > 5) { socket.emit('system message', 'Slow down! You are sending messages too fast.'); return; }

    if (typeof msg !== 'string') return;
    const raw = msg.trim().slice(0, 500);
    if (!raw) return;

    user.lastActivity = Date.now();
    const room = user.room;
    stopTypingForSocket(socket, room);

    if (raw.startsWith('/me ')) {
      const action = escapeHtml(raw.slice(4).trim());
      if (!action) return;
      await saveMessage({ room, sender: user.username, type: 'action', text: action });
      io.to(room).emit('chat message', { user: user.username, color: user.color, text: action, type: 'action' });
      return;
    }

    if (raw.startsWith('/msg ')) {
      const parts = raw.slice(5).split(' ');
      if (parts.length < 2) { socket.emit('system message', 'Usage: /msg username message'); return; }
      const targetName = parts[0];
      const dmText = escapeHtml(parts.slice(1).join(' '));
      const targetSocketId = userSocketMap[targetName.toLowerCase()];
      if (!targetSocketId) { socket.emit('system message', `User "${escapeHtml(targetName)}" is not online.`); return; }
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      const targetUser = connectedUsers[targetSocketId];
      if (!targetSocket || !targetUser) { socket.emit('system message', `User "${escapeHtml(targetName)}" is not online.`); return; }
      const dmData = { from: user.username, fromColor: user.color, to: targetUser.username, text: dmText, type: 'dm' };
      await saveMessage({ sender: user.username, recipient: targetUser.username, type: 'dm', text: dmText });
      socket.emit('dm', { ...dmData, self: true });
      targetSocket.emit('dm', { ...dmData, self: false });
      return;
    }

    if (raw.startsWith('/poll ')) {
      const rest = raw.slice(6).trim();
      const qMatch = rest.match(/^"([^"]+)"\s+(.+)$/);
      if (!qMatch) { socket.emit('system message', 'Usage: /poll "Question?" Option1 Option2 ...'); return; }
      const question = escapeHtml(qMatch[1].slice(0, 200));
      const options = qMatch[2].split(/\s+/).map(o => escapeHtml(o.slice(0, 50))).slice(0, 8);
      if (options.length < 2) { socket.emit('system message', 'Poll requires at least 2 options.'); return; }
      const result = await db.query(
        `INSERT INTO polls (room, question, options, votes, creator, ends_at) VALUES ($1,$2,$3,$4,$5, NOW() + INTERVAL '5 minutes') RETURNING *`,
        [room, question, JSON.stringify(options), JSON.stringify({}), user.username]
      );
      io.to(room).emit('poll update', formatPollData(result.rows[0]));
      io.to(room).emit('system message', `${user.username} started a poll: "${question}" — voting closes in 5 minutes`);
      return;
    }

    // ── /duel ──
    if (raw.startsWith('/duel ')) {
      const parts = raw.slice(6).trim().split(' ');
      if (parts.length < 2) { socket.emit('system message', 'Usage: /duel username amount'); return; }
      const targetName = parts[0].replace(/^@/, '');
      const amount = parseInt(parts[1], 10);
      if (!amount || amount < 1 || amount > 1000) { socket.emit('system message', 'Bet must be 1-1000 coins.'); return; }
      if (targetName.toLowerCase() === user.username.toLowerCase()) { socket.emit('system message', 'You cannot duel yourself.'); return; }
      const targetSocketId = userSocketMap[targetName.toLowerCase()];
      if (!targetSocketId) { socket.emit('system message', `User "${escapeHtml(targetName)}" is not online.`); return; }
      const challengerCoins = await getCoins(user.username);
      if (challengerCoins < amount) { socket.emit('system message', `You only have ${challengerCoins} coins.`); return; }
      const targetUser = connectedUsers[targetSocketId];
      pendingDuels[targetName.toLowerCase()] = { from: user.username, fromSocketId: socket.id, amount, expiresAt: Date.now() + 30000 };
      io.to(room).emit('system message', `🎲 ${user.username} challenges ${targetUser.username} to a coinflip for ${amount} coins! Type /accept or /decline (30s)`);
      return;
    }

    if (raw.trim() === '/accept') {
      const key = user.username.toLowerCase();
      const duel = pendingDuels[key];
      if (!duel) { socket.emit('system message', 'No pending duel.'); return; }
      if (duel.expiresAt < Date.now()) { delete pendingDuels[key]; socket.emit('system message', 'That duel has expired.'); return; }
      delete pendingDuels[key];
      const accepterBal = await deductCoins(user.username, duel.amount);
      if (accepterBal === false) { socket.emit('system message', `You don't have enough coins.`); return; }
      const challengerBal = await deductCoins(duel.from, duel.amount);
      if (challengerBal === false) {
        await addCoins(user.username, duel.amount);
        socket.emit('system message', `${duel.from} no longer has enough coins.`);
        return;
      }
      const winner = Math.random() < 0.5 ? user.username : duel.from;
      const loser  = winner === user.username ? duel.from : user.username;
      const prize  = duel.amount * 2;
      const winnerCoins = await addCoins(winner, prize);
      broadcastCoins(winner, winnerCoins);
      const loserCoins = await getCoins(loser);
      broadcastCoins(loser, loserCoins);
      io.to(room).emit('system message', `🎲 COINFLIP: ${winner} wins ${prize} coins from ${loser}! 🏆`);
      return;
    }

    if (raw.trim() === '/decline') {
      const key = user.username.toLowerCase();
      const duel = pendingDuels[key];
      if (!duel) { socket.emit('system message', 'No pending duel.'); return; }
      delete pendingDuels[key];
      io.to(room).emit('system message', `${user.username} declined the duel from ${duel.from}.`);
      return;
    }

    const sanitized = escapeHtml(raw);
    await saveMessage({ room, sender: user.username, type: 'chat', text: sanitized });
    io.to(room).emit('chat message', { user: user.username, color: user.color, text: sanitized, type: 'chat', timestamp: Date.now() });
    const url = extractUrl(raw);
    if (url) fetchLinkPreview(url).then((preview) => { if (preview) io.to(room).emit('link preview', { url, ...preview }); });
  });

  socket.on('poll vote', async ({ pollId, option }) => {
    const user = connectedUsers[socket.id];
    if (!user) return;
    try {
      const result = await db.query('SELECT * FROM polls WHERE id = $1 AND room = $2', [pollId, user.room]);
      const poll = result.rows[0];
      if (!poll || poll.concluded || !poll.options.includes(option)) return;
      const votes = poll.votes || {};
      votes[user.username] = option;
      await db.query('UPDATE polls SET votes = $1 WHERE id = $2', [JSON.stringify(votes), pollId]);
      io.to(user.room).emit('poll update', { ...formatPollData(poll), votes });
    } catch (err) { console.error('Poll vote error:', err); }
  });

  socket.on('typing start', () => {
    const user = connectedUsers[socket.id];
    if (!user) return;
    const room = user.room;
    if (!typingByRoom[room]) typingByRoom[room] = new Set();
    typingByRoom[room].add(socket.id);
    broadcastTyping(room);
    clearTimeout(typingTimeouts[socket.id]);
    typingTimeouts[socket.id] = setTimeout(() => {
      if (typingByRoom[room]) typingByRoom[room].delete(socket.id);
      broadcastTyping(room);
    }, 3000);
  });

  socket.on('typing stop', () => {
    const user = connectedUsers[socket.id];
    if (!user) return;
    stopTypingForSocket(socket, user.room);
  });

  socket.on('activity', () => {
    const user = connectedUsers[socket.id];
    if (user) { user.lastActivity = Date.now(); broadcastUserList(user.room); }
  });

  socket.on('disconnect', () => {
    const user = connectedUsers[socket.id];
    if (user) {
      const room = user.room;
      const key = user.username.toLowerCase();
      if (userSocketMap[key] === socket.id) delete userSocketMap[key];
      if (typingByRoom[room]) typingByRoom[room].delete(socket.id);
      clearTimeout(typingTimeouts[socket.id]);
      delete connectedUsers[socket.id]; delete rateLimits[socket.id];
      broadcastUserList(room); broadcastTyping(room);
      io.to(room).emit('system message', `${user.username} has left #${room}`);
    }
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`Server running on port ${PORT}`); });