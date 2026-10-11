// Reviews & ratings (PRD §21). Buyer-only, one per completed order.
const crypto = require('crypto');
const { getDb } = require('./db');
const { send, readBody, requireUser } = require('./listings');
const notify = require('./notify');

const pub = (r) => ({
  id: r.id, orderId: r.order_id, authorId: r.author_id, targetUserId: r.target_user_id,
  listingKind: r.listing_kind, listingId: r.listing_id, rating: r.rating,
  dimensions: r.dimensions, photos: r.photos, body: r.body, response: r.response,
  verifiedPurchase: r.verified_purchase, createdAt: r.created_at,
});

async function handler(req, res) {
  const parts = req.url.split('?')[0].split('/').filter(Boolean);
  const db = await getDb();

  // GET /api/reviews?listing=product:<id> | ?order=<id> — public
  if (req.method === 'GET' && parts.length === 2) {
    const url = new URL(req.url, 'http://x');
    const listing = url.searchParams.get('listing');
    const orderId = url.searchParams.get('order');
    let rows;
    if (orderId) rows = await db.query('SELECT * FROM reviews WHERE order_id = $1', [orderId]);
    else if (listing) {
      const [kind, ...rest] = listing.split(':');
      rows = await db.query('SELECT * FROM reviews WHERE listing_kind = $1 AND listing_id = $2 ORDER BY created_at DESC LIMIT 50', [kind, rest.join(':')]);
    } else rows = await db.query('SELECT * FROM reviews ORDER BY created_at DESC LIMIT 50');
    return send(res, 200, { ok: true, reviews: rows.rows.map(pub) });
  }

  const user = await requireUser(req);
  if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') {
    try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
  }

  // POST /api/orders/:id/review {rating 1-5, body?, dimensions?, photos?}
  if (req.method === 'POST' && parts[1] === 'orders' && parts[3] === 'review') {
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return send(res, 400, { ok: false, error: 'bad-rating' });
    const o = await db.query('SELECT * FROM orders WHERE id = $1', [parts[2]]);
    if (o.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
    const order = o.rows[0];
    if (order.buyer_id !== user.id) return send(res, 403, { ok: false, error: 'forbidden' });
    const terminal = order.type === 'product' ? 'completed' : 'confirmed';
    if (order.status !== terminal) return send(res, 400, { ok: false, error: 'not-complete', status: order.status });
    const dupe = await db.query('SELECT id FROM reviews WHERE order_id = $1', [order.id]);
    if (dupe.rows.length > 0) return send(res, 409, { ok: false, error: 'already-reviewed' });
    const first = (order.items || [])[0] || {};
    const listingKind = order.type;
    const listingId = first.product_id || first.service_id || null;
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO reviews (id, order_id, author_id, target_user_id, listing_kind, listing_id, rating, dimensions, photos, body, response, verified_purchase, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,TRUE,$11)`,
      [id, order.id, user.id, order.seller_id, listingKind, listingId, rating,
       body.dimensions || null, body.photos || null, body.body ? String(body.body).slice(0, 2000) : null, new Date().toISOString()]
    );
    await notify.create(db, order.seller_id, 'new_review', { order_id: order.id, rating });
    const r = await db.query('SELECT * FROM reviews WHERE id = $1', [id]);
    return send(res, 201, { ok: true, review: pub(r.rows[0]) });
  }

  if (parts.length < 3 || parts[1] !== 'reviews') return send(res, 404, { ok: false, error: 'not-found' });
  const existing = await db.query('SELECT * FROM reviews WHERE id = $1', [parts[2]]);
  if (existing.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
  const rev = existing.rows[0];

  // POST /api/reviews/:id/respond {response} — reviewed seller only
  if (req.method === 'POST' && parts[3] === 'respond') {
    if (rev.target_user_id !== user.id) return send(res, 403, { ok: false, error: 'forbidden' });
    const response = String(body.response || '').trim().slice(0, 1000);
    if (!response) return send(res, 400, { ok: false, error: 'response-required' });
    await db.query('UPDATE reviews SET response = $1 WHERE id = $2', [response, rev.id]);
    const r = await db.query('SELECT * FROM reviews WHERE id = $1', [rev.id]);
    return send(res, 200, { ok: true, review: pub(r.rows[0]) });
  }

  // POST /api/reviews/:id/report {reason} — anyone authed
  if (req.method === 'POST' && parts[3] === 'report') {
    const reason = String(body.reason || '').trim().slice(0, 500);
    if (!reason) return send(res, 400, { ok: false, error: 'reason-required' });
    const id = crypto.randomUUID();
    await db.query(
      "INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at) VALUES ($1,$2,'review',$3,$4,'open',$5)",
      [id, user.id, rev.id, reason, new Date().toISOString()]);
    return send(res, 201, { ok: true, report: id });
  }

  return send(res, 404, { ok: false, error: 'not-found' });
}

module.exports = { handler };
