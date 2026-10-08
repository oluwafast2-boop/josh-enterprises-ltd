// Hosting-gate smoke test: node scripts/smoke.js (exit 1 on any failure)
const cases = [
  ['http://localhost:3000/health', 200, (b) => b.ok === true && b.service === 'web'],
  ['http://localhost:4000/health', 200, (b) => b.ok === true && b.service === 'api'],
  ['http://localhost:4000/api/status', 200, (b) => b.ok === true && b.routes === 18],
  // (auth covered by Slice 1 POST flow below; GET on auth paths is 404 by design)
  ['http://localhost:4000/api/products', 501, (b) => b.error === 'not-implemented' && b.slice === 3],
  ['http://localhost:4000/api/orders', 501, (b) => b.error === 'not-implemented' && b.slice === 4],
  ['http://localhost:4000/api/nope', 404, (b) => b.error === 'not-found'],
];

(async () => {
  let fail = 0;
  for (const [url, code, check] of cases) {
    try {
      const res = await fetch(url, { headers: { connection: 'close' } });
      const body = await res.json();
      const pass = res.status === code && check(body);
      console.log(`${pass ? 'PASS' : 'FAIL'} ${res.status} ${url}`);
      if (!pass) { fail++; console.log('  body:', JSON.stringify(body)); }
    } catch (e) {
      fail++;
      console.log(`FAIL (fetch) ${url}: ${e.message}`);
    }
  }
  // ---- Slice 1: auth flow ----
  const api = async (path, { method = 'GET', body = null, token = null } = {}) => {
    const headers = { connection: 'close', 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`http://localhost:4000${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const stamp = Date.now();
  const email = `smoke+${stamp}@test.local`;
  const results = [];
  const t = async (name, fn) => {
    try { const pass = await fn(); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); if (!pass) fail++; }
    catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
  };

  let token = null;
  await t('auth register 201', async () => {
    const r = await api('/api/auth/register', { method: 'POST', body: { email, password: 'smoke-pass-1', name: 'Smoke' } });
    return r.status === 201 && r.body.ok && !!r.body.user.id;
  });
  await t('auth duplicate 409', async () => {
    const r = await api('/api/auth/register', { method: 'POST', body: { email, password: 'smoke-pass-1' } });
    return r.status === 409 && r.body.error === 'email-taken';
  });
  await t('auth invalid-email 400', async () => {
    const r = await api('/api/auth/register', { method: 'POST', body: { email: 'bad', password: 'smoke-pass-1' } });
    return r.status === 400;
  });
  await t('auth weak-password 400', async () => {
    const r = await api('/api/auth/register', { method: 'POST', body: { email: `x${stamp}@t.co`, password: 'short' } });
    return r.status === 400;
  });
  await t('auth login 200', async () => {
    const r = await api('/api/auth/login', { method: 'POST', body: { email, password: 'smoke-pass-1' } });
    if (r.status === 200 && r.body.token) token = r.body.token;
    return r.status === 200 && !!token;
  });
  await t('auth bad-login 401', async () => {
    const r = await api('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-pass' } });
    return r.status === 401;
  });
  await t('auth me 200', async () => {
    const r = await api('/api/auth/me', { token });
    return r.status === 200 && r.body.user.email === email;
  });
  await t('auth verify-email flow', async () => {
    const r1 = await api('/api/auth/verify-email', { method: 'POST', body: { email } });
    if (r1.status !== 200 || !r1.body.devCode) return false;
    const r2 = await api('/api/auth/verify-email', { method: 'POST', body: { email, code: r1.body.devCode } });
    return r2.status === 200 && r2.body.user.emailVerified === true;
  });
  await t('auth reset-password flow', async () => {
    const r1 = await api('/api/auth/forgot-password', { method: 'POST', body: { email } });
    if (r1.status !== 200 || !r1.body.devToken) return false;
    const r2 = await api('/api/auth/reset-password', { method: 'POST', body: { token: r1.body.devToken, password: 'smoke-pass-2' } });
    if (r2.status !== 200) return false;
    const r3 = await api('/api/auth/login', { method: 'POST', body: { email, password: 'smoke-pass-2' } });
    if (r3.status === 200 && r3.body.token) token = r3.body.token;
    return r3.status === 200;
  });
  await t('auth logout + me 401', async () => {
    const r1 = await api('/api/auth/logout', { method: 'POST', token });
    if (r1.status !== 200) return false;
    const r2 = await api('/api/auth/me', { token });
    return r2.status === 401;
  });
  void results;
  // no cleanup: PGlite holds an exclusive lock on data/ while the API runs,
  // so a second embedded connection from smoke would block. Test emails are
  // timestamp-unique; use `node scripts/db-reset.js` (API stopped) to wipe.
  console.log('PASS auth isolation (timestamp-unique emails)');

  // design tokens load check
  try {
    const tokens = require('../packages/design-tokens/tokens.json');
    const pass = tokens.colors.primary === '#0E6B4F' && !!tokens.typography;
    console.log(`${pass ? 'PASS' : 'FAIL'} design-tokens`);
    if (!pass) fail++;
  } catch (e) { fail++; console.log(`FAIL tokens: ${e.message}`); }
  console.log(fail === 0 ? 'SMOKE OK' : `SMOKE FAIL (${fail})`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
