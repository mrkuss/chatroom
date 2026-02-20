const { db } = require('../lib/db');
const { escapeHtml, extractUrl } = require('../lib/utils');
const { consumeSocketToken } = require('../lib/socketAuth');
const { addCoins, deductCoins, getCoins, broadcastCoins } = require('../lib/coins');
const { fetchLinkPreview } = require('../lib/linkPreview');
const { broadcastGambling } = require('../routes/gambling');
const { handleClaim } = require('./claimEvents');

const connectedUsers  = {};
const userSocketMap   = {};
const rateLimits      = {};
const typingTimeouts  = {};
const typingByRoom    = {};
const pendingDuels    = {};
// Track when each user connected so we can add to time_online_seconds on disconnect
const sessionStartTimes = {};
// Track which private rooms a socket has been granted access to this session
const privateRoomAccess = {}; // socketId → Set of room names

// ─── Helpers ──────────────────────────────────────────────────────────────────
function broadcastUserList(io, room) {
  const list = Object.values(connectedUsers)
    .filter(u => u.room === room)
    .map(({ username, color, joinedAt, lastActivity }) => ({
      username, color, joinedAt, idle: Date.now() - lastActivity > 5 * 60 * 1000,
    }));
  io.to(room).emit('user list', list);
}

function broadcastAllUserLists(io) {
  const rooms = new Set(Object.values(connectedUsers).map(u => u.room));
  rooms.forEach(r => broadcastUserList(io, r));
}

function broadcastTyping(io, room) {
  const ids = typingByRoom[room] ? [...typingByRoom[room]] : [];
  const names = ids.map(id => connectedUsers[id]?.username).filter(Boolean);
  let text = '';
  if (names.length === 1) text = `${names[0]} is typing`;
  else if (names.length > 1) text = 'Multiple users are typing';
  io.to(room).emit('typing', { text });
}

function stopTypingForSocket(io, socket, room) {
  if (typingByRoom[room]) typingByRoom[room].delete(socket.id);
  clearTimeout(typingTimeouts[socket.id]);
  broadcastTyping(io, room);
}

async function addOnlineTime(username, socketId) {
  const start = sessionStartTimes[socketId];
  if (!start) return;
  const seconds = Math.floor((Date.now() - start) / 1000);
  if (seconds > 0) {
    await db.query(
      `UPDATE users SET time_online_seconds = time_online_seconds + $1 WHERE LOWER(username) = LOWER($2)`,
      [seconds, username]
    ).catch(() => {});
  }
  delete sessionStartTimes[socketId];
}

// ─── Message persistence & history ───────────────────────────────────────────
async function saveMessage({ room, sender, recipient, type, text, clientId }) {
  const r = await db.query(
    'INSERT INTO messages (room, sender, recipient, type, text, client_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [room || null, sender, recipient || null, type, text, clientId || null]
  );
  return r.rows[0].id;
}

async function getHistory(room, username, limit = 5) {
  const result = await db.query(
    `SELECT m.id, m.sender, m.recipient, m.type, m.text, m.created_at,
            COALESCE(
              json_object_agg(r.emoji, r.cnt) FILTER (WHERE r.emoji IS NOT NULL),
              '{}'
            ) as reactions
     FROM messages m
     LEFT JOIN (
       SELECT message_id, emoji, COUNT(*) as cnt
       FROM reactions GROUP BY message_id, emoji
     ) r ON r.message_id = m.id
     WHERE m.room = $1 OR (m.type = 'dm' AND (LOWER(m.sender) = LOWER($2) OR LOWER(m.recipient) = LOWER($2)))
     GROUP BY m.id
     ORDER BY m.created_at DESC LIMIT $3`,
    [room, username, limit]
  );
  return result.rows.reverse();
}

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

function formatPollData(poll) {
  return { id: poll.id, question: poll.question, options: poll.options, votes: poll.votes, creator: poll.creator, endsAt: poll.ends_at, concluded: poll.concluded };
}

