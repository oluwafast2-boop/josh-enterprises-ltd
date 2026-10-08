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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
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
    CREATE TABLE IF NOT EXISTS businesses (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      location TEXT,
      logo TEXT,
      banner TEXT,
      verification_status TEXT NOT NULL DEFAULT 'none',
      policies JSONB,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      sort_order INT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      seller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      price_kobo INT NOT NULL DEFAULT 0,
      stock INT NOT NULL DEFAULT 0,
      condition TEXT NOT NULL DEFAULT 'new',
      location TEXT,
      delivery_methods JSONB,
      variations JSONB,
      media JSONB,
      sku TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      price_kobo INT NOT NULL DEFAULT 0,
      location TEXT,
      is_online BOOLEAN NOT NULL DEFAULT FALSE,
      availability JSONB,
      packages JSONB,
      portfolio JSONB,
      media JSONB,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL
    );
  `);
}

const CURATED_CATEGORIES = [
  'Electronics', 'Phones & Tablets', 'Fashion', 'Beauty & Personal Care',
  'Home & Kitchen', 'Vehicles', 'Real Estate', 'Services',
];

async function seedCategories(d) {
  const existing = await d.query('SELECT COUNT(*)::int AS n FROM categories');
  if (existing.rows[0].n > 0) return;
  const crypto = require('crypto');
  let i = 0;
  for (const name of CURATED_CATEGORIES) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    await d.query('INSERT INTO categories (id, parent_id, name, slug, sort_order) VALUES ($1,NULL,$2,$3,$4)',
      [crypto.randomUUID(), name, slug, i++]);
  }
}

async function seedAdminFromEnv(d) {
  // Boot-time admin bootstrap (ADMIN_EMAIL + ADMIN_PASSWORD set): only when
  // users table is empty. Dev/local scaffolding until admin invites exist.
  const existing = await d.query('SELECT COUNT(*)::int AS n FROM users');
  if (existing.rows[0].n > 0) return;
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email || password.length < 8) return;
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  await d.query(
    `INSERT INTO users (id, email, phone, name, role, verification_level, email_verified, phone_verified, password_hash, created_at)
     VALUES ($1,$2,NULL,$3,'admin',1,TRUE,FALSE,$4,$5)`,
    [crypto.randomUUID(), email, 'Admin', `scrypt:${salt}:${hash}`, new Date().toISOString()]
  );
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
    await seedCategories(db);
    await seedAdminFromEnv(db);
  }
  return db;
}

const rowToUser = (r) => r ? {
  id: r.id, email: r.email, phone: r.phone, name: r.name, role: r.role,
  verificationLevel: r.verification_level, emailVerified: r.email_verified,
  phoneVerified: r.phone_verified, passwordHash: r.password_hash, createdAt: r.created_at,
  location: r.location || null, bio: r.bio || null,
} : null;

module.exports = { getDb, rowToUser, MODE: 'pglite' };
