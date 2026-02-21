// ── SPRITE HELPER ─────────────────────────────────────────────
const KNOWN_SPRITES = new Set([
  'coinIcon.png','shopButtonIcon.png','gameButtonIcon.png','closeIcon.png',
  'warningIcon.png','lockIcon.png','slotsIcon.png','diceIcon.png','rouletteIcon.png',
  'cherryIcon.png','lemonIcon.png','orangeIcon.png','starIcon.png','diamondIcon.png',
  'sevenIcon.png','trophyIcon.png','profileAvatar.png','goldMedal.png','silverMedal.png',
  'bronzeMedal.png','onlineUsersButtonIcon.png','settingsButtonIcon.png','placeholder.png',
  'zzzIcon.png'
]);
function si(file, w, h, alt) {
  w = w || 20; h = h || 20; alt = alt || '';
  const fb = KNOWN_SPRITES.has(file) ? ` onerror="this.onerror=null;this.src='/sprites/placeholder.png'"` : '';
  return `<img class="sprite" src="/sprites/${file}" width="${w}" height="${h}" alt="${alt}"${fb}>`;
}
const BADGE_SPRITES = {
  lurker_no_more:'starIcon.png', regular:'starIcon.png', chatterbox:'starIcon.png',
  motormouth:'starIcon.png', legendary:'trophyIcon.png', feeling_lucky:'diceIcon.png',
  high_roller:'coinIcon.png', loaded:'coinIcon.png', whale:'diamondIcon.png',
  tycoon:'diamondIcon.png', mogul:'trophyIcon.png'
};
const SHOP_COLORS = {
  '#ccaa00': { name:'Gold',        effect:'gold'        },
  '#ff6bcb': { name:'Rainbow',     effect:'rainbow'     },
  '#ff0044': { name:'Neon Red',    effect:'neon_red'    },
  '#cc00ff': { name:'Neon Purple', effect:'neon_purple' }
};

function darkenHex(hex, amount) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const r = Math.max(0, parseInt(hex.slice(0,2),16) - amount);
  const g = Math.max(0, parseInt(hex.slice(2,4),16) - amount);
  const b = Math.max(0, parseInt(hex.slice(4,6),16) - amount);
  return `rgb(${r},${g},${b})`;
}

// ── SOUNDS ────────────────────────────────────────────────────
let soundEnabled = true;
const _sounds = {};
['click','hover','message','join','leave','dm','pollEnd','win','lose','coin','claim','keypad','spin','roll','bet','notify'].forEach(n => {
  const a = new Audio(`/sounds/${n}.wav`);
  a.preload = 'auto';
  _sounds[n] = a;
});
function playSound(name, vol) {
  if (!soundEnabled) return;
  const a = _sounds[name];
  if (!a) return;
  try { a.volume = Math.min(1, Math.max(0, vol || 1)); a.currentTime = 0; a.play().catch(() => {}); } catch(e) {}
}
function sfxClick()   { playSound('click',   0.7); }
function sfxHover()   { playSound('hover',   0.4); }
function soundMessage(){ playSound('message', 0.8); }
function soundJoin()  { playSound('join',    0.9); }
function soundLeave() { playSound('leave',   0.8); }
function soundDM()    { playSound('dm',      1.0); }
function soundPollEnd(){ playSound('pollEnd',0.9); }
function soundWin()   { playSound('win',     1.0); }
function soundLose()  { playSound('lose',    0.9); }
function soundCoin()  { playSound('coin',    0.8); }
function soundClaim() { playSound('claim',   1.0); }
function soundKeypad(){ playSound('keypad',  0.6); }
function toggleSound() {
  soundEnabled = !soundEnabled;
  const btn = document.getElementById('sound-toggle-btn');
  btn.textContent = soundEnabled ? 'Sound On' : 'Sound Off';
  btn.classList.toggle('on', soundEnabled);
}
document.addEventListener('mouseover', e => {
  const el = e.target.closest('button,.room-btn,.msg-user,.uname,.reaction-pill,.poll-option,.color-swatch,.badge-item,.shop-buy-btn,.bet-preset,.keypad-btn,.theme-btn,.stab,.shop-tab,.games-tab,.auth-tab');
  if (el) sfxHover();
}, { passive: true });

// ── STATE ─────────────────────────────────────────────────────
const socket = io({
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  timeout: 20000
});
let myUsername = null, myColor = '#000080', myCoins = 0, selectedTheme = 'classic';
let currentRoom = 'general', pendingRoom = null, usersVisible = false, isTyping = false, typingTimer;
let myToken = null;
const unreadCounts = {}, polls = {};
let shopItems = [], selectedSettingsColor = '#000080', selectedSettingsTheme = 'classic';
let keypadRoom = null, keypadCode = '';
let pendingChangepass = null;
const ownerRoomCodes = {};

// ── SESSION PRESENCE ──────────────────────────────────────────
// Tracks stats for the self-profile discovery feature
const sessionStart = Date.now();
let sessionMessagesSent = 0;

// ── UTILS ─────────────────────────────────────────────────────
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtNum(n)  { const v = Number(n); return isNaN(v) ? String(n) : v.toLocaleString(); }
function formatDuration(ms) {
  const t = Math.floor(ms / 1000), d = Math.floor(t/86400), h = Math.floor((t%86400)/3600), m = Math.floor((t%3600)/60), s = t%60;
  if (d > 0) return d+'D '+h+'HR '+m+'M';
  if (h > 0) return h+'HR '+m+'M';
  if (m > 0) return m+'M '+s+'S';
  return s+'S';
}
function formatSeconds(s) {
  if (s < 60) return s+'s';
  if (s < 3600) return Math.floor(s/60)+'m';
  if (s < 86400) return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';
  return Math.floor(s/86400)+'d '+Math.floor((s%86400)/3600)+'h';
}
function formatTime(ts)  { return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }
function formatDate(d)   { return new Date(d).toLocaleDateString([], { year:'numeric', month:'short', day:'numeric' }); }
function applyTheme(theme) {
  document.body.className = document.body.className.replace(/theme-\w+/g, '').trim();
  if (theme !== 'classic') document.body.classList.add('theme-' + theme);
  selectedTheme = theme;
}
function updateCoinDisplay() {
  document.getElementById('coin-amount').textContent = fmtNum(myCoins);
  document.getElementById('shop-balance-amt').textContent = fmtNum(myCoins);
  ['slots','dice','roulette'].forEach(g => {
    const el = document.getElementById(g + '-balance-amt');
    if (el) el.textContent = fmtNum(myCoins);
  });
}

// ── WINDOW MANAGER ────────────────────────────────────────────
const IS_DESKTOP = () => window.innerWidth >= 700;
let winZCounter = 500;
const WIN_OFFSETS = {};

function winCenterPos(id) {
  const el = document.getElementById(id);
  if (!el) return { x: 80, y: 80 };
  const prevDisplay = el.style.display;
  el.style.visibility = 'hidden';
  el.style.display = 'block';
  const w = el.querySelector('.modal-box')?.offsetWidth || 400;
  const h = el.querySelector('.modal-box')?.offsetHeight || 300;
  el.style.display = prevDisplay || '';
  el.style.visibility = '';
  const x = Math.max(20, Math.floor((window.innerWidth - w) / 2));
  const y = Math.max(20, Math.floor((window.innerHeight - h) / 2));
  return { x, y };
}
function winOpen(id) {
  if (!IS_DESKTOP()) return;
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('minimized');
  const pos = WIN_OFFSETS[id] || winCenterPos(id);
  el.style.left = pos.x + 'px';
  el.style.top  = pos.y + 'px';
  winFocus(id);
}
function winFocus(id) {
  if (!IS_DESKTOP()) return;
  document.querySelectorAll('.modal-overlay').forEach(w => w.classList.remove('win-focused'));
  const el = document.getElementById(id);
  if (!el) return;
  winZCounter++;
  el.style.zIndex = winZCounter;
  el.classList.add('win-focused');
}
function winMinimize(id) {
  if (!IS_DESKTOP()) return;
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('minimized');
}