async function getRoomsForUser(username) {
  // Public rooms + private rooms the user created or has accessed this session
  const r = await db.query('SELECT name, is_private, creator FROM rooms ORDER BY id');
  return r.rows;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function initChat(io) {
  setInterval(() => {
    const now = Date.now();
    for (const key in pendingDuels) {
      if (pendingDuels[key].expiresAt < now) delete pendingDuels[key];
    }
  }, 10000);

  setInterval(() => broadcastAllUserLists(io), 30000);

  io.on('connection', (socket) => {
    privateRoomAccess[socket.id] = new Set();

    // ── Join ────────────────────────────────────────────────────────────────
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
        if (existingSocket) {
          existingSocket.emit('kicked', 'You were signed in from another device.');
          existingSocket.disconnect(true);
        }
        const oldUser = connectedUsers[existingId];
        if (oldUser) {
          await addOnlineTime(oldUser.username, existingId);
          if (typingByRoom[oldUser.room]) typingByRoom[oldUser.room].delete(existingId);
        }
        delete connectedUsers[existingId];
        delete rateLimits[existingId];
        delete privateRoomAccess[existingId];
      }

      const defaultRoom = 'general';
      connectedUsers[socket.id] = { username, color, room: defaultRoom, joinedAt: Date.now(), lastActivity: Date.now() };
      userSocketMap[key] = socket.id;
      sessionStartTimes[socket.id] = Date.now();
      socket.join(defaultRoom);

      // Send rooms list (public + private rooms created by this user)
      await sendRoomsList(socket, username);

      const history = await getHistory(defaultRoom, username, 5);
      const historyWithColors = await enrichHistoryWithColors(history);
      socket.emit('history', historyWithColors);

      const pollsResult = await db.query('SELECT * FROM polls WHERE room = $1 ORDER BY created_at DESC LIMIT 20', [defaultRoom]);
      pollsResult.rows.reverse().forEach(poll => socket.emit('poll update', formatPollData(poll)));

      broadcastUserList(io, defaultRoom);
      io.to(defaultRoom).emit('system message', `${username} has joined #${defaultRoom}`);
    });

    async function sendRoomsList(socket, username) {
      const rooms = await db.query('SELECT name, is_private, creator FROM rooms ORDER BY id');
      // Show public rooms + private rooms this user created
      const visible = rooms.rows.filter(r =>
        !r.is_private ||
        r.creator?.toLowerCase() === username?.toLowerCase() ||
        privateRoomAccess[socket.id]?.has(r.name)
      );
      socket.emit('rooms list', visible.map(r => ({ name: r.name, isPrivate: r.is_private, isOwner: r.creator?.toLowerCase() === username?.toLowerCase() })));
    }

    // ── Switch room ─────────────────────────────────────────────────────────
    socket.on('switch room', async ({ room: newRoom, password }) => {
      const user = connectedUsers[socket.id];
      if (!user) return;

      const r = await db.query('SELECT name, is_private, password_hash FROM rooms WHERE name = $1', [newRoom]);
      if (!r.rows.length) { socket.emit('system message', 'Room not found.'); return; }

      const roomRow = r.rows[0];

      // Check private room access
      if (roomRow.is_private && !privateRoomAccess[socket.id].has(newRoom)) {
        if (!password) { socket.emit('room requires password', newRoom); return; }
        const match = await require('bcrypt').compare(password, roomRow.password_hash);
        if (!match) { socket.emit('system message', 'Wrong password for that room.'); return; }
        privateRoomAccess[socket.id].add(newRoom);
        await sendRoomsList(socket, user.username);
      }

      const oldRoom = user.room;
      stopTypingForSocket(io, socket, oldRoom);
      socket.leave(oldRoom);
      broadcastUserList(io, oldRoom);
      io.to(oldRoom).emit('system message', `${user.username} left #${oldRoom}`);
      user.room = newRoom;
      socket.join(newRoom);
      const history = await getHistory(newRoom, user.username, 5);
      const historyWithColors = await enrichHistoryWithColors(history);
      socket.emit('history', historyWithColors);
      const pollsResult = await db.query('SELECT * FROM polls WHERE room = $1 ORDER BY created_at DESC LIMIT 20', [newRoom]);
      pollsResult.rows.reverse().forEach(poll => socket.emit('poll update', formatPollData(poll)));
      broadcastUserList(io, newRoom);
      io.to(newRoom).emit('system message', `${user.username} joined #${newRoom}`);
      socket.emit('room changed', newRoom);
    });

    // ── Chat message ────────────────────────────────────────────────────────
    socket.on('chat message', async (msg) => {
      const user = connectedUsers[socket.id];
      if (!user) return;

      const now = Date.now();
      const rl = rateLimits[socket.id];
      if (rl && rl.lockedUntil && now < rl.lockedUntil) {
        const secsLeft = Math.ceil((rl.lockedUntil - now) / 1000);
        socket.emit('system message', `You are muted for spamming. Try again in ${secsLeft}s.`);
        return;
      }
      if (!rl || now > rl.resetTime) rateLimits[socket.id] = { count: 0, resetTime: now + 10000 };
      rateLimits[socket.id].count++;
      if (rateLimits[socket.id].count >= 5) {
        rateLimits[socket.id].lockedUntil = now + 10000;
        socket.emit('system message', 'You have been muted for 10 seconds for sending too many messages.');
        return;
      }

      if (typeof msg !== 'string') return;
      const raw = msg.trim().slice(0, 500);
      if (!raw) return;

      user.lastActivity = Date.now();
      const room = user.room;
      stopTypingForSocket(io, socket, room);

      // ── claim ──────────────────────────────────────────────────────────────
      if (raw.toLowerCase() === 'claim') {
        const won = await handleClaim(io, user.username);
        if (!won) socket.emit('system message', 'There is no active claim event right now.');
        return;
      }

      // ── /me ───────────────────────────────────────────────────────────────
      if (raw.startsWith('/me ')) {
        const action = escapeHtml(raw.slice(4).trim());
        if (!action) return;
        await saveMessage({ room, sender: user.username, type: 'action', text: action });
        io.to(room).emit('chat message', { user: user.username, color: user.color, text: action, type: 'action' });
        return;
      }

      // ── /msg (DM) ─────────────────────────────────────────────────────────
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

      // ── /poll ─────────────────────────────────────────────────────────────
      if (raw.startsWith('/poll ')) {
        const rest = raw.slice(6).trim();
        const qMatch = rest.match(/^"([^"]+)"\s+(.+)$/);
        if (!qMatch) { socket.emit('system message', 'Usage: /poll "Question?" Option1 Option2 ...'); return; }
        const question = escapeHtml(qMatch[1].slice(0, 200));
        const options = qMatch[2].split(/\s+/).map(o => escapeHtml(o.slice(0, 50))).slice(0, 8);
        if (options.length < 2) { socket.emit('system message', 'Poll requires at least 2 options.'); return; }
        const result = await db.query(
          `INSERT INTO polls (room, question, options, votes, creator, ends_at)
           VALUES ($1,$2,$3,$4,$5, NOW() + INTERVAL '5 minutes') RETURNING *`,
          [room, question, JSON.stringify(options), JSON.stringify({}), user.username]
        );
        io.to(room).emit('poll update', formatPollData(result.rows[0]));
        io.to(room).emit('system message', `${user.username} started a poll: "${question}" — voting closes in 5 minutes`);
        return;
      }

      // ── /create (private room) ─────────────────────────────────────────────
      if (raw.startsWith('/create ')) {
        const parts = raw.slice(8).trim().split(' ');
        if (parts.length < 2) { socket.emit('system message', 'Usage: /create roomname password'); return; }
        const roomName = parts[0].toLowerCase();
        const roomPassword = parts.slice(1).join(' ');
        try {
          const res = await fetch(`http://localhost:${process.env.PORT || 3000}/rooms/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': `connect.sid=ignored` },
          });
        } catch {}
        // Call the logic directly instead of HTTP
        const bcrypt = require('bcrypt');
        if (!/^[a-zA-Z0-9_-]+$/.test(roomName) || roomName.length < 2 || roomName.length > 20) {
          socket.emit('system message', 'Room name: 2-20 chars, letters/numbers/dash/underscore only'); return;
        }
        if (roomPassword.length < 3) { socket.emit('system message', 'Password must be at least 3 characters.'); return; }
        const owned = await db.query(
          `SELECT COUNT(*) FROM rooms WHERE LOWER(creator) = LOWER($1) AND is_private = true`,
          [user.username]
        );
        if (parseInt(owned.rows[0].count, 10) >= 3) {
          socket.emit('system message', 'You can only have 3 private rooms at once.'); return;
        }
        try {
          const hash = await bcrypt.hash(roomPassword, 10);
          await db.query(
            `INSERT INTO rooms (name, is_private, password_hash, creator) VALUES ($1, true, $2, $3)`,
            [roomName, hash, user.username]
          );
          privateRoomAccess[socket.id].add(roomName);
          await sendRoomsList(socket, user.username);
          socket.emit('system message', `🔒 Private room #${roomName} created! Share the password with friends.`);
        } catch (err) {
          if (err.code === '23505') socket.emit('system message', 'A room with that name already exists.');
          else socket.emit('system message', 'Error creating room.');
        }
        return;
      }

      // ── /deleteroom ────────────────────────────────────────────────────────
      if (raw.startsWith('/deleteroom ')) {
        const roomName = raw.slice(12).trim().toLowerCase();
        const r = await db.query(`SELECT creator FROM rooms WHERE name = $1 AND is_private = true`, [roomName]);
        if (!r.rows.length) { socket.emit('system message', 'Private room not found.'); return; }
        if (r.rows[0].creator.toLowerCase() !== user.username.toLowerCase()) {
          socket.emit('system message', 'Only the creator can delete this room.'); return;
        }
        await db.query(`DELETE FROM rooms WHERE name = $1`, [roomName]);
        // Kick anyone in that room back to general
        Object.entries(connectedUsers).forEach(([sid, u]) => {
          if (u.room === roomName) {
            const s = io.sockets.sockets.get(sid);
            if (s) {
              u.room = 'general';
              s.leave(roomName);
              s.join('general');
              s.emit('room changed', 'general');
              s.emit('system message', `The room #${roomName} was deleted.`);
            }
          }
        });
        await sendRoomsList(socket, user.username);
        socket.emit('system message', `🗑️ Room #${roomName} deleted.`);
        return;
      }

      // ── /duel ─────────────────────────────────────────────────────────────
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
        await broadcastGambling(`🎲 COINFLIP: ${winner} beat ${loser} for ${prize} coins!`);
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

      // ── /give ─────────────────────────────────────────────────────────────
      if (raw.startsWith('/give ')) {
        const parts = raw.slice(6).trim().split(/\s+/);
        if (parts.length < 2) { socket.emit('system message', 'Usage: /give username amount'); return; }
        const targetName = parts[0].replace(/^@/, '');
        const amount = parseInt(parts[1], 10);
        if (!amount || amount < 1 || amount > 10000) { socket.emit('system message', 'Amount must be between 1 and 10,000 coins.'); return; }
        if (targetName.toLowerCase() === user.username.toLowerCase()) { socket.emit('system message', 'You cannot give coins to yourself.'); return; }
        const targetResult = await db.query('SELECT username FROM users WHERE LOWER(username) = LOWER($1)', [targetName]);
        if (!targetResult.rows.length) { socket.emit('system message', `User "${escapeHtml(targetName)}" does not exist.`); return; }
        const targetUsername = targetResult.rows[0].username;
        const newSenderBal = await deductCoins(user.username, amount);
        if (newSenderBal === false) {
          const senderCoins = await getCoins(user.username);
          socket.emit('system message', `You only have ${senderCoins} coins.`);
          return;
        }
        const newTargetBal = await addCoins(targetUsername, amount);
        broadcastCoins(user.username, newSenderBal);
        broadcastCoins(targetUsername, newTargetBal);
        io.to(room).emit('system message', `💸 ${user.username} gave ${amount} coins to ${targetUsername}!`);
        return;
      }

      // ── Regular chat ───────────────────────────────────────────────────────
      const sanitized = escapeHtml(raw);
      const clientId = `${user.username}-${Date.now()}`;
      const messageId = await saveMessage({ room, sender: user.username, type: 'chat', text: sanitized, clientId });

      // Increment message count
      db.query(`UPDATE users SET messages_sent = messages_sent + 1 WHERE LOWER(username) = LOWER($1)`, [user.username]).catch(() => {});

      io.to(room).emit('chat message', { id: messageId, user: user.username, color: user.color, text: sanitized, type: 'chat', timestamp: Date.now() });
      addCoins(user.username, 1).then(newBal => broadcastCoins(user.username, newBal)).catch(() => {});
      const url = extractUrl(raw);
      if (url) fetchLinkPreview(url).then(preview => { if (preview) io.to(room).emit('link preview', { url, ...preview }); });
    });

    // ── Reaction ─────────────────────────────────────────────────────────────
    socket.on('react', async ({ messageId, emoji }) => {
      const user = connectedUsers[socket.id];
      if (!user) return;
      const allowed = ['👍', '❤️', '😂', '😮'];
      if (!allowed.includes(emoji)) return;
      try {
        await db.query(
          `INSERT INTO reactions (message_id, username, emoji)
           VALUES ($1, $2, $3)
           ON CONFLICT (message_id, username) DO UPDATE SET emoji = $3`,
          [messageId, user.username, emoji]
        );
        // Get updated counts
        const r = await db.query(
          `SELECT emoji, COUNT(*) as count FROM reactions WHERE message_id = $1 GROUP BY emoji`,
          [messageId]
        );
        const reactions = {};
        r.rows.forEach(row => { reactions[row.emoji] = parseInt(row.count, 10); });
        // Broadcast to room
        io.to(user.room).emit('reaction update', { messageId, reactions });
      } catch (err) { console.error('React error:', err); }
    });

    socket.on('unreact', async ({ messageId }) => {
      const user = connectedUsers[socket.id];
      if (!user) return;
      try {
        await db.query(`DELETE FROM reactions WHERE message_id = $1 AND LOWER(username) = LOWER($2)`, [messageId, user.username]);
        const r = await db.query(
          `SELECT emoji, COUNT(*) as count FROM reactions WHERE message_id = $1 GROUP BY emoji`,
          [messageId]
        );
        const reactions = {};
        r.rows.forEach(row => { reactions[row.emoji] = parseInt(row.count, 10); });
        io.to(user.room).emit('reaction update', { messageId, reactions });
      } catch (err) { console.error('Unreact error:', err); }
    });

    // ── Poll vote ────────────────────────────────────────────────────────────
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

    // ── Typing ───────────────────────────────────────────────────────────────
    socket.on('typing start', () => {
      const user = connectedUsers[socket.id];
      if (!user) return;
      const room = user.room;
      if (!typingByRoom[room]) typingByRoom[room] = new Set();
      typingByRoom[room].add(socket.id);
      broadcastTyping(io, room);
      clearTimeout(typingTimeouts[socket.id]);
      typingTimeouts[socket.id] = setTimeout(() => {
        if (typingByRoom[room]) typingByRoom[room].delete(socket.id);
        broadcastTyping(io, room);
      }, 3000);
    });

    socket.on('typing stop', () => {
      const user = connectedUsers[socket.id];
      if (!user) return;
      stopTypingForSocket(io, socket, user.room);
    });

    socket.on('activity', () => {
      const user = connectedUsers[socket.id];
      if (user) { user.lastActivity = Date.now(); broadcastUserList(io, user.room); }
    });

    // ── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      const user = connectedUsers[socket.id];
      if (user) {
        const room = user.room;
        const key = user.username.toLowerCase();
        if (userSocketMap[key] === socket.id) delete userSocketMap[key];
        if (typingByRoom[room]) typingByRoom[room].delete(socket.id);
        clearTimeout(typingTimeouts[socket.id]);
        await addOnlineTime(user.username, socket.id);
        delete connectedUsers[socket.id];
        delete rateLimits[socket.id];
        delete privateRoomAccess[socket.id];
        broadcastUserList(io, room);
        broadcastTyping(io, room);
        io.to(room).emit('system message', `${user.username} has left #${room}`);
      }
    });
  });
}

module.exports = { initChat, connectedUsers, userSocketMap };