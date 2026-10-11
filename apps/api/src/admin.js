// Admin (PRD §28) + trust reports (PRD §31).
const crypto = require('crypto');
const { getDb } = require('./db');
const { send, readBody, requireUser } = require('./listings');
const notify = require('./notify');

async function handler(req, res) {
  const pathname = req.url.split('?')[0];
  const parts = pathname.split('/').filter(Boolean);
  const db = await getDb();

  // POST /api/reports {target_type, target_id, reason} — any authed user
  if (req.method === 'POST' && parts[1] === 'reports' && parts.length === 2) {
    const user = await requireUser(req);
    if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
    let body = {};
    try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
    const valid = ['user', 'listing', 'message', 'review', 'business'];
    if (!valid.includes(body.target_type) || !body.target_id || !String(body.reason || '').trim()) {
      return send(res, 400, { ok: false, error: 'target-and-reason-required' });
    }
    const id = crypto.randomUUID();
    await db.query(
      "INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at) VALUES ($1,$2,$3,$4,$5,'open',$6)",
      [id, user.id, body.target_type, String(body.target_id), String(body.reason).slice(0, 500), new Date().toISOString()]);
    return send(res, 201, { ok: true, report: id });
  }

  // everything else under /api/admin — admin only
  if (parts[1] !== 'admin') return send(res, 404, { ok: false, error: 'not-found' });
  const user = await requireUser(req);
  if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
  if (user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') {
    try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
  }

  // GET /api/admin/overview — marketplace + transactions + financials (§33)
  if (req.method === 'GET' && pathname === '/api/admin/overview') {
    const q = (sql, p = []) => db.query(sql, p).then((r) => r.rows[0]);
    const users = await q('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE role = \'seller\' OR role = \'business\')::int AS sellers FROM users');
    const products = await q("SELECT COUNT(*)::int AS n FROM products WHERE status = 'published'");
    const services = await q("SELECT COUNT(*)::int AS n FROM services WHERE status = 'published'");
    const orders = await q("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status IN ('completed','confirmed'))::int AS done, COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled FROM orders");
    const gtv = await q("SELECT COALESCE(SUM(total_kobo),0)::int AS gtv FROM orders WHERE status IN ('completed','confirmed')");
    const revenue = await q("SELECT COALESCE(SUM(platform_kobo),0)::int AS revenue FROM orders WHERE status IN ('completed','confirmed')");
    const escrowPending = await q("SELECT COALESCE(SUM(amount_kobo),0)::int AS pending FROM escrow_ledger WHERE state = 'held'");
    const disputes = await q("SELECT COUNT(*)::int AS open FROM disputes WHERE status = 'open'");
    const refunds = await q('SELECT COALESCE(SUM(amount_kobo),0)::int AS refunded FROM refunds');
    const reports = await q("SELECT COUNT(*)::int AS open FROM reports WHERE status = 'open'");
    return send(res, 200, {
      ok: true, overview: { users: users.total, sellers: users.sellers, publishedProducts: products.n, publishedServices: services.n,
        orders: orders.total, completedOrders: orders.done, cancelledOrders: orders.cancelled,
        gtvKobo: gtv.gtv, revenueKobo: revenue.revenue, escrowHeldKobo: escrowPending.pending,
        openDisputes: disputes.open, refundedKobo: refunds.refunded, openReports: reports.open },
    });
  }

  // GET /api/admin/users?q= — search users
  if (req.method === 'GET' && pathname === '/api/admin/users') {
    const url = new URL(req.url, 'http://x');
    const term = `%${url.searchParams.get('q') || ''}%`;
    const r = await db.query(
      'SELECT id, email, phone, name, role, verification_level AS "verificationLevel", suspended, created_at FROM users WHERE email ILIKE $1 OR name ILIKE $1 ORDER BY created_at DESC LIMIT 50', [term]);
    return send(res, 200, { ok: true, users: r.rows });
  }

  // POST /api/admin/users/:id/suspend|ban|restore|verify
  if (req.method === 'POST' && parts[2] === 'users' && parts.length === 5) {
    const target = await db.query('SELECT id FROM users WHERE id = $1', [parts[3]]);
    if (target.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
    if (parts[3] === user.id) return send(res, 400, { ok: false, error: 'cannot-moderate-self' });
    const action = parts[4];
    if (action === 'suspend' || action === 'ban') {
      await db.query('UPDATE users SET suspended = TRUE WHERE id = $1', [parts[3]]);
      await db.query('DELETE FROM sessions WHERE user_id = $1', [parts[3]]);
    } else if (action === 'restore') {
      await db.query('UPDATE users SET suspended = FALSE WHERE id = $1', [parts[3]]);
    } else if (action === 'verify') {
      await db.query('UPDATE users SET verification_level = GREATEST(verification_level, 2) WHERE id = $1', [parts[3]]);
    } else return send(res, 404, { ok: false, error: 'not-found' });
    await notify.create(db, parts[3], 'account_moderated', { action });
    const r = await db.query('SELECT id, email, role, verification_level AS "verificationLevel", suspended FROM users WHERE id = $1', [parts[3]]);
    return send(res, 200, { ok: true, user: r.rows[0] });
  }

  // GET /api/admin/reports — open reports queue
  if (req.method === 'GET' && pathname === '/api/admin/reports') {
    const r = await db.query("SELECT * FROM reports WHERE status = 'open' ORDER BY created_at DESC LIMIT 100");
    return send(res, 200, { ok: true, reports: r.rows });
  }

  // POST /api/admin/reports/:id/close
  if (req.method === 'POST' && parts[2] === 'reports' && parts[4] === 'close') {
    await db.query("UPDATE reports SET status = 'closed' WHERE id = $1", [parts[3]]);
    return send(res, 200, { ok: true });
  }

  // POST /api/admin/listings/:kind/:id/approve|remove
  if (req.method === 'POST' && parts[2] === 'listings' && parts.length === 6) {
    const table = parts[3] === 'product' ? 'products' : parts[3] === 'service' ? 'services' : null;
    if (!table) return send(res, 400, { ok: false, error: 'bad-kind' });
    const action = parts[5];
    if (action === 'approve') await db.query(`UPDATE ${table} SET status = 'published' WHERE id = $1`, [parts[4]]);
    else if (action === 'remove') await db.query(`UPDATE ${table} SET status = 'draft' WHERE id = $1`, [parts[4]]);
    else return send(res, 404, { ok: false, error: 'not-found' });
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false, error: 'not-found' });
}

module.exports = { handler };
