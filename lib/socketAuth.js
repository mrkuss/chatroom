const crypto = require('crypto');

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

// Prune expired tokens every minute
setInterval(() => {
  const now = Date.now();
  for (const token in socketTokens) {
    if (socketTokens[token].expires < now) delete socketTokens[token];
  }
}, 60000);

module.exports = { createSocketToken, consumeSocketToken };