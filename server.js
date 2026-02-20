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

  // Rooms table
  await db.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Seed default rooms
  await db.query(`
    INSERT INTO rooms (name) VALUES ('general'), ('random')
    ON CONFLICT (name) DO NOTHING
  `);

  // Messages table (with room + DM support)
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

  // Polls table
  await db.query(`
    CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY,
      room TEXT NOT NULL,
      question TEXT NOT NULL,
      options JSONB NOT NULL,
      votes JSONB NOT NULL DEFAULT '{}',
      creator TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add color column if upgrading from old schema
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#000080'`);

  console.log('Database initialised');
}

initDb().catch((err) => {
  console.error('Failed to initialise database:', err);
  process.exit(1);
});

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({
    pool: db,
    tableName: 'session',
    pruneSessionInterval: 60 * 15,
  }),
  secret: process.env.SESSION_SECRET || 'change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
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
  for (const token in socketTokens) {
    if (socketTokens[token].expires < now) delete socketTokens[token];
  }
}, 60000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Valid username colours (curated, readable on white & dark bg)
const VALID_COLORS = [
  '#000080','#800000','#008000','#800080','#008080',
  '#0000cc','#cc0000','#007700','#aa00aa','#007777',
  '#cc6600','#006699','#990000','#009900','#660099',
];

// ─── Link Preview (server-side OG fetch) ──────────────────────────────────────

const previewCache = new Map(); // url -> { title, image, description, fetched }

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
        res.on('data', (chunk) => { body += chunk; if (body.length > 50000) { req.destroy(); } });
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
          if (result.title || result.description) {
            previewCache.set(rawUrl, result);
            resolve(result);
          } else {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

// Extract first URL from a string
function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0] : null;
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.post('/register', async (req, res) => {
  const { username, password, color } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required' });
  if (username.length < 3 || username.length > 20)
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(username))
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const safeColor = VALID_COLORS.includes(color) ? color : '#000080';

  try {
    const hash = await bcrypt.hash(password, 12);
    await db.query('INSERT INTO users (username, password_hash, color) VALUES ($1, $2, $3)', [username, hash, safeColor]);
    req.session.username = username;
    const token = createSocketToken(username);
    res.json({ ok: true, username, color: safeColor, token });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'Username already taken' });
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required' });

  try {
    const result = await db.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid username or password' });

    req.session.username = user.username;
    const token = createSocketToken(user.username);
    res.json({ ok: true, username: user.username, color: user.color || '#000080', token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Logout error:', err);
    res.json({ ok: true });
  });
});

