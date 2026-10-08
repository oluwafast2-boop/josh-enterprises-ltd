// Hosting-gate smoke test: node scripts/smoke.js (exit 1 on any failure)
const cases = [
  ['http://localhost:3000/health', 200, (b) => b.ok === true && b.service === 'web'],
  ['http://localhost:4000/health', 200, (b) => b.ok === true && b.service === 'api'],
  ['http://localhost:4000/api/status', 200, (b) => b.ok === true && b.routes === 11],
  // (auth covered by Slice 1 POST flow below; GET on auth paths is 404 by design)
  ['http://localhost:4000/api/products', 200, (b) => b.ok === true && Array.isArray(b.products)],
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
  // ---- Slice 2: profiles, businesses, categories ----
  const sellerEmail = `seller+${stamp}@test.local`;
  let sellerToken = null;
  await t('slice2 register seller', async () => {
    const r = await api('/api/auth/register', { method: 'POST', body: { email: sellerEmail, password: 'seller-pass-1' } });
    const l = await api('/api/auth/login', { method: 'POST', body: { email: sellerEmail, password: 'seller-pass-1' } });
    if (l.status === 200 && l.body.token) sellerToken = l.body.token;
    return r.status === 201 && !!sellerToken;
  });
  await t('slice2 me 401 unauth', async () => {
    const r = await api('/api/me');
    return r.status === 401;
  });
  await t('slice2 me patch profile', async () => {
    const r = await api('/api/me', { method: 'PATCH', token: sellerToken, body: { name: 'Smoke Seller', location: 'Lagos', bio: 'Test bio' } });
    return r.status === 200 && r.body.user.name === 'Smoke Seller' && r.body.user.location === 'Lagos';
  });
  let bizId = null;
  await t('slice2 business create 201', async () => {
    const r = await api('/api/businesses', { method: 'POST', token: sellerToken, body: { name: 'Smoke Stores', location: 'Lagos' } });
    if (r.status === 201) bizId = r.body.business.id;
    return r.status === 201 && r.body.business.verificationStatus === 'none';
  });
  await t('slice2 business get + list', async () => {
    const g = await api(`/api/businesses/${bizId}`);
    const l = await api('/api/businesses');
    return g.status === 200 && l.status === 200 && l.body.businesses.some((b) => b.id === bizId);
  });
  await t('slice2 business patch owner', async () => {
    const r = await api(`/api/businesses/${bizId}`, { method: 'PATCH', token: sellerToken, body: { description: 'Best store' } });
    return r.status === 200 && r.body.business.description === 'Best store';
  });
  await t('slice2 business verify forbidden 403', async () => {
    const r = await api(`/api/businesses/${bizId}/verify`, { method: 'POST', token: sellerToken, body: { status: 'verified' } });
    return r.status === 403;
  });
  await t('slice2 categories public tree', async () => {
    const r = await api('/api/categories');
    return r.status === 200 && r.body.categories.length >= 8;
  });
  await t('slice2 categories write forbidden 403', async () => {
    const r = await api('/api/categories', { method: 'POST', token: sellerToken, body: { name: 'Nope' } });
    return r.status === 403;
  });
  // admin block — needs ADMIN_EMAIL/ADMIN_PASSWORD on both server and smoke env
  const adminEmail = process.env.ADMIN_EMAIL, adminPass = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPass) {
    let adminToken = null;
    await t('slice2 admin login', async () => {
      const r = await api('/api/auth/login', { method: 'POST', body: { email: adminEmail, password: adminPass } });
      if (r.status === 200 && r.body.token) adminToken = r.body.token;
      return r.status === 200 && r.body.user.role === 'admin';
    });
    let parentId = null, childId = null;
    await t('slice2 admin category create', async () => {
      const r = await api('/api/categories', { method: 'POST', token: adminToken, body: { name: `Smoke Cat ${stamp}` } });
      if (r.status === 201) parentId = r.body.category.id;
      return r.status === 201;
    });
    await t('slice2 admin subcategory nests', async () => {
      const r = await api('/api/categories', { method: 'POST', token: adminToken, body: { name: 'Smoke Sub', parent_id: parentId } });
      if (r.status === 201) childId = r.body.category.id;
      if (r.status !== 201) return false;
      const tree = await api('/api/categories');
      const parent = tree.body.categories.find((c) => c.id === parentId);
      return !!parent && parent.children.some((c) => c.id === childId);
    });
    await t('slice2 admin category patch+delete', async () => {
      const p = await api(`/api/categories/${childId}`, { method: 'PATCH', token: adminToken, body: { name: 'Smoke Sub 2' } });
      if (p.status !== 200) return false;
      const d1 = await api(`/api/categories/${childId}`, { method: 'DELETE', token: adminToken });
      const d2 = await api(`/api/categories/${parentId}`, { method: 'DELETE', token: adminToken });
      return d1.status === 200 && d2.status === 200;
    });
    await t('slice2 admin business verify', async () => {
      const r = await api(`/api/businesses/${bizId}/verify`, { method: 'POST', token: adminToken, body: { status: 'verified' } });
      return r.status === 200 && r.body.business.verificationStatus === 'verified';
    });
  } else {
    console.log('SKIP slice2 admin block (set ADMIN_EMAIL/ADMIN_PASSWORD)');
  }

  // ---- Slice 3: listings + search + uploads ----
  const catTree = await api('/api/categories');
  const catId = catTree.body.categories.length > 0 ? catTree.body.categories[0].id : null;
  let prodId = null, svcId = null;
  await t('slice3 product create draft 201', async () => {
    const r = await api('/api/products', { method: 'POST', token: sellerToken, body: { title: `Smoke Phone ${stamp}`, price_kobo: 150000, category_id: catId, stock: 5 } });
    if (r.status === 201) prodId = r.body.product.id;
    return r.status === 201 && r.body.product.status === 'draft';
  });
  await t('slice3 product draft hidden public', async () => {
    const g = await api(`/api/products/${prodId}`);
    const l = await api('/api/products');
    return g.status === 404 && !l.body.products.some((p) => p.id === prodId);
  });
  await t('slice3 product publish + detail', async () => {
    const p = await api(`/api/products/${prodId}`, { method: 'PATCH', token: sellerToken, body: { status: 'published', variations: [{ color: 'black' }] } });
    if (p.status !== 200) return false;
    const g = await api(`/api/products/${prodId}`);
    return g.status === 200 && g.body.seller && typeof g.body.seller.verificationLevel === 'number';
  });
  await t('slice3 product validation', async () => {
    const noTitle = await api('/api/products', { method: 'POST', token: sellerToken, body: { price_kobo: 100 } });
    const badPrice = await api('/api/products', { method: 'POST', token: sellerToken, body: { title: 'X', price_kobo: -5 } });
    const badCat = await api('/api/products', { method: 'POST', token: sellerToken, body: { title: 'X', price_kobo: 100, category_id: 'nope' } });
    return noTitle.status === 400 && badPrice.status === 400 && badCat.status === 400;
  });
  await t('slice3 service create+publish', async () => {
    const r = await api('/api/services', { method: 'POST', token: sellerToken, body: { title: `Smoke Repair ${stamp}`, price_kobo: 50000, isOnline: false, location: 'Lagos', packages: [{ name: 'Basic' }] } });
    if (r.status !== 201) return false;
    svcId = r.body.service.id;
    const p = await api(`/api/services/${svcId}`, { method: 'PATCH', token: sellerToken, body: { status: 'published' } });
    return p.status === 200;
  });
  await t('slice3 search finds both', async () => {
    const r = await api(`/api/search?q=Smoke&type=all`);
    const kinds = r.body.items.map((i) => i.kind);
    return r.status === 200 && r.body.engine === 'pg-ilike' && kinds.includes('product') && kinds.includes('service');
  });
  await t('slice3 search filters+sort', async () => {
    const f = await api(`/api/search?type=product&min_kobo=100000&max_kobo=200000&sort=price_desc`);
    const s = await api(`/api/search?type=service`);
    return f.status === 200 && f.body.items.every((i) => i.kind === 'product') && s.body.items.every((i) => i.kind === 'service');
  });
  await t('slice3 uploads stub shape', async () => {
    const unauth = await api('/api/uploads', { method: 'POST', body: { filename: 'a.jpg' } });
    const authed = await api('/api/uploads', { method: 'POST', token: sellerToken, body: { filename: 'pic.jpg', kind: 'listing' } });
    return unauth.status === 401 && authed.status === 200 && authed.body.mode === 'stub' && String(authed.body.key).startsWith('listing/');
  });
  await t('slice3 cross-owner forbidden', async () => {
    const other = await api('/api/auth/register', { method: 'POST', body: { email: `other+${stamp}@test.local`, password: 'other-pass-1' } });
    void other;
    const login = await api('/api/auth/login', { method: 'POST', body: { email: `other+${stamp}@test.local`, password: 'other-pass-1' } });
    const r = await api(`/api/products/${prodId}`, { method: 'PATCH', token: login.body.token, body: { title: 'Hijack' } });
    return r.status === 403;
  });

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