// Drag
let dragState = null;
function initDrag(overlayEl) {
  const titlebar = overlayEl.querySelector('.modal-titlebar');
  if (!titlebar) return;
  titlebar.addEventListener('mousedown', e => {
    if (e.target.closest('button')) return;
    if (!IS_DESKTOP()) return;
    winFocus(overlayEl.id);
    const rect = overlayEl.getBoundingClientRect();
    dragState = { el: overlayEl, sx: e.clientX, sy: e.clientY, ex: rect.left, ey: rect.top };
    e.preventDefault();
  });
}
document.addEventListener('mousemove', e => {
  if (!dragState) return;
  const dx = e.clientX - dragState.sx, dy = e.clientY - dragState.sy;
  let nx = dragState.ex + dx, ny = dragState.ey + dy;
  const w = dragState.el.offsetWidth, h = dragState.el.offsetHeight;
  nx = Math.max(0, Math.min(window.innerWidth - w, nx));
  ny = Math.max(0, Math.min(window.innerHeight - 30, ny));
  dragState.el.style.left = nx + 'px';
  dragState.el.style.top  = ny + 'px';
});
document.addEventListener('mouseup', () => {
  if (!dragState) return;
  WIN_OFFSETS[dragState.el.id] = { x: parseInt(dragState.el.style.left), y: parseInt(dragState.el.style.top) };
  dragState = null;
});
document.addEventListener('mousedown', e => {
  const win = e.target.closest('.modal-overlay');
  if (win && IS_DESKTOP()) winFocus(win.id);
}, true);
function initAllWindows() {
  document.querySelectorAll('.modal-overlay').forEach(el => initDrag(el));
}
function winShow(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('open');
  winOpen(id);
}

// ── AUTH ──────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t, i) => t.classList.toggle('active', (i === 0) === (tab === 'login')));
  document.getElementById('login-panel').classList.toggle('active', tab === 'login');
  document.getElementById('register-panel').classList.toggle('active', tab === 'register');
}
fetch('/user-count').then(r => r.json()).then(d => {
  if (d.count) document.getElementById('auth-user-count').textContent = `${d.count} registered user${d.count === 1 ? '' : 's'}`;
}).catch(() => {});

