const { db } = require('../lib/db');
const { escapeHtml, extractUrl, formatNumber } = require('../lib/utils');
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
const sessionStartTimes = {};

// privateRoomAccess is now ONLY an in-session cache; the source of truth is the DB.
// We populate it on join from the DB, and write to DB whenever access is granted.
const privateRoomAccess = {}; // socketId → Set of room names

// ─── DB helpers for persistent room access ────────────────────────────────────
async function loadRoomAccessFromDb(username) {
  const r = await db.query(
    `SELECT room_name FROM private_room_access WHERE LOWER(username) = LOWER($1)`,
    [username]
  );
  return new Set(r.rows.map(row => row.room_name));
}

async function grantRoomAccessDb(username, roomName) {
  await db.query(
    `INSERT INTO private_room_access (username, room_name)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [username, roomName]
  );
}

async function revokeRoomAccessDb(username, roomName) {
  await db.query(
    `DELETE FROM private_room_access WHERE LOWER(username) = LOWER($1) AND room_name = $2`,
    [username, roomName]
  );
}

// ─── DB helpers for bans ──────────────────────────────────────────────────────
async function banUserFromRoom(roomName, targetUsername, bannedBy) {
  await db.query(
    `INSERT INTO room_bans (room_name, banned_username, banned_by)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [roomName, targetUsername.toLowerCase(), bannedBy]
  );
  // Also revoke access
  await revokeRoomAccessDb(targetUsername, roomName);
}

async function isUserBanned(roomName, username) {
  const r = await db.query(
    `SELECT 1 FROM room_bans WHERE room_name = $1 AND banned_username = LOWER($2)`,
    [roomName, username]
  );
  return r.rows.length > 0;
}

async function unbanUserFromRoom(roomName, targetUsername) {
  await db.query(
    `DELETE FROM room_bans WHERE room_name = $1 AND banned_username = LOWER($2)`,
    [roomName, targetUsername]
  );
}

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

