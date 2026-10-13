// Messaging (PRD §12, MVP: text + images + block). Voice/video = Phase 2.
const crypto = require('crypto');
const { getDb } = require('./db');
const { send, readBody, requireUser } = require('./listings');

async function isBlocked(db, a, b) {
  const r = await db.query(
    'SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1', [a, b]);
  return r.rows.length > 0;
}

async function participant(db, convId, userId) {
  const r = await db.query('SELECT * FROM conversations WHERE id = $1', [convId]);
  if (r.rows.length === 0) return { code: 404 };
  const c = r.rows[0];
  if (c.buyer_id !== userId && c.seller_id !== userId) return { code: 403 };
  return { conv: c };
}

async function handler(req, res) {
  const pathname = req.url.split('?')[0];
  const parts = pathname.split('/').filter(Boolean); // api, conversations, ...
  const user = await requireUser(req);
  if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
  const db = await getDb();
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
    try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
  }

  // GET /api/conversations — own threads, latest message preview + unread count
  if (req.method === 'GET' && parts.length === 2) {
    const r = await db.query(
      `SELECT c.*, (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
              (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
              (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> $1
                 AND m.created_at > COALESCE(CASE WHEN c.buyer_id = $1 THEN c.buyer_last_read ELSE c.seller_last_read END, '1970-01-01')) AS unread
       FROM conversations c WHERE c.buyer_id = $1 OR c.seller_id = $1 ORDER BY last_at DESC NULLS LAST, c.created_at DESC LIMIT 50`,
      [user.id]);
    return send(res, 200, { ok: true, conversations: r.rows });
  }

  // POST /api/conversations {with_user_id | seller_id, order_id?}
  if (req.method === 'POST' && parts.length === 2) {
    const otherId = body.with_user_id || body.seller_id;
    if (!otherId || otherId === user.id) return send(res, 400, { ok: false, error: 'bad-peer' });
    const peer = await db.query('SELECT id FROM users WHERE id = $1', [otherId]);
    if (peer.rows.length === 0) return send(res, 404, { ok: false, error: 'no-user' });
    if (await isBlocked(db, user.id, otherId)) return send(res, 403, { ok: false, error: 'blocked' });
    let orderId = body.order_id || null;
    if (orderId) {
      const o = await db.query('SELECT buyer_id, seller_id FROM orders WHERE id = $1', [orderId]);
      if (o.rows.length === 0) return send(res, 400, { ok: false, error: 'bad-order' });
      const pair = [o.rows[0].buyer_id, o.rows[0].seller_id].sort().join('|');
      if (pair !== [user.id, otherId].sort().join('|')) return send(res, 400, { ok: false, error: 'order-mismatch' });
    }
    // dedupe: same pair + same order returns existing
    const dupe = await db.query(
      `SELECT id FROM conversations WHERE ((buyer_id=$1 AND seller_id=$2) OR (buyer_id=$2 AND seller_id=$1))
        AND (order_id IS NOT DISTINCT FROM $3) LIMIT 1`, [user.id, otherId, orderId]);
    if (dupe.rows.length > 0) {
      const c = await db.query('SELECT * FROM conversations WHERE id = $1', [dupe.rows[0].id]);
      return send(res, 200, { ok: true, conversation: c.rows[0], deduped: true });
    }
    const buyerId = orderId ? (await db.query('SELECT buyer_id FROM orders WHERE id=$1', [orderId])).rows[0].buyer_id : user.id;
    const sellerId = buyerId === user.id ? otherId : user.id;
    const id = crypto.randomUUID();
    await db.query('INSERT INTO conversations (id, buyer_id, seller_id, order_id, created_at) VALUES ($1,$2,$3,$4,$5)',
      [id, buyerId, sellerId, orderId, new Date().toISOString()]);
    const c = await db.query('SELECT * FROM conversations WHERE id = $1', [id]);
    return send(res, 201, { ok: true, conversation: c.rows[0] });
  }

  // POST /api/conversations/:id/block — block the other participant
  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'block') {
    const p = await participant(db, parts[2], user.id);
    if (p.code) return send(res, p.code, { ok: false, error: p.code === 404 ? 'not-found' : 'forbidden' });
    const other = p.conv.buyer_id === user.id ? p.conv.seller_id : p.conv.buyer_id;
    await db.query('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [user.id, other, new Date().toISOString()]);
    return send(res, 200, { ok: true, blocked: other });
  }

  // DELETE /api/conversations/:id/block — unblock
  if (req.method === 'DELETE' && parts.length === 4 && parts[3] === 'block') {
    const p = await participant(db, parts[2], user.id);
    if (p.code) return send(res, p.code, { ok: false, error: p.code === 404 ? 'not-found' : 'forbidden' });
    const other = p.conv.buyer_id === user.id ? p.conv.seller_id : p.conv.buyer_id;
    await db.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [user.id, other]);
    return send(res, 200, { ok: true, unblocked: other });
  }

  if (parts.length < 3) return send(res, 404, { ok: false, error: 'not-found' });
  const p = await participant(db, parts[2], user.id);
  if (p.code) return send(res, p.code, { ok: false, error: p.code === 404 ? 'not-found' : 'forbidden' });
  const other = p.conv.buyer_id === user.id ? p.conv.seller_id : p.conv.buyer_id;

  // GET /api/conversations/:id/messages (marks own side read)
  if (req.method === 'GET' && parts[3] === 'messages') {
    const col = p.conv.buyer_id === user.id ? 'buyer_last_read' : 'seller_last_read';
    await db.query(`UPDATE conversations SET ${col} = $1 WHERE id = $2`, [new Date().toISOString(), parts[2]]);
    const r = await db.query('SELECT id, sender_id, body, attachments, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 100', [parts[2]]);
    return send(res, 200, { ok: true, messages: r.rows });
  }

  // POST /api/conversations/:id/messages {body, attachments?}
  if (req.method === 'POST' && parts[3] === 'messages') {
    const text = String(body.body || '').trim().slice(0, 2000);
    if (!text) return send(res, 400, { ok: false, error: 'body-required' });
    if (await isBlocked(db, user.id, other)) return send(res, 403, { ok: false, error: 'blocked' });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.query('INSERT INTO messages (id, conversation_id, sender_id, body, attachments, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, parts[2], user.id, text, body.attachments || null, now]);
    const notify = require('./notify');
    await notify.create(db, other, 'new_message', { conversation_id: parts[2], from: user.id, preview: text.slice(0, 120) });
    return send(res, 201, { ok: true, message: { id, sender_id: user.id, body: text, created_at: now } });
  }

  return send(res, 404, { ok: false, error: 'not-found' });
}

module.exports = { handler, isBlocked };