async function doLogin() {
  const u = document.getElementById('login-username').value.trim();
  const p = document.getElementById('login-password').value;
  const e = document.getElementById('login-error');
  e.textContent = '';
  if (!u || !p) { e.textContent = 'Please fill in all fields.'; return; }
  const res  = await fetch('/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username:u, password:p }) });
  const data = await res.json();
  if (!res.ok) { e.textContent = data.error; return; }
  enterChat(data.username, data.color||'#000080', data.theme||'classic', data.coins||0, data.token, data.dailyAvailable);
}
async function doRegister() {
  const u  = document.getElementById('reg-username').value.trim();
  const p  = document.getElementById('reg-password').value;
  const p2 = document.getElementById('reg-password2').value;
  const e  = document.getElementById('register-error');
  e.textContent = '';
  if (!u||!p||!p2) { e.textContent = 'Please fill in all fields.'; return; }
  if (p !== p2)    { e.textContent = 'Passwords do not match.'; return; }
  const res  = await fetch('/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username:u, password:p }) });
  const data = await res.json();
  if (!res.ok) { e.textContent = data.error; return; }
  enterChat(data.username, data.color||'#000080', data.theme||'classic', data.coins||100, data.token, false);
}
async function doLogout() { await fetch('/logout', { method:'POST' }); socket.disconnect(); location.reload(); }

function enterChat(username, color, theme, coins, token, dailyAvailable) {
  myUsername = username; myColor = color || '#000080'; myCoins = coins || 0; myToken = token;
  applyTheme(theme || 'classic');
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('chat-screen').style.display = 'block';
  setLoggedInAs(username, color);
  updateCoinDisplay();
  document.getElementById('input').focus();
  socket.connect();
  initAllWindows();
  startAmbientSystem();
  startVisibilityWatcher();
  if (dailyAvailable) setTimeout(showDailyModal, 1500);
}
function setLoggedInAs(username, color) {
  const ci = SHOP_COLORS[color];
  const ec = ci ? ` user-${ci.effect}` : '';
  document.getElementById('logged-in-as').innerHTML =
    `<span class="${ec}" style="color:${color};text-shadow:0 0 2px rgba(255,255,255,0.5)">${escHtml(username)}</span>`;
}

// ── RECONNECTION ──────────────────────────────────────────────
socket.on('disconnect', reason => {
  if (reason === 'io server disconnect') return;
  document.getElementById('reconnect-banner').classList.add('visible');
  document.getElementById('input').disabled = true;
  document.getElementById('send-btn').disabled = true;
});
socket.on('connect', () => {
  document.getElementById('reconnect-banner').classList.remove('visible');
  document.getElementById('input').disabled  = false;
  document.getElementById('send-btn').disabled = false;
  if (myToken) socket.emit('join', myToken);
});
socket.on('reconnect', () => {
  if (currentRoom && currentRoom !== 'general') socket.emit('switch room', { room: currentRoom });
});

// ── ROOMS ─────────────────────────────────────────────────────
function renderRooms(rooms) {
  const list = document.getElementById('rooms-list');
  list.innerHTML = '';
  rooms.forEach(r => {
    const name = typeof r === 'string' ? r : r.name;
    const isPrivate  = typeof r === 'object' && r.isPrivate;
    const serverCode = typeof r === 'object' && r.ownerCode ? r.ownerCode : null;
    if (serverCode) ownerRoomCodes[name] = serverCode;
    const btn = document.createElement('button');
    btn.className = 'room-btn' + (name === currentRoom ? ' active' : '');
    btn.dataset.room = name;
    if (isPrivate) {
      const li = document.createElement('img');
      li.className = 'sprite room-private-icon';
      li.src = '/sprites/lockIcon.png'; li.width = 15; li.height = 15; li.alt = 'private';
      li.onerror = function(){ this.onerror = null; this.src = '/sprites/placeholder.png'; };
      btn.appendChild(li);
      btn.appendChild(document.createTextNode(' '));
    }
    btn.appendChild(document.createTextNode('#' + name));
    if (unreadCounts[name]) {
      const badge = document.createElement('span');
      badge.className = 'room-unread';
      badge.textContent = unreadCounts[name];
      btn.appendChild(badge);
    }
    btn.onclick = () => { sfxClick(); switchRoom(name); };
    list.appendChild(btn);
  });
}
function switchRoom(room) {
  if (room === currentRoom || room === pendingRoom) return;
  pendingRoom = room;
  socket.emit('switch room', { room });
}

// ── KEYPAD ────────────────────────────────────────────────────
function openKeypad(room) {
  keypadRoom = room; keypadCode = '';
  document.getElementById('keypad-room-label').textContent = '#' + room;
  document.getElementById('keypad-error').textContent = '';
  renderKeypadDots();
  winShow('keypad-modal');
}
function closeKeypad() { document.getElementById('keypad-modal').classList.remove('open'); keypadRoom = null; keypadCode = ''; pendingRoom = null; }
function renderKeypadDots() {
  const wrap = document.getElementById('keypad-dots');
  wrap.innerHTML = '';
  const len = Math.max(keypadCode.length, 1);
  for (let i = 0; i < Math.min(len, 9); i++) {
    const d = document.createElement('div');
    d.className = 'keypad-dot' + (i < keypadCode.length ? ' filled' : '');
    wrap.appendChild(d);
  }
}
function keypadPress(digit) { if (keypadCode.length >= 9) return; soundKeypad(); keypadCode += digit; document.getElementById('keypad-error').textContent = ''; renderKeypadDots(); }
function keypadClear()      { if (!keypadCode.length) return; keypadCode = keypadCode.slice(0, -1); renderKeypadDots(); }
function keypadSubmit()     { if (!keypadCode) { document.getElementById('keypad-error').textContent = 'Enter a code first.'; return; } pendingRoom = keypadRoom; socket.emit('switch room', { room: keypadRoom, code: keypadCode }); }
document.addEventListener('keydown', e => {
  if (!document.getElementById('keypad-modal').classList.contains('open')) return;
  if (e.key >= '0' && e.key <= '9') keypadPress(e.key);
  else if (e.key === 'Backspace') keypadClear();
  else if (e.key === 'Enter') keypadSubmit();
});

// ── ROOM CREATED / CHANGEPASS ─────────────────────────────────
function openRoomCreated(room, code) { document.getElementById('rc-room-name').textContent = '#' + room; document.getElementById('rc-room-code').textContent = code; winShow('room-created-modal'); }
function closeRoomCreated()          { document.getElementById('room-created-modal').classList.remove('open'); }
function openChangepassConfirm(room, newCode) { pendingChangepass = { room, newCode }; document.getElementById('cp-room-name').textContent = '#' + room; document.getElementById('cp-new-code').textContent = newCode; winShow('changepass-modal'); }
function closeChangepass()           { document.getElementById('changepass-modal').classList.remove('open'); pendingChangepass = null; }
function confirmChangepass()         { if (!pendingChangepass) return; socket.emit('confirm changepass', pendingChangepass); closeChangepass(); }

// ── SEND / TYPING ─────────────────────────────────────────────
function send() {
  const inp = document.getElementById('input'), t = inp.value.trim();
  if (!t) return;
  socket.emit('chat message', t);
  inp.value = '';
  stopTyping();
  sessionMessagesSent++;
  resetAmbientTimer(); // any message resets the quiet timer
}
document.getElementById('input').addEventListener('input', () => {
  socket.emit('activity');
  if (!isTyping) { isTyping = true; socket.emit('typing start'); }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 2000);
});
function stopTyping() { if (!isTyping) return; isTyping = false; clearTimeout(typingTimer); socket.emit('typing stop'); }
function toggleUsers() { usersVisible = !usersVisible; document.getElementById('users-panel').classList.toggle('visible', usersVisible); }

// ── MESSAGES ──────────────────────────────────────────────────
function addMessage(html, extraClass, timestamp, msgId) {
  const messages = document.getElementById('messages');
  const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
  const li = document.createElement('li');
  li.style.listStyle = 'none';
  li.className = 'msg-row' + (extraClass ? ' ' + extraClass : '');
  if (msgId) li.dataset.msgId = msgId;
  const ts = timestamp ? `<span class="msg-ts">${formatTime(timestamp)}</span>` : '';
  const reactBtn = msgId ? `<button class="msg-react-btn" title="React">+<div class="react-picker"><span class="react-emoji" data-emoji="👍">👍</span><span class="react-emoji" data-emoji="❤️">❤️</span><span class="react-emoji" data-emoji="😂">😂</span><span class="react-emoji" data-emoji="😮">😮</span></div></button>` : '';
  if (myUsername) {
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    const re = new RegExp('@' + myUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(tmp.textContent || '')) li.classList.add('msg-mention');
  }
  li.innerHTML = html + ts + reactBtn;
  messages.appendChild(li);
  if (atBottom) messages.scrollTop = messages.scrollHeight;
  return li;
}
function updateRoomBadge(room) {
  const btn = document.querySelector(`.room-btn[data-room="${room}"]`);
  if (!btn) return;
  const ex = btn.querySelector('.room-unread');
  if (ex) ex.remove();
  const c = unreadCounts[room] || 0;
  if (c > 0) { const s = document.createElement('span'); s.className = 'room-unread'; s.textContent = c > 99 ? '99+' : c; btn.appendChild(s); }
}
function addDmMessage(data) {
  const messages = document.getElementById('messages');
  const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
  const li = document.createElement('li');
  li.style.listStyle = 'none';
  li.className = 'msg-row msg-dm-row' + (!data.noFlash && !data.self ? ' dm-flash' : '');
  const label = data.self
    ? `<span class="msg-dm-label">DM to ${escHtml(data.to)}:</span>`
    : `<span class="msg-dm-label">DM from ${escHtml(data.from)}:</span>`;
  li.innerHTML = label + `<span class="msg-text">${escHtml(data.text)}</span>`;
  messages.appendChild(li);
  if (atBottom) messages.scrollTop = messages.scrollHeight;
  if (!data.noFlash && !data.self) soundDM();
}
document.getElementById('messages').addEventListener('click', e => {
  const emojiBtn = e.target.closest('.react-emoji');
  if (emojiBtn) { const li = emojiBtn.closest('.msg-row'); if (li && li.dataset.msgId) socket.emit('react', { messageId: parseInt(li.dataset.msgId), emoji: emojiBtn.dataset.emoji }); return; }
  const pill = e.target.closest('.reaction-pill');
  if (pill) { const li = pill.closest('.msg-row'); if (!li || !li.dataset.msgId) return; const emoji = pill.dataset.emoji, mr = li.dataset.myReaction; if (mr === emoji) socket.emit('unreact', { messageId: parseInt(li.dataset.msgId) }); else socket.emit('react', { messageId: parseInt(li.dataset.msgId), emoji }); return; }
  const opt = e.target.closest('.poll-option');
  if (opt && !opt.classList.contains('concluded')) { const pollId = parseInt(opt.dataset.poll), option = opt.dataset.opt; if (pollId && option) socket.emit('poll vote', { pollId, option }); return; }
  const uEl = e.target.closest('.msg-user');
  if (uEl && uEl.dataset.username) { sfxClick(); openProfile(uEl.dataset.username); }
});
function updateReactions(li, reactions, myReaction) {
  let wrap = li.querySelector('.msg-reactions');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'msg-reactions'; li.appendChild(wrap); }
  wrap.innerHTML = ''; li.dataset.myReaction = myReaction || '';
  Object.entries(reactions).forEach(([emoji, count]) => {
    if (count <= 0) return;
    const pill = document.createElement('span');
    pill.className = 'reaction-pill' + (myReaction === emoji ? ' selected' : '');
    pill.dataset.emoji = emoji;
    pill.innerHTML = `${emoji}<span class="r-count">${count}</span>`;
    wrap.appendChild(pill);
  });
}

// ── POLLS ─────────────────────────────────────────────────────
function renderPoll(poll) {
  polls[poll.id] = poll;
  const ex = document.getElementById('poll-' + poll.id);
  if (ex) { ex.innerHTML = buildPollHtml(poll); return; }
  const messages = document.getElementById('messages');
  const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
  const li = document.createElement('li'); li.style.listStyle = 'none'; li.id = 'poll-' + poll.id; li.className = 'msg-row'; li.innerHTML = buildPollHtml(poll);
  messages.appendChild(li);
  if (atBottom) messages.scrollTop = messages.scrollHeight;
}
function buildPollHtml(poll) {
  const total = Object.keys(poll.votes || {}).length, myVote = (poll.votes || {})[myUsername], concluded = poll.concluded;
  let topCount = 0;
  if (concluded && total > 0) { const t = {}; poll.options.forEach(o => t[o] = 0); Object.values(poll.votes || {}).forEach(v => { if (t[v] !== undefined) t[v]++; }); topCount = Math.max(...Object.values(t)); }
  const optsHtml = poll.options.map(opt => {
    const count = Object.values(poll.votes || {}).filter(v => v === opt).length, pct = total > 0 ? Math.round((count/total)*100) : 0;
    const isVoted = myVote === opt, isWinner = concluded && total > 0 && count === topCount;
    const cls = ['poll-option', isVoted?'voted':'', concluded?'concluded':'', isWinner?'winner':''].filter(Boolean).join(' ');
    return `<div class="${cls}" data-poll="${poll.id}" data-opt="${escHtml(opt)}"><span class="poll-opt-label">${isWinner ? si('trophyIcon.png',14,14,'win')+' ' : ''}${escHtml(opt)}</span><div class="poll-bar-wrap"><div class="poll-bar" style="width:${pct}%"></div></div><span class="poll-pct">${pct}%</span><span style="font-size:13px;color:var(--text-system)">${count}</span></div>`;
  }).join('');
  let timerHtml = '';
  if (!concluded && poll.endsAt) timerHtml = `<span class="poll-timer" data-ends="${new Date(poll.endsAt).getTime()}">...</span>`;
  else if (concluded) timerHtml = `<span style="color:var(--text-system)">concluded</span>`;
  return `<div class="poll-card${concluded?' poll-concluded':''}"><div class="poll-question">${si('starIcon.png',14,14,'poll')} ${escHtml(poll.question)}</div>${optsHtml}<div class="poll-meta">by ${escHtml(poll.creator)} &middot; ${total} vote${total!==1?'s':''} &middot; ${timerHtml}</div></div>`;
}