app.get('/me', async (req, res) => {
  if (req.session.username) {
    const result = await db.query('SELECT color FROM users WHERE LOWER(username) = LOWER($1)', [req.session.username]);
    const color = result.rows[0]?.color || '#000080';
    const token = createSocketToken(req.session.username);
    res.json({ username: req.session.username, color, token });
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

// Rooms list
app.get('/rooms', async (req, res) => {
  const result = await db.query('SELECT name FROM rooms ORDER BY id');
  res.json(result.rows.map(r => r.name));
});

// ─── Socket State ─────────────────────────────────────────────────────────────

const connectedUsers  = {};   // socket.id -> { username, color, room, joinedAt, lastActivity }
const userSocketMap   = {};   // username lowercase -> socket.id
const rateLimits      = {};   // socket.id -> { count, resetTime }
const typingTimeouts  = {};   // socket.id -> timeout handle
const typingByRoom    = {};   // room -> Set of socket.ids

// ─── Broadcast Helpers ────────────────────────────────────────────────────────

function broadcastUserList(room) {
  const list = Object.values(connectedUsers)
    .filter(u => u.room === room)
    .map(({ username, color, joinedAt, lastActivity }) => ({
      username, color, joinedAt,
      idle: Date.now() - lastActivity > 5 * 60 * 1000,
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
  await db.query(
    'INSERT INTO messages (room, sender, recipient, type, text) VALUES ($1,$2,$3,$4,$5)',
    [room || null, sender, recipient || null, type, text]
  );
}

async function getHistory(room, username, limit = 50) {
  const result = await db.query(
    `SELECT sender, recipient, type, text, created_at
     FROM messages
     WHERE room = $1
        OR (type = 'dm' AND (LOWER(sender) = LOWER($2) OR LOWER(recipient) = LOWER($2)))
     ORDER BY created_at DESC LIMIT $3`,
    [room, username, limit]
  );
  return result.rows.reverse();
}

// ─── Poll Helpers ─────────────────────────────────────────────────────────────

function formatPollData(poll) {
  return {
    id: poll.id,
    question: poll.question,
    options: poll.options,
    votes: poll.votes,
    creator: poll.creator,
  };
}

// ─── Socket.io ────────────────────────────────────────────────────────────────

// Idle checker - broadcasts updated user lists every 30s to reflect idle changes
setInterval(() => {
  broadcastAllUserLists();
}, 30000);

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

    // Fetch user color
    let color = '#000080';
    try {
      const r = await db.query('SELECT color FROM users WHERE LOWER(username) = LOWER($1)', [username]);
      color = r.rows[0]?.color || '#000080';
    } catch {}

    // Kick existing socket for this user
    const existingId = userSocketMap[key];
    if (existingId && existingId !== socket.id) {
      const existingSocket = io.sockets.sockets.get(existingId);
      if (existingSocket) {
        existingSocket.emit('kicked', 'You were signed in from another device.');
        existingSocket.disconnect(true);
      }
      const oldUser = connectedUsers[existingId];
      if (oldUser) {
        if (typingByRoom[oldUser.room]) typingByRoom[oldUser.room].delete(existingId);
      }
      delete connectedUsers[existingId];
      delete rateLimits[existingId];
    }

    const defaultRoom = 'general';
    connectedUsers[socket.id] = { username, color, room: defaultRoom, joinedAt: Date.now(), lastActivity: Date.now() };
    userSocketMap[key] = socket.id;

    socket.join(defaultRoom);

    // Send rooms list
    const roomsResult = await db.query('SELECT name FROM rooms ORDER BY id');
    socket.emit('rooms list', roomsResult.rows.map(r => r.name));

    // Send active polls in the room
    const pollsResult = await db.query('SELECT * FROM polls WHERE room = $1', [defaultRoom]);
    pollsResult.rows.forEach(poll => socket.emit('poll update', formatPollData(poll)));

    // Send history
    const history = await getHistory(defaultRoom, username, 50);
    const historyWithColors = await enrichHistoryWithColors(history);
    socket.emit('history', historyWithColors);

    broadcastUserList(defaultRoom);
    io.to(defaultRoom).emit('system message', `${username} has joined #${defaultRoom}`);
  });

  socket.on('switch room', async (newRoom) => {
    const user = connectedUsers[socket.id];
    if (!user) return;

    // Validate room exists
    const r = await db.query('SELECT name FROM rooms WHERE name = $1', [newRoom]);
    if (!r.rows.length) return;

    const oldRoom = user.room;
    stopTypingForSocket(socket, oldRoom);
    socket.leave(oldRoom);
    broadcastUserList(oldRoom);
    io.to(oldRoom).emit('system message', `${user.username} left #${oldRoom}`);

    user.room = newRoom;
    socket.join(newRoom);

    // Send polls for new room
    const pollsResult = await db.query('SELECT * FROM polls WHERE room = $1', [newRoom]);
    pollsResult.rows.forEach(poll => socket.emit('poll update', formatPollData(poll)));

    // Send history
    const history = await getHistory(newRoom, user.username, 50);
    const historyWithColors = await enrichHistoryWithColors(history);
    socket.emit('history', historyWithColors);

    broadcastUserList(newRoom);
    io.to(newRoom).emit('system message', `${user.username} joined #${newRoom}`);
    socket.emit('room changed', newRoom);
  });

  socket.on('chat message', async (msg) => {
    const user = connectedUsers[socket.id];
    if (!user) return;

    // Rate limit
    const now = Date.now();
    if (!rateLimits[socket.id] || now > rateLimits[socket.id].resetTime) {
      rateLimits[socket.id] = { count: 0, resetTime: now + 3000 };
    }
    rateLimits[socket.id].count++;
    if (rateLimits[socket.id].count > 5) {
      socket.emit('system message', 'Slow down! You are sending messages too fast.');
      return;
    }

    if (typeof msg !== 'string') return;
    const raw = msg.trim().slice(0, 500);
    if (!raw) return;

    user.lastActivity = Date.now();
    const room = user.room;
    stopTypingForSocket(socket, room);

    // ── /me command ──
    if (raw.startsWith('/me ')) {
      const action = escapeHtml(raw.slice(4).trim());
      if (!action) return;
      await saveMessage({ room, sender: user.username, type: 'action', text: action });
      io.to(room).emit('chat message', { user: user.username, color: user.color, text: action, type: 'action' });
      return;
    }

    // ── /msg DM command ──
    if (raw.startsWith('/msg ')) {
      const parts = raw.slice(5).split(' ');
      if (parts.length < 2) {
        socket.emit('system message', 'Usage: /msg username message');
        return;
      }
      const targetName = parts[0];
      const dmText = escapeHtml(parts.slice(1).join(' '));
      const targetKey = targetName.toLowerCase();
      const targetSocketId = userSocketMap[targetKey];

      if (!targetSocketId) {
        socket.emit('system message', `User "${escapeHtml(targetName)}" is not online.`);
        return;
      }
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      const targetUser = connectedUsers[targetSocketId];
      if (!targetSocket || !targetUser) {
        socket.emit('system message', `User "${escapeHtml(targetName)}" is not online.`);
        return;
      }

      // Save & send DM
      const dmData = {
        from: user.username,
        fromColor: user.color,
        to: targetUser.username,
        text: dmText,
        type: 'dm',
      };
      await saveMessage({ sender: user.username, recipient: targetUser.username, type: 'dm', text: dmText });
      socket.emit('dm', { ...dmData, self: true });
      targetSocket.emit('dm', { ...dmData, self: false });
      return;
    }

    // ── /poll command ──
    // Usage: /poll "Question?" Option1 Option2 Option3
    if (raw.startsWith('/poll ')) {
      const rest = raw.slice(6).trim();
      const qMatch = rest.match(/^"([^"]+)"\s+(.+)$/);
      if (!qMatch) {
        socket.emit('system message', 'Usage: /poll "Question?" Option1 Option2 ...');
        return;
      }
      const question = escapeHtml(qMatch[1].slice(0, 200));
      const options = qMatch[2].split(/\s+/).map(o => escapeHtml(o.slice(0, 50))).slice(0, 8);
      if (options.length < 2) {
        socket.emit('system message', 'Poll requires at least 2 options.');
        return;
      }

      const result = await db.query(
        'INSERT INTO polls (room, question, options, votes, creator) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [room, question, JSON.stringify(options), JSON.stringify({}), user.username]
      );
      const poll = result.rows[0];
      io.to(room).emit('poll update', formatPollData(poll));
      io.to(room).emit('system message', `${user.username} started a poll: "${question}"`);
      return;
    }

    // ── Regular message ──
    const sanitized = escapeHtml(raw);
    await saveMessage({ room, sender: user.username, type: 'chat', text: sanitized });

    const msgData = {
      user: user.username,
      color: user.color,
      text: sanitized,
      type: 'chat',
      timestamp: Date.now(),
    };
    io.to(room).emit('chat message', msgData);

    // Link preview (async, don't block)
    const url = extractUrl(raw);
    if (url) {
      fetchLinkPreview(url).then((preview) => {
        if (preview) {
          io.to(room).emit('link preview', { url, ...preview });
        }
      });
    }
  });

  socket.on('poll vote', async ({ pollId, option }) => {
    const user = connectedUsers[socket.id];
    if (!user) return;

    try {
      const result = await db.query('SELECT * FROM polls WHERE id = $1 AND room = $2', [pollId, user.room]);
      const poll = result.rows[0];
      if (!poll) return;

      const options = poll.options;
      if (!options.includes(option)) return;

      const votes = poll.votes || {};
      votes[user.username] = option; // one vote per user

      await db.query('UPDATE polls SET votes = $1 WHERE id = $2', [JSON.stringify(votes), pollId]);
      io.to(user.room).emit('poll update', { ...formatPollData(poll), votes });
    } catch (err) {
      console.error('Poll vote error:', err);
    }
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

  // Touch activity (for away tracking)
  socket.on('activity', () => {
    const user = connectedUsers[socket.id];
    if (user) {
      user.lastActivity = Date.now();
      broadcastUserList(user.room);
    }
  });

  socket.on('disconnect', () => {
    const user = connectedUsers[socket.id];
    if (user) {
      const room = user.room;
      const key = user.username.toLowerCase();
      if (userSocketMap[key] === socket.id) delete userSocketMap[key];
      if (typingByRoom[room]) typingByRoom[room].delete(socket.id);
      clearTimeout(typingTimeouts[socket.id]);
      delete connectedUsers[socket.id];
      delete rateLimits[socket.id];
      broadcastUserList(room);
      broadcastTyping(room);
      io.to(room).emit('system message', `${user.username} has left #${room}`);
    }
  });
});

// Helper to enrich history rows with user colors
async function enrichHistoryWithColors(rows) {
  const usernames = [...new Set(rows.map(r => r.sender))];
  if (!usernames.length) return rows;
  const result = await db.query(
    `SELECT username, color FROM users WHERE LOWER(username) = ANY($1)`,
    [usernames.map(u => u.toLowerCase())]
  );
  const colorMap = {};
  result.rows.forEach(r => { colorMap[r.username.toLowerCase()] = r.color; });
  return rows.map(r => ({ ...r, color: colorMap[r.sender.toLowerCase()] || '#000080' }));
}

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});