// Service listings (PRD §9). Public reads published; provider/admin writes.
const crypto = require('crypto');
const { getDb } = require('./db');
const { send, readBody, requireUser, sellerCard, asInt } = require('./listings');

const pub = (r) => ({
  kind: 'service', id: r.id, providerId: r.provider_id, title: r.title, description: r.description,
  categoryId: r.category_id, priceKobo: r.price_kobo, location: r.location, isOnline: r.is_online,
  availability: r.availability, packages: r.packages, portfolio: r.portfolio,
  media: r.media, status: r.status, createdAt: r.created_at,
});

async function checkCategory(db, categoryId) {
  if (!categoryId) return true;
  const c = await db.query('SELECT id FROM categories WHERE id = $1', [categoryId]);
  return c.rows.length > 0;
}

async function handler(req, res) {
  const parts = req.url.split('?')[0].split('/').filter(Boolean);
  const db = await getDb();

  if (req.method === 'GET' && parts.length === 2) {
    const mine = req.url.includes('mine=1');
    if (mine) {
      const user = await requireUser(req);
      if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
      const r = await db.query('SELECT * FROM services WHERE provider_id = $1 ORDER BY created_at DESC LIMIT 100', [user.id]);
      return send(res, 200, { ok: true, services: r.rows.map(pub) });
    }
    const r = await db.query("SELECT * FROM services WHERE status = 'published' ORDER BY created_at DESC LIMIT 100");
    return send(res, 200, { ok: true, services: r.rows.map(pub) });
  }

  if (req.method === 'GET' && parts.length === 3) {
    const r = await db.query('SELECT * FROM services WHERE id = $1', [parts[2]]);
    if (r.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
    const s = r.rows[0];
    if (s.status !== 'published') {
      const user = await requireUser(req);
      if (!user || (user.id !== s.provider_id && user.role !== 'admin')) return send(res, 404, { ok: false, error: 'not-found' });
    }
    return send(res, 200, { ok: true, service: pub(s), provider: await sellerCard(db, s.provider_id) });
  }

  const user = await requireUser(req);
  if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') {
    try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
  }

  if (req.method === 'POST' && parts.length === 2) {
    const title = String(body.title || '').trim().slice(0, 200);
    if (!title) return send(res, 400, { ok: false, error: 'title-required' });
    const priceKobo = asInt(body.price_kobo ?? body.priceKobo, null);
    if (priceKobo === null) return send(res, 400, { ok: false, error: 'bad-price' });
    if (!(await checkCategory(db, body.category_id || body.categoryId))) return send(res, 400, { ok: false, error: 'bad-category' });
    const status = body.status === 'published' ? 'published' : 'draft';
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO services (id, provider_id, title, description, category_id, price_kobo, location, is_online, availability, packages, portfolio, media, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, user.id, title, String(body.description || '').slice(0, 5000), body.category_id || body.categoryId || null,
       priceKobo, body.location ? String(body.location).slice(0, 200) : null, !!body.is_online || !!body.isOnline,
       body.availability || null, body.packages || null, body.portfolio || null, body.media || null, status, now]
    );
    const r = await db.query('SELECT * FROM services WHERE id = $1', [id]);
    return send(res, 201, { ok: true, service: pub(r.rows[0]) });
  }

  if (parts.length !== 3) return send(res, 404, { ok: false, error: 'not-found' });
  const existing = await db.query('SELECT * FROM services WHERE id = $1', [parts[2]]);
  if (existing.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
  const s = existing.rows[0];
  if (s.provider_id !== user.id && user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });

  if (req.method === 'PATCH') {
    if (body.category_id !== undefined && !(await checkCategory(db, body.category_id))) return send(res, 400, { ok: false, error: 'bad-category' });
    const next = {
      title: body.title !== undefined ? String(body.title).slice(0, 200) : s.title,
      description: body.description !== undefined ? String(body.description).slice(0, 5000) : s.description,
      category_id: body.category_id !== undefined ? body.category_id : s.category_id,
      price_kobo: body.price_kobo !== undefined || body.priceKobo !== undefined ? asInt(body.price_kobo ?? body.priceKobo, null) : s.price_kobo,
      location: body.location !== undefined ? (body.location ? String(body.location).slice(0, 200) : null) : s.location,
      is_online: body.is_online !== undefined || body.isOnline !== undefined ? !!(body.is_online ?? body.isOnline) : s.is_online,
      availability: body.availability !== undefined ? body.availability : s.availability,
      packages: body.packages !== undefined ? body.packages : s.packages,
      portfolio: body.portfolio !== undefined ? body.portfolio : s.portfolio,
      media: body.media !== undefined ? body.media : s.media,
      status: body.status === 'published' ? 'published' : body.status === 'draft' ? 'draft' : s.status,
    };
    if (!next.title) return send(res, 400, { ok: false, error: 'title-required' });
    if (next.price_kobo === null) return send(res, 400, { ok: false, error: 'bad-number' });
    await db.query(
      `UPDATE services SET title=$1, description=$2, category_id=$3, price_kobo=$4, location=$5, is_online=$6, availability=$7, packages=$8, portfolio=$9, media=$10, status=$11 WHERE id=$12`,
      [next.title, next.description, next.category_id, next.price_kobo, next.location, next.is_online,
       next.availability, next.packages, next.portfolio, next.media, next.status, s.id]
    );
    const r = await db.query('SELECT * FROM services WHERE id = $1', [s.id]);
    return send(res, 200, { ok: true, service: pub(r.rows[0]) });
  }

  if (req.method === 'DELETE') {
    await db.query('DELETE FROM services WHERE id = $1', [s.id]);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false, error: 'not-found' });
}

module.exports = { handler };
