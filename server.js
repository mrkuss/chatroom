const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Database setup
const db = new Database('chat.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Helper: escape HTML to prevent XSS
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Auth routes
app.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    req.session.username = username;
    res.json({ ok: true, username });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  req.session.username = user.username;
  res.json({ ok: true, username: user.username });
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/me', (req, res) => {
  if (req.session.username) {
    res.json({ username: req.session.username });
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

// Socket.io
const connectedUsers = {}; // socket.id -> username
const rateLimits = {};     // socket.id -> { count, resetTime }

io.on('connection', (socket) => {

  socket.on('join', (username) => {
    // Basic validation
    if (!username || typeof username !== 'string') return;
    connectedUsers[socket.id] = escapeHtml(username.slice(0, 20));
    io.emit('user count', Object.keys(connectedUsers).length);
    io.emit('system message', `${connectedUsers[socket.id]} has joined the chat`);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});