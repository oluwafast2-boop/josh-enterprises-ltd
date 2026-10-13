// Josh Enterprises SPA (v1: buyer loop + sell + inbox).
// API base: localStorage override (settings) > ?api= param > same-origin /api > localhost.
const API = (() => {
  const stored = localStorage.getItem('je_api');
  if (stored) return stored.replace(/\/$/, '');
  const q = new URLSearchParams(location.search).get('api');
  if (q) return q.replace(/\/$/, '');
  return 'http://localhost:4000';
})();
const app = document.getElementById('app');
const getToken = () => localStorage.getItem('je_token');
const setToken = (t) => t ? localStorage.setItem('je_token', t) : localStorage.removeItem('je_token');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kobo = (k) => '₦' + (Number(k || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });

function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}
// Deterministic colorful gradient per listing id.
function gradient(id) {
  const palettes = [
    ['#0e6b4f', '#14957a'], ['#7c3aed', '#c026d3'], ['#ea580c', '#f59e0b'],
    ['#0369a1', '#22d3ee'], ['#be123c', '#fb7185'], ['#4d7c0f', '#a3e635'],
  ];
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [g1, g2] = palettes[h % palettes.length];
  return `style="--g1:${g1};--g2:${g2}"`;
}
function stars(r) {
  r = Math.round(Number(r) || 0);
  return `<span class="stars">${'★'.repeat(Math.min(5, Math.max(0, r)))}${'☆'.repeat(5 - Math.min(5, Math.max(0, r)))}</span>`;
}
function card(i) {
  const letter = esc((i.title || '?').trim().charAt(0).toUpperCase() || '?');
  return `<div class="card"><div class="thumb" ${gradient(i.id)}>${letter}</div>
    <h3><a href="#/${i.kind === 'product' ? 'p' : 's'}/${i.id}">${esc(i.title)}</a></h3>
    <div class="price">${kobo(i.price_kobo)}</div>
    <div class="muted">${esc(i.kind)}${i.location ? ' · ' + esc(i.location) : ''}</div></div>`;
}
const loading = `<div class="grid"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>`;

// Live polling (chat refresh). One timer at a time, always cleared on route change.
let pollTimer = null;
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function api(path, { method = 'GET', body = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) headers.Authorization = 'Bearer ' + t;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}
const errBox = (m) => `<div class="err">${esc(m)}</div>`;

async function refreshMe() {
  if (!getToken()) { document.getElementById('meLink').textContent = 'Login'; return null; }
  const { status, data } = await api('/api/me');
  if (status !== 200) { setToken(null); document.getElementById('meLink').textContent = 'Login'; return null; }
  document.getElementById('meLink').textContent = data.user.name || data.user.email;
  return data.user;
}

// ---------- views ----------
async function vHome() {
  app.innerHTML = `<div class="hero"><h1>Everything, from people you can trust</h1>
    <p>Buy products, hire services, pay securely with escrow protection.</p>
    <a class="btn" href="#/sell">Start selling — it's free</a></div>
    <div id="cats" class="chips"></div><div id="secs">${loading}</div>`;
  const [cats, items] = await Promise.all([api('/api/categories'), api('/api/search?limit=24')]);
  document.getElementById('cats').innerHTML =
    `<a class="chip" href="#/">All</a>` + ((cats.data.categories || []).map((c) => `<a class="chip" href="#/c/${c.id}">${esc(c.name)}</a>`).join(''));
  const all = items.data.items || [];
  const prods = all.filter((i) => i.kind === 'product');
  const svcs = all.filter((i) => i.kind === 'service');
  const sec = (title, list, empty) => list.length === 0 ? '' : `<div class="section-title"><span class="dot"></span>${title}</div><div class="grid">${list.map(card).join('')}</div>`;
  document.getElementById('secs').innerHTML =
    sec('✨ New arrivals', all.slice(0, 8)) +
    sec('🛍️ Products', prods.slice(0, 4)) +
    sec('🛠️ Services', svcs.slice(0, 4)) +
    (all.length === 0 ? `<div class="card"><p class="muted">No listings yet — be the first to <a href="#/sell">sell</a>.</p></div>` : '');
}

function filterBar(values) {
  const v = values || {};
  return `<form class="filters" id="ff">
    <input name="q" placeholder="Keyword" value="${esc(v.q || '')}">
    <input name="min" type="number" min="0" placeholder="Min ₦" value="${esc(v.min || '')}">
    <input name="max" type="number" min="0" placeholder="Max ₦" value="${esc(v.max || '')}">
    <input name="location" placeholder="Location" value="${esc(v.location || '')}">
    <select name="sort"><option value="newest">Newest</option><option value="price_asc"${v.sort === 'price_asc' ? ' selected' : ''}>Price ↑</option><option value="price_desc"${v.sort === 'price_desc' ? ' selected' : ''}>Price ↓</option></select>
    <button>Filter</button></form>`;
}

