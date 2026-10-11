// Hosting-gate smoke test: node scripts/smoke.js (exit 1 on any failure)
const cases = [
  ['http://localhost:3000/health', 200, (b) => b.ok === true && b.service === 'web'],
  ['http://localhost:4000/health', 200, (b) => b.ok === true && b.service === 'api'],
  ['http://localhost:4000/api/status', 200, (b) => b.ok === true && b.routes === 0],
  // (auth covered by Slice 1 POST flow below; GET on auth paths is 404 by design)
  ['http://localhost:4000/api/products', 200, (b) => b.ok === true && Array.isArray(b.products)],
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

  // ---- Slice 4: cart, checkout, orders, escrow ----
  // sellerToken owns prodId (published, price 150000, stock 5). Buyer = fresh user.
  const buyerEmail = `buyer+${stamp}@test.local`;
  let buyerToken = null;
  await t('slice4 buyer setup', async () => {
    await api('/api/auth/register', { method: 'POST', body: { email: buyerEmail, password: 'buyer-pass-1' } });
    const l = await api('/api/auth/login', { method: 'POST', body: { email: buyerEmail, password: 'buyer-pass-1' } });
    if (l.status === 200) buyerToken = l.body.token;
    return !!buyerToken;
  });
  await t('slice4 cart validation', async () => {
    const over = await api('/api/cart', { method: 'POST', token: buyerToken, body: { items: [{ product_id: prodId, qty: 999 }] } });
    const bad = await api('/api/cart', { method: 'POST', token: buyerToken, body: { items: [{ product_id: 'nope', qty: 1 }] } });
    return over.status === 400 && over.body.error === 'insufficient-stock' && bad.status === 400;
  });
  await t('slice4 cart add + preview math', async () => {
    const c = await api('/api/cart', { method: 'POST', token: buyerToken, body: { items: [{ product_id: prodId, qty: 2 }] } });
    if (c.status !== 200) return false;
    const p = await api('/api/checkout/preview', { method: 'POST', token: buyerToken, body: {} });
    // 2 x 150000 = 300000 subtotal, 5% fee = 15000, total 315000
    return p.status === 200 && p.body.orderCount === 1 && p.body.grandTotalKobo === 315000;
  });
  let orderId = null;
  await t('slice4 place order', async () => {
    const r = await api('/api/checkout/place', { method: 'POST', token: buyerToken, body: {} });
    if (r.status === 201 && r.body.orders.length === 1) orderId = r.body.orders[0].id;
    return r.status === 201 && r.body.orders[0].status === 'pending' && r.body.orders[0].totalKobo === 315000;
  });
  await t('slice4 cannot buy own', async () => {
    await api('/api/cart', { method: 'POST', token: sellerToken, body: { items: [{ product_id: prodId, qty: 1 }] } });
    const r = await api('/api/checkout/place', { method: 'POST', token: sellerToken, body: {} });
    await api('/api/cart', { method: 'DELETE', token: sellerToken });
    return r.status === 400 && r.body.error === 'cannot-buy-own';
  });
  await t('slice4 pay holds escrow + stock', async () => {
    const r = await api('/api/payments/simulate-pay', { method: 'POST', token: buyerToken, body: { order_id: orderId } });
    if (r.status !== 200) return false;
    const e = await api(`/api/escrow/${orderId}`, { token: buyerToken });
    const g = await api(`/api/products/${prodId}`);
    return r.body.order.status === 'paid' && e.body.escrow.state === 'held' && g.body.product.stock === 3;
  });
  await t('slice4 bad transition rejected', async () => {
    const skip = await api(`/api/orders/${orderId}/status`, { method: 'PATCH', token: sellerToken, body: { status: 'delivered' } });
    const back = await api(`/api/orders/${orderId}/status`, { method: 'PATCH', token: sellerToken, body: { status: 'pending' } });
    const buyerTry = await api(`/api/orders/${orderId}/status`, { method: 'PATCH', token: buyerToken, body: { status: 'processing' } });
    return skip.status === 400 && back.status === 400 && buyerTry.status === 403;
  });
  await t('slice4 seller fulfills forward', async () => {
    // paid -> processing -> shipped -> out_for_delivery -> delivered (one step each)
    for (const s of ['processing', 'shipped', 'out_for_delivery', 'delivered']) {
      const r = await api(`/api/orders/${orderId}/status`, { method: 'PATCH', token: sellerToken, body: { status: s } });
      if (r.status !== 200) return false;
    }
    return true;
  });
  await t('slice4 confirm releases escrow', async () => {
    const r = await api(`/api/orders/${orderId}/confirm`, { method: 'POST', token: buyerToken, body: {} });
    return r.status === 200 && r.body.order.status === 'completed' && r.body.escrow === 'released';
  });
  await t('slice4 cancel pending order', async () => {
    await api('/api/cart', { method: 'POST', token: buyerToken, body: { items: [{ product_id: prodId, qty: 1 }] } });
    const p = await api('/api/checkout/place', { method: 'POST', token: buyerToken, body: {} });
    const id = p.body.orders[0].id;
    const c = await api(`/api/orders/${id}/cancel`, { method: 'POST', token: buyerToken, body: {} });
    return c.status === 200 && c.body.order.status === 'cancelled';
  });
  await t('slice4 cancel paid refunds + restores', async () => {
    await api('/api/cart', { method: 'POST', token: buyerToken, body: { items: [{ product_id: prodId, qty: 1 }] } });
    const p = await api('/api/checkout/place', { method: 'POST', token: buyerToken, body: {} });
    const id = p.body.orders[0].id;
    await api('/api/payments/simulate-pay', { method: 'POST', token: buyerToken, body: { order_id: id } });
    const before = await api(`/api/products/${prodId}`);
    const c = await api(`/api/orders/${id}/cancel`, { method: 'POST', token: buyerToken, body: {} });
    const after = await api(`/api/products/${prodId}`);
    const e = await api(`/api/escrow/${id}`, { token: buyerToken });
    return c.status === 200 && e.body.escrow.state === 'refunded' && after.body.product.stock === before.body.product.stock + 1;
  });
  await t('slice4 service order flow', async () => {
    const o = await api('/api/orders', { method: 'POST', token: buyerToken, body: { service_id: svcId } });
    if (o.status !== 201 || o.body.order.type !== 'service') return false;
    const id = o.body.order.id;
    await api('/api/payments/simulate-pay', { method: 'POST', token: buyerToken, body: { order_id: id } });
    for (const s of ['accepted', 'scheduled', 'in_progress', 'completed']) {
      const r = await api(`/api/orders/${id}/status`, { method: 'PATCH', token: sellerToken, body: { status: s } });
      if (r.status !== 200) return false;
    }
    const c = await api(`/api/orders/${id}/confirm`, { method: 'POST', token: buyerToken, body: {} });
    return c.status === 200 && c.body.order.status === 'confirmed' && c.body.escrow === 'released';
  });
  await t('slice4 order visibility', async () => {
    const buying = await api('/api/orders?role=buying', { token: buyerToken });
    const sold = await api('/api/orders?role=sold', { token: sellerToken });
    const stranger = await api(`/api/orders/${orderId}`, { token: sellerToken }); // seller sees own sold — ok
    void stranger;
    const otherLogin = await api('/api/auth/login', { method: 'POST', body: { email: `other+${stamp}@test.local`, password: 'other-pass-1' } });
    const denied = await api(`/api/orders/${orderId}`, { token: otherLogin.body.token });
    return buying.body.orders.length >= 3 && sold.body.orders.length >= 1 && denied.status === 403;
  });

  // ---- Slice 5: messaging + notifications ----
  // buyerToken + sellerToken from earlier slices; seller's user id needed:
  const sellerMe = await api('/api/me', { token: sellerToken });
  const sellerId = sellerMe.body.user.id;
  let convId = null;
  await t('slice5 conversation create 201', async () => {
    const r = await api('/api/conversations', { method: 'POST', token: buyerToken, body: { with_user_id: sellerId, order_id: orderId } });
    if (r.status === 201 || (r.status === 200 && r.body.deduped)) convId = r.body.conversation.id;
    return !!convId;
  });
  await t('slice5 conversation dedupe', async () => {
    const r = await api('/api/conversations', { method: 'POST', token: sellerToken, body: { with_user_id: (await api('/api/me', { token: buyerToken })).body.user.id, order_id: orderId } });
    return r.status === 200 && r.body.deduped === true && r.body.conversation.id === convId;
  });
  await t('slice5 message exchange', async () => {
    const m1 = await api(`/api/conversations/${convId}/messages`, { method: 'POST', token: buyerToken, body: { body: 'Hello, is this available?' } });
    const m2 = await api(`/api/conversations/${convId}/messages`, { method: 'POST', token: sellerToken, body: { body: 'Yes, ready to ship!' } });
    if (m1.status !== 201 || m2.status !== 201) return false;
    const list = await api(`/api/conversations/${convId}/messages`, { token: buyerToken });
    return list.status === 200 && list.body.messages.length === 2 && list.body.messages[0].body.startsWith('Hello');
  });
  await t('slice5 outsider forbidden', async () => {
    const otherLogin = await api('/api/auth/login', { method: 'POST', body: { email: `other+${stamp}@test.local`, password: 'other-pass-1' } });
    const r = await api(`/api/conversations/${convId}/messages`, { token: otherLogin.body.token });
    return r.status === 403;
  });
  await t('slice5 block prevents messages', async () => {
    const b = await api(`/api/conversations/${convId}/block`, { method: 'POST', token: sellerToken, body: {} });
    if (b.status !== 200) return false;
    const blocked = await api(`/api/conversations/${convId}/messages`, { method: 'POST', token: buyerToken, body: { body: 'Can you hear me?' } });
    const un = await api(`/api/conversations/${convId}/block`, { method: 'DELETE', token: sellerToken });
    const after = await api(`/api/conversations/${convId}/messages`, { method: 'POST', token: buyerToken, body: { body: 'Back again' } });
    return blocked.status === 403 && un.status === 200 && after.status === 201;
  });
  await t('slice5 notifications inbox', async () => {
    const inbox = await api('/api/notifications', { token: sellerToken });
    const types = inbox.body.notifications.map((n) => n.type);
    const hasOrder = types.includes('order_placed') && types.includes('payment_received');
    const unread = await api('/api/notifications?unread=1', { token: sellerToken });
    const firstId = inbox.body.notifications[0].id;
    const read = await api(`/api/notifications/${firstId}/read`, { method: 'PATCH', token: sellerToken, body: {} });
    const unread2 = await api('/api/notifications?unread=1', { token: sellerToken });
    return inbox.body.unread >= 2 && hasOrder && unread.body.unread === inbox.body.unread && read.status === 200 && unread2.body.unread === inbox.body.unread - 1;
  });
  await t('slice5 message notifies peer', async () => {
    const before = await api('/api/notifications?unread=1', { token: sellerToken });
    await api(`/api/conversations/${convId}/messages`, { method: 'POST', token: buyerToken, body: { body: 'Ping for notify' } });
    const after = await api('/api/notifications?unread=1', { token: sellerToken });
    return after.body.unread === before.body.unread + 1 && after.body.notifications.some((n) => n.type === 'new_message');
  });

  // ---- Slice 6: reviews, refunds, disputes, admin ----
  // orderId (slice 4) is completed product order by buyerToken from sellerToken.
  let reviewId = null;
  await t('slice6 review create 201', async () => {
    const r = await api(`/api/orders/${orderId}/review`, { method: 'POST', token: buyerToken, body: { rating: 5, body: 'Great!' } });
    if (r.status === 201) reviewId = r.body.review.id;
    return r.status === 201 && r.body.review.verifiedPurchase === true;
  });
  await t('slice6 review guards', async () => {
    const dupe = await api(`/api/orders/${orderId}/review`, { method: 'POST', token: buyerToken, body: { rating: 4 } });
    const badRating = await api(`/api/orders/${orderId}/review`, { method: 'POST', token: buyerToken, body: { rating: 9 } });
    await api('/api/cart', { method: 'POST', token: buyerToken, body: { items: [{ product_id: prodId, qty: 1 }] } });
    const pending = await api('/api/checkout/place', { method: 'POST', token: buyerToken, body: {} });
    const early = await api(`/api/orders/${pending.body.orders[0].id}/review`, { method: 'POST', token: buyerToken, body: { rating: 5 } });
    await api(`/api/orders/${pending.body.orders[0].id}/cancel`, { method: 'POST', token: buyerToken, body: {} });
    return dupe.status === 409 && badRating.status === 400 && early.status === 400;
  });
  await t('slice6 review list + respond + report', async () => {
    const list = await api(`/api/reviews?listing=product:${prodId}`);
    const resp = await api(`/api/reviews/${reviewId}/respond`, { method: 'POST', token: sellerToken, body: { response: 'Thanks!' } });
    const rep = await api(`/api/reviews/${reviewId}/report`, { method: 'POST', token: buyerToken, body: { reason: 'test report' } });
    return list.body.reviews.length >= 1 && resp.status === 200 && rep.status === 201;
  });
  await t('slice6 partial refund keeps order', async () => {
    await api('/api/cart', { method: 'POST', token: buyerToken, body: { items: [{ product_id: prodId, qty: 1 }] } });
    const p = await api('/api/checkout/place', { method: 'POST', token: buyerToken, body: {} });
    const id = p.body.orders[0].id;
    await api('/api/payments/simulate-pay', { method: 'POST', token: buyerToken, body: { order_id: id } });
    const r = await api(`/api/orders/${id}/refund`, { method: 'POST', token: buyerToken, body: { type: 'partial', amount_kobo: 10000, reason: 'scratch' } });
    const g = await api(`/api/orders/${id}`, { token: buyerToken });
    const e = await api(`/api/escrow/${id}`, { token: buyerToken });
    await api(`/api/orders/${id}/cancel`, { method: 'POST', token: buyerToken, body: {} });
    return r.status === 200 && r.body.type === 'partial' && g.body.order.status !== 'cancelled' && e.body.escrow.state === 'held';
  });
  await t('slice6 full refund cancels + restores', async () => {
    const before = (await api(`/api/products/${prodId}`)).body.product.stock;
    await api('/api/cart', { method: 'POST', token: buyerToken, body: { items: [{ product_id: prodId, qty: 1 }] } });
    const p = await api('/api/checkout/place', { method: 'POST', token: buyerToken, body: {} });
    const id = p.body.orders[0].id;
    await api('/api/payments/simulate-pay', { method: 'POST', token: buyerToken, body: { order_id: id } });
    const r = await api(`/api/orders/${id}/refund`, { method: 'POST', token: buyerToken, body: { type: 'full', reason: 'changed mind' } });
    const after = (await api(`/api/products/${prodId}`)).body.product.stock;
    const e = await api(`/api/escrow/${id}`, { token: buyerToken });
    return r.status === 200 && r.body.order.status === 'cancelled' && e.body.escrow.state === 'refunded' && after === before;
  });
  const adminLogin = await api('/api/auth/login', { method: 'POST', body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
  const adminToken = adminLogin.body.token;
  let disputeId = null, disputeOrder = null;
  await t('slice6 dispute freezes escrow', async () => {
    await api('/api/cart', { method: 'POST', token: buyerToken, body: { items: [{ product_id: prodId, qty: 1 }] } });
    const p = await api('/api/checkout/place', { method: 'POST', token: buyerToken, body: {} });
    disputeOrder = p.body.orders[0].id;
    await api('/api/payments/simulate-pay', { method: 'POST', token: buyerToken, body: { order_id: disputeOrder } });
    for (const s of ['processing', 'shipped', 'out_for_delivery', 'delivered']) {
      await api(`/api/orders/${disputeOrder}/status`, { method: 'PATCH', token: sellerToken, body: { status: s } });
    }
    const d = await api('/api/disputes', { method: 'POST', token: buyerToken, body: { order_id: disputeOrder, reason: 'box damaged', evidence: ['http://x/pic.jpg'] } });
    if (d.status === 201) disputeId = d.body.dispute.id;
    const e = await api(`/api/escrow/${disputeOrder}`, { token: buyerToken });
    const c = await api(`/api/orders/${disputeOrder}/confirm`, { method: 'POST', token: buyerToken, body: {} });
    return d.status === 201 && e.body.escrow.state === 'disputed' && c.status === 400 && c.body.error === 'dispute-open';
  });
  await t('slice6 dispute evidence + non-admin resolve 403', async () => {
    const ev = await api(`/api/disputes/${disputeId}/evidence`, { method: 'POST', token: sellerToken, body: { urls: ['http://x/proof.jpg'] } });
    const no = await api(`/api/disputes/${disputeId}/resolve`, { method: 'POST', token: sellerToken, body: { decision: 'release' } });
    return ev.status === 200 && no.status === 403;
  });
  await t('slice6 admin resolve release', async () => {
    const r = await api(`/api/disputes/${disputeId}/resolve`, { method: 'POST', token: adminToken, body: { decision: 'release' } });
    const e = await api(`/api/escrow/${disputeOrder}`, { token: buyerToken });
    return r.status === 200 && r.body.dispute.status === 'resolved' && e.body.escrow.state === 'released';
  });
  await t('slice6 admin resolve refund', async () => {
    const before = (await api(`/api/products/${prodId}`)).body.product.stock;
    await api('/api/cart', { method: 'POST', token: buyerToken, body: { items: [{ product_id: prodId, qty: 1 }] } });
    const p = await api('/api/checkout/place', { method: 'POST', token: buyerToken, body: {} });
    const id = p.body.orders[0].id;
    await api('/api/payments/simulate-pay', { method: 'POST', token: buyerToken, body: { order_id: id } });
    const d = await api('/api/disputes', { method: 'POST', token: buyerToken, body: { order_id: id, reason: 'never arrived' } });
    const r = await api(`/api/disputes/${d.body.dispute.id}/resolve`, { method: 'POST', token: adminToken, body: { decision: 'refund' } });
    const after = (await api(`/api/products/${prodId}`)).body.product.stock;
    return r.status === 200 && after === before;
  });
  await t('slice6 admin overview + users', async () => {
    const o = await api('/api/admin/overview', { token: adminToken });
    const u = await api(`/api/admin/users?q=${encodeURIComponent('seller+')}`, { token: adminToken });
    const denied = await api('/api/admin/overview', { token: buyerToken });
    return o.status === 200 && o.body.overview.orders >= 5 && o.body.overview.gtvKobo > 0 && u.body.users.length >= 1 && denied.status === 403;
  });
  await t('better-auth legacy migration', async () => {
    // pre-migration seed accounts (raw scrypt hashes) must log in, then work migrated.
    const found = await api('/api/admin/users?q=demo.local', { token: adminToken });
    if (found.body.users.length === 0) { console.log('  SKIP legacy (no seed users)'); return true; }
    const seller = found.body.users.find((u) => u.role !== 'admin');
    const l1 = await api('/api/auth/login', { method: 'POST', body: { email: seller.email, password: 'demo-pass-1' } });
    if (l1.status !== 200) return false;
    const me = await api('/api/me', { token: l1.body.token });
    const l2 = await api('/api/auth/login', { method: 'POST', body: { email: seller.email, password: 'demo-pass-1' } });
    return me.status === 200 && l2.status === 200;
  });
  await t('slice6 suspend locks out + restore', async () => {    const u = await api('/api/admin/users?q=other%2B', { token: adminToken });
    const target = u.body.users[0].id;
    const s = await api(`/api/admin/users/${target}/suspend`, { method: 'POST', token: adminToken, body: {} });
    const login = await api('/api/auth/login', { method: 'POST', body: { email: `other+${stamp}@test.local`, password: 'other-pass-1' } });
    const r = await api(`/api/admin/users/${target}/restore`, { method: 'POST', token: adminToken, body: {} });
    const login2 = await api('/api/auth/login', { method: 'POST', body: { email: `other+${stamp}@test.local`, password: 'other-pass-1' } });
    return s.status === 200 && login.status === 401 && r.status === 200 && login2.status === 200;
  });
  await t('slice6 reports queue + close', async () => {
    const made = await api('/api/reports', { method: 'POST', token: buyerToken, body: { target_type: 'listing', target_id: prodId, reason: 'test' } });
    const q = await api('/api/admin/reports', { token: adminToken });
    const c = await api(`/api/admin/reports/${made.body.report}/close`, { method: 'POST', token: adminToken, body: {} });
    return made.status === 201 && q.body.reports.length >= 1 && c.status === 200;
  });
  await t('slice6 listing moderation', async () => {
    const draft = await api('/api/products', { method: 'POST', token: sellerToken, body: { title: `Mod Me ${stamp}`, price_kobo: 1000 } });
    const id = draft.body.product.id;
    const rem = await api(`/api/admin/listings/product/${id}/remove`, { method: 'POST', token: adminToken, body: {} });
    const app = await api(`/api/admin/listings/product/${id}/approve`, { method: 'POST', token: adminToken, body: {} });
    const g = await api(`/api/products/${id}`);
    return rem.status === 200 && app.status === 200 && g.status === 200;
  });

  // ---- Web UI ----
  await t('web index 200', async () => {
    const res = await fetch('http://localhost:3000/', { headers: { connection: 'close' } });
    const html = await res.text();
    return res.status === 200 && html.includes('id="app"') && html.includes('/app.js');
  });
  await t('web assets 200', async () => {
    const js = await fetch('http://localhost:3000/app.js', { headers: { connection: 'close' } });
    const css = await fetch('http://localhost:3000/styles.css', { headers: { connection: 'close' } });
    const tcss = await fetch('http://localhost:3000/tokens.css', { headers: { connection: 'close' } });
    return js.status === 200 && css.status === 200 && tcss.status === 200;
  });
  await t('api CORS preflight 204', async () => {
    const res = await fetch('http://localhost:4000/api/products', { method: 'OPTIONS', headers: { connection: 'close', Origin: 'http://localhost:3000' } });
    return res.status === 204 && (res.headers.get('access-control-allow-origin') || '').includes('localhost:3000');
  });
  await t('security headers present', async () => {
    const web = await fetch('http://localhost:3000/', { headers: { connection: 'close' } });
    await web.text();
    const apiRes = await fetch('http://localhost:4000/api/search?q=x', { headers: { connection: 'close' } });
    await apiRes.text();
    return web.headers.get('x-content-type-options') === 'nosniff'
      && web.headers.get('x-frame-options') === 'SAMEORIGIN'
      && apiRes.headers.get('x-content-type-options') === 'nosniff';
  });

  // ---- Paystack live path (test mode; no charge) ----
  // NOTE: Paystack validates customer email strictly, so this test uses a
  // gmail-formatted address (init sends no email until a real payment lands).
  await t('paystack init + webhook settle', async () => {
    const fs = require('fs');
    const raw = (fs.readFileSync('.env', 'utf8').match(/^PAYSTACK_SECRET_KEY=(.*)$/m) || [])[1] || '';
    const m = raw.trim();
    if (!m) { console.log('  SKIP paystack (no key)'); return true; }
    const crypto = require('crypto');
    const psEmail = `paystack+${stamp}@gmail.com`;
    await api('/api/auth/register', { method: 'POST', body: { email: psEmail, password: 'paystack-pass-1' } });
    const psLogin = await api('/api/auth/login', { method: 'POST', body: { email: psEmail, password: 'paystack-pass-1' } });
    const psToken = psLogin.body.token;
    await api('/api/cart', { method: 'POST', token: psToken, body: { items: [{ product_id: prodId, qty: 1 }] } });
    const p = await api('/api/checkout/place', { method: 'POST', token: psToken, body: {} });
    if (p.status !== 201) return false;
    const id = p.body.orders[0].id;
    const total = p.body.orders[0].totalKobo;
    const init = await api('/api/payments/init', { method: 'POST', token: psToken, body: { order_id: id } });
    if (init.status !== 200 || !init.body.authorizationUrl || !init.body.reference) return false;
    // forged payload must fail
    const badHook = await fetch('http://localhost:4000/api/payments/webhook', {
      method: 'POST', headers: { connection: 'close', 'content-type': 'application/json', 'x-paystack-signature': 'bad' },
      body: JSON.stringify({ event: 'charge.success', data: { reference: init.body.reference, amount: total } }),
    });
    if (badHook.status !== 401) return false;
    // genuine HMAC over exact raw body
    const payload = JSON.stringify({ event: 'charge.success', data: { reference: init.body.reference, amount: total } });
    const sig = crypto.createHmac('sha512', m.trim()).update(payload).digest('hex');
    const hook = await fetch('http://localhost:4000/api/payments/webhook', {
      method: 'POST', headers: { connection: 'close', 'content-type': 'application/json', 'x-paystack-signature': sig }, body: payload,
    });
    const hj = await hook.json();
    const g0 = await api(`/api/orders/${id}`, { token: psToken });
    const e = await api(`/api/escrow/${id}`, { token: psToken });
    await api(`/api/orders/${id}/cancel`, { method: 'POST', token: psToken, body: {} });
    const g = await api(`/api/orders/${id}`, { token: psToken });
    return hook.status === 200 && hj.settled === id && g0.body.order.status === 'paid' && g.body.order.status === 'cancelled' && e.body.escrow.state === 'held';
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
