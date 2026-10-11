// Slice 1 auth — credentials via Better Auth (better-auth/crypto + account
// table), sessions with expiry. Contract unchanged: IMPLEMENTATION_PLAN.md Phase 5.1.
const crypto = require('crypto');
const { getDb, rowToUser } = require('./db');
const ba = require('./ba');

const MODE = 'better-auth';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9]{7,15}$/;

const publicUser = (u) => ({
  id: u.id, email: u.email, phone: u.phone || null, name: u.name || null,
  role: u.role, verificationLevel: u.verificationLevel,
  emailVerified: u.emailVerified, phoneVerified: u.phoneVerified,
  location: u.location || null, bio: u.bio || null,
  createdAt: u.createdAt,
});

const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(32).toString('hex');

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  return m ? m[1] : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('bad-json')); }
    });
  });
}
const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

async function handler(req, res) {
  const pathname = req.url.split('?')[0];
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') {
    try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
  }
  const db = await getDb();

  const findByLogin = async (id) => {
    const r = await db.query('SELECT * FROM users WHERE email = $1 OR LOWER(phone) = $2 LIMIT 1', [id, id]);
    return rowToUser(r.rows[0]);
  };
  const sessionUser = async () => ba.getSessionUser(db, rowToUser, bearer(req));

  // POST /api/auth/register
  if (req.method === 'POST' && pathname === '/api/auth/register') {
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim().replace(/[\s-]/g, '');
    const password = String(body.password || '');
    const name = String(body.name || '').trim() || null;
    if (!EMAIL_RE.test(email)) return send(res, 400, { ok: false, error: 'invalid-email' });
    if (phone && !PHONE_RE.test(phone)) return send(res, 400, { ok: false, error: 'invalid-phone' });
    if (password.length < 8) return send(res, 400, { ok: false, error: 'weak-password', hint: 'min 8 chars' });
    const byEmail = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (byEmail.rows.length > 0) return send(res, 409, { ok: false, error: 'email-taken' });
    if (phone) {
      const byPhone = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
      if (byPhone.rows.length > 0) return send(res, 409, { ok: false, error: 'phone-taken' });
    }
    const now = new Date().toISOString();
    const id = newId();
    await db.query(
      `INSERT INTO users (id, email, phone, name, role, verification_level, email_verified, phone_verified, password_hash, created_at)
       VALUES ($1,$2,$3,$4,'buyer',0,FALSE,FALSE,NULL,$5)`,
      [id, email, phone || null, name, now]
    );
    await ba.createCredential(db, id, email, password);
    const user = { id, email, phone: phone || null, name, role: 'buyer', verificationLevel: 0, emailVerified: false, phoneVerified: false, createdAt: now };
    return send(res, 201, { ok: true, user: publicUser(user), next: 'verify email/phone' });
  }

  // POST /api/auth/login {email|phone, password}
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const id = String(body.email || body.phone || '').trim().toLowerCase();
    const user = await findByLogin(id);
    if (!user || user.suspended || !(await ba.checkPassword(db, user, String(body.password || '')))) {
      return send(res, 401, { ok: false, error: 'bad-credentials' });
    }
    const token = await ba.createSession(db, user.id);
    return send(res, 200, { ok: true, token, user: publicUser(user) });
  }

  // POST /api/auth/logout
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const token = bearer(req);
    if (!token) return send(res, 401, { ok: false, error: 'no-token' });
    await ba.deleteSession(db, token);
    return send(res, 200, { ok: true });
  }

  // GET /api/auth/me
  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = await sessionUser();
    if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
    return send(res, 200, { ok: true, user: publicUser(user) });
  }

  // POST /api/auth/verify-email | verify-phone (dev: code returned until provider lands)
  if (req.method === 'POST' && (pathname === '/api/auth/verify-email' || pathname === '/api/auth/verify-phone')) {
    const isEmail = pathname.endsWith('verify-email');
    const identifier = String(isEmail ? body.email || '' : body.phone || '').trim().toLowerCase();
    if (!identifier) return send(res, 400, { ok: false, error: 'missing-identifier' });
    if (!body.code) {
      const code = String(crypto.randomInt(100000, 999999));
      await db.query(
        'INSERT INTO otp (identifier, code, expires) VALUES ($1,$2,$3) ON CONFLICT (identifier) DO UPDATE SET code=$2, expires=$3',
        [identifier, code, Date.now() + 10 * 60 * 1000]
      );
      // Real SMS for phone verifications when live; real email for email verifications when live.
      if (!isEmail && process.env.TERMII_SEND === '1') {
        const { sendSms } = require('./sms');
        try {
          await sendSms(identifier, `Your JOSHENT verification code is ${code}. It expires in 10 minutes. Do not share with anyone.`);
          return send(res, 200, { ok: true, sent: true });
        } catch (e) {
          return send(res, 502, { ok: false, error: 'sms-failed', hint: 'check Termii credit/sender' });
        }
      }
      if (isEmail && process.env.RESEND_SEND === '1') {
        const { sendMail } = require('./mail');
        try {
          await sendMail(identifier, 'Your Josh Enterprises verification code',
            `<p>Your verification code is <b>${code}</b>. It expires in 10 minutes.</p><p>Do not share it with anyone.</p>`);
          return send(res, 200, { ok: true, sent: true });
        } catch (e) {
          return send(res, 502, { ok: false, error: 'email-failed', hint: String(e.message).slice(0, 120) });
        }
      }
      return send(res, 200, { ok: true, sent: true, devCode: code, hint: 'no SMS/email provider yet — code returned directly' });
    }
    const rec = await db.query('SELECT * FROM otp WHERE identifier = $1', [identifier]);
    if (rec.rows.length === 0 || rec.rows[0].expires < Date.now() || rec.rows[0].code !== String(body.code)) {
      return send(res, 400, { ok: false, error: 'bad-code' });
    }
    await db.query('DELETE FROM otp WHERE identifier = $1', [identifier]);
    const col = isEmail ? 'email' : 'phone';
    const u = await db.query(`SELECT * FROM users WHERE ${col} = $1`, [identifier]);
    if (u.rows.length > 0) {
      const flag = isEmail ? 'email_verified' : 'phone_verified';
      await db.query(`UPDATE users SET ${flag} = TRUE, verification_level = GREATEST(verification_level, 1) WHERE id = $1`, [u.rows[0].id]);
      const fresh = await db.query('SELECT * FROM users WHERE id = $1', [u.rows[0].id]);
      return send(res, 200, { ok: true, user: publicUser(rowToUser(fresh.rows[0])) });
    }
    return send(res, 200, { ok: true });
  }

  // POST /api/auth/forgot-password {email} -> devToken
  if (req.method === 'POST' && pathname === '/api/auth/forgot-password') {
    const email = String(body.email || '').trim().toLowerCase();
    const token = newToken();
    await db.query('INSERT INTO resets (token, email, expires) VALUES ($1,$2,$3)', [token, email, Date.now() + 30 * 60 * 1000]);
    return send(res, 200, { ok: true, devToken: token, hint: 'no email provider yet — token returned directly' });
  }

  // POST /api/auth/reset-password {token, password}
  if (req.method === 'POST' && pathname === '/api/auth/reset-password') {
    const rec = await db.query('SELECT * FROM resets WHERE token = $1', [String(body.token || '')]);
    if (rec.rows.length === 0 || rec.rows[0].expires < Date.now()) return send(res, 400, { ok: false, error: 'bad-token' });
    if (String(body.password || '').length < 8) return send(res, 400, { ok: false, error: 'weak-password' });
    const target = await db.query('SELECT * FROM users WHERE email = $1', [rec.rows[0].email]);
    if (target.rows.length === 0) return send(res, 404, { ok: false, error: 'no-user' });
    await ba.setPassword(db, rowToUser(target.rows[0]), String(body.password));
    await db.query('DELETE FROM resets WHERE token = $1', [String(body.token)]);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false, error: 'not-found' });
}

async function requireUser(req) {
  const db = await getDb();
  const user = await ba.getSessionUser(db, rowToUser, bearer(req));
  if (!user || user.suspended) return null;
  return user;
}

module.exports = {
  mode: MODE,
  routes: [
    'POST /api/auth/register',
    'POST /api/auth/login',
    'POST /api/auth/logout',
    'GET /api/auth/me',
    'POST /api/auth/verify-email',
    'POST /api/auth/verify-phone',
    'POST /api/auth/forgot-password',
    'POST /api/auth/reset-password',
  ],
  handler,
  requireUser,
  publicUser,
};