async function runSearch(params) {
  const q = new URLSearchParams({ limit: 48 });
  for (const [k, val] of Object.entries(params)) if (val) q.set(k === 'min' ? 'min_kobo' : k === 'max' ? 'max_kobo' : k, k === 'min' || k === 'max' ? Math.round(Number(val) * 100) : val);
  const { data } = await api('/api/search?' + q);
  return data;
}

async function vSearch(initial) {
  const url = new URLSearchParams(location.search);
  app.innerHTML = `<h2>Search & filters</h2>${filterBar({ q: initial || url.get('q') || '' })}<div id="res">${loading}</div>`;
  const go = async (vals) => {
    const data = await runSearch(vals);
    document.getElementById('res').innerHTML = `<p class="muted">${data.count} result(s) · via ${esc(data.engine)}</p>
      <div class="grid">${(data.items || []).map(card).join('')}</div>`;
  };
  document.getElementById('ff').onsubmit = (e) => { e.preventDefault(); const fd = new FormData(e.target); go({ q: fd.get('q'), min: fd.get('min'), max: fd.get('max'), location: fd.get('location'), sort: fd.get('sort') }); };
  await go({ q: initial || url.get('q') || '' });
}

async function vCategory(id) {
  const cats = await api('/api/categories');
  const flat = [];
  const walk = (list) => (list || []).forEach((c) => { flat.push(c); walk(c.children); });
  walk(cats.data.categories);
  const cat = flat.find((c) => c.id === id);
  app.innerHTML = `<h2>${esc(cat ? cat.name : 'Category')}</h2>${filterBar({})}<div id="res">${loading}</div>`;
  const go = async (vals) => {
    const data = await runSearch({ ...vals, category: id });
    document.getElementById('res').innerHTML = `<p class="muted">${data.count} result(s)</p><div class="grid">${(data.items || []).map(card).join('')}</div>`;
  };
  document.getElementById('ff').onsubmit = (e) => { e.preventDefault(); const fd = new FormData(e.target); go({ q: fd.get('q'), min: fd.get('min'), max: fd.get('max'), location: fd.get('location'), sort: fd.get('sort') }); };
  await go({});
}

