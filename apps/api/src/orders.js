// Orders + checkout + payments-sim + confirm/cancel (PRD §§14,15,17,18).
// Money in kobo. Platform fee 5% (PLATFORM_FEE_BPS) on top of subtotal.
const crypto = require('crypto');
const { getDb } = require('./db');
const { send, readBody, requireUser } = require('./listings');
const { getCart, saveCart } = require('./cart');
const escrow = require('./escrow');
const notify = require('./notify');

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

// Shared settlement: stock check/decrement, payment record, paid + escrow hold + notifications.
// Throws on insufficient stock. Idempotent per reference (ON CONFLICT updates to paid).
async function settlePaid(db, o, provider, reference) {
  if (o.type === 'product') {
    for (const line of o.items) {
      const p = await db.query('SELECT stock FROM products WHERE id = $1', [line.product_id]);
      if (p.rows.length === 0 || p.rows[0].stock < line.qty) throw new Error('insufficient-stock');
    }
    for (const line of o.items) {
      await db.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [line.qty, line.product_id]);
    }
  }
  await db.query(
    `INSERT INTO payments (id, order_id, provider, reference, amount_kobo, status, created_at) VALUES ($1,$2,$3,$4,$5,'paid',$6)
     ON CONFLICT (reference) DO UPDATE SET status = 'paid'`,
    [crypto.randomUUID(), o.id, provider, reference, o.total_kobo, new Date().toISOString()]
  );
  await db.query("UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending'", [o.id]);
  await escrow.hold(db, o.id, o.total_kobo);
  await notify.create(db, o.buyer_id, 'payment_confirmed', { order_id: o.id, total_kobo: o.total_kobo, reference });
  await notify.create(db, o.seller_id, 'payment_received', { order_id: o.id, total_kobo: o.total_kobo });
}

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
  const isWebhook = req.method === 'POST' && pathname === '/api/payments/webhook';
  const user = isWebhook ? null : await requireUser(req);
  if (!user && !isWebhook) return send(res, 401, { ok: false, error: 'unauthorized' });
  const db = await getDb();
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') {
    try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
  }
  // Webhook is server-to-server (HMAC verified here) — no user session.
  if (isWebhook) {
    const paystack = require('./paystack');
    if (!paystack.enabled()) return send(res, 501, { ok: false, error: 'paystack-disabled' });
    if (!paystack.verifySignature(req._raw || '', req.headers['x-paystack-signature'])) {
      return send(res, 401, { ok: false, error: 'bad-signature' });
    }
    if (body.event === 'charge.success') {
      const ref = body.data && body.data.reference;
      const paidKobo = body.data && body.data.amount;
      const pay = await db.query('SELECT * FROM payments WHERE reference = $1', [ref]);
      if (pay.rows.length === 0) return send(res, 200, { ok: true, ignored: 'unknown-reference' });
      const o = (await db.query('SELECT * FROM orders WHERE id = $1', [pay.rows[0].order_id])).rows[0];
      if (!o) return send(res, 200, { ok: true, ignored: 'unknown-order' });
      if (paidKobo !== o.total_kobo) return send(res, 200, { ok: true, ignored: 'amount-mismatch' });
      if (o.status === 'pending') {
        try { await settlePaid(db, o, 'paystack', ref); }
        catch (e) { return send(res, 200, { ok: true, ignored: String(e.message).slice(0, 80) }); }
      }
      return send(res, 200, { ok: true, settled: o.id });
    }
    return send(res, 200, { ok: true, ignored: body.event || 'unknown' });
  }
  // Webhook is server-to-server (HMAC verified here) — no user session.

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
      for (const o of rows.rows) {
        await notify.create(db, o.seller_id, 'order_placed', { order_id: o.id, total_kobo: o.total_kobo, buyer_id: user.id });
      }
      return send(res, 201, { ok: true, orders: rows.rows.map(pub) });
    } catch (e) {
      return send(res, e.code || 400, { ok: false, error: e.message });
    }
  }

  // POST /api/orders {service_id, slot?: {date, time}} — direct service order/booking
  if (req.method === 'POST' && pathname === '/api/orders') {
    if (!body.service_id) return send(res, 400, { ok: false, error: 'service-required' });
    const s = await db.query("SELECT * FROM services WHERE id = $1 AND status = 'published'", [body.service_id]);
    if (s.rows.length === 0) return send(res, 400, { ok: false, error: 'not-for-sale' });
    const svc = s.rows[0];
    if (svc.provider_id === user.id) return send(res, 400, { ok: false, error: 'cannot-buy-own' });
    let slot = null;
    if (body.slot) {
      const date = String(body.slot.date || '');
      const time = String(body.slot.time || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < new Date().toISOString().slice(0, 10)) {
        return send(res, 400, { ok: false, error: 'bad-slot-date' });
      }
      if (!/^\d{2}:\d{2}$/.test(time)) return send(res, 400, { ok: false, error: 'bad-slot-time' });
      slot = { date, time };
    }
    const platform = fee(svc.price_kobo);
    const id = crypto.randomUUID();
    const deliveryInfo = { ...(body.delivery_info || {}), ...(slot ? { slot } : {}) };
    await db.query(
      `INSERT INTO orders (id, buyer_id, seller_id, type, status, subtotal_kobo, delivery_kobo, platform_kobo, total_kobo, items, delivery_info, created_at)
       VALUES ($1,$2,$3,'service','pending',$4,0,$5,$6,$7,$8,$9)`,
      [id, user.id, svc.provider_id, svc.price_kobo, platform, svc.price_kobo + platform,
       JSON.stringify([{ service_id: svc.id, title: svc.title, price_kobo: svc.price_kobo }]),
       deliveryInfo, new Date().toISOString()]
    );
    const r = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
    await notify.create(db, svc.provider_id, 'order_placed', { order_id: id, total_kobo: svc.price_kobo + platform, buyer_id: user.id });
    return send(res, 201, { ok: true, order: pub(r.rows[0]) });
  }

  // POST /api/payments/simulate-pay {order_id} — dev stand-in (kept for tests)
  if (req.method === 'POST' && pathname === '/api/payments/simulate-pay') {
    const r = await db.query('SELECT * FROM orders WHERE id = $1', [body.order_id]);
    if (r.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
    const o = r.rows[0];
    if (o.buyer_id !== user.id && user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });
    if (o.status !== 'pending') return send(res, 400, { ok: false, error: 'bad-status', status: o.status });
    try {
      const ref = `sim-${crypto.randomUUID()}`;
      await settlePaid(db, o, 'manual', ref);
      const fresh = await db.query('SELECT * FROM orders WHERE id = $1', [o.id]);
      return send(res, 200, { ok: true, order: pub(fresh.rows[0]), escrow: 'held', reference: ref });
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message });
    }
  }

  // POST /api/payments/init {order_id} — real Paystack transaction
  if (req.method === 'POST' && pathname === '/api/payments/init') {
    const paystack = require('./paystack');
    if (!paystack.enabled()) return send(res, 501, { ok: false, error: 'paystack-disabled', hint: 'set PAYSTACK_SECRET_KEY' });
    const r = await db.query('SELECT * FROM orders WHERE id = $1', [body.order_id]);
    if (r.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
    const o = r.rows[0];
    if (o.buyer_id !== user.id && user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });
    if (o.status !== 'pending') return send(res, 400, { ok: false, error: 'bad-status', status: o.status });
    const buyer = await db.query('SELECT email FROM users WHERE id = $1', [o.buyer_id]);
    const ref = `josh-${o.id.slice(0, 8)}-${Date.now()}`;
    try {
      const init = await paystack.init(buyer.rows[0].email, o.total_kobo, ref, { order_id: o.id });
      await db.query(
        "INSERT INTO payments (id, order_id, provider, reference, amount_kobo, status, created_at) VALUES ($1,$2,'paystack',$3,$4,'initialized',$5) ON CONFLICT (reference) DO NOTHING",
        [crypto.randomUUID(), o.id, ref, o.total_kobo, new Date().toISOString()]
      );
      return send(res, 200, { ok: true, authorizationUrl: init.authorization_url, reference: ref });
    } catch (e) {
      return send(res, 502, { ok: false, error: 'paystack-init-failed', hint: String(e.message).slice(0, 120) });
    }
  }

  // POST /api/payments/webhook lives above (unauthenticated, HMAC verified).

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
    await notify.create(db, o.buyer_id, 'order_status', { order_id: o.id, status: body.status });
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
    const openDispute = await db.query("SELECT id FROM disputes WHERE order_id = $1 AND status = 'open' LIMIT 1", [o.id]);
    if (openDispute.rows.length > 0) return send(res, 400, { ok: false, error: 'dispute-open' });
    await db.query('UPDATE orders SET status = $1 WHERE id = $2', [done, o.id]);
    const ledger = await escrow.release(db, o.id);
    await notify.create(db, o.seller_id, 'order_confirmed', { order_id: o.id, total_kobo: o.total_kobo });
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
    const otherParty = user.id === o.buyer_id ? o.seller_id : o.buyer_id;
    await notify.create(db, otherParty, 'order_cancelled', { order_id: o.id, by: user.id });
    const fresh = await db.query('SELECT * FROM orders WHERE id = $1', [o.id]);
    return send(res, 200, { ok: true, order: pub(fresh.rows[0]) });
  }

  return send(res, 404, { ok: false, error: 'not-found' });
}

module.exports = { handler, PLATFORM_FEE_BPS };
