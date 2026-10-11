// Better Auth as the credential engine: password hashing/verification via
// better-auth/crypto, credentials in the `account` table, sessions with
// expiry. API contract unchanged (endpoints, codes, shapes all identical).
const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('better-auth/crypto');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function createCredential(db, userId, email, password) {
  const hash = await hashPassword(password);
  await db.query(
    "INSERT INTO account (id, user_id, provider, provider_account_id, password, created_at) VALUES ($1,$2,'credential',$3,$4,$5)",
    [crypto.randomUUID(), userId, email.toLowerCase(), hash, new Date().toISOString()]
  );
}

// Returns true when password matches. Transparently migrates legacy
// `scrypt:salt:hash` passwords to better-auth hashes on success.
async function checkPassword(db, user, password) {
  const acc = await db.query("SELECT * FROM account WHERE user_id = $1 AND provider = 'credential' LIMIT 1", [user.id]);
  if (acc.rows.length > 0 && acc.rows[0].password) {
    return verifyPassword({ hash: acc.rows[0].password, password });
  }
  // legacy path (pre-Better-Auth accounts)
  const [algo, salt, hash] = String(user.passwordHash || '').split(':');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex')); } catch { ok = false; }
  if (ok) {
    await db.query('DELETE FROM account WHERE user_id = $1 AND provider = $2', [user.id, 'credential']);
    await createCredential(db, user.id, user.email, password);
    await db.query('UPDATE users SET password_hash = NULL WHERE id = $1', [user.id]);
  }
  return ok;
}

async function setPassword(db, user, password) {
  await db.query('DELETE FROM account WHERE user_id = $1 AND provider = $2', [user.id, 'credential']);
  await createCredential(db, user.id, user.email, password);
  await db.query('UPDATE users SET password_hash = NULL WHERE id = $1', [user.id]);
}

async function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  await db.query('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ($1,$2,$3,$4)',
    [token, userId, now, Date.now() + SESSION_TTL_MS]);
  return token;
}

async function getSessionUser(db, rowToUser, token) {
  if (!token) return null;
  const s = await db.query('SELECT user_id, expires_at FROM sessions WHERE token = $1', [token]);
  if (s.rows.length === 0) return null;
  if (s.rows[0].expires_at && Number(s.rows[0].expires_at) < Date.now()) {
    await db.query('DELETE FROM sessions WHERE token = $1', [token]);
    return null;
  }
  const u = await db.query('SELECT * FROM users WHERE id = $1', [s.rows[0].user_id]);
  return rowToUser(u.rows[0]);
}

async function deleteSession(db, token) {
  await db.query('DELETE FROM sessions WHERE token = $1', [token]);
}

module.exports = { createCredential, checkPassword, setPassword, createSession, getSessionUser, deleteSession, SESSION_TTL_MS };