async function vDetail(kind, id) {
  const base = kind === 'p' ? 'products' : 'services';
  const { status, data } = await api(`/api/${base}/${id}`);
  if (status !== 200) { app.innerHTML = errBox('Listing not found.'); return; }
  const item = data.product || data.service;
  const who = data.seller || data.provider || {};
  const revs = await api(`/api/reviews?listing=${kind === 'p' ? 'product' : 'service'}:${id}`);
  const avg = revs.data.reviews.length === 0 ? 0 : revs.data.reviews.reduce((s, r) => s + r.rating, 0) / revs.data.reviews.length;
  const letter = esc((item.title || '?').trim().charAt(0).toUpperCase());
  app.innerHTML = `<div class="gallery" ${gradient(item.id)}>${letter}</div>
    <div class="card"><h2 style="margin-top:0">${esc(item.title)}</h2>
    <div class="price" style="font-size:22px">${kobo(item.priceKobo)}</div>
    <div>${stars(avg)} <span class="muted">${avg ? avg.toFixed(1) : 'No ratings yet'} (${revs.data.reviews.length})</span></div>
    <p>${esc(item.description || '')}</p>
    <div class="muted">Seller: <a href="#/store/${who.id || ''}">${esc(who.name || '')}</a> ${who.verificationLevel > 0 ? '<span class="badge">✓ Verified</span>' : '<span class="badge gray">Unverified</span>'}${item.location ? ' · ' + esc(item.location) : ''}${item.stock != null ? ' · Stock: ' + item.stock : ''}${item.condition ? ' · ' + esc(item.condition) : ''}</div>
    <div class="row" style="margin-top:12px">
      ${kind === 'p' ? `<button data-add="${item.id}" class="accent">Add to cart</button>` : ''}
      <button class="secondary" data-chat="${who.id || ''}">💬 Chat seller</button>
      <button class="secondary" data-share="1">🔗 Share</button>
      <button class="secondary" data-report="1">🚩 Report</button>
    </div></div>
    ${kind === 's' ? `<div class="card" style="margin-top:12px"><h3 style="margin-top:0">📅 Book this service</h3>
      <form id="book" class="row"><input type="date" name="date" required style="flex:1"><input type="time" name="time" required style="flex:1"><button class="accent">Book now</button></form>
      <div id="bookmsg"></div></div>` : ''}
    <div class="section-title"><span class="dot"></span>Reviews</div>
    <div id="revs">${(revs.data.reviews || []).map((r) => `<div class="card" style="margin-bottom:10px">${stars(r.rating)} <b>${esc(r.rating)}/5</b><p>${esc(r.body || '')}</p>${r.response ? `<p class="muted">Seller: ${esc(r.response)}</p>` : ''}</div>`).join('') || '<p class="muted">No reviews yet — buy it and be the first.</p>'}</div>`;
  if (kind === 's') document.getElementById('book').onsubmit = async (e) => {
    e.preventDefault();
    if (!getToken()) { location.hash = '#/auth'; return; }
    const fd = new FormData(e.target);
    const r = await api('/api/orders', { method: 'POST', body: { service_id: item.id, slot: { date: fd.get('date'), time: fd.get('time') } } });
    if (r.status === 201) location.hash = '#/orders/' + r.body.order.id;
    else document.getElementById('bookmsg').innerHTML = errBox(r.data.error === 'bad-slot-date' ? 'Pick a future date.' : (r.data.error || 'Failed'));
  };
  const add = app.querySelector('[data-add]');
  if (add) add.onclick = async () => {
    if (!getToken()) { location.hash = '#/auth'; return; }
    const cart = await api('/api/cart');
    const items = (cart.data.items || []).map((l) => ({ product_id: l.product_id, qty: l.qty }));
    items.push({ product_id: item.id, qty: 1 });
    const r = await api('/api/cart', { method: 'POST', body: { items } });
    if (r.status === 200) { toast('Added to cart ✓'); location.hash = '#/cart'; }
    else toast(r.data.error || 'Cannot add');
  };
  const chat = app.querySelector('[data-chat]');
  if (chat) chat.onclick = async () => {
    if (!getToken()) { location.hash = '#/auth'; return; }
    if (!chat.dataset.chat) { toast('Seller unavailable'); return; }
    const r = await api('/api/conversations', { method: 'POST', body: { with_user_id: chat.dataset.chat } });
    if (r.data.conversation) location.hash = '#/messages/' + r.data.conversation.id;
    else toast(r.data.error || 'Cannot start chat');
  };
  app.querySelector('[data-share]').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied ✓'); }
    catch { prompt('Copy this link:', location.href); }
  };
  app.querySelector('[data-report]').onclick = async () => {
    if (!getToken()) { location.hash = '#/auth'; return; }
    const reason = prompt('Why are you reporting this listing?');
    if (!reason) return;
    const r = await api('/api/reports', { method: 'POST', body: { target_type: 'listing', target_id: item.id, reason } });
    toast(r.status === 201 ? 'Reported — thank you ✓' : (r.data.error || 'Failed'));
  };
}

async function vStore(userId) {
  app.innerHTML = loading;
  const [bizs, prods, svcs] = await Promise.all([
    api('/api/businesses'), api('/api/search?limit=48'), api('/api/search?type=service&limit=48'),
  ]);
  const mine = (bizs.data.businesses || []).filter((b) => b.ownerId === userId);
  const items = [...(prods.data.items || []), ...(svcs.data.items || [])].filter((i) => (i.sellerId || i.providerId) === userId);
  const biz = mine[0];
  app.innerHTML = `<div class="hero"><h1>${esc(biz ? biz.name : 'Storefront')}</h1>
    <p>${esc((biz && biz.description) || '')} ${biz && biz.verificationStatus === 'verified' ? '<span class="badge">✓ Verified business</span>' : ''}</p>
    ${biz && biz.location ? `<div style="opacity:.85">📍 ${esc(biz.location)}</div>` : ''}</div>
    <div class="section-title"><span class="dot"></span>Listings (${items.length})</div>
    <div class="grid">${items.map(card).join('') || '<p class="muted">Nothing listed yet.</p>'}</div>`;
}

function vAuth() {
  app.innerHTML = `<div class="card"><form class="narrow" id="f">
    <h2>Login / Register</h2><div id="msg"></div>
    <input name="email" type="email" placeholder="Email" required>
    <input name="password" type="password" placeholder="Password (min 8)" required>
    <div class="row"><button name="m" value="login">Login</button><button name="m" value="register" class="secondary">Register</button></div></form></div>`;
  const f = document.getElementById('f');
  let mode = 'login';
  f.m[0].onclick = () => { mode = 'login'; };
  f.m[1].onclick = () => { mode = 'register'; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const r = await api('/api/auth/' + (mode === 'login' ? 'login' : 'register'), { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } });
    if (r.data.token) { setToken(r.data.token); await refreshMe(); location.hash = '#/'; }
    else document.getElementById('msg').innerHTML = errBox(r.data.error || 'Failed');
  };
}

