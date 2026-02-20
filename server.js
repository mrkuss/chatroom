const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');

const { db, initDb } = require('./lib/db');
const { initCoins } = require('./lib/coins');
const { initChat, userSocketMap } = require('./sockets/chat');
const { initPollJobs } = require('./sockets/pollJobs');
const { initClaimEvents } = require('./sockets/claimEvents');
const { initGambling, router: gamblingRouter } = require('./routes/gambling');

const authRouter     = require('./routes/auth');
const settingsRouter = require('./routes/settings');
const shopRouter     = require('./routes/shop');
const { router: socialRouter } = require('./routes/social');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);

app.use(session({
  store: new pgSession({ pool: db, tableName: 'session', pruneSessionInterval: 60 * 15 }),
  secret: process.env.SESSION_SECRET || 'change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

app.use(authRouter);
app.use(settingsRouter);
app.use(shopRouter);
app.use(gamblingRouter);
app.use(socialRouter);

async function start() {
  await initDb();
  initCoins(io, userSocketMap);
  initGambling(io);
  initChat(io);
  initPollJobs(io);
  initClaimEvents(io);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});