// Notifications inbox (PRD §24).
const { getDb } = require('./db');
const { send, readBody, requireUser } = require('./listings');

async function handler(req, res) {
  const parts = req.url.split('?')[0].split('/').filter(Boolean);
  const user = await requireUser(req);
  if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
  const db = await getDb();

  // GET /api/notifications[?unread=1]
  if (req.method === 'GET' && parts.length === 2) {
    const unreadOnly = req.url.includes('unread=1');
    const r = await db.query(
      `SELECT * FROM notifications WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 50`, [user.id]);
    const unread = await db.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [user.id]);
    return send(res, 200, { ok: true, unread: unread.rows[0].n, notifications: r.rows });
  }

  // PATCH /api/notifications/:id/read
  if ((req.method === 'PATCH' || req.method === 'POST') && parts.length === 3 && parts[2] === 'read-all') {
    await db.query('UPDATE notifications SET read_at = $1 WHERE user_id = $2 AND read_at IS NULL', [new Date().toISOString(), user.id]);
    return send(res, 200, { ok: true });
  }
  if ((req.method === 'PATCH' || req.method === 'POST') && parts.length === 4 && parts[3] === 'read') {
    const r = await db.query('UPDATE notifications SET read_at = $1 WHERE id = $2 AND user_id = $3 AND read_at IS NULL',
      [new Date().toISOString(), parts[2], user.id]);
    if (r.rowCount === 0) return send(res, 404, { ok: false, error: 'not-found' });
    return send(res, 200, { ok: true });
  }

  void readBody;
  return send(res, 404, { ok: false, error: 'not-found' });
}

module.exports = { handler };
