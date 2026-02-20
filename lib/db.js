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

  // Safe column upgrades
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#000080'`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'classic'`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 100`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily TIMESTAMPTZ`);
  await db.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ`);
  await db.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS concluded BOOLEAN NOT NULL DEFAULT false`);

  // Migrate: give all existing users the free default items they already "own"
  // (classic theme + navy color are free, no purchase record needed — handled in shop logic)

  console.log('Database initialised');
}

module.exports = { db, initDb };