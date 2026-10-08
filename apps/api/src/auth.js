// Slice 1 auth — real logic, file-backed store (Postgres + Better Auth later).
// Mode: 'file-store'. Contract: IMPLEMENTATION_PLAN.md Phase 5.1.
const crypto = require('crypto');
const store = require('./store');

const MODE = (() => {
  try {
    require.resolve('better-auth');
    return process.env.BETTER_AUTH_SECRET ? 'real' : 'file-store';
  } catch {
    return 'file-store';
  }
})();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9]{7,15}$/;

const publicUser = (u) => ({
  id: u.id, email: u.email, phone: u.phone || null, name: u.name || null,
  role: u.role, verificationLevel: u.verificationLevel,
  emailVerified: u.emailVerified, phoneVerified: u.phoneVerified,
  createdAt: u.createdAt,
});

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored).split(':');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
}
const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(32).toString('hex');

const users = () => store.read('users.json', []);
const saveUsers = (list) => store.write('users.json', list);
const sessions = () => store.read('sessions.json', {});
const saveSessions = (s) => store.write('sessions.json', s);

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  return m ? m[1] : null;
}
function sessionUser(req) {
  const token = bearer(req);
  if (!token) return null;
  const s = sessions()[token];
  if (!s) return null;
  return users().find((u) => u.id === s.userId) || null;
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

  // POST /api/auth/register
  if (req.method === 'POST' && pathname === '/api/auth/register') {
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim().replace(/[\s-]/g, '');
    const password = String(body.password || '');
    const name = String(body.name || '').trim() || null;
    if (!EMAIL_RE.test(email)) return send(res, 400, { ok: false, error: 'invalid-email' });
    if (phone && !PHONE_RE.test(phone)) return send(res, 400, { ok: false, error: 'invalid-phone' });
    if (password.length < 8) return send(res, 400, { ok: false, error: 'weak-password', hint: 'min 8 chars' });
    const list = users();
    if (list.some((u) => u.email === email)) return send(res, 409, { ok: false, error: 'email-taken' });
    if (phone && list.some((u) => u.phone === phone)) return send(res, 409, { ok: false, error: 'phone-taken' });
    const user = {
      id: newId(), email, phone: phone || null, name, role: 'buyer',
      verificationLevel: 0, emailVerified: false, phoneVerified: false,
      passwordHash: hashPassword(password), createdAt: new Date().toISOString(),
    };
    list.push(user);
    saveUsers(list);
    return send(res, 201, { ok: true, user: publicUser(user), next: 'verify email/phone' });
  }

  // POST /api/auth/login {email|phone, password}
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const id = String(body.email || body.phone || '').trim().toLowerCase();
    const list = users();
    const user = list.find((u) => u.email === id || (u.phone && u.phone.toLowerCase() === id));
    if (!user || !verifyPassword(String(body.password || ''), user.passwordHash)) {
      return send(res, 401, { ok: false, error: 'bad-credentials' });
    }
    const token = newToken();
    const s = sessions();
    s[token] = { userId: user.id, createdAt: new Date().toISOString() };
    saveSessions(s);
    return send(res, 200, { ok: true, token, user: publicUser(user) });
  }

  // POST /api/auth/logout
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const token = bearer(req);
    if (!token) return send(res, 401, { ok: false, error: 'no-token' });
    const s = sessions();
    delete s[token];
    saveSessions(s);
    return send(res, 200, { ok: true });
  }

  // GET /api/auth/me
  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = sessionUser(req);
    if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
    return send(res, 200, { ok: true, user: publicUser(user) });
  }

  // POST /api/auth/verify-email {email, code?} — dev: returns code until SMS/email provider lands
  // POST /api/auth/verify-phone {phone, code?}
  if (req.method === 'POST' && (pathname === '/api/auth/verify-email' || pathname === '/api/auth/verify-phone')) {
    const isEmail = pathname.endsWith('verify-email');
    const identifier = String(isEmail ? body.email || '' : body.phone || '').trim().toLowerCase();
    if (!identifier) return send(res, 400, { ok: false, error: 'missing-identifier' });
    const otps = store.read('otp.json', {});
    if (!body.code) {
      const code = String(crypto.randomInt(100000, 999999));
      otps[identifier] = { code, expires: Date.now() + 10 * 60 * 1000 };
      store.write('otp.json', otps);
      return send(res, 200, { ok: true, sent: true, devCode: code, hint: 'no SMS/email provider yet — code returned directly' });
    }
    const rec = otps[identifier];
    if (!rec || rec.expires < Date.now() || rec.code !== String(body.code)) {
      return send(res, 400, { ok: false, error: 'bad-code' });
    }
    delete otps[identifier];
    store.write('otp.json', otps);
    const list = users();
    const user = list.find((u) => (isEmail ? u.email === identifier : (u.phone || '').toLowerCase() === identifier));
    if (user) {
      if (isEmail) user.emailVerified = true; else user.phoneVerified = true;
      user.verificationLevel = Math.max(user.verificationLevel, 1);
      saveUsers(list);
      return send(res, 200, { ok: true, user: publicUser(user) });
    }
    return send(res, 200, { ok: true });
  }

  // POST /api/auth/forgot-password {email} -> devToken
  if (req.method === 'POST' && pathname === '/api/auth/forgot-password') {
    const email = String(body.email || '').trim().toLowerCase();
    const resets = store.read('resets.json', {});
    const token = newToken();
    resets[token] = { email, expires: Date.now() + 30 * 60 * 1000 };
    store.write('resets.json', resets);
    return send(res, 200, { ok: true, devToken: token, hint: 'no email provider yet — token returned directly' });
  }

  // POST /api/auth/reset-password {token, password}
  if (req.method === 'POST' && pathname === '/api/auth/reset-password') {
    const resets = store.read('resets.json', {});
    const rec = resets[String(body.token || '')];
    if (!rec || rec.expires < Date.now()) return send(res, 400, { ok: false, error: 'bad-token' });
    if (String(body.password || '').length < 8) return send(res, 400, { ok: false, error: 'weak-password' });
    const list = users();
    const user = list.find((u) => u.email === rec.email);
    if (!user) return send(res, 404, { ok: false, error: 'no-user' });
    user.passwordHash = hashPassword(String(body.password));
    saveUsers(list);
    delete resets[String(body.token)];
    store.write('resets.json', resets);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false, error: 'not-found' });
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
  // test-only: remove a user by email (smoke cleanup)
  __removeUser(email) {
    saveUsers(users().filter((u) => u.email !== email));
  },
};
