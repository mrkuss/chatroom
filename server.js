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
  ssl: { rejectUnauthorized: false }, // Required for Railway
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

  // Table required by connect-pg-simple for persistent sessions
  await db.query(`
    CREATE TABLE IF NOT EXISTS session (
      sid TEXT NOT NULL COLLATE "default",
      sess JSON NOT NULL,
      expire TIMESTAMPTZ NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire)
  `);

  console.log('Database initialised');
}

initDb().catch((err) => {
  console.error('Failed to initialise database:', err);
  process.exit(1);
});

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    store: new pgSession({
      pool: db,
      tableName: 'session',
      pruneSessionInterval: 60 * 15, // Clean up expired sessions every 15 min
    }),
    secret: process.env.SESSION_SECRET || 'change-this-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function requireAuth(req, res, next) {
  if (!req.session.username) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  next();
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3–20 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res
      .status(400)
      .json({ error: 'Username can only contain letters, numbers, and underscores' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    await db.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
      [username, hash]
    );
    req.session.username = username;
    res.json({ ok: true, username });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already taken' });
    }
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const result = await db.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

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

// ─── Socket.io ────────────────────────────────────────────────────────────────

const connectedUsers = {}; // socket.id -> username
const rateLimits = {};     // socket.id -> { count, resetTime }

io.on('connection', (socket) => {

  socket.on('join', (username) => {
    if (!username || typeof username !== 'string') return;

    const sanitized = escapeHtml(username.slice(0, 20));
    connectedUsers[socket.id] = sanitized;

    io.emit('user count', Object.keys(connectedUsers).length);
    io.emit('system message', `${sanitized} has joined the chat`);
  });

  socket.on('chat message', (msg) => {
    const username = connectedUsers[socket.id];
    if (!username) return;

    // Rate limiting: max 5 messages per 3 seconds
    const now = Date.now();
    if (!rateLimits[socket.id] || now > rateLimits[socket.id].resetTime) {
      rateLimits[socket.id] = { count: 0, resetTime: now + 3000 };
    }
    rateLimits[socket.id].count++;

    if (rateLimits[socket.id].count > 5) {
      socket.emit('system message', 'You are sending messages too fast. Please slow down.');
      return;
    }

    if (typeof msg !== 'string') return;
    const sanitized = escapeHtml(msg.trim().slice(0, 500));
    if (!sanitized) return;

    io.emit('chat message', { user: username, text: sanitized });
  });

  socket.on('disconnect', () => {
    const username = connectedUsers[socket.id];
    if (username) {
      delete connectedUsers[socket.id];
      delete rateLimits[socket.id];
      io.emit('user count', Object.keys(connectedUsers).length);
      io.emit('system message', `${username} has left the chat`);
    }
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});