async function getHistory(room, username, limit = 30) {
  const result = await db.query(
    `SELECT combined.id, combined.sender, combined.recipient, combined.type,
            combined.text, combined.created_at, combined.reactions, combined.poll_data
     FROM (
       -- Regular messages with reactions
       SELECT m.id,
              m.sender,
              m.recipient,
              m.type,
              m.text,
              m.created_at,
              COALESCE(
                json_object_agg(r.emoji, r.cnt) FILTER (WHERE r.emoji IS NOT NULL),
                '{}'
              ) as reactions,
              NULL::json as poll_data
       FROM messages m
       LEFT JOIN (
         SELECT message_id, emoji, COUNT(*) as cnt
         FROM reactions GROUP BY message_id, emoji
       ) r ON r.message_id = m.id
       WHERE m.room = $1 OR (m.type = 'dm' AND (LOWER(m.sender) = LOWER($2) OR LOWER(m.recipient) = LOWER($2)))
       GROUP BY m.id

       UNION ALL

       -- Polls as inline history rows
       SELECT p.id,
              p.creator   AS sender,
              NULL        AS recipient,
              'poll'      AS type,
              p.question  AS text,
              p.created_at,
              '{}'::json  AS reactions,
              json_build_object(
                'id',        p.id,
                'question',  p.question,
                'options',   p.options,
                'votes',     p.votes,
                'creator',   p.creator,
                'endsAt',    p.ends_at,
                'concluded', p.concluded
              ) AS poll_data
       FROM polls p
       WHERE p.room = $1
     ) combined
     ORDER BY combined.created_at DESC
     LIMIT $3`,
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

// ─── Build rooms list for a user ──────────────────────────────────────────────
// Returns the rooms the user can see, including their code for rooms they own.
async function buildRoomsList(username, accessSet) {
  const rooms = await db.query('SELECT name, is_private, creator, owner_code FROM rooms ORDER BY id');

  const result = [];
  for (const r of rooms.rows) {
    const isOwner = r.creator?.toLowerCase() === username?.toLowerCase();
    const hasAccess = isOwner || !r.is_private || accessSet.has(r.name);
    if (!hasAccess) continue;

    const entry = {
      name: r.name,
      isPrivate: r.is_private,
      isOwner,
      // Only send the code to the owner; others get null
      ownerCode: isOwner ? (r.owner_code || null) : null,
    };

    result.push(entry);
  }
  return result;
}

async function sendRoomsList(socket, username, accessSet) {
  const list = await buildRoomsList(username, accessSet);
  socket.emit('rooms list', list);
}

// ─── Shared room switch logic ──────────────────────────────────────────────────
async function performRoomSwitch(io, socket, user, newRoom) {
  const oldRoom = user.room;
  stopTypingForSocket(io, socket, oldRoom);
  socket.leave(oldRoom);
  broadcastUserList(io, oldRoom);
  io.to(oldRoom).emit('system message', `${user.username} left #${oldRoom}`);
  user.room = newRoom;
  socket.join(newRoom);
  // Notify client that the room has changed first so it can clear UI
  socket.emit('room changed', newRoom);

  const roomInfo = await db.query('SELECT is_private FROM rooms WHERE name = $1', [newRoom]);
  const historyLimit = roomInfo.rows[0]?.is_private ? 1000 : 30;

  const history = await getHistory(newRoom, user.username, historyLimit);
  const historyWithColors = await enrichHistoryWithColors(history);
  socket.emit('history', historyWithColors);
  broadcastUserList(io, newRoom);
  io.to(newRoom).emit('system message', `${user.username} joined #${newRoom}`);
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

      // Kick any existing socket for this user
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

      // Load persistent room access from DB
      const dbAccess = await loadRoomAccessFromDb(username);
      privateRoomAccess[socket.id] = dbAccess;

      const defaultRoom = 'general';
      connectedUsers[socket.id] = { username, color, room: defaultRoom, joinedAt: Date.now(), lastActivity: Date.now() };
      userSocketMap[key] = socket.id;
      sessionStartTimes[socket.id] = Date.now();
      socket.join(defaultRoom);

      await sendRoomsList(socket, username, dbAccess);

      const history = await getHistory(defaultRoom, username, 30);
      const historyWithColors = await enrichHistoryWithColors(history);
      socket.emit('history', historyWithColors);

      broadcastUserList(io, defaultRoom);
      io.to(defaultRoom).emit('system message', `${username} has joined #${defaultRoom}`);
    });

    // ── Switch room ─────────────────────────────────────────────────────────
    socket.on('switch room', async ({ room: newRoom, code }) => {
      const user = connectedUsers[socket.id];
      if (!user) return;

      const r = await db.query('SELECT name, is_private, password_hash, creator FROM rooms WHERE name = $1', [newRoom]);
      if (!r.rows.length) { socket.emit('system message', 'Room not found.'); return; }

      const roomRow = r.rows[0];
      const isOwner = roomRow.creator?.toLowerCase() === user.username.toLowerCase();

      if (roomRow.is_private && !isOwner && !privateRoomAccess[socket.id].has(newRoom)) {
        // Check if the user is banned from this room
        const banned = await isUserBanned(newRoom, user.username);
        if (banned) {
          socket.emit('system message', `You are banned from #${newRoom}.`);
          return;
        }

        if (!code) { socket.emit('room requires code', newRoom); return; }
        const match = await require('bcrypt').compare(String(code), roomRow.password_hash);
        if (!match) { socket.emit('keypad error', 'Wrong code. Try again.'); return; }

        // Grant access persistently
        privateRoomAccess[socket.id].add(newRoom);
        await grantRoomAccessDb(user.username, newRoom);
        await sendRoomsList(socket, user.username, privateRoomAccess[socket.id]);
      }

      await performRoomSwitch(io, socket, user, newRoom);
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

      // ── /help (private help output) ─────────────────────────────────────────
      if (raw.trim() === '/help') {
        const helpLines = [
          'Commands (shown only to you):',
          '/me action — emote action',
          '/msg username message — private DM',
          '/poll "Question?" Option1 Option2 — create a 5-min poll',
          '/give username amount — give coins',
          '/duel username amount — challenge to coinflip',
          '/rob username percentage — attempt to steal coins (risky!)',
          '/accept — accept a duel',
          '/decline — decline a duel',
          '/create roomname code — create private room (digits only)',
          '/joinroom roomname — open keypad to join a private room',
          '/leaveroom — return to #general',
          '/kick username, /ban username, /unban username — room owner only',
          '/changepass newcode — room owner only (numeric code)',
          '/deleteroom roomname — private room owner only',
          'claim — claim an active reward event',
          "/help — show this message (private)"
        ];
        // Include admin commands only for admin user
        if (user.username && user.username.toLowerCase() === 'mce') {
          helpLines.push('/coins username amount — (admin) set target user coins to amount');
        }
        helpLines.forEach(l => socket.emit('system message', l));
        return;
      }

      // ── /me ───────────────────────────────────────────────────────────────
      if (raw.startsWith('/me ')) {
        const action = escapeHtml(raw.slice(4).trim());
        if (!action) return;
        await saveMessage({ room, sender: user.username, type: 'action', text: action });
        io.to(room).emit('chat message', { user: user.username, color: user.color, text: action, type: 'action' });
        // Notify clients about activity in this room (for unread badges)
        io.emit('room message', { room, user: user.username });
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

      // ── /create (private room with numeric code) ──────────────────────────
      if (raw.startsWith('/create ')) {
        const parts = raw.slice(8).trim().split(' ');
        if (parts.length < 2) { socket.emit('system message', 'Usage: /create roomname code  (code = digits only, 1-9 digits)'); return; }
        const roomName = parts[0].toLowerCase();
        const roomCode = parts[1].trim();

        if (!/^[a-zA-Z0-9_-]+$/.test(roomName) || roomName.length < 2 || roomName.length > 20) {
          socket.emit('system message', 'Room name: 2-20 chars, letters/numbers/dash/underscore only'); return;
        }
        if (!/^\d{1,9}$/.test(roomCode)) {
          socket.emit('system message', 'Code must be 1-9 digits (e.g. 4729). No letters or symbols.'); return;
        }

        const owned = await db.query(
          `SELECT COUNT(*) FROM rooms WHERE LOWER(creator) = LOWER($1) AND is_private = true`,
          [user.username]
        );
        if (parseInt(owned.rows[0].count, 10) >= 3) {
          socket.emit('system message', 'You can only have 3 private rooms at once.'); return;
        }

        try {
          const bcrypt = require('bcrypt');
          const hash = await bcrypt.hash(roomCode, 10);
          await db.query(
            `INSERT INTO rooms (name, is_private, password_hash, creator, owner_code) VALUES ($1, true, $2, $3, $4)`,
            [roomName, hash, user.username, roomCode]
          );
          // Grant owner access persistently
          privateRoomAccess[socket.id].add(roomName);
          await grantRoomAccessDb(user.username, roomName);
          await sendRoomsList(socket, user.username, privateRoomAccess[socket.id]);
          socket.emit('room created', { room: roomName, code: roomCode });
        } catch (err) {
          if (err.code === '23505') socket.emit('system message', `A room named "${roomName}" already exists. Choose a different name.`);
          else socket.emit('system message', 'Error creating room.');
        }
        return;
      }

      // ── /leaveroom ─────────────────────────────────────────────────────
      if (raw === '/leaveroom' || raw === '/leave') {
        if (user.room === 'general') { socket.emit('system message', 'You are already in #general.'); return; }
        await performRoomSwitch(io, socket, user, 'general');
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
        // Clean up access records and bans for this room
        await db.query(`DELETE FROM private_room_access WHERE room_name = $1`, [roomName]);
        await db.query(`DELETE FROM room_bans WHERE room_name = $1`, [roomName]);

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
          if (privateRoomAccess[sid]) privateRoomAccess[sid].delete(roomName);
        });
        await sendRoomsList(socket, user.username, privateRoomAccess[socket.id]);
        socket.emit('system message', `🗑️ Room #${roomName} deleted.`);
        return;
      }

      // ── /kick ─────────────────────────────────────────────────────────────
      if (raw.startsWith('/kick ')) {
        const targetName = raw.slice(6).trim().replace(/^@/, '');
        if (!targetName) { socket.emit('system message', 'Usage: /kick username'); return; }

        const roomRes = await db.query(
          `SELECT creator FROM rooms WHERE name = $1 AND is_private = true`, [room]
        );
        if (!roomRes.rows.length) { socket.emit('system message', 'You can only /kick in a private room.'); return; }
        if (roomRes.rows[0].creator.toLowerCase() !== user.username.toLowerCase()) {
          socket.emit('system message', 'Only the room owner can kick users.'); return;
        }
        if (targetName.toLowerCase() === user.username.toLowerCase()) {
          socket.emit('system message', 'You cannot kick yourself.'); return;
        }

        const targetSocketId = userSocketMap[targetName.toLowerCase()];
        if (!targetSocketId) { socket.emit('system message', `"${escapeHtml(targetName)}" is not online.`); return; }
        const targetUser = connectedUsers[targetSocketId];
        if (!targetUser || targetUser.room !== room) {
          socket.emit('system message', `"${escapeHtml(targetName)}" is not in this room.`); return;
        }

        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
          // Revoke access so they can't just rejoin
          privateRoomAccess[targetSocketId]?.delete(room);
          await revokeRoomAccessDb(targetUser.username, room);

          targetUser.room = 'general';
          targetSocket.leave(room);
          targetSocket.join('general');
          targetSocket.emit('room changed', 'general');
          targetSocket.emit('system message', `👢 You were kicked from #${room} by ${user.username}.`);
          await sendRoomsList(targetSocket, targetUser.username, privateRoomAccess[targetSocketId] || new Set());
        }
        io.to(room).emit('system message', `👢 ${targetName} was kicked from #${room}.`);
        broadcastUserList(io, room);
        broadcastUserList(io, 'general');
        return;
      }

      // ── /ban ──────────────────────────────────────────────────────────────
      if (raw.startsWith('/ban ')) {
        const targetName = raw.slice(5).trim().replace(/^@/, '');
        if (!targetName) { socket.emit('system message', 'Usage: /ban username'); return; }

        const roomRes = await db.query(
          `SELECT creator FROM rooms WHERE name = $1 AND is_private = true`, [room]
        );
        if (!roomRes.rows.length) { socket.emit('system message', 'You can only /ban in a private room.'); return; }
        if (roomRes.rows[0].creator.toLowerCase() !== user.username.toLowerCase()) {
          socket.emit('system message', 'Only the room owner can ban users.'); return;
        }
        if (targetName.toLowerCase() === user.username.toLowerCase()) {
          socket.emit('system message', 'You cannot ban yourself.'); return;
        }

        // Check if they even exist
        const targetDbRes = await db.query(`SELECT username FROM users WHERE LOWER(username) = LOWER($1)`, [targetName]);
        if (!targetDbRes.rows.length) {
          socket.emit('system message', `User "${escapeHtml(targetName)}" does not exist.`); return;
        }
        const realTargetName = targetDbRes.rows[0].username;

        // Persist the ban
        await banUserFromRoom(room, realTargetName, user.username);

        // If the target is currently online, kick them out too
        const targetSocketId = userSocketMap[realTargetName.toLowerCase()];
        if (targetSocketId) {
          const targetUser = connectedUsers[targetSocketId];
          const targetSocket = io.sockets.sockets.get(targetSocketId);
          if (targetSocket && targetUser && targetUser.room === room) {
            privateRoomAccess[targetSocketId]?.delete(room);
            targetUser.room = 'general';
            targetSocket.leave(room);
            targetSocket.join('general');
            targetSocket.emit('room changed', 'general');
            targetSocket.emit('system message', `🚫 You have been banned from #${room} by ${user.username}.`);
            await sendRoomsList(targetSocket, targetUser.username, privateRoomAccess[targetSocketId] || new Set());
          }
          // Revoke from their in-memory access even if not in the room currently
          privateRoomAccess[targetSocketId]?.delete(room);
        }

        io.to(room).emit('system message', `🚫 ${realTargetName} has been banned from #${room}.`);
        broadcastUserList(io, room);
        broadcastUserList(io, 'general');
        return;
      }

      // ── /unban ────────────────────────────────────────────────────────────
      if (raw.startsWith('/unban ')) {
        const targetName = raw.slice(7).trim().replace(/^@/, '');
        if (!targetName) { socket.emit('system message', 'Usage: /unban username'); return; }

        const roomRes = await db.query(
          `SELECT creator FROM rooms WHERE name = $1 AND is_private = true`, [room]
        );
        if (!roomRes.rows.length) { socket.emit('system message', 'You can only /unban in a private room.'); return; }
        if (roomRes.rows[0].creator.toLowerCase() !== user.username.toLowerCase()) {
          socket.emit('system message', 'Only the room owner can unban users.'); return;
        }

        await unbanUserFromRoom(room, targetName);
        socket.emit('system message', `✅ ${escapeHtml(targetName)} has been unbanned from #${room}. They can rejoin with the code.`);
        return;
      }

      // ── /changepass (owner only — client confirms first) ──────────────────
      if (raw.startsWith('/changepass ')) {
        const newCode = raw.slice(12).trim();
        if (!/^\d{1,9}$/.test(newCode)) {
          socket.emit('system message', 'New code must be 1-9 digits (numbers only).'); return;
        }
        const roomRes = await db.query(
          `SELECT creator FROM rooms WHERE name = $1 AND is_private = true`, [room]
        );
        if (!roomRes.rows.length) { socket.emit('system message', 'You can only /changepass in a private room.'); return; }
        if (roomRes.rows[0].creator.toLowerCase() !== user.username.toLowerCase()) {
          socket.emit('system message', 'Only the room owner can change the code.'); return;
        }
        socket.emit('confirm changepass', { room, newCode });
        return;
      }

      // ── /joinroom (triggers keypad) ───────────────────────────────────────
      if (raw.startsWith('/joinroom ')) {
        const roomName = raw.slice(10).trim().split(' ')[0].toLowerCase();
        const r = await db.query(
          `SELECT name FROM rooms WHERE name = $1 AND is_private = true`, [roomName]
        );
        if (!r.rows.length) { socket.emit('system message', `Private room "${escapeHtml(roomName)}" not found.`); return; }
        if (privateRoomAccess[socket.id].has(roomName)) {
          socket.emit('system message', `You already have access to #${roomName}. Click it in the sidebar.`); return;
        }
        socket.emit('room requires code', roomName);
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
        if (challengerCoins < amount) { socket.emit('system message', `You only have ${formatNumber(challengerCoins)} coins.`); return; }
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
        io.to(room).emit('system message', `🎲 COINFLIP: ${winner} wins ${formatNumber(prize)} coins from ${loser}! 🏆`);
        await broadcastGambling(`🎲 COINFLIP: ${winner} beat ${loser} for ${formatNumber(prize)} coins!`);
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
          socket.emit('system message', `You only have ${formatNumber(senderCoins)} coins.`);
          return;
        }
        const newTargetBal = await addCoins(targetUsername, amount);
        broadcastCoins(user.username, newSenderBal);
        broadcastCoins(targetUsername, newTargetBal);
        io.to(room).emit('system message', `💸 ${user.username} gave ${formatNumber(amount)} coins to ${targetUsername}!`);
        return;
      }

      // ── /rob (username) (percentage) ───────────────────────────────────────
      if (raw.startsWith('/rob ')) {
        const parts = raw.slice(5).trim().split(/\s+/);
        if (parts.length < 2) { socket.emit('system message', 'Usage: /rob username percentage'); return; }
        const targetName = parts[0].replace(/^@/, '');
        const percentage = parseInt(parts[1], 10);
        if (isNaN(percentage) || percentage < 1 || percentage > 100) { socket.emit('system message', 'Percentage must be 1-100.'); return; }
        if (targetName.toLowerCase() === user.username.toLowerCase()) { socket.emit('system message', 'You cannot rob yourself.'); return; }
        
        try {
          const targetRes = await db.query('SELECT username, coins FROM users WHERE LOWER(username) = LOWER($1)', [targetName]);
          if (!targetRes.rows.length) { socket.emit('system message', `User "${escapeHtml(targetName)}" not found.`); return; }
          const targetUser = targetRes.rows[0];
          const targetCoins = targetUser.coins;
          const robAmount = Math.max(1, Math.floor(targetCoins * percentage / 100));
          
          // Calculate success chance: 0.6 / (1 + (percentage / 10)^2)
          const successChance = 0.6 / (1 + Math.pow(percentage / 10, 2));
          const roll = Math.random();
          const success = roll < successChance;
          
          if (success) {
            // Rob succeeds: robber gains robAmount, victim loses robAmount
            const robberNewBal = await addCoins(user.username, robAmount);
            const victimNewBal = await deductCoins(targetUser.username, robAmount);
            broadcastCoins(user.username, robberNewBal);
            broadcastCoins(targetUser.username, victimNewBal);
            io.to(room).emit('system message', `🏴 ${user.username} robbed ${formatNumber(robAmount)} coins from ${targetUser.username}! 💰`);
          } else {
            // Rob fails: robber loses 2x the amount they tried to rob (doubled), victim gains it
            const penalty = robAmount * 2;
            const robberNewBal = await deductCoins(user.username, penalty);
            if (robberNewBal === false) {
              socket.emit('system message', `You don't have enough coins to cover the penalty!`);
              return;
            }
            const victimNewBal = await addCoins(targetUser.username, penalty);
            broadcastCoins(user.username, robberNewBal);
            broadcastCoins(targetUser.username, victimNewBal);
            io.to(room).emit('system message', `🚔 ${user.username} failed to rob ${targetUser.username}! Penalty: ${formatNumber(penalty)} coins to victim! 👮`);
          }
        } catch (err) {
          console.error('Rob error:', err);
          socket.emit('system message', 'Error executing /rob command.');
        }
        return;
      }

      // ── /coins (admin only) ───────────────────────────────────────────────
      if (raw.startsWith('/coins ')) {
        const parts = raw.slice(7).trim().split(/\s+/);
        if (parts.length < 2) { socket.emit('system message', 'Usage: /coins username amount'); return; }
        if (user.username.toLowerCase() !== 'mce') { socket.emit('system message', 'You do not have permission to use that command.'); return; }
        const targetName = parts[0].replace(/^@/, '');
        const amount = parseInt(parts[1], 10);
        if (isNaN(amount) || amount < 0) { socket.emit('system message', 'Amount must be a non-negative integer.'); return; }
        try {
          const r = await db.query('UPDATE users SET coins = $1 WHERE LOWER(username) = LOWER($2) RETURNING username, coins', [amount, targetName]);
          if (!r.rows.length) { socket.emit('system message', `User "${escapeHtml(targetName)}" not found.`); return; }
          const updated = r.rows[0];
          broadcastCoins(updated.username, updated.coins);
          io.to(user.room).emit('system message', `🔧 ${user.username} set ${updated.username}'s coins to ${formatNumber(updated.coins)}.`);
        } catch (err) {
          console.error('Admin /coins error:', err);
          socket.emit('system message', 'Error executing /coins command.');
        }
        return;
      }

      // ── Regular chat ───────────────────────────────────────────────────────
      // Enforce link rules and word filtering per-room
      const roomRow = await db.query('SELECT is_private FROM rooms WHERE name = $1', [room]);
      const isPrivate = !!roomRow.rows[0]?.is_private;
      const foundUrl = extractUrl(raw);
      if (foundUrl && !isPrivate) { socket.emit('system message', 'Links are only allowed in private rooms.'); return; }

      let textForSave = raw;
      try {
        const { filterText } = require('../lib/utils');
        if (!isPrivate) textForSave = filterText(textForSave);
      } catch (e) { /* ignore filter errors */ }

      const sanitized = escapeHtml(textForSave);
      const clientId = `${user.username}-${Date.now()}`;
      const messageId = await saveMessage({ room, sender: user.username, type: 'chat', text: sanitized, clientId });

      db.query(`UPDATE users SET messages_sent = messages_sent + 1 WHERE LOWER(username) = LOWER($1)`, [user.username]).catch(() => {});

      io.to(room).emit('chat message', { id: messageId, user: user.username, color: user.color, text: sanitized, type: 'chat', timestamp: Date.now() });
      // Notify all clients that this room received a message so they can show unread badges
      io.emit('room message', { room, user: user.username });
      addCoins(user.username, 1).then(newBal => broadcastCoins(user.username, newBal)).catch(() => {});
      if (foundUrl) fetchLinkPreview(foundUrl).then(preview => { if (preview) io.to(room).emit('link preview', { url: foundUrl, ...preview }); });
    });

    // ── Confirm changepass (after client confirms dialog) ─────────────────────
    socket.on('confirm changepass', async ({ room: roomName, newCode }) => {
      const user = connectedUsers[socket.id];
      if (!user) return;
      if (!/^\d{1,9}$/.test(String(newCode))) return;

      const roomRes = await db.query(
        `SELECT creator FROM rooms WHERE name = $1 AND is_private = true`, [roomName]
      );
      if (!roomRes.rows.length) return;
      if (roomRes.rows[0].creator.toLowerCase() !== user.username.toLowerCase()) return;

      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash(String(newCode), 10);
      await db.query(`UPDATE rooms SET password_hash = $1, owner_code = $2 WHERE name = $3`, [hash, String(newCode), roomName]);

      // Revoke ALL non-owner access from DB and in-memory
      await db.query(
        `DELETE FROM private_room_access WHERE room_name = $1 AND LOWER(username) != LOWER($2)`,
        [roomName, user.username]
      );

      Object.entries(connectedUsers).forEach(([sid, u]) => {
        if (sid === socket.id) return;
        if (privateRoomAccess[sid]) privateRoomAccess[sid].delete(roomName);
        if (u.room === roomName) {
          const s = io.sockets.sockets.get(sid);
          if (s) {
            u.room = 'general';
            s.leave(roomName);
            s.join('general');
            s.emit('room changed', 'general');
            s.emit('system message', `🔒 The code for #${roomName} was changed. You have been removed.`);
            sendRoomsList(s, u.username, privateRoomAccess[sid] || new Set());
          }
        }
      });

      socket.emit('room code changed', { room: roomName, newCode: String(newCode) });
      broadcastUserList(io, roomName);
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
        const r = await db.query(
          `SELECT emoji, COUNT(*) as count FROM reactions WHERE message_id = $1 GROUP BY emoji`,
          [messageId]
        );
        const reactions = {};
        r.rows.forEach(row => { reactions[row.emoji] = parseInt(row.count, 10); });
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

    // ── Colour update (after settings save) ──────────────────────────────────
    socket.on('color update', (newColor) => {
      const user = connectedUsers[socket.id];
      if (!user) return;
      if (typeof newColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(newColor)) return;
      user.color = newColor;
      broadcastUserList(io, user.room);
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