async function vCart() {
  const { data } = await api('/api/cart');
  const rows = (data.items || []).map((l) => `<tr><td>${esc(l.title)}</td><td>${l.qty}</td><td>${kobo(l.line_kobo)}</td></tr>`).join('');
  app.innerHTML = `<h2>Cart</h2><div class="card"><table><tr><th>Item</th><th>Qty</th><th>Total</th></tr>${rows || '<tr><td colspan=3 class=muted>Empty</td></tr>'}</table>
    <p>Subtotal: <b>${kobo(data.subtotal_kobo)}</b></p>
    <div class="row"><a class="btn" href="#/checkout">Checkout</a></div></div>`;
}

async function vCheckout() {
  const { status, data } = await api('/api/checkout/preview', { method: 'POST', body: {} });
  if (status !== 200) { app.innerHTML = errBox(data.error || 'Cart problem') + '<p><a href="#/cart">Back to cart</a></p>'; return; }
  app.innerHTML = `<h2>Checkout</h2><div id="msg"></div>` + data.groups.map((g, i) => `
    <div class="card"><h3>Order ${i + 1}</h3>
    ${g.lines.map((l) => `<div>${esc(l.title)} × ${l.qty} — ${kobo(l.line_kobo)}</div>`).join('')}
    <p class="muted">Subtotal ${kobo(g.subtotalKobo)} + Fee ${kobo(g.platformKobo)} = <b>${kobo(g.totalKobo)}</b></p></div>`).join('') +
    `<p>Grand total: <b>${kobo(data.grandTotalKobo)}</b></p><button id="pay">Pay now (simulated)</button>`;
  document.getElementById('pay').onclick = async () => {
    const placed = await api('/api/checkout/place', { method: 'POST', body: {} });
    if (placed.status !== 201) { document.getElementById('msg').innerHTML = errBox(placed.data.error || 'Failed'); return; }
    // Real Paystack where enabled (redirect to authorization URL, webhook settles).
    const first = placed.data.orders[0];
    if (placed.data.orders.length === 1) {
      const init = await api('/api/payments/init', { method: 'POST', body: { order_id: first.id } });
      if (init.status === 200 && init.body.authorizationUrl) { window.location = init.body.authorizationUrl; return; }
    }
    for (const o of placed.data.orders) {
      await api('/api/payments/simulate-pay', { method: 'POST', body: { order_id: o.id } });
    }
    location.hash = '#/orders';
  };
}

async function vOrders() {
  const [buying, sold] = await Promise.all([api('/api/orders?role=buying'), api('/api/orders?role=sold')]);
  const row = (o, as) => `<tr><td><a href="#/orders/${o.id}">${o.id.slice(0, 8)}</a></td><td>${esc(o.type)}</td><td>${o.status}</td><td>${kobo(o.totalKobo)}</td><td class="muted">${as}</td></tr>`;
  app.innerHTML = `<h2>Orders</h2><div class="card"><table><tr><th>ID</th><th>Type</th><th>Status</th><th>Total</th><th></th></tr>
    ${(buying.data.orders || []).map((o) => row(o, 'bought')).join('')}${(sold.data.orders || []).map((o) => row(o, 'sold')).join('')}</table></div>`;
}

