// Business storefronts (PRD §6). Owner writes, anyone reads, admin verifies.
const crypto = require('crypto');
const { getDb } = require('./db');
const { requireUser } = require('./auth');

const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('bad-json')); }
    });
  });
}
const pub = (r) => ({
  id: r.id, ownerId: r.owner_id, name: r.name, description: r.description,
  location: r.location, logo: r.logo, banner: r.banner,
  verificationStatus: r.verification_status, policies: r.policies, createdAt: r.created_at,
});

async function handler(req, res) {
  const parts = req.url.split('?')[0].split('/').filter(Boolean); // ['api','businesses', id?, action?]
  const db = await getDb();

  // GET /api/businesses, GET /api/businesses/:id — public
  if (req.method === 'GET') {
    if (parts.length === 2) {
      const r = await db.query('SELECT * FROM businesses ORDER BY created_at DESC LIMIT 100');
      return send(res, 200, { ok: true, businesses: r.rows.map(pub) });
    }
    if (parts.length === 3) {
      const r = await db.query('SELECT * FROM businesses WHERE id = $1', [parts[2]]);
      if (r.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
      return send(res, 200, { ok: true, business: pub(r.rows[0]) });
    }
    return send(res, 404, { ok: false, error: 'not-found' });
  }

  const user = await requireUser(req);
  if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') {
    try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
  }

  // POST /api/businesses
  if (req.method === 'POST' && parts.length === 2) {
    const name = String(body.name || '').trim().slice(0, 120);
    if (!name) return send(res, 400, { ok: false, error: 'name-required' });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO businesses (id, owner_id, name, description, location, logo, banner, verification_status, policies, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'none',$8,$9)`,
      [id, user.id, name, body.description ? String(body.description).slice(0, 2000) : null,
       body.location ? String(body.location).slice(0, 200) : null,
       body.logo || null, body.banner || null, body.policies || null, now]
    );
    const r = await db.query('SELECT * FROM businesses WHERE id = $1', [id]);
    return send(res, 201, { ok: true, business: pub(r.rows[0]) });
  }

  if (parts.length < 3) return send(res, 404, { ok: false, error: 'not-found' });
  const existing = await db.query('SELECT * FROM businesses WHERE id = $1', [parts[2]]);
  if (existing.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
  const biz = existing.rows[0];

  // POST /api/businesses/:id/verify — admin only
  if (req.method === 'POST' && parts[3] === 'verify') {
    if (user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });
    const status = ['verified', 'rejected', 'none'].includes(body.status) ? body.status : 'verified';
    await db.query('UPDATE businesses SET verification_status = $1 WHERE id = $2', [status, biz.id]);
    const r = await db.query('SELECT * FROM businesses WHERE id = $1', [biz.id]);
    return send(res, 200, { ok: true, business: pub(r.rows[0]) });
  }

  // owner-only writes
  if (biz.owner_id !== user.id && user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });

  if (req.method === 'PATCH' && parts.length === 3) {
    const patch = {
      name: body.name !== undefined ? String(body.name).slice(0, 120) : biz.name,
      description: body.description !== undefined ? String(body.description).slice(0, 2000) : biz.description,
      location: body.location !== undefined ? String(body.location).slice(0, 200) : biz.location,
      logo: body.logo !== undefined ? body.logo : biz.logo,
      banner: body.banner !== undefined ? body.banner : biz.banner,
      policies: body.policies !== undefined ? body.policies : biz.policies,
    };
    if (!patch.name) return send(res, 400, { ok: false, error: 'name-required' });
    await db.query(
      'UPDATE businesses SET name=$1, description=$2, location=$3, logo=$4, banner=$5, policies=$6 WHERE id=$7',
      [patch.name, patch.description, patch.location, patch.logo, patch.banner, patch.policies, biz.id]
    );
    const r = await db.query('SELECT * FROM businesses WHERE id = $1', [biz.id]);
    return send(res, 200, { ok: true, business: pub(r.rows[0]) });
  }

  if (req.method === 'DELETE' && parts.length === 3) {
    await db.query('DELETE FROM businesses WHERE id = $1', [biz.id]);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false, error: 'not-found' });
}

module.exports = { handler };
