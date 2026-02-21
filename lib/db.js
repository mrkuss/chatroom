const { Pool } = require('pg');

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
      color TEXT NOT NULL DEFAULT '#000080',
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
  await db.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      is_private BOOLEAN NOT NULL DEFAULT false,
      password_hash TEXT,
      creator TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`INSERT INTO rooms (name) VALUES ('general'), ('random'), ('gambling') ON CONFLICT (name) DO NOTHING`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room TEXT,
      sender TEXT NOT NULL,
      recipient TEXT,
      type TEXT NOT NULL DEFAULT 'chat',
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS IDX_messages_room ON messages (room, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS IDX_messages_dm ON messages (sender, recipient, created_at DESC)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY,
      room TEXT NOT NULL,
      question TEXT NOT NULL,
      options JSONB NOT NULL,
      votes JSONB NOT NULL DEFAULT '{}',
      creator TEXT NOT NULL,
      ends_at TIMESTAMPTZ,
      concluded BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS shop_purchases (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      item_id TEXT NOT NULL,
      purchased_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(username, item_id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS reactions (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(message_id, username)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS IDX_reactions_message ON reactions (message_id)`);

  // ── Persistent private room access ─────────────────────────────────────────
  // Stores which users have been granted access to which private rooms
  await db.query(`
    CREATE TABLE IF NOT EXISTS private_room_access (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      room_name TEXT NOT NULL,
      granted_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(username, room_name)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS IDX_pra_username ON private_room_access (LOWER(username))`);

  // ── Room bans ──────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS room_bans (
      id SERIAL PRIMARY KEY,
      room_name TEXT NOT NULL,
      banned_username TEXT NOT NULL,
      banned_by TEXT NOT NULL,
      banned_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(room_name, banned_username)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS IDX_room_bans_room ON room_bans (room_name, LOWER(banned_username))`);

  // ── Coin Clicker Breaks Tracking ────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS coin_breaker_tracker (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      breaks_count INTEGER NOT NULL DEFAULT 0,
      reset_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS IDX_cbt_username ON coin_breaker_tracker (LOWER(username))`);

  // ── Safe column upgrades ───────────────────────────────────────────────────
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#000080'`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'classic'`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 100`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily TIMESTAMPTZ`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS coins_earned INTEGER NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS coins_spent INTEGER NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS messages_sent INTEGER NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS time_online_seconds INTEGER NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_gamble BOOLEAN NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_badge TEXT`);
  await db.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ`);
  await db.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS concluded BOOLEAN NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await db.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS creator TEXT`);
  await db.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS owner_code TEXT`);
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_id TEXT`);

  console.log('Database initialised');
}

module.exports = { db, initDb };