async function vOrderDetail(id) {
  const { status, data } = await api('/api/orders/' + id);
  if (status !== 200) { app.innerHTML = errBox('Order not found.'); return; }
  const o = data.order;
  const me = await refreshMe();
  const isBuyer = me && me.id === o.buyerId;
  const isSeller = me && me.id === o.sellerId;
  const flow = o.type === 'product'
    ? ['pending', 'paid', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'completed']
    : ['pending', 'paid', 'accepted', 'scheduled', 'in_progress', 'completed', 'confirmed'];
  const timeline = flow.map((s) => `<div class="tstep${flow.indexOf(s) <= flow.indexOf(o.status) ? ' done' : ''}">${esc(s.replace(/_/g, ' '))}</div>`).join('');
  const NEXT = { paid: 1, processing: 1, shipped: 1, out_for_delivery: 1, delivered: 0, accepted: 1, scheduled: 1, in_progress: 1, completed: 0 };
  const canAdvance = isSeller && NEXT[o.status] === 1;
  const nextStatus = canAdvance ? flow[flow.indexOf(o.status) + 1] : null;
  app.innerHTML = `<div class="card"><h2>Order ${esc(o.id.slice(0, 8))}</h2>
    <div class="timeline">${timeline}</div>
    <p>Status: <b>${esc(o.status)}</b> · Escrow: <b>${esc(data.escrow ? data.escrow.state : 'none')}</b></p>
    ${(o.items || []).map((l) => `<div>${esc(l.title || l.service_id || '')} — ${kobo(l.line_kobo || l.price_kobo)}</div>`).join('')}
    ${o.deliveryInfo && o.deliveryInfo.slot ? `<p>📅 Booked: <b>${esc(o.deliveryInfo.slot.date)} ${esc(o.deliveryInfo.slot.time)}</b></p>` : ''}
    <p>Total: <b>${kobo(o.totalKobo)}</b> (fee ${kobo(o.platformKobo)})</p><div id="msg"></div>
    <div class="row">
      ${isBuyer && ['delivered', 'completed'].includes(o.status) ? '<button id="cf" class="accent">Confirm receipt ✓</button>' : ''}
      ${canAdvance ? `<button id="adv">Mark: ${esc(nextStatus.replace(/_/g, ' '))} →</button>` : ''}
      ${!['completed', 'confirmed', 'cancelled'].includes(o.status) ? '<button id="cx" class="secondary">Cancel</button>' : ''}
      ${['completed', 'confirmed'].includes(o.status) && isBuyer ? `<a class="btn secondary" href="#/orders/${o.id}/review">Leave review</a>` : ''}
    </div></div>`;
  const msg = (ok, m) => { document.getElementById('msg').innerHTML = ok ? `<div class="ok">${esc(m)}</div>` : errBox(m); };
  const reload = () => setTimeout(() => vOrderDetail(id), 800);
  const cf = document.getElementById('cf');
  if (cf) cf.onclick = async () => { const r = await api(`/api/orders/${id}/confirm`, { method: 'POST', body: {} }); msg(r.status === 200, r.status === 200 ? 'Confirmed — funds released ✓' : (r.data.error || 'Failed')); if (r.status === 200) reload(); };
  const adv = document.getElementById('adv');
  if (adv) adv.onclick = async () => { const r = await api(`/api/orders/${id}/status`, { method: 'PATCH', body: { status: nextStatus } }); msg(r.status === 200, r.status === 200 ? 'Updated ✓' : (r.data.error || 'Failed')); if (r.status === 200) reload(); };
  const cx = document.getElementById('cx');
  if (cx) cx.onclick = async () => { const r = await api(`/api/orders/${id}/cancel`, { method: 'POST', body: {} }); msg(r.status === 200, r.status === 200 ? 'Cancelled.' : (r.data.error || 'Failed')); if (r.status === 200) reload(); };
}

