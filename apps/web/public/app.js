// Josh Enterprises SPA (v1: buyer loop + sell + inbox). API on :4000.
const API = 'http://localhost:4000';
const app = document.getElementById('app');
const getToken = () => localStorage.getItem('je_token');
const setToken = (t) => t ? localStorage.setItem('je_token', t) : localStorage.removeItem('je_token');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kobo = (k) => '₦' + (Number(k || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });

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
  const [cats, items] = await Promise.all([api('/api/categories'), api('/api/search?limit=12')]);
  const list = (items.data.items || []).map((i) => `
    <div class="card"><h3><a href="#/${i.kind === 'product' ? 'p' : 's'}/${i.id}">${esc(i.title)}</a></h3>
    <div class="price">${kobo(i.price_kobo)}</div>
    <div class="muted">${esc(i.kind)}${i.location ? ' · ' + esc(i.location) : ''}</div></div>`).join('');
  app.innerHTML = `<h2>Marketplace</h2>
    <nav class="tabs">${(cats.data.categories || []).map((c) => `<a class="btn secondary" href="#/c/${c.id}">${esc(c.name)}</a>`).join('')}</nav>
    <div class="grid">${list || '<p class="muted">No listings yet — be the first to <a href="#/sell">sell</a>.</p>'}</div>`;
}

async function vSearch(q) {
  const params = new URLSearchParams({ q, limit: 24 });
  const { data } = await api('/api/search?' + params);
  app.innerHTML = `<h2>Results for “${esc(q)}” (${data.count})</h2>
    <div class="grid">${(data.items || []).map((i) => `
      <div class="card"><h3><a href="#/${i.kind === 'product' ? 'p' : 's'}/${i.id}">${esc(i.title)}</a></h3>
      <div class="price">${kobo(i.price_kobo)}</div><div class="muted">${esc(i.kind)}</div></div>`).join('')}</div>`;
}

async function vCategory(id) {
  const { data } = await api('/api/search?category=' + encodeURIComponent(id) + '&limit=24');
  app.innerHTML = `<h2>Category (${data.count})</h2>
    <div class="grid">${(data.items || []).map((i) => `
      <div class="card"><h3><a href="#/${i.kind === 'product' ? 'p' : 's'}/${i.id}">${esc(i.title)}</a></h3>
      <div class="price">${kobo(i.price_kobo)}</div></div>`).join('')}</div>`;
}

