const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcrypt");
const session = require("express-session");
const Database = require("better-sqlite3");
const path = require("path");

/* -------------------- APP SETUP -------------------- */

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/* -------------------- DATABASE -------------------- */

const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH + "/chat.db"
  : "chat.db";

const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

/* -------------------- MIDDLEWARE -------------------- */

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

/* -------------------- HELPERS -------------------- */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;

  const parts = [];
  if (d) parts.push(d + "D");
  if (h) parts.push(h + "H");
  if (m) parts.push(m + "M");
  if (sec || !parts.length) parts.push(sec + "S");
  return parts.join(" ");
}

/* -------------------- AUTH ROUTES -------------------- */

app.post("/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) return res.status(400).json({ error: "Missing fields" });

  const hash = await bcrypt.hash(password, 12);

  try {
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(username, hash);
    req.session.username = username;
    res.json({ ok: true, username });
  } catch {
    res.status(409).json({ error: "Username taken" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);

  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: "Invalid login" });

  req.session.username = username;
  res.json({ ok: true, username });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/me", (req, res) => {
  if (!req.session.username) return res.status(401).end();
  res.json({ username: req.session.username });
});

/* -------------------- SOCKET -------------------- */

const users = {}; // socket.id -> { username, joined }

io.on("connection", (socket) => {
  const username = socket.request.session.username;
  if (!username) return socket.disconnect();

  users[socket.id] = { username, joined: Date.now() };

  socket.emit("history", db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 50").all().reverse());

  io.emit("system", `${username} joined`);

  function broadcastUsers() {
    io.emit(
      "users",
      Object.values(users).map(u => ({
        username: u.username,
        online: formatDuration(Date.now() - u.joined)
      }))
    );
  }

  broadcastUsers();
  const interval = setInterval(broadcastUsers, 1000);

  socket.on("msg", text => {
    text = escapeHtml(text.trim().slice(0, 500));
    if (!text) return;

    db.prepare("INSERT INTO messages (username, text) VALUES (?, ?)").run(username, text);
    io.emit("msg", { username, text });
  });

  socket.on("disconnect", () => {
    clearInterval(interval);
    delete users[socket.id];
    io.emit("system", `${username} left`);
  });
});

/* -------------------- START -------------------- */

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("running", PORT));