async function vReview(orderId) {
  app.innerHTML = `<div class="card"><form class="narrow" id="f"><h2>Review order ${esc(orderId.slice(0, 8))}</h2><div id="msg"></div>
    <select name="rating"><option value="5">5 — Excellent</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1 — Poor</option></select>
    <textarea name="body" placeholder="What went well?"></textarea><button>Submit review</button></form></div>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = await api(`/api/orders/${orderId}/review`, { method: 'POST', body: { rating: Number(fd.get('rating')), body: fd.get('body') } });
    document.getElementById('msg').innerHTML = r.status === 201 ? '<div class="ok">Thanks for reviewing!</div>' : errBox(r.data.error || 'Failed');
  };
}

async function vSell(edit) {
  const cats = await api('/api/categories');
  const opts = (cats.data.categories || []).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  let existing = null, kind = 'product';
  if (edit) {
    const r = await api(`/api/${edit.kind === 'product' ? 'products' : 'services'}/${edit.id}`);
    if (r.status !== 200) { app.innerHTML = errBox('Listing not found.'); return; }
    existing = r.data.product || r.data.service;
    kind = edit.kind;
  }
  const val = (k) => existing ? esc(existing[k] == null ? '' : existing[k]) : '';
  app.innerHTML = `<div class="card"><form class="narrow" id="f"><h2>${existing ? 'Edit listing' : 'Sell something'}</h2><div id="msg"></div>
    <select name="kind" ${existing ? 'disabled' : ''}><option value="product"${kind === 'product' ? ' selected' : ''}>Product</option><option value="service"${kind === 'service' ? ' selected' : ''}>Service</option></select>
    <input name="title" placeholder="Title" required value="${val('title')}">
    <textarea name="description" placeholder="Description">${esc((existing && existing.description) || '')}</textarea>
    <input name="price" type="number" min="0" placeholder="Price in naira" required value="${existing ? (existing.priceKobo / 100) : ''}">
    <select name="category_id"><option value="">Category…</option>${opts}</select>
    <input name="stock" type="number" min="0" value="${existing && existing.stock != null ? existing.stock : 1}">
    <label><input type="checkbox" name="published" style="width:auto"${existing && existing.status === 'published' ? ' checked' : ''}> Published</label>
    <button>${existing ? 'Save changes' : 'Create listing'}</button></form></div>`;
  if (existing && existing.categoryId) document.querySelector('[name=category_id]').value = existing.categoryId;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { title: fd.get('title'), description: fd.get('description'), price_kobo: Math.round(Number(fd.get('price')) * 100),
      category_id: fd.get('category_id') || null, stock: Number(fd.get('stock')), status: fd.get('published') ? 'published' : 'draft' };
    let r;
    if (existing) r = await api(`/api/${kind === 'product' ? 'products' : 'services'}/${existing.id}`, { method: 'PATCH', body: payload });
    else r = await api(fd.get('kind') === 'product' ? '/api/products' : '/api/services', { method: 'POST', body: payload });
    const saved = r.body.product || r.body.service;
    document.getElementById('msg').innerHTML = (r.status === 201 || r.status === 200) && saved
      ? `<div class="ok">Saved! <a href="#/${saved.kind === 'service' ? 's' : 'p'}/${saved.id}">View</a> · <a href="#/listings">My listings</a></div>`
      : errBox(r.data.error || 'Failed');
  };
}

async function vListings() {
  const me = await refreshMe();
  if (!me) { location.hash = '#/auth'; return; }
  const [prods, svcs] = await Promise.all([api('/api/products?mine=1'), api('/api/services?mine=1')]);
  const card = (it) => `<div class="card"><h3>${esc(it.title)}</h3>
    <div class="muted">${esc(it.kind)} · ${it.status} · ${kobo(it.priceKobo)}${it.stock != null ? ' · stock ' + it.stock : ''}</div>
    <div class="row" style="margin-top:8px">
      <a class="btn secondary" href="#/sell/${it.kind}/${it.id}">Edit</a>
      <button data-pub="${it.kind}:${it.id}" class="secondary">${it.status === 'published' ? 'Unpublish' : 'Publish'}</button>
      <button data-del="${it.kind}:${it.id}" class="warn">Delete</button>
    </div></div>`;
  app.innerHTML = `<h2>My listings</h2><div class="row" style="margin-bottom:12px"><a class="btn" href="#/sell">+ New listing</a></div>
    <div class="grid">${(prods.data.products || []).map((p) => card({ ...p, kind: 'product' })).join('')}${(svcs.data.services || []).map((s) => card({ ...s, kind: 'service' })).join('')}</div>`;
  app.querySelectorAll('[data-pub]').forEach((b) => { b.onclick = async () => {
    const [kind, id] = b.dataset.pub.split(':');
    const base = kind === 'product' ? 'products' : 'services';
    const cur = b.textContent.trim() === 'Unpublish' ? 'draft' : 'published';
    await api(`/api/${base}/${id}`, { method: 'PATCH', body: { status: cur } });
    vListings();
  }; });
  app.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => {
    if (!confirm('Delete this listing?')) return;
    const [kind, id] = b.dataset.del.split(':');
    await api(`/api/${kind === 'product' ? 'products' : 'services'}/${id}`, { method: 'DELETE' });
    vListings();
  }; });
}

async function vMessages(id) {
  stopPoll();
  if (!id) {
    const { data } = await api('/api/conversations');
    app.innerHTML = `<h2>Messages</h2>` + ((data.conversations || []).map((c) => `
      <div class="card"><a href="#/messages/${c.id}">Thread ${esc(c.id.slice(0, 8))}</a>
      ${c.unread > 0 ? `<span class="badge amber">${c.unread} new</span>` : ''}
      <div class="muted">${esc(c.last_body || 'No messages yet')}</div></div>`).join('') || '<p class="muted">No conversations. Chat a seller from a listing page.</p>');
    // refresh badges while inbox is open
    let lastTotal = -1;
    pollTimer = setInterval(async () => {
      if ((location.hash || '') !== '#/messages') return stopPoll();
      const r = await api('/api/conversations');
      const total = (r.data.conversations || []).reduce((s, c) => s + (c.unread || 0), 0);
      if (lastTotal >= 0 && total !== lastTotal) return vMessages(null);
      lastTotal = total;
    }, 8000);
    return;
  }
  const paint = (msgs, meId) => msgs.map((m) => `<div class="msg ${m.sender_id === meId ? 'me' : 'them'}" data-mid="${m.id}">${esc(m.body)}</div>`).join('');
  const first = await api(`/api/conversations/${id}/messages`);
  const me = await refreshMe();
  const known = new Set((first.data.messages || []).map((m) => m.id));
  app.innerHTML = `<h2>Thread</h2><div id="log">${paint(first.data.messages || [], me && me.id)}</div>
    <form id="f" class="row"><input name="body" placeholder="Message…" required style="flex:1" autocomplete="off"><button>Send</button></form><div id="msg"></div><p class="muted">● Live — new messages appear automatically.</p>`;
  const log = document.getElementById('log');
  log.scrollTop = log.scrollHeight;
  pollTimer = setInterval(async () => {
    if (!(location.hash || '').startsWith('#/messages/' + id)) return stopPoll();
    const r = await api(`/api/conversations/${id}/messages`);
    if (r.status !== 200) return;
    const fresh = (r.data.messages || []).filter((m) => !known.has(m.id));
    if (fresh.length > 0) {
      fresh.forEach((m) => known.add(m.id));
      log.insertAdjacentHTML('beforeend', paint(fresh, me && me.id));
      log.scrollTop = log.scrollHeight;
      toast('New message ↓');
    }
  }, 4000);
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = await api(`/api/conversations/${id}/messages`, { method: 'POST', body: { body: fd.get('body') } });
    if (r.status === 201) { known.add(r.body.message.id); log.insertAdjacentHTML('beforeend', paint([r.body.message], me && me.id)); e.target.reset(); log.scrollTop = log.scrollHeight; }
    else document.getElementById('msg').innerHTML = errBox(r.data.error || 'Failed');
  };
}

async function vAdmin() {
  const me = await refreshMe();
  if (!me || me.role !== 'admin') { app.innerHTML = errBox('Admin only.'); return; }
  const [ov, reports] = await Promise.all([
    api('/api/disputes?all=1'), api('/api/admin/reports'),
  ]);
  const over = await api('/api/admin/overview');
  const o = over.data.overview || {};
  const naira = (k) => '₦' + (Number(k || 0) / 100).toLocaleString('en-NG');
  app.innerHTML = `<h2>Admin</h2>
    <div class="grid">
      <div class="card"><h3>${o.users || 0}</h3><div class="muted">Users (${o.sellers || 0} sellers)</div></div>
      <div class="card"><h3>${(o.publishedProducts || 0) + (o.publishedServices || 0)}</h3><div class="muted">Live listings</div></div>
      <div class="card"><h3>${o.orders || 0}</h3><div class="muted">Orders (${o.completedOrders || 0} done)</div></div>
      <div class="card"><h3>${naira(o.gtvKobo)}</h3><div class="muted">GTV · Revenue ${naira(o.revenueKobo)}</div></div>
      <div class="card"><h3>${naira(o.escrowHeldKobo)}</h3><div class="muted">Escrow held</div></div>
      <div class="card"><h3>${o.openDisputes || 0} / ${o.openReports || 0}</h3><div class="muted">Open disputes / reports</div></div>
    </div>
    <h3>Open disputes</h3><div id="dq">${(ov.data.disputes || []).map((d) => `
      <div class="card"><div>${esc(d.id.slice(0, 8))} · ${esc(d.reason)} <span class="badge gray">${esc(d.status)}</span></div>
      <div class="row" style="margin-top:8px"><button data-rel="${d.id}">Release to seller</button><button data-ref="${d.id}" class="secondary">Refund buyer</button></div></div>`).join('') || '<p class="muted">None open.</p>'}</div>
    <h3>Open reports</h3><div>${(reports.data.reports || []).map((r) => `
      <div class="card"><div>${esc(r.target_type)} ${esc(r.target_id.slice(0, 8))} — ${esc(r.reason)}</div>
      <div class="row" style="margin-top:8px"><button data-close="${r.id}" class="secondary">Close</button></div></div>`).join('') || '<p class="muted">None open.</p>'}</div>
    <h3>Users</h3><form id="uq" class="row"><input name="q" placeholder="Search email…" style="flex:1"><button>Search</button></form><div id="ul"></div>`;
  app.querySelectorAll('[data-rel]').forEach((b) => { b.onclick = async () => { await api(`/api/disputes/${b.dataset.rel}/resolve`, { method: 'POST', body: { decision: 'release' } }); vAdmin(); }; });
  app.querySelectorAll('[data-ref]').forEach((b) => { b.onclick = async () => { await api(`/api/disputes/${b.dataset.ref}/resolve`, { method: 'POST', body: { decision: 'refund' } }); vAdmin(); }; });
  app.querySelectorAll('[data-close]').forEach((b) => { b.onclick = async () => { await api(`/api/admin/reports/${b.dataset.close}/close`, { method: 'POST', body: {} }); vAdmin(); }; });
  document.getElementById('uq').onsubmit = async (e) => {
    e.preventDefault();
    const q = new FormData(e.target).get('q');
    const r = await api('/api/admin/users?q=' + encodeURIComponent(q));
    document.getElementById('ul').innerHTML = `<table><tr><th>Email</th><th>Role</th><th>Status</th><th></th></tr>` + ((r.data.users || []).map((u) => `
      <tr><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${u.suspended ? 'suspended' : 'active'}</td>
      <td>${u.suspended ? `<button data-rs="${u.id}" class="secondary">Restore</button>` : `<button data-sp="${u.id}" class="warn">Suspend</button>`}</td></tr>`).join('')) + `</table>`;
    document.querySelectorAll('[data-sp]').forEach((b) => { b.onclick = async () => { await api(`/api/admin/users/${b.dataset.sp}/suspend`, { method: 'POST', body: {} }); vAdmin(); }; });
    document.querySelectorAll('[data-rs]').forEach((b) => { b.onclick = async () => { await api(`/api/admin/users/${b.dataset.rs}/restore`, { method: 'POST', body: {} }); vAdmin(); }; });
  };
}

async function vNotifs() {
  const me = await refreshMe();
  if (!me) { location.hash = '#/auth'; return; }
  const { data } = await api('/api/notifications');
  app.innerHTML = `<div class="row"><h2 style="margin-right:auto">Notifications (${data.unread} unread)</h2><button id="ra" class="secondary">Mark all read</button></div>
    ${(data.notifications || []).map((n) => `<div class="card" style="margin-bottom:10px;${n.read_at ? 'opacity:.65' : ''}">
      <b>${esc(n.type.replace(/_/g, ' '))}</b> <span class="muted">${esc(n.created_at || '')}</span>
      <div class="muted">${esc(JSON.stringify(n.payload || {}))}</div></div>`).join('') || '<p class="muted">Nothing yet.</p>'}`;
  document.getElementById('ra').onclick = async () => { await api('/api/notifications/read-all', { method: 'POST', body: {} }); vNotifs(); };
}

async function vMe() {
  const me = await refreshMe();
  if (!me) { location.hash = '#/auth'; return; }
  const notifs = await api('/api/notifications?unread=1');
  app.innerHTML = `<div class="card"><h2>${esc(me.name || me.email)}</h2>
    <div class="muted">${esc(me.email)} · ${esc(me.role)} ${me.verificationLevel > 0 ? '<span class="badge">Verified</span>' : ''}</div>
    <p>Unread notifications: <b>${notifs.data.unread}</b></p>
    <form id="f" class="narrow"><input name="name" value="${esc(me.name || '')}" placeholder="Name">
    <input name="location" value="${esc(me.location || '')}" placeholder="Location">
    <textarea name="bio" placeholder="Bio">${esc(me.bio || '')}</textarea><button>Save</button></form>
    <form id="api" class="narrow"><h3>API connection</h3>
    <input name="api_url" value="${esc(localStorage.getItem('je_api') || '')}" placeholder="http://localhost:4000 (blank = default)">
    <button class="secondary">Switch API & reload</button></form>
    <p class="muted">Currently talking to: ${esc(API)}</p>
    <p><button id="out" class="secondary">Logout</button></p></div>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api('/api/me', { method: 'PATCH', body: { name: fd.get('name'), location: fd.get('location'), bio: fd.get('bio') } });
    await refreshMe();
  };
  document.getElementById('api').onsubmit = async (e) => {
    e.preventDefault();
    const apiUrl = String(new FormData(e.target).get('api_url') || '').trim().replace(/\/$/, '');
    if (apiUrl) localStorage.setItem('je_api', apiUrl);
    else localStorage.removeItem('je_api');
    location.reload();
  };
  document.getElementById('out').onclick = async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); setToken(null); location.hash = '#/'; };
}