// ── HISTORY ───────────────────────────────────────────────────
function renderHistory(history) {
  const messages = document.getElementById('messages');
  messages.innerHTML = '';
  if (!history.length) return;
  addMessage(`<span class="msg-system">-- message history --</span>`);
  history.forEach(row => {
    const ts = new Date(row.created_at).getTime();
    const ci = SHOP_COLORS[row.color]; const ec = ci ? ` user-${ci.effect}` : '';
    if (row.type === 'poll') {
      const poll = row.poll_data; if (!poll) return; polls[poll.id] = poll;
      const messages2 = document.getElementById('messages');
      const atBottom = messages2.scrollHeight - messages2.scrollTop - messages2.clientHeight < 40;
      const li = document.createElement('li'); li.style.listStyle = 'none'; li.id = 'poll-' + poll.id; li.className = 'msg-row'; li.innerHTML = buildPollHtml(poll);
      messages2.appendChild(li); if (atBottom) messages2.scrollTop = messages2.scrollHeight;
    } else if (row.type === 'system') {
      addMessage(`<span class="msg-system">*** ${escHtml(row.text)} ***</span>`, '', ts);
    } else if (row.type === 'action') {
      addMessage(`<span class="msg-action">*** <span class="msg-user${ec}" data-username="${escHtml(row.sender)}" style="color:${row.color}">${escHtml(row.sender)}</span> ${escHtml(row.text)} ***</span>`, '', ts);
    } else if (row.type === 'dm') {
      addDmMessage({ from: row.sender, to: row.recipient, text: row.text, self: row.sender === myUsername, noFlash: true });
    } else {
      const li = addMessage(`<span class="msg-user${ec}" data-username="${escHtml(row.sender)}" style="color:${row.color}">${escHtml(row.sender)}:</span> <span class="msg-text">${escHtml(row.text)}</span>`, row.sender === myUsername ? 'msg-own' : '', ts, row.id);
      if (row.reactions && Object.keys(row.reactions).length) updateReactions(li, row.reactions, null);
    }
  });
  addMessage(`<span class="msg-system">-- live --</span>`);
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
}

// ── SOCKET EVENTS ─────────────────────────────────────────────
socket.on('rooms list', rooms => renderRooms(rooms));
socket.on('room changed', room => {
  currentRoom = room; pendingRoom = null; unreadCounts[room] = 0; updateRoomBadge(room);
  document.getElementById('messages').innerHTML = '';
  if (document.getElementById('keypad-modal').classList.contains('open')) closeKeypad();
  document.querySelectorAll('.room-btn').forEach(b => b.classList.toggle('active', b.dataset.room === room));
  resetAmbientTimer();
});
socket.on('history', history => { document.getElementById('messages').innerHTML = ''; renderHistory(history); });
socket.on('room requires code', room => { pendingRoom = room; openKeypad(room); });
socket.on('keypad error', msg => { document.getElementById('keypad-error').textContent = msg || 'Wrong code.'; keypadCode = ''; renderKeypadDots(); });
socket.on('confirm changepass', ({ room, newCode }) => openChangepassConfirm(room, newCode));
socket.on('room code changed', ({ room, newCode }) => { ownerRoomCodes[room] = String(newCode); addMessage(`<span class="msg-system">Room code changed to: ${newCode}</span>`); });
socket.on('room created', ({ room, code }) => { ownerRoomCodes[room] = String(code); openRoomCreated(room, code); });
socket.on('chat message', ({ id, user, color, text, type, timestamp }) => {
  const isOwn = user === myUsername;
  const ci = SHOP_COLORS[color]; const ec = ci ? ` user-${ci.effect}` : '';
  if (type === 'action') addMessage(`<span class="msg-action">*** <span class="msg-user${ec}" data-username="${escHtml(user)}" style="color:${color}">${escHtml(user)}</span> ${escHtml(text)} ***</span>`, '', timestamp);
  else addMessage(`<span class="msg-user${ec}" data-username="${escHtml(user)}" style="color:${color}">${escHtml(user)}:</span> <span class="msg-text">${escHtml(text)}</span>`, isOwn ? 'msg-own' : '', timestamp || Date.now(), id);
  if (!isOwn) soundMessage();
  resetAmbientTimer();
});
socket.on('room message', ({ room, user }) => {
  try { if (!myUsername || room === currentRoom) return; if (user && user.toLowerCase() === myUsername.toLowerCase()) return; unreadCounts[room] = (unreadCounts[room] || 0) + 1; updateRoomBadge(room); } catch(e) {}
});
socket.on('system message', msg => {
  const isClaim = msg.includes('/claim') || msg.includes('claimed the reward') || msg.includes('Nobody claimed');
  if (isClaim) { addMessage(`<span class="msg-claim-event">${escHtml(msg)}</span>`); if (msg.includes('/claim')) soundClaim(); else if (msg.includes('claimed the reward') && msg.includes(myUsername)) soundWin(); }
  else { addMessage(`<span class="msg-system">*** ${escHtml(msg)} ***</span>`); if (/has joined/.test(msg)) soundJoin(); else if (/has left/.test(msg)) soundLeave(); }
  resetAmbientTimer();
});
socket.on('announcement', ({ from, message }) => {
  document.getElementById('announcement-content').textContent = (from && from.toLowerCase() === 'mce' ? 'Admin: ' : '') + message;
  winShow('announcement-modal'); soundClaim();
});
socket.on('dm', data => addDmMessage(data));
socket.on('coins update', ({ coins }) => { myCoins = coins; updateCoinDisplay(); });
socket.on('reaction update', ({ messageId, reactions }) => { const li = document.querySelector(`[data-msg-id="${messageId}"]`); if (!li) return; updateReactions(li, reactions, li.dataset.myReaction || null); });
socket.on('link preview', ({ url, title, image, description }) => {
  const messages = document.getElementById('messages'); const rows = messages.querySelectorAll('.msg-row'); let target = null;
  for (let i = rows.length - 1; i >= 0; i--) { if (rows[i].textContent.includes(url.slice(8, 40))) { target = rows[i]; break; } }
  const prev = document.createElement('div'); prev.className = 'link-preview';
  let h = ''; if (image) h += `<img src="${image}" alt="" onerror="this.style.display='none'">`; if (title) h += `<div class="lp-title">${escHtml(title)}</div>`; if (description) h += `<div class="lp-desc">${escHtml(description)}</div>`;
  prev.innerHTML = h;
  const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
  if (target) target.appendChild(prev); else { const li = document.createElement('li'); li.style.listStyle = 'none'; li.appendChild(prev); messages.appendChild(li); }
  if (atBottom) messages.scrollTop = messages.scrollHeight;
});
socket.on('poll update', poll => renderPoll(poll));
socket.on('poll concluded', ({ pollId }) => { if (polls[pollId]) { polls[pollId].concluded = true; const el = document.getElementById('poll-' + pollId); if (el) el.innerHTML = buildPollHtml(polls[pollId]); soundPollEnd(); } });

// ── USER LIST ─────────────────────────────────────────────────
// idle = server flag (short idle ~5min)
// We track last-active per username client-side for long-lurk fading (10min no message)
const userLastActive = {};

