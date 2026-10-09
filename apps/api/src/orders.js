// Orders + checkout + payments-sim + confirm/cancel (PRD §§14,15,17,18).
// Money in kobo. Platform fee 5% (PLATFORM_FEE_BPS) on top of subtotal.
const crypto = require('crypto');
const { getDb } = require('./db');
const { send, readBody, requireUser } = require('./listings');
const { getCart, saveCart } = require('./cart');
const escrow = require('./escrow');

const PLATFORM_FEE_BPS = 500;

const PRODUCT_FLOW = ['pending', 'paid', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'completed'];
const SERVICE_FLOW = ['pending', 'paid', 'accepted', 'scheduled', 'in_progress', 'completed', 'confirmed'];
const TERMINAL = ['completed', 'confirmed', 'cancelled'];

const pub = (r) => ({
  id: r.id, buyerId: r.buyer_id, sellerId: r.seller_id, type: r.type, status: r.status,
  subtotalKobo: r.subtotal_kobo, deliveryKobo: r.delivery_kobo, platformKobo: r.platform_kobo,
  totalKobo: r.total_kobo, items: r.items, deliveryInfo: r.delivery_info, createdAt: r.created_at,
});

const fee = (subtotal) => Math.round((subtotal * PLATFORM_FEE_BPS) / 10000);

async function visibleOrder(db, id, user) {
  const r = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
  if (r.rows.length === 0) return { code: 404 };
  const o = r.rows[0];
  if (user.role !== 'admin' && user.id !== o.buyer_id && user.id !== o.seller_id) return { code: 403 };
  const ledger = await escrow.getLedger(db, o.id);
  return { order: pub(o), escrow: ledger ? { state: ledger.state, amountKobo: ledger.amount_kobo, audit: ledger.audit } : null };
}