// ---------- router ----------
async function route() {
  stopPoll();
  const h = location.hash || '#/';
  await refreshMe();
  try {
    if (h === '#/') return vHome();
    if (h.startsWith('#/c/')) return vCategory(h.slice(4));
    if (h.startsWith('#/p/')) return vDetail('p', h.slice(4));
    if (h.startsWith('#/s/')) return vDetail('s', h.slice(4));
    if (h === '#/auth') return vAuth();
    if (h === '#/cart') return vCart();
    if (h === '#/checkout') return vCheckout();
    if (h === '#/orders') return vOrders();
    if (h.startsWith('#/orders/') && h.endsWith('/review')) return vReview(h.split('/')[2]);
    if (h.startsWith('#/orders/')) return vOrderDetail(h.slice(9));
    if (h === '#/sell') return vSell(null);
    if (h.startsWith('#/sell/')) { const [, , kind, id] = h.split('/'); return vSell({ kind, id }); }
    if (h === '#/listings') return vListings();
    if (h === '#/admin') return vAdmin();
    if (h === '#/messages') return vMessages(null);
    if (h.startsWith('#/messages/')) return vMessages(h.slice(11));
    if (h === '#/notifs') return vNotifs();
    if (h.startsWith('#/store/')) return vStore(h.slice(8));
    if (h === '#/me') return vMe();
    const q = document.getElementById('q').value;
    if (q) return vSearch(q);
    return vHome();
  } catch (e) { app.innerHTML = errBox('Something broke: ' + e.message); }
}
document.getElementById('q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value) { location.hash = '#/'; vSearch(e.target.value); } });
window.addEventListener('hashchange', route);
route();