socket.on('user list', list => {
  document.getElementById('user-count-text').textContent = list.length;
  const panel = document.getElementById('users-panel');
  panel.innerHTML = '';
  list.forEach(({ username, color, joinedAt, idle }) => {
    // track activity time if we don't have it
    if (!userLastActive[username]) userLastActive[username] = joinedAt;

    const entry = document.createElement('span');
    entry.className = 'user-entry';
    entry.dataset.joinedAt = joinedAt;
    entry.dataset.username = username;

    const ci = SHOP_COLORS[color]; const ec = ci ? ` user-${ci.effect}` : '';
    const uname = document.createElement('span');
    uname.className = 'uname' + ec;
    uname.style.color = color;
    uname.dataset.username = username;
    uname.textContent = username;
    uname.onclick = () => { sfxClick(); handleUsernameClick(username); };

    entry.appendChild(uname);

    // zzz for server-flagged idle
    if (idle) {
      const zzz = document.createElement('span');
      zzz.className = 'zzz-sprite';
      zzz.title = 'idle';
      entry.appendChild(zzz);
    }

    // long-lurk fading (10+ min of no messages seen from this user)
    const msSilent = Date.now() - (userLastActive[username] || joinedAt);
    if (msSilent > 10 * 60 * 1000) {
      entry.classList.add('user-lurking');
    }

    panel.appendChild(entry);
    if (username === myUsername) { myColor = color; setLoggedInAs(username, color); }
  });
});

// Update lastActive when a message comes in from a user
socket.on('chat message', ({ user }) => {
  if (user) userLastActive[user] = Date.now();
});

socket.on('typing', ({ text }) => {
  const bar = document.getElementById('typing-bar');
  bar.innerHTML = text ? escHtml(text) + ' <span class="dots"><span></span><span></span><span></span></span>' : '';
});
socket.on('kicked', reason => {
  addMessage(`<span class="msg-kicked">You were kicked: ${escHtml(reason || 'Signed in elsewhere.')}</span>`);
  document.getElementById('input').disabled = true;
  document.getElementById('send-btn').disabled = true;
  socket.disconnect();
});

// ── SELF PROFILE (discovered feature) ────────────────────────
function handleUsernameClick(username) {
  if (username === myUsername) {
    openSelfProfile();
  } else {
    openProfile(username);
  }
}

function openSelfProfile() {
  const timeHere = Date.now() - sessionStart;
  const title = document.getElementById('self-profile-title');
  const body  = document.getElementById('self-profile-body');
  title.textContent = myUsername;

  body.innerHTML = `
    <div class="self-stat">
      <span class="self-stat-label">time here tonight</span>
      <span class="self-stat-value">${formatDuration(timeHere)}</span>
    </div>
    <div class="self-stat">
      <span class="self-stat-label">messages this session</span>
      <span class="self-stat-value">${sessionMessagesSent}</span>
    </div>
    <div class="self-stat">
      <span class="self-stat-label">room</span>
      <span class="self-stat-value">#${escHtml(currentRoom)}</span>
    </div>
    <div class="self-profile-note">only you can see this</div>
  `;
  winShow('self-profile-modal');
}
function closeSelfProfile() { document.getElementById('self-profile-modal').classList.remove('open'); }

// ── AMBIENT IDLE SYSTEM ───────────────────────────────────────
const AMBIENT_PHRASES = [
  '...',
  'the room is quiet',
  'still here',
  '...',
  'somewhere, someone is thinking about typing',
  '...',
  'the clock ticks',
  'quiet tonight',
  '...',
  'listening',
];
let ambientTimer = null;
let ambientPhaseMs = () => (8 + Math.random() * 7) * 60 * 1000; // 8–15 min

function startAmbientSystem() {
  scheduleNextAmbient();
}
function scheduleNextAmbient() {
  clearTimeout(ambientTimer);
  ambientTimer = setTimeout(() => {
    fireAmbientMessage();
    scheduleNextAmbient();
  }, ambientPhaseMs());
}
function resetAmbientTimer() {
  // Any real activity resets the clock
  scheduleNextAmbient();
}
function fireAmbientMessage() {
  const phrase = AMBIENT_PHRASES[Math.floor(Math.random() * AMBIENT_PHRASES.length)];
  addMessage(`<span class="msg-ambient">${escHtml(phrase)}</span>`);
}

// ── WELCOME BACK (Page Visibility API) ───────────────────────
let hiddenAt = null;
const WELCOME_BACK_THRESHOLD = 5 * 60 * 1000; // 5 minutes away

function startVisibilityWatcher() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else {
      if (hiddenAt && Date.now() - hiddenAt >= WELCOME_BACK_THRESHOLD) {
        setTimeout(() => {
          addMessage(`<span class="msg-welcomeback">welcome back</span>`);
        }, 800);
      }
      hiddenAt = null;
    }
  });
}

// ── DAILY ─────────────────────────────────────────────────────
function showDailyModal() { winShow('daily-modal'); }
function closeDailyModal() { document.getElementById('daily-modal').classList.remove('open'); }
async function claimDaily() {
  try {
    const res = await fetch('/daily', { method:'POST', credentials:'include' });
    const data = await res.json();
    if (!res.ok) { closeDailyModal(); return; }
    myCoins = data.coins; updateCoinDisplay(); soundCoin(); soundWin(); closeDailyModal();
    addMessage(`<span class="msg-system">Daily reward claimed! +${fmtNum(data.reward)} coins. Balance: ${fmtNum(data.coins)}</span>`);
  } catch { closeDailyModal(); }
}

// ── PROFILE (other users) ────────────────────────────────────
async function openProfile(username) {
  document.getElementById('profile-modal-title').textContent = username + "'s Profile";
  document.getElementById('profile-modal-body').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-system);">Loading...</div>';
  winShow('profile-modal');
  try {
    const res = await fetch(`/profile/${encodeURIComponent(username)}`, { credentials:'include' });
    const d = await res.json();
    if (!res.ok) { document.getElementById('profile-modal-body').textContent = d.error; return; }
    const ci = SHOP_COLORS[d.color]; const ec = ci ? ` user-${ci.effect}` : '';
    const badgeHtml  = d.activeBadge ? `${si(BADGE_SPRITES[d.activeBadge.id]||'placeholder.png',18,18,d.activeBadge.name)} ${escHtml(d.activeBadge.name)}` : `<span style="color:var(--text-system)">No badge</span>`;
    const earnedHtml = d.earnedBadges.length ? d.earnedBadges.map(b => `<span title="${escHtml(b.description)}" style="cursor:help">${si(BADGE_SPRITES[b.id]||'placeholder.png',24,24,b.name)}</span>`).join(' ') : `<span style="color:var(--text-system);font-size:14px">No badges yet</span>`;
    document.getElementById('profile-modal-body').innerHTML = `
      <div class="profile-header">
        <img class="profile-avatar-img sprite" src="/sprites/profileAvatar.png" alt="Avatar" onerror="this.onerror=null;this.src='/sprites/placeholder.png'">
        <div>
          <div class="profile-name${ec}" style="color:${d.color||'var(--text-main)'}">${escHtml(d.username)}</div>
          <div class="profile-badge-display">${badgeHtml}</div>
        </div>
      </div>
      <div class="profile-stats">
        <div class="stat-row"><span class="stat-label">Joined</span><span class="stat-value">${formatDate(d.createdAt)}</span></div>
        <div class="stat-row"><span class="stat-label">Messages sent</span><span class="stat-value">${d.messagesSent}</span></div>
        <div class="stat-row"><span class="stat-label">Time online</span><span class="stat-value">${formatSeconds(d.timeOnlineSeconds)}</span></div>
      </div>
      <div style="font-size:15px;margin-bottom:6px;">Badges earned:</div>
      <div style="padding:4px 0;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">${earnedHtml}</div>`;
  } catch { document.getElementById('profile-modal-body').textContent = 'Error loading profile.'; }
}
function closeProfile() { document.getElementById('profile-modal').classList.remove('open'); }
document.getElementById('profile-modal').addEventListener('click', e => { if (e.target === document.getElementById('profile-modal') && !IS_DESKTOP()) closeProfile(); });