async function vDetail(kind, id) {
  const base = kind === 'p' ? 'products' : 'services';
  const { status, data } = await api(`/api/${base}/${id}`);
  if (status !== 200) { app.innerHTML = errBox('Listing not found.'); return; }
  const item = data.product || data.service;
  const who = data.seller || data.provider || {};
  app.innerHTML = `<div class="card"><h2>${esc(item.title)}</h2>
    <div class="price">${kobo(item.priceKobo)}</div>
    <p>${esc(item.description || '')}</p>
    <div class="muted">Seller: ${esc(who.name || '')} ${who.verificationLevel > 0 ? '<span class="badge">Verified</span>' : ''}${item.location ? ' · ' + esc(item.location) : ''}${item.stock != null ? ' · Stock: ' + item.stock : ''}</div>
    <div class="row" style="margin-top:12px">
      ${kind === 'p' ? `<button data-add="${item.id}">Add to cart</button>` : ''}
      <button class="secondary" data-chat="${who.id || ''}">Chat seller</button>
    </div></div>`;
  const add = app.querySelector('[data-add]');
  if (add) add.onclick = async () => {
    if (!getToken()) { location.hash = '#/auth'; return; }
    const cart = await api('/api/cart');
    const items = (cart.data.items || []).map((l) => ({ product_id: l.product_id, qty: l.qty }));
    items.push({ product_id: item.id, qty: 1 });
    const r = await api('/api/cart', { method: 'POST', body: { items } });
    if (r.status === 200) location.hash = '#/cart'; else app.insertAdjacentHTML('beforeend', errBox(r.data.error || 'Cannot add'));
  };
  const chat = app.querySelector('[data-chat]');
  if (chat) chat.onclick = async () => {
    if (!getToken()) { location.hash = '#/auth'; return; }
    const me = await refreshMe();
    const r = await api('/api/conversations', { method: 'POST', body: { with_user_id: chat.dataset.chat } });
    void me;
    if (r.data.conversation) location.hash = '#/messages/' + r.data.conversation.id;
  };
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
  app.innerHTML = `<div class="card"><h2>Order ${esc(o.id.slice(0, 8))}</h2>
    <p>Status: <b>${esc(o.status)}</b> · Escrow: <b>${esc(data.escrow ? data.escrow.state : 'none')}</b></p>
    ${(o.items || []).map((l) => `<div>${esc(l.title || l.service_id || '')} — ${kobo(l.line_kobo || l.price_kobo)}</div>`).join('')}
    <p>Total: <b>${kobo(o.totalKobo)}</b> (fee ${kobo(o.platformKobo)})</p><div id="msg"></div>
    <div class="row">
      ${isBuyer && ['delivered', 'completed'].includes(o.status) ? '<button id="cf">Confirm receipt</button>' : ''}
      ${!['completed', 'confirmed', 'cancelled'].includes(o.status) ? '<button id="cx" class="secondary">Cancel</button>' : ''}
      <a class="btn secondary" href="#/orders/${o.id}/review">Leave review</a>
    </div></div>`;
  const msg = (ok, m) => { document.getElementById('msg').innerHTML = ok ? `<div class="ok">${esc(m)}</div>` : errBox(m); };
  const cf = document.getElementById('cf');
  if (cf) cf.onclick = async () => { const r = await api(`/api/orders/${id}/confirm`, { method: 'POST', body: {} }); msg(r.status === 200, r.status === 200 ? 'Confirmed — funds released.' : (r.data.error || 'Failed')); if (r.status === 200) setTimeout(() => vOrderDetail(id), 800); };
  const cx = document.getElementById('cx');
  if (cx) cx.onclick = async () => { const r = await api(`/api/orders/${id}/cancel`, { method: 'POST', body: {} }); msg(r.status === 200, r.status === 200 ? 'Cancelled.' : (r.data.error || 'Failed')); if (r.status === 200) setTimeout(() => vOrderDetail(id), 800); };
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

async function vSell() {
  const cats = await api('/api/categories');
  const opts = (cats.data.categories || []).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  app.innerHTML = `<div class="card"><form class="narrow" id="f"><h2>Sell something</h2><div id="msg"></div>
    <select name="kind"><option value="product">Product</option><option value="service">Service</option></select>
    <input name="title" placeholder="Title" required>
    <textarea name="description" placeholder="Description"></textarea>
    <input name="price" type="number" min="0" placeholder="Price in naira" required>
    <select name="category_id"><option value="">Category…</option>${opts}</select>
    <input name="stock" type="number" min="0" value="1">
    <label><input type="checkbox" name="published" style="width:auto"> Publish immediately</label>
    <button>Create listing</button></form></div>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const kind = fd.get('kind');
    const r = await api(kind === 'product' ? '/api/products' : '/api/services', { method: 'POST',
      body: { title: fd.get('title'), description: fd.get('description'), price_kobo: Math.round(Number(fd.get('price')) * 100),
        category_id: fd.get('category_id') || undefined, stock: Number(fd.get('stock')), status: fd.get('published') ? 'published' : 'draft' } });
    document.getElementById('msg').innerHTML = r.status === 201 ? `<div class="ok">Created! <a href="#/${kind === 'product' ? 'p' : 's'}/${r.body[kind].id}">View</a></div>` : errBox(r.data.error || 'Failed');
  };
}

async function vMessages(id) {
  if (!id) {
    const { data } = await api('/api/conversations');
    app.innerHTML = `<h2>Messages</h2>` + ((data.conversations || []).map((c) => `
      <div class="card"><a href="#/messages/${c.id}">Thread ${esc(c.id.slice(0, 8))}</a>
      <div class="muted">${esc(c.last_body || 'No messages yet')}</div></div>`).join('') || '<p class="muted">No conversations. Chat a seller from a listing page.</p>');
    return;
  }
  const { data } = await api(`/api/conversations/${id}/messages`);
  app.innerHTML = `<h2>Thread</h2><div id="log">${(data.messages || []).map((m) => `<div class="msg" data-s="${m.sender_id}">${esc(m.body)}</div>`).join('')}</div>
    <form id="f" class="row"><input name="body" placeholder="Message…" required style="flex:1"><button>Send</button></form><div id="msg"></div>`;
  const me = await refreshMe();
  app.querySelectorAll('.msg').forEach((d) => d.classList.add(d.dataset.s === (me && me.id) ? 'me' : 'them'));
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = await api(`/api/conversations/${id}/messages`, { method: 'POST', body: { body: fd.get('body') } });
    if (r.status === 201) vMessages(id); else document.getElementById('msg').innerHTML = errBox(r.data.error || 'Failed');
  };
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
    <p><button id="out" class="secondary">Logout</button></p></div>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api('/api/me', { method: 'PATCH', body: { name: fd.get('name'), location: fd.get('location'), bio: fd.get('bio') } });
    await refreshMe();
  };
  document.getElementById('out').onclick = async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); setToken(null); location.hash = '#/'; };
}

// ---------- router ----------
async function route() {
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
    if (h === '#/sell') return vSell();
    if (h === '#/messages') return vMessages(null);
    if (h.startsWith('#/messages/')) return vMessages(h.slice(11));
    if (h === '#/me') return vMe();
    const q = document.getElementById('q').value;
    if (q) return vSearch(q);
    return vHome();
  } catch (e) { app.innerHTML = errBox('Something broke: ' + e.message); }
}
document.getElementById('q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value) { location.hash = '#/'; vSearch(e.target.value); } });
window.addEventListener('hashchange', route);
route();
