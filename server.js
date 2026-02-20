const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const path = require('path');

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
  console.log('Database initialised');
}

initDb().catch((err) => {
  console.error('Failed to initialise database:', err);
  process.exit(1);
});

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
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
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required' });
  if (username.length < 3 || username.length > 20)
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(username))
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const hash = await bcrypt.hash(password, 12);
    await db.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [username, hash]);
    req.session.username = username;
    res.json({ ok: true, username });
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
    const result = await db.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    const user = result.rows[0];

    if (!user)
      return res.status(401).json({ error: 'Invalid username or password' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match)
      return res.status(401).json({ error: 'Invalid username or password' });

    req.session.username = user.username;
    res.json({ ok: true, username: user.username });
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

app.get('/me', (req, res) => {
  if (req.session.username) {
    res.json({ username: req.session.username });
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

// ─── Socket State ─────────────────────────────────────────────────────────────

// socket.id -> { username, joinedAt }
const connectedUsers = {};

// username lowercase -> socket.id
const userSocketMap = {};

// socket.id -> { count, resetTime }
const rateLimits = {};

// socket.id -> timeout handle
const typingTimeouts = {};

// Set of socket.ids currently typing
const typingUsers = new Set();

// ─── Broadcast Helpers ────────────────────────────────────────────────────────

function broadcastUserList() {
  const list = Object.values(connectedUsers).map(({ username, joinedAt }) => ({
    username,
    joinedAt,
  }));
  io.emit('user list', list);
}

function broadcastTyping() {
  const names = [...typingUsers]
    .map((id) => connectedUsers[id]?.username)
    .filter(Boolean);

  if (names.length === 0) {
    io.emit('typing', { text: '' });
  } else if (names.length === 1) {
    io.emit('typing', { text: `${names[0]} is typing` });
  } else {
    io.emit('typing', { text: 'Multiple users are typing' });
  }
}

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  // ── Join ──────────────────────────────────────────────────────────────────

  socket.on('join', (clientUsername) => {
    // Verify the username against the server session — client can't spoof it
    const sessionUsername = socket.request.session?.username;

    if (!sessionUsername) {
      socket.emit('kicked', 'Not authenticated. Please log in again.');
      socket.disconnect(true);
      return;
    }

    // Use the session username (authoritative), ignore what client sent
    const username = escapeHtml(sessionUsername.slice(0, 20));
    const key = username.toLowerCase();

    // Kick any existing session for this user
    const existingId = userSocketMap[key];
    if (existingId && existingId !== socket.id) {
      const existingSocket = io.sockets.sockets.get(existingId);
      if (existingSocket) {
        existingSocket.emit('kicked', 'You were signed in from another device.');
        existingSocket.disconnect(true);
      }
      delete connectedUsers[existingId];
      delete rateLimits[existingId];
      typingUsers.delete(existingId);
      clearTimeout(typingTimeouts[existingId]);
    }

    connectedUsers[socket.id] = { username, joinedAt: Date.now() };
    userSocketMap[key] = socket.id;

    broadcastUserList();
    io.emit('system message', `${username} has joined the chat`);
  });

  // ── Chat message ──────────────────────────────────────────────────────────

  socket.on('chat message', (msg) => {
    const user = connectedUsers[socket.id];
    if (!user) return;

    // Rate limiting: max 5 messages per 3 seconds
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
    const sanitized = escapeHtml(msg.trim().slice(0, 500));
    if (!sanitized) return;

    // Clear typing state when they send
    typingUsers.delete(socket.id);
    clearTimeout(typingTimeouts[socket.id]);
    broadcastTyping();

    io.emit('chat message', { user: user.username, text: sanitized });
  });

  // ── Typing ────────────────────────────────────────────────────────────────

  socket.on('typing start', () => {
    if (!connectedUsers[socket.id]) return;
    typingUsers.add(socket.id);
    broadcastTyping();
    clearTimeout(typingTimeouts[socket.id]);
    typingTimeouts[socket.id] = setTimeout(() => {
      typingUsers.delete(socket.id);
      broadcastTyping();
    }, 3000);
  });

  socket.on('typing stop', () => {
    typingUsers.delete(socket.id);
    clearTimeout(typingTimeouts[socket.id]);
    broadcastTyping();
  });

  // ── Disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    const user = connectedUsers[socket.id];
    if (user) {
      const key = user.username.toLowerCase();
      if (userSocketMap[key] === socket.id) {
        delete userSocketMap[key];
      }
      delete connectedUsers[socket.id];
      delete rateLimits[socket.id];
      typingUsers.delete(socket.id);
      clearTimeout(typingTimeouts[socket.id]);
      broadcastUserList();
      broadcastTyping();
      io.emit('system message', `${user.username} has left the chat`);
    }
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});