// ── SETTINGS ─────────────────────────────────────────────────
function switchSettingsTab(tab) {
  const tabs = ['look','you','account'];
  document.querySelectorAll('.stab').forEach((t, i) => t.classList.toggle('active', tabs[i] === tab));
  document.querySelectorAll('.stab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('stab-' + tab).classList.add('active');
  if (tab === 'you') { loadStats(); loadBadges(); }
}
async function openSettings() {
  winShow('settings-overlay');
  document.getElementById('settings-status').textContent = '';
  selectedSettingsColor = myColor;
  selectedSettingsTheme = selectedTheme;
  await loadShopItems();
  renderSettingsThemes();
  renderSettingsColors();
}
function closeSettings() { document.getElementById('settings-overlay').classList.remove('open'); }
document.getElementById('settings-overlay').addEventListener('click', e => { if (e.target === document.getElementById('settings-overlay') && !IS_DESKTOP()) closeSettings(); });

function renderSettingsThemes() {
  const owned = shopItems.filter(i => i.type === 'theme' && i.owned);
  const wrap  = document.getElementById('settings-theme-options');
  wrap.innerHTML = '';
  if (!owned.length) { wrap.innerHTML = '<span style="font-size:14px;color:var(--text-system)">No themes owned. Visit Shop!</span>'; return; }
  owned.forEach(item => {
    const btn = document.createElement('button');
    btn.className = `theme-btn theme-opt-${item.value}${item.value === selectedSettingsTheme ? ' selected' : ''}`;
    btn.textContent = item.name;
    btn.onclick = () => { sfxClick(); selectedSettingsTheme = item.value; wrap.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('selected')); btn.classList.add('selected'); applyTheme(item.value); };
    wrap.appendChild(btn);
  });
}
function renderSettingsColors() {
  const owned = shopItems.filter(i => i.type === 'color' && i.owned);
  const wrap  = document.getElementById('settings-color-swatches');
  wrap.innerHTML = '';
  owned.forEach(item => {
    const div   = document.createElement('div'); div.className = 'color-swatch' + (item.value === selectedSettingsColor ? ' selected' : '');
    const prev  = document.createElement('div'); prev.className = 'color-preview'; prev.style.background = item.value;
    const name  = document.createElement('div'); name.className = 'color-name'; name.textContent = item.name; name.style.color = item.value; name.style.textShadow = '0 1px 3px rgba(0,0,0,0.6)';
    const check = document.createElement('div'); check.className = 'color-checkmark'; check.textContent = item.value === selectedSettingsColor ? '✓' : '';
    div.appendChild(prev); div.appendChild(name); div.appendChild(check);
    div.onclick = () => { sfxClick(); selectedSettingsColor = item.value; wrap.querySelectorAll('.color-swatch').forEach(s => { s.classList.remove('selected'); s.querySelector('.color-checkmark').textContent = ''; }); div.classList.add('selected'); div.querySelector('.color-checkmark').textContent = '✓'; };
    wrap.appendChild(div);
  });
}
async function saveSettings() {
  const st = document.getElementById('settings-status'); st.textContent = 'Saving...'; st.style.color = 'inherit';
  try {
    const res = await fetch('/settings', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ color: selectedSettingsColor, theme: selectedSettingsTheme }) });
    const data = await res.json();
    if (!res.ok) { st.textContent = data.error; st.style.color = '#cc0000'; return; }
    myColor = selectedSettingsColor; setLoggedInAs(myUsername, myColor); socket.emit('color update', myColor);
    st.textContent = 'Saved!'; st.style.color = '#007700'; setTimeout(() => st.textContent = '', 2000);
  } catch { st.textContent = 'Error saving.'; st.style.color = '#cc0000'; }
}
async function changePassword() {
  const st  = document.getElementById('pw-status');
  const op  = document.getElementById('pw-old').value;
  const np  = document.getElementById('pw-new').value;
  const np2 = document.getElementById('pw-new2').value;
  st.textContent = 'Changing...'; st.style.color = 'inherit';
  try {
    const res = await fetch('/settings/password', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ oldPassword:op, newPassword:np, newPassword2:np2 }) });
    const data = await res.json();
    if (!res.ok) { st.textContent = data.error || 'Error'; st.style.color = '#cc0000'; return; }
    st.textContent = 'Password changed!'; st.style.color = '#007700';
    ['pw-old','pw-new','pw-new2'].forEach(id => document.getElementById(id).value = '');
    setTimeout(() => st.textContent = '', 2500);
  } catch { st.textContent = 'Server error'; st.style.color = '#cc0000'; }
}

// ── BADGES ────────────────────────────────────────────────────
async function loadBadges() {
  const grid = document.getElementById('badge-grid');
  grid.innerHTML = '<div style="color:var(--text-system);font-size:14px">Loading...</div>';
  try {
    const res = await fetch('/stats', { credentials:'include' });
    const data = await res.json();
    if (!res.ok) return;
    const earnedIds = new Set(data.earnedBadges.map(b => b.id));
    const activeId  = data.activeBadge?.id || null;
    const allBadges = [
      { id:'lurker_no_more', name:'Lurker No More',  description:'Send 10 messages' },
      { id:'regular',        name:'Regular',          description:'Send 50 messages' },
      { id:'chatterbox',     name:'Chatterbox',       description:'Send 100 messages' },
      { id:'motormouth',     name:'Motormouth',       description:'Send 500 messages' },
      { id:'legendary',      name:'Legendary',        description:'Send 1,000 messages' },
      { id:'feeling_lucky',  name:'Feeling Lucky',    description:'Place your first gamble' },
      { id:'high_roller',    name:'High Roller',      description:'Win over 1,000 coins at once' },
      { id:'loaded',         name:'Loaded',           description:'Earn 5,000 coins total' },
      { id:'whale',          name:'Whale',            description:'Earn 10,000 coins total' },
      { id:'tycoon',         name:'Tycoon',           description:'Earn 50,000 coins total' },
      { id:'mogul',          name:'Mogul',            description:'Earn 100,000 coins total' },
    ];
    grid.innerHTML = '';
    allBadges.forEach(b => {
      const earned = earnedIds.has(b.id), isActive = b.id === activeId;
      const div = document.createElement('div');
      div.className = 'badge-item' + (earned ? ' earned' : ' locked') + (isActive ? ' active-badge' : '');
      const spriteFile = BADGE_SPRITES[b.id] || 'placeholder.png';
      div.innerHTML = `<img class="badge-icon sprite" src="/sprites/${spriteFile}" alt="${escHtml(b.name)}" onerror="this.onerror=null;this.src='/sprites/placeholder.png'"><div class="badge-name">${escHtml(b.name)}</div><div class="badge-desc">${escHtml(b.description)}</div>${isActive ? '<div class="badge-active-label">* Active showcase</div>' : ''}`;
      if (earned) div.onclick = () => { sfxClick(); setActiveBadge(b.id, activeId); };
      grid.appendChild(div);
    });
  } catch { document.getElementById('badge-grid').innerHTML = '<div style="color:#cc0000">Error loading badges.</div>'; }
}
async function setActiveBadge(badgeId, currentActiveId) {
  const newId = badgeId === currentActiveId ? null : badgeId;
  try {
    const res = await fetch('/badge/set', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ badgeId: newId }) });
    const data = await res.json();
    const st = document.getElementById('badge-status');
    if (!res.ok) { st.textContent = data.error; st.style.color = '#cc0000'; return; }
    st.textContent = newId ? 'Badge set!' : 'Badge removed.'; st.style.color = '#007700';
    setTimeout(() => st.textContent = '', 2000); loadBadges();
  } catch {}
}

