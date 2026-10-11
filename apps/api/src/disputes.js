// Hybrid disputes (PRD §23). Open freezes escrow (held->disputed);
// admin resolves release (completed + released) or refund (cancelled + refunded).
const crypto = require('crypto');
const { getDb } = require('./db');
const { send, readBody, requireUser } = require('./listings');
const escrow = require('./escrow');
const notify = require('./notify');

const TERMINAL = ['completed', 'confirmed', 'cancelled'];
const pub = (r) => ({
  id: r.id, orderId: r.order_id, raisedBy: r.raised_by, reason: r.reason, evidence: r.evidence,
  status: r.status, resolution: r.resolution, createdAt: r.created_at, resolvedAt: r.resolved_at,
});

async function handler(req, res) {
  const parts = req.url.split('?')[0].split('/').filter(Boolean);
  const user = await requireUser(req);
  if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
  const db = await getDb();
  let body = {};
  if (req.method === 'POST') {
    try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
  }

  // GET /api/disputes — own (buyer or seller); admin ?all=1
  if (req.method === 'GET' && parts.length === 2) {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('all') === '1') {
      if (user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });
      const r = await db.query("SELECT * FROM disputes WHERE status = 'open' ORDER BY created_at DESC LIMIT 100");
      return send(res, 200, { ok: true, disputes: r.rows.map(pub) });
    }
    const r = await db.query(
      `SELECT d.* FROM disputes d JOIN orders o ON o.id = d.order_id
       WHERE o.buyer_id = $1 OR o.seller_id = $1 ORDER BY d.created_at DESC LIMIT 100`, [user.id]);
    return send(res, 200, { ok: true, disputes: r.rows.map(pub) });
  }

  // POST /api/disputes {order_id, reason, evidence?}
  if (req.method === 'POST' && parts.length === 2) {
    if (!body.order_id || !String(body.reason || '').trim()) return send(res, 400, { ok: false, error: 'order-and-reason-required' });
    const o = await db.query('SELECT * FROM orders WHERE id = $1', [body.order_id]);
    if (o.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
    const order = o.rows[0];
    if (user.id !== order.buyer_id && user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });
    if (TERMINAL.includes(order.status)) return send(res, 400, { ok: false, error: 'terminal', status: order.status });
    if (order.status === 'pending') return send(res, 400, { ok: false, error: 'not-paid' });
    const open = await db.query("SELECT id FROM disputes WHERE order_id = $1 AND status = 'open' LIMIT 1", [order.id]);
    if (open.rows.length > 0) return send(res, 409, { ok: false, error: 'already-open' });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.query(
      "INSERT INTO disputes (id, order_id, raised_by, reason, evidence, status, resolution, resolver_id, created_at, resolved_at) VALUES ($1,$2,$3,$4,$5,'open',NULL,NULL,$6,NULL)",
      [id, order.id, user.id, String(body.reason).slice(0, 1000), body.evidence || null, now]);
    await escrow.ensureLedger(db, order.id, order.total_kobo);
    await db.query(`UPDATE escrow_ledger SET state='disputed', updated_at=$1,
      audit = COALESCE(audit,'[]'::jsonb) || $2::jsonb WHERE order_id = $3 AND state = 'held'`, [now, JSON.stringify([{ at: now, event: 'dispute-opened' }]), order.id]);
    await notify.create(db, order.seller_id, 'dispute_opened', { order_id: order.id });
    const r = await db.query('SELECT * FROM disputes WHERE id = $1', [id]);
    return send(res, 201, { ok: true, dispute: pub(r.rows[0]) });
  }

  if (parts.length < 3) return send(res, 404, { ok: false, error: 'not-found' });
  const existing = await db.query('SELECT * FROM disputes WHERE id = $1', [parts[2]]);
  if (existing.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
  const d = existing.rows[0];
  const order = (await db.query('SELECT * FROM orders WHERE id = $1', [d.order_id])).rows[0];
  const involved = user.id === order.buyer_id || user.id === order.seller_id || user.role === 'admin';
  if (!involved) return send(res, 403, { ok: false, error: 'forbidden' });

  // POST /api/disputes/:id/evidence {urls: []} — involved parties while open
  if (req.method === 'POST' && parts[3] === 'evidence') {
    if (d.status !== 'open') return send(res, 400, { ok: false, error: 'closed' });
    if (!Array.isArray(body.urls) || body.urls.length === 0) return send(res, 400, { ok: false, error: 'urls-required' });
    const merged = [...(d.evidence || []), ...body.urls.map(String).slice(0, 10)];
    await db.query('UPDATE disputes SET evidence = $1 WHERE id = $2', [JSON.stringify(merged), d.id]);
    const r = await db.query('SELECT * FROM disputes WHERE id = $1', [d.id]);
    return send(res, 200, { ok: true, dispute: pub(r.rows[0]) });
  }

  // POST /api/disputes/:id/resolve {decision: release|refund} — admin only
  if (req.method === 'POST' && parts[3] === 'resolve') {
    if (user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });
    if (d.status !== 'open') return send(res, 400, { ok: false, error: 'closed' });
    const decision = body.decision === 'refund' ? 'refund' : 'release';
    const now = new Date().toISOString();
    if (decision === 'release') {
      const done = order.type === 'product' ? 'completed' : 'confirmed';
      await db.query('UPDATE orders SET status = $1 WHERE id = $2', [done, order.id]);
      await db.query(`UPDATE escrow_ledger SET state='released', updated_at=$1,
        audit = COALESCE(audit,'[]'::jsonb) || $2::jsonb WHERE order_id = $3`, [now, JSON.stringify([{ at: now, event: 'dispute-resolved-release' }]), order.id]);
    } else {
      if (order.type === 'product') {
        for (const line of order.items) {
          await db.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [line.qty, line.product_id]);
        }
      }
      await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [order.id]);
      await db.query(`UPDATE escrow_ledger SET state='refunded', updated_at=$1,
        audit = COALESCE(audit,'[]'::jsonb) || $2::jsonb WHERE order_id = $3`, [now, JSON.stringify([{ at: now, event: 'dispute-resolved-refund' }]), order.id]);
      await db.query(
        "INSERT INTO refunds (id, order_id, type, amount_kobo, reason, status, created_at) VALUES ($1,$2,'full',$3,$4,'applied',$5)",
        [crypto.randomUUID(), order.id, order.total_kobo, `dispute ${d.id}`, now]);
    }
    await db.query('UPDATE disputes SET status = $1, resolution = $2, resolver_id = $3, resolved_at = $4 WHERE id = $5',
      ['resolved', decision, user.id, now, d.id]);
    await notify.create(db, order.buyer_id, 'dispute_resolved', { order_id: order.id, decision });
    await notify.create(db, order.seller_id, 'dispute_resolved', { order_id: order.id, decision });
    const r = await db.query('SELECT * FROM disputes WHERE id = $1', [d.id]);
    return send(res, 200, { ok: true, dispute: pub(r.rows[0]) });
  }

  return send(res, 404, { ok: false, error: 'not-found' });
}

module.exports = { handler };
