// Postgres via PGlite (embedded, zero-install). Same SQL dialect as the
// Docker Postgres in compose — swap to server PG later by changing one
// connection. Data in <repo>/data/pglite (gitignored).
const path = require('path');

const DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'pglite');

let db = null;

async function initSchema(d) {
  await d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'buyer',
      verification_level INT NOT NULL DEFAULT 0,
      email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS otp (
      identifier TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resets (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires BIGINT NOT NULL
    );
  `);
}

async function importFileStore(d) {
  // One-time: adopt users from the pre-DB file store, then archive it.
  const fs = require('fs');
  const f = path.resolve(__dirname, '..', '..', '..', 'data', 'users.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return; }
  if (!Array.isArray(list) || list.length === 0) return;
  const existing = await d.query('SELECT COUNT(*)::int AS n FROM users');
  if (existing.rows[0].n > 0) return;
  for (const u of list) {
    await d.query(
      `INSERT INTO users (id, email, phone, name, role, verification_level, email_verified, phone_verified, password_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [u.id, u.email, u.phone || null, u.name || null, u.role || 'buyer', u.verificationLevel || 0,
       !!u.emailVerified, !!u.phoneVerified, u.passwordHash, u.createdAt]
    );
  }
  fs.renameSync(f, f + '.imported');
}

async function getDb() {
  if (!db) {
    const { PGlite } = require('@electric-sql/pglite');
    db = new PGlite(DIR);
    await db.waitReady;
    await initSchema(db);
    await importFileStore(db);
  }
  return db;
}

const rowToUser = (r) => r ? {
  id: r.id, email: r.email, phone: r.phone, name: r.name, role: r.role,
  verificationLevel: r.verification_level, emailVerified: r.email_verified,
  phoneVerified: r.phone_verified, passwordHash: r.password_hash, createdAt: r.created_at,
} : null;

module.exports = { getDb, rowToUser, MODE: 'pglite' };
