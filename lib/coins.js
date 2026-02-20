const { db } = require('./db');

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

// broadcastCoins needs the io + userSocketMap from the socket layer.
// We pass them in at init time so this module stays decoupled from socket.io.
let _io = null;
let _userSocketMap = null;

function initCoins(io, userSocketMap) {
  _io = io;
  _userSocketMap = userSocketMap;
}

function broadcastCoins(username, coins) {
  if (!_io || !_userSocketMap) return;
  const key = username.toLowerCase();
  const socketId = _userSocketMap[key];
  if (socketId) {
    const s = _io.sockets.sockets.get(socketId);
    if (s) s.emit('coins update', { coins });
  }
}

module.exports = { getCoins, addCoins, deductCoins, broadcastCoins, initCoins };