async function handler(req, res) {
  const pathname = req.url.split('?')[0];
  const parts = pathname.split('/').filter(Boolean);
  const user = await requireUser(req);
  if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
  const db = await getDb();
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') {
    try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
  }

  // POST /api/checkout/preview — cart math without writing orders
  if (req.method === 'POST' && pathname === '/api/checkout/preview') {
    const { priceCart } = require('./cart');
    const items = await getCart(db, user.id);
    if (items.length === 0) return send(res, 400, { ok: false, error: 'cart-empty' });
    try {
      const priced = await priceCart(db, items);
      const bySeller = {};
      priced.lines.forEach((l) => { (bySeller[l.seller_id] = bySeller[l.seller_id] || []).push(l); });
      const groups = Object.entries(bySeller).map(([sellerId, lines]) => {
        const subtotal = lines.reduce((s, l) => s + l.line_kobo, 0);
        const platform = fee(subtotal);
        return { sellerId, lines, subtotalKobo: subtotal, deliveryKobo: 0, platformKobo: platform, totalKobo: subtotal + platform };
      });
      const total = groups.reduce((s, g) => s + g.totalKobo, 0);
      return send(res, 200, { ok: true, groups, orderCount: groups.length, grandTotalKobo: total, platformFeeBps: PLATFORM_FEE_BPS });
    } catch (e) {
      return send(res, e.code || 400, { ok: false, error: e.message });
    }
  }

  // POST /api/checkout/place — split cart per seller into pending orders
  if (req.method === 'POST' && pathname === '/api/checkout/place') {
    const { priceCart } = require('./cart');
    const items = await getCart(db, user.id);
    if (items.length === 0) return send(res, 400, { ok: false, error: 'cart-empty' });
    try {
      const priced = await priceCart(db, items);
      const bySeller = {};
      priced.lines.forEach((l) => { (bySeller[l.seller_id] = bySeller[l.seller_id] || []).push(l); });
      const created = [];
      for (const [sellerId, lines] of Object.entries(bySeller)) {
        if (sellerId === user.id) return send(res, 400, { ok: false, error: 'cannot-buy-own' });
        const subtotal = lines.reduce((s, l) => s + l.line_kobo, 0);
        const platform = fee(subtotal);
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO orders (id, buyer_id, seller_id, type, status, subtotal_kobo, delivery_kobo, platform_kobo, total_kobo, items, delivery_info, created_at)
           VALUES ($1,$2,$3,'product','pending',$4,0,$5,$6,$7,$8,$9)`,
          [id, user.id, sellerId, subtotal, platform, subtotal + platform, JSON.stringify(lines),
           body.delivery_info || null, new Date().toISOString()]
        );
        created.push(id);
      }
      await saveCart(db, user.id, []);
      const rows = await db.query('SELECT * FROM orders WHERE id = ANY($1)', [created]);
      return send(res, 201, { ok: true, orders: rows.rows.map(pub) });
    } catch (e) {
      return send(res, e.code || 400, { ok: false, error: e.message });
    }
  }

  // POST /api/orders {service_id} — direct service order
  if (req.method === 'POST' && pathname === '/api/orders') {
    if (!body.service_id) return send(res, 400, { ok: false, error: 'service-required' });
    const s = await db.query("SELECT * FROM services WHERE id = $1 AND status = 'published'", [body.service_id]);
    if (s.rows.length === 0) return send(res, 400, { ok: false, error: 'not-for-sale' });
    const svc = s.rows[0];
    if (svc.provider_id === user.id) return send(res, 400, { ok: false, error: 'cannot-buy-own' });
    const platform = fee(svc.price_kobo);
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO orders (id, buyer_id, seller_id, type, status, subtotal_kobo, delivery_kobo, platform_kobo, total_kobo, items, delivery_info, created_at)
       VALUES ($1,$2,$3,'service','pending',$4,0,$5,$6,$7,$8,$9)`,
      [id, user.id, svc.provider_id, svc.price_kobo, platform, svc.price_kobo + platform,
       JSON.stringify([{ service_id: svc.id, title: svc.title, price_kobo: svc.price_kobo }]),
       body.delivery_info || null, new Date().toISOString()]
    );
    const r = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
    return send(res, 201, { ok: true, order: pub(r.rows[0]) });
  }

  // POST /api/payments/simulate-pay {order_id} — dev stand-in for provider webhook
  if (req.method === 'POST' && pathname === '/api/payments/simulate-pay') {
    const r = await db.query('SELECT * FROM orders WHERE id = $1', [body.order_id]);
    if (r.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
    const o = r.rows[0];
    if (o.buyer_id !== user.id && user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });
    if (o.status !== 'pending') return send(res, 400, { ok: false, error: 'bad-status', status: o.status });
    // stock check + decrement for products
    if (o.type === 'product') {
      for (const line of o.items) {
        const p = await db.query('SELECT stock FROM products WHERE id = $1', [line.product_id]);
        if (p.rows.length === 0 || p.rows[0].stock < line.qty) return send(res, 400, { ok: false, error: 'insufficient-stock' });
      }
      for (const line of o.items) {
        await db.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [line.qty, line.product_id]);
      }
    }
    const ref = `sim-${crypto.randomUUID()}`;
    await db.query(
      "INSERT INTO payments (id, order_id, provider, reference, amount_kobo, status, created_at) VALUES ($1,$2,'manual',$3,$4,'paid',$5)",
      [crypto.randomUUID(), o.id, ref, o.total_kobo, new Date().toISOString()]
    );
    await db.query("UPDATE orders SET status = 'paid' WHERE id = $1", [o.id]);
    await escrow.hold(db, o.id, o.total_kobo);
    const fresh = await db.query('SELECT * FROM orders WHERE id = $1', [o.id]);
    return send(res, 200, { ok: true, order: pub(fresh.rows[0]), escrow: 'held', reference: ref });
  }

  // GET /api/escrow/:order_id
  if (req.method === 'GET' && parts[1] === 'escrow' && parts.length === 3) {
    const v = await visibleOrder(db, parts[2], user);
    if (v.code) return send(res, v.code, { ok: false, error: v.code === 404 ? 'not-found' : 'forbidden' });
    return send(res, 200, { ok: true, orderId: parts[2], escrow: v.escrow });
  }

  // GET /api/orders?role=buying|sold|all(admin)
  if (req.method === 'GET' && pathname === '/api/orders') {
    const url = new URL(req.url, 'http://x');
    const role = url.searchParams.get('role') || 'buying';
    let rows;
    if (role === 'sold') rows = await db.query('SELECT * FROM orders WHERE seller_id = $1 ORDER BY created_at DESC LIMIT 100', [user.id]);
    else if (role === 'all') {
      if (user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });
      rows = await db.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100');
    } else rows = await db.query('SELECT * FROM orders WHERE buyer_id = $1 ORDER BY created_at DESC LIMIT 100', [user.id]);
    return send(res, 200, { ok: true, orders: rows.rows.map(pub) });
  }

  // GET /api/orders/:id
  if (req.method === 'GET' && parts[1] === 'orders' && parts.length === 3) {
    const v = await visibleOrder(db, parts[2], user);
    if (v.code) return send(res, v.code, { ok: false, error: v.code === 404 ? 'not-found' : 'forbidden' });
    const pays = await db.query('SELECT reference, provider, amount_kobo, status, created_at FROM payments WHERE order_id = $1', [parts[2]]);
    return send(res, 200, { ok: true, order: v.order, escrow: v.escrow, payments: pays.rows });
  }

  // PATCH /api/orders/:id/status {status} — seller advances fulfillment (forward only)
  if ((req.method === 'PATCH') && parts[1] === 'orders' && parts[3] === 'status') {
    const r = await db.query('SELECT * FROM orders WHERE id = $1', [parts[2]]);
    if (r.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
    const o = r.rows[0];
    if (user.id !== o.seller_id && user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });
    const flow = o.type === 'product' ? PRODUCT_FLOW : SERVICE_FLOW;
    const cur = flow.indexOf(o.status);
    const nxt = flow.indexOf(body.status);
    const terminalByConfirm = o.type === 'product' ? 'completed' : 'confirmed';
    if (TERMINAL.includes(o.status)) return send(res, 400, { ok: false, error: 'terminal', status: o.status });
    // single-step forward only: no skipping; paid comes only from payment, terminal only via confirm/cancel
    if (body.status === 'paid' || body.status === 'pending' || body.status === 'cancelled' || nxt !== cur + 1) {
      return send(res, 400, { ok: false, error: 'bad-transition', from: o.status });
    }
    await db.query('UPDATE orders SET status = $1 WHERE id = $2', [body.status, o.id]);
    const fresh = await db.query('SELECT * FROM orders WHERE id = $1', [o.id]);
    return send(res, 200, { ok: true, order: pub(fresh.rows[0]) });
  }

  // POST /api/orders/:id/confirm — buyer confirms receipt/completion -> release escrow
  if (req.method === 'POST' && parts[1] === 'orders' && parts[3] === 'confirm') {
    const r = await db.query('SELECT * FROM orders WHERE id = $1', [parts[2]]);
    if (r.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
    const o = r.rows[0];
    if (user.id !== o.buyer_id && user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });
    const ready = o.type === 'product' ? 'delivered' : 'completed';
    const done = o.type === 'product' ? 'completed' : 'confirmed';
    if (o.status !== ready) return send(res, 400, { ok: false, error: 'not-ready', status: o.status, need: ready });
    await db.query('UPDATE orders SET status = $1 WHERE id = $2', [done, o.id]);
    const ledger = await escrow.release(db, o.id);
    const fresh = await db.query('SELECT * FROM orders WHERE id = $1', [o.id]);
    return send(res, 200, { ok: true, order: pub(fresh.rows[0]), escrow: ledger.state });
  }

  // POST /api/orders/:id/cancel — buyer (pending/paid) or seller (pending/paid/processing)
  if (req.method === 'POST' && parts[1] === 'orders' && parts[3] === 'cancel') {
    const r = await db.query('SELECT * FROM orders WHERE id = $1', [parts[2]]);
    if (r.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
    const o = r.rows[0];
    const isBuyer = user.id === o.buyer_id;
    const isSeller = user.id === o.seller_id;
    if (!isBuyer && !isSeller && user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });
    const allowed = isBuyer ? ['pending', 'paid'] : ['pending', 'paid', 'processing'];
    if (!allowed.includes(o.status) && user.role !== 'admin') return send(res, 400, { ok: false, error: 'too-late', status: o.status });
    if (o.status === 'paid') {
      if (o.type === 'product') {
        for (const line of o.items) {
          await db.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [line.qty, line.product_id]);
        }
      }
      await escrow.ensureLedger(db, o.id, o.total_kobo);
      await escrow.refund(db, o.id);
    }
    await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [o.id]);
    const fresh = await db.query('SELECT * FROM orders WHERE id = $1', [o.id]);
    return send(res, 200, { ok: true, order: pub(fresh.rows[0]) });
  }

  return send(res, 404, { ok: false, error: 'not-found' });
}

module.exports = { handler, PLATFORM_FEE_BPS };
