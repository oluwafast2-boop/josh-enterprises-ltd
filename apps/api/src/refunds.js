// Refunds (PRD §22). Buyer/admin on non-terminal orders.
// Full: escrow -> refunded, stock restored, order cancelled.
// Partial: recorded against held escrow (escrow stays held, audit note), order continues.
const crypto = require('crypto');
const { getDb } = require('./db');
const { send, readBody, requireUser } = require('./listings');
const escrow = require('./escrow');
const notify = require('./notify');

const TERMINAL = ['completed', 'confirmed', 'cancelled'];

async function handler(req, res) {
  // POST /api/orders/:id/refund {type: full|partial, amount_kobo?, reason?}
  const parts = req.url.split('?')[0].split('/').filter(Boolean);
  if (!(req.method === 'POST' && parts[1] === 'orders' && parts[3] === 'refund')) {
    return send(res, 404, { ok: false, error: 'not-found' });
  }
  const user = await requireUser(req);
  if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
  let body = {};
  try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
  const db = await getDb();
  const r = await db.query('SELECT * FROM orders WHERE id = $1', [parts[2]]);
  if (r.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
  const o = r.rows[0];
  if (user.id !== o.buyer_id && user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });
  if (TERMINAL.includes(o.status)) return send(res, 400, { ok: false, error: 'terminal', status: o.status });
  if (o.status === 'pending') return send(res, 400, { ok: false, error: 'not-paid' });
  const type = body.type === 'partial' ? 'partial' : 'full';
  const now = new Date().toISOString();

  if (type === 'full') {
    if (o.type === 'product') {
      for (const line of o.items) {
        await db.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [line.qty, line.product_id]);
      }
    }
    await escrow.ensureLedger(db, o.id, o.total_kobo);
    await escrow.refund(db, o.id);
    await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [o.id]);
    await db.query(
      "INSERT INTO refunds (id, order_id, type, amount_kobo, reason, status, created_at) VALUES ($1,$2,'full',$3,$4,'applied',$5)",
      [crypto.randomUUID(), o.id, o.total_kobo, body.reason ? String(body.reason).slice(0, 500) : null, now]);
    await notify.create(db, o.seller_id, 'refund_applied', { order_id: o.id, type: 'full', amount_kobo: o.total_kobo });
    const fresh = await db.query('SELECT * FROM orders WHERE id = $1', [o.id]);
    return send(res, 200, { ok: true, type: 'full', amountKobo: o.total_kobo, order: { id: fresh.rows[0].id, status: fresh.rows[0].status } });
  }

  // partial
  const amount = Number(body.amount_kobo);
  if (!Number.isInteger(amount) || amount <= 0 || amount >= o.total_kobo) {
    return send(res, 400, { ok: false, error: 'bad-amount', hint: '0 < amount_kobo < total' });
  }
  await db.query(
    "INSERT INTO refunds (id, order_id, type, amount_kobo, reason, status, created_at) VALUES ($1,$2,'partial',$3,$4,'applied',$5)",
    [crypto.randomUUID(), o.id, amount, body.reason ? String(body.reason).slice(0, 500) : null, now]);
  const ledger = await escrow.getLedger(db, o.id);
  if (ledger && ledger.state === 'held') {
    await db.query(`UPDATE escrow_ledger SET audit = COALESCE(audit,'[]'::jsonb) || $1::jsonb, updated_at = $2 WHERE order_id = $3`,
      [JSON.stringify([{ at: now, event: 'partial-refund', amount_kobo: amount }]), now, o.id]);
  }
  await notify.create(db, o.seller_id, 'refund_applied', { order_id: o.id, type: 'partial', amount_kobo: amount });
  return send(res, 200, { ok: true, type: 'partial', amountKobo: amount });
}

module.exports = { handler };