// ── STATS ─────────────────────────────────────────────────────
async function loadStats() {
  const el = document.getElementById('stats-content');
  el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-system);">Loading...</div>';
  try {
    const res = await fetch('/stats', { credentials:'include' });
    const d   = await res.json();
    if (!res.ok) { el.textContent = d.error; return; }
    el.innerHTML = `
      <div class="stat-row"><span class="stat-label">Username</span><span class="stat-value" style="color:${myColor}">${escHtml(d.username)}</span></div>
      <div class="stat-row"><span class="stat-label">Member since</span><span class="stat-value">${formatDate(d.createdAt)}</span></div>
      <div class="stat-row"><span class="stat-label">Coins</span><span class="stat-value stat-coins">${si('coinIcon.png',14,14,'coin')} ${fmtNum(d.coins)}</span></div>
      <div class="stat-row"><span class="stat-label">Total earned</span><span class="stat-value stat-coins">${si('coinIcon.png',14,14,'coin')} ${fmtNum(d.coinsEarned)}</span></div>
      <div class="stat-row"><span class="stat-label">Total spent</span><span class="stat-value stat-coins">${si('coinIcon.png',14,14,'coin')} ${fmtNum(d.coinsSpent)}</span></div>
      <div class="stat-row"><span class="stat-label">Messages sent</span><span class="stat-value">${d.messagesSent}</span></div>
      <div class="stat-row"><span class="stat-label">Time online</span><span class="stat-value">${formatSeconds(d.timeOnlineSeconds)}</span></div>
      <div class="stat-row"><span class="stat-label">Badges earned</span><span class="stat-value">${si('trophyIcon.png',14,14,'trophy')} ${d.earnedBadges.length}</span></div>
      <div style="font-size:12px;color:var(--text-system);margin-top:8px;text-align:center;">Stats tracked from Feb 2026</div>`;
  } catch { el.textContent = 'Error loading stats.'; }
}

// ── SHOP ──────────────────────────────────────────────────────
async function openShop() {
  winShow('shop-overlay');
  document.getElementById('shop-balance-amt').textContent = fmtNum(myCoins);
  document.getElementById('shop-status').textContent = '';
  await loadShopItems();
}
function closeShop() { document.getElementById('shop-overlay').classList.remove('open'); }
function switchShopTab(tab) {
  document.querySelectorAll('.shop-tab').forEach(t => t.classList.toggle('active', t.textContent.toLowerCase().includes(tab === 'themes' ? 'theme' : 'colour')));
  document.getElementById('shop-themes').classList.toggle('active', tab === 'themes');
  document.getElementById('shop-colors').classList.toggle('active', tab === 'colors');
}
async function loadShopItems() {
  try {
    const res = await fetch('/shop', { credentials:'include' });
    shopItems = await res.json();
    renderShopThemes(); renderShopColors();
  } catch { document.getElementById('shop-status').textContent = 'Error loading shop.'; document.getElementById('shop-status').className = 'shop-status err'; }
}
function renderShopThemes() { document.getElementById('shop-themes').innerHTML = `<div class="shop-grid">${shopItems.filter(i => i.type === 'theme').map(shopItemHtml).join('')}</div>`; }
function renderShopColors()  { document.getElementById('shop-colors').innerHTML  = `<div class="shop-grid">${shopItems.filter(i => i.type === 'color').map(shopItemHtml).join('')}</div>`; }
function shopItemHtml(item) {
  const priceHtml  = item.price === 0 ? `<span class="shop-item-price free">FREE</span>` : `<span class="shop-item-price">${si('coinIcon.png',13,13,'coin')} ${fmtNum(item.price)}</span>`;
  const badge      = item.owned ? `<span class="shop-item-owned-badge">OWNED</span>` : '';
  const btn        = item.owned ? `<button class="shop-buy-btn" disabled>Owned</button>` : `<button class="shop-buy-btn" onclick="sfxClick();buyItem('${item.id}')">Buy ${item.price === 0 ? '(Free)' : fmtNum(item.price)}</button>`;
  const nameStyle  = item.type === 'color' ? `style="color:${item.value};text-shadow:0 1px 3px rgba(0,0,0,0.55)"` : '';
  return `<div class="shop-item${item.owned?' owned':''}" id="shop-item-${item.id}">${badge}<div class="shop-item-swatch" style="background:${item.preview}"></div><div class="shop-item-name" ${nameStyle}>${escHtml(item.name)}</div><div class="shop-item-desc">${escHtml(item.description||'')}</div>${priceHtml}${btn}</div>`;
}
async function buyItem(itemId) {
  const st = document.getElementById('shop-status'); st.textContent = 'Purchasing...'; st.className = 'shop-status';
  try {
    const res = await fetch('/shop/buy', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ itemId }) });
    const data = await res.json();
    if (!res.ok) { st.textContent = data.error; st.className = 'shop-status err'; return; }
    myCoins = data.coins; updateCoinDisplay();
    const idx = shopItems.findIndex(i => i.id === itemId);
    if (idx >= 0) shopItems[idx].owned = true;
    renderShopThemes(); renderShopColors();
    st.textContent = `Purchased ${data.item.name}!`; soundCoin();
  } catch { st.textContent = 'Purchase failed.'; st.className = 'shop-status err'; }
}
document.getElementById('shop-overlay').addEventListener('click', e => { if (e.target === document.getElementById('shop-overlay') && !IS_DESKTOP()) closeShop(); });

// ── GAMES ─────────────────────────────────────────────────────
function openGames() { updateCoinDisplay(); winShow('games-overlay'); loadLeaderboard(); }
function closeGames() { document.getElementById('games-overlay').classList.remove('open'); }
function openPatchNotes()  { winShow('patchnotes-modal'); }
function closePatchNotes() { document.getElementById('patchnotes-modal').classList.remove('open'); }
function closeAnnouncement() { document.getElementById('announcement-modal').classList.remove('open'); }
function switchGame(name) {
  document.querySelectorAll('.game-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.games-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('game-' + name).classList.add('active');
  document.querySelectorAll('.games-tab').forEach(t => { if (t.textContent.toLowerCase().includes(name === 'leaderboard' ? 'board' : name)) t.classList.add('active'); });
  if (name === 'leaderboard') loadLeaderboard();
  if (name === 'roulette') initRouletteNumbers();
}
function setBet(game, amount) { document.getElementById(game + '-bet').value = amount; }

const SLOT_SYMBOLS = { '🍒':'cherryIcon.png','🍋':'lemonIcon.png','🍊':'orangeIcon.png','⭐':'starIcon.png','💎':'diamondIcon.png','7️⃣':'sevenIcon.png' };
function reelSymbolHtml(sym) { const f = SLOT_SYMBOLS[sym]; return f ? `<img class="sprite" src="/sprites/${f}" width="40" height="40" alt="${sym}" onerror="this.onerror=null;this.src='/sprites/placeholder.png'">` : sym; }

let slotsSpinning = false;
async function playSlots() {
  if (slotsSpinning) return;
  const bet = parseInt(document.getElementById('slots-bet').value, 10);
  if (!bet || bet < 1 || bet > 50000) { document.getElementById('slots-result').innerHTML = '<span class="result-lose">Bet must be 1-50000</span>'; return; }
  slotsSpinning = true;
  const btn = document.getElementById('slots-spin-btn'); btn.disabled = true;
  document.getElementById('slots-result').textContent = '';
  [0,1,2].forEach(i => document.getElementById('reel-' + i).classList.add('spinning'));
  await new Promise(r => setTimeout(r, 600));
  try {
    const res = await fetch('/game/slots', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ bet }) });
    const data = await res.json();
    [0,1,2].forEach(i => { const el = document.getElementById('reel-' + i); el.classList.remove('spinning'); el.innerHTML = data.reels ? reelSymbolHtml(data.reels[i]) : '?'; });
    if (!res.ok) document.getElementById('slots-result').innerHTML = `<span class="result-lose">${escHtml(data.error)}</span>`;
    else { myCoins = data.coins; updateCoinDisplay(); if (data.winAmount > 0) { document.getElementById('slots-result').innerHTML = `<span class="result-win">WIN! ${data.multiplier}x = +${fmtNum(data.winAmount)} coins!</span>`; soundWin(); } else { document.getElementById('slots-result').innerHTML = `<span class="result-lose">No match. Better luck next time!</span>`; soundLose(); } }
  } catch { document.getElementById('slots-result').innerHTML = '<span class="result-lose">Error. Try again.</span>'; [0,1,2].forEach(i => document.getElementById('reel-' + i).classList.remove('spinning')); }
  slotsSpinning = false; btn.disabled = false;
}

let diceRolling = false;
async function playDice() {
  if (diceRolling) return;
  const bet = parseInt(document.getElementById('dice-bet').value, 10);
  if (!bet || bet < 1 || bet > 50000) { document.getElementById('dice-result').innerHTML = '<span class="result-lose">Bet must be 1-50000</span>'; return; }
  diceRolling = true;
  const btn = document.getElementById('dice-roll-btn'); btn.disabled = true;
  document.getElementById('dice-player').innerHTML = `<img class="sprite" src="/sprites/diceIcon.png" width="36" height="36" alt="..." onerror="this.src='/sprites/placeholder.png'">`;
  document.getElementById('dice-house').innerHTML  = `<img class="sprite" src="/sprites/diceIcon.png" width="36" height="36" alt="..." onerror="this.src='/sprites/placeholder.png'">`;
  document.getElementById('dice-result').textContent = '';
  await new Promise(r => setTimeout(r, 500));
  try {
    const res = await fetch('/game/dice', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ bet }) });
    const data = await res.json();
    if (!res.ok) document.getElementById('dice-result').innerHTML = `<span class="result-lose">${escHtml(data.error)}</span>`;
    else { document.getElementById('dice-player').textContent = data.playerRoll; document.getElementById('dice-house').textContent = data.houseRoll; myCoins = data.coins; updateCoinDisplay(); if (data.result === 'win') { document.getElementById('dice-result').innerHTML = `<span class="result-win">You win! +${fmtNum(data.winAmount)} coins!</span>`; soundWin(); } else if (data.result === 'tie') document.getElementById('dice-result').innerHTML = `<span class="result-tie">Tie! Bet returned.</span>`; else { document.getElementById('dice-result').innerHTML = `<span class="result-lose">House wins. Better luck next time!</span>`; soundLose(); } }
  } catch { document.getElementById('dice-result').innerHTML = '<span class="result-lose">Error. Try again.</span>'; }
  diceRolling = false; btn.disabled = false;
}

let rouletteSpinning = false, selectedRouletteNumber = null;
async function playRoulette(betType) {
  if (rouletteSpinning) return;
  const bet = parseInt(document.getElementById('roulette-bet').value, 10);
  if (!bet || bet < 1 || bet > 50000) { document.getElementById('roulette-result').innerHTML = '<span class="result-lose">Bet must be 1-50000</span>'; return; }
  if (betType === 'number' && selectedRouletteNumber === null) { document.getElementById('roulette-result').innerHTML = '<span class="result-lose">Select a number first!</span>'; return; }
  rouletteSpinning = true;
  const spinEl = document.getElementById('roulette-spin');
  spinEl.innerHTML = `<img class="sprite" src="/sprites/rouletteIcon.png" width="40" height="40" alt="spinning" style="animation:spin 2s linear 1" onerror="this.src='/sprites/placeholder.png'">`;
  document.getElementById('roulette-result').textContent = '';
  await new Promise(r => setTimeout(r, 2000));
  try {
    const res = await fetch('/game/roulette', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ bet, betType: betType === 'number' ? selectedRouletteNumber : betType }) });
    const data = await res.json();
    if (!res.ok) document.getElementById('roulette-result').innerHTML = `<span class="result-lose">${escHtml(data.error)}</span>`;
    else { spinEl.innerHTML = `<div style="font-size:28px;">${data.spinColor}</div><div>${data.spin}</div>`; myCoins = data.coins; updateCoinDisplay(); if (data.result === 'win') { const label = betType === 'number' ? `#${selectedRouletteNumber}` : betType; document.getElementById('roulette-result').innerHTML = `<span class="result-win">${label} hits! +${fmtNum(data.winAmount)} coins!</span>`; soundWin(); } else { document.getElementById('roulette-result').innerHTML = `<span class="result-lose">House wins. Better luck next time!</span>`; soundLose(); } }
  } catch { document.getElementById('roulette-result').innerHTML = '<span class="result-lose">Error. Try again.</span>'; }
  rouletteSpinning = false;
}
function initRouletteNumbers() {
  const reds = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
  const grid = document.getElementById('roulette-number-grid'); grid.innerHTML = '';
  for (let i = 1; i <= 36; i++) {
    const btn = document.createElement('button');
    btn.className = 'roulette-num-btn ' + (reds.includes(i) ? 'red' : 'black');
    btn.innerHTML = `<div style="font-size:20px;">${reds.includes(i) ? 'R' : 'B'}</div><div>${i}</div>`;
    btn.onclick = () => { sfxClick(); selectedRouletteNumber = i; playRoulette('number'); };
    grid.appendChild(btn);
  }
}
async function loadLeaderboard() {
  const container = document.getElementById('leaderboard-rows');
  container.innerHTML = '<div style="text-align:center;color:var(--text-system);padding:20px;">Loading...</div>';
  try {
    const res = await fetch('/leaderboard', { credentials:'include' });
    const data = await res.json();
    if (!res.ok) { container.innerHTML = '<div style="color:#cc0000;text-align:center;padding:12px;">Error loading.</div>'; return; }
    const medals = ['goldMedal.png','silverMedal.png','bronzeMedal.png'];
    container.innerHTML = data.map((row, i) => {
      const rank = i < 3 ? `<img class="sprite" src="/sprites/${medals[i]}" width="20" height="20" alt="#${i+1}" onerror="this.onerror=null;this.src='/sprites/placeholder.png'">` : ` #${i+1}`;
      return `<div class="lb-row"><span class="lb-rank">${rank}</span><span class="lb-name">${escHtml(row.username)}</span><span class="lb-coins">${si('coinIcon.png',16,16,'coin')} ${fmtNum(row.coins)}</span></div>`;
    }).join('');
  } catch { container.innerHTML = '<div style="color:#cc0000;text-align:center;padding:12px;">Error loading.</div>'; }
}

// ── TICKERS ───────────────────────────────────────────────────
// Poll timers
setInterval(() => {
  document.querySelectorAll('.poll-timer').forEach(el => {
    const left = Math.max(0, Math.ceil((parseInt(el.dataset.ends, 10) - Date.now()) / 1000));
    if (left === 0) { el.textContent = 'ending...'; el.classList.add('urgent'); }
    else { const m = Math.floor(left/60), s = left%60; el.textContent = m > 0 ? `${m}m ${s}s left` : `${s}s left`; el.classList.toggle('urgent', left <= 30); }
  });
}, 1000);

// Lurking: re-evaluate fade every minute (user-list comes from server periodically, but we also check locally)
setInterval(() => {
  document.querySelectorAll('.user-entry[data-username]').forEach(entry => {
    const username = entry.dataset.username;
    const lastActive = userLastActive[username] || parseInt(entry.dataset.joinedAt, 10) || 0;
    const msSilent = Date.now() - lastActive;
    entry.classList.toggle('user-lurking', msSilent > 10 * 60 * 1000);
  });
}, 60 * 1000);

// ── KEYBOARD ─────────────────────────────────────────────────
let activityThrottle = 0;
document.addEventListener('keydown', e => {
  const now = Date.now();
  if (now - activityThrottle > 30000) { activityThrottle = now; socket.emit('activity'); }
  if (e.key === 'Escape') {
    closeSettings(); closeGames(); closeShop(); closeProfile(); closeSelfProfile();
    closeKeypad(); closeRoomCreated(); closeChangepass(); closeDailyModal();
    closeAnnouncement(); closePatchNotes();
  }
});
document.getElementById('input').addEventListener('keydown', e => { if (e.key === 'Enter') { sfxClick(); send(); } });
['login-username','login-password'].forEach(id => document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); }));
['reg-username','reg-password','reg-password2'].forEach(id => document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); }));

// ── AUTO-LOGIN ────────────────────────────────────────────────
fetch('/me').then(async res => {
  if (res.ok) { const d = await res.json(); enterChat(d.username, d.color, d.theme||'classic', d.coins||0, d.token, d.dailyAvailable); }
});