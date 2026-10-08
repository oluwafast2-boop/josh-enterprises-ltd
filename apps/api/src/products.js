// Product listings (PRD §8). Public reads published; owner/admin writes.
const crypto = require('crypto');
const { getDb } = require('./db');
const { send, readBody, requireUser, sellerCard, asInt } = require('./listings');

const pub = (r) => ({
  kind: 'product', id: r.id, sellerId: r.seller_id, title: r.title, description: r.description,
  categoryId: r.category_id, priceKobo: r.price_kobo, stock: r.stock, condition: r.condition,
  location: r.location, deliveryMethods: r.delivery_methods, variations: r.variations,
  media: r.media, sku: r.sku, status: r.status, createdAt: r.created_at,
});

async function checkCategory(db, categoryId) {
  if (!categoryId) return true;
  const c = await db.query('SELECT id FROM categories WHERE id = $1', [categoryId]);
  return c.rows.length > 0;
}

async function handler(req, res) {
  const parts = req.url.split('?')[0].split('/').filter(Boolean);
  const db = await getDb();

  // GET /api/products[?mine=1] — public published; ?mine=1 needs auth (own incl. drafts)
  if (req.method === 'GET' && parts.length === 2) {
    const mine = req.url.includes('mine=1');
    if (mine) {
      const user = await requireUser(req);
      if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
      const r = await db.query('SELECT * FROM products WHERE seller_id = $1 ORDER BY created_at DESC LIMIT 100', [user.id]);
      return send(res, 200, { ok: true, products: r.rows.map(pub) });
    }
    const r = await db.query("SELECT * FROM products WHERE status = 'published' ORDER BY created_at DESC LIMIT 100");
    return send(res, 200, { ok: true, products: r.rows.map(pub) });
  }

  // GET /api/products/:id — published public; draft owner/admin
  if (req.method === 'GET' && parts.length === 3) {
    const r = await db.query('SELECT * FROM products WHERE id = $1', [parts[2]]);
    if (r.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
    const p = r.rows[0];
    if (p.status !== 'published') {
      const user = await requireUser(req);
      if (!user || (user.id !== p.seller_id && user.role !== 'admin')) return send(res, 404, { ok: false, error: 'not-found' });
    }
    return send(res, 200, { ok: true, product: pub(p), seller: await sellerCard(db, p.seller_id) });
  }

  const user = await requireUser(req);
  if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') {
    try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
  }

  // POST /api/products
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
      `INSERT INTO products (id, seller_id, title, description, category_id, price_kobo, stock, condition, location, delivery_methods, variations, media, sku, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, user.id, title, String(body.description || '').slice(0, 5000), body.category_id || body.categoryId || null,
       priceKobo, asInt(body.stock, 0), String(body.condition || 'new').slice(0, 20),
       body.location ? String(body.location).slice(0, 200) : null,
       body.delivery_methods || body.deliveryMethods || null, body.variations || null, body.media || null,
       body.sku ? String(body.sku).slice(0, 60) : null, status, now]
    );
    const r = await db.query('SELECT * FROM products WHERE id = $1', [id]);
    return send(res, 201, { ok: true, product: pub(r.rows[0]) });
  }

  if (parts.length !== 3) return send(res, 404, { ok: false, error: 'not-found' });
  const existing = await db.query('SELECT * FROM products WHERE id = $1', [parts[2]]);
  if (existing.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });
  const p = existing.rows[0];
  if (p.seller_id !== user.id && user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });

  if (req.method === 'PATCH') {
    if (body.category_id !== undefined && !(await checkCategory(db, body.category_id))) return send(res, 400, { ok: false, error: 'bad-category' });
    const next = {
      title: body.title !== undefined ? String(body.title).slice(0, 200) : p.title,
      description: body.description !== undefined ? String(body.description).slice(0, 5000) : p.description,
      category_id: body.category_id !== undefined ? body.category_id : p.category_id,
      price_kobo: body.price_kobo !== undefined || body.priceKobo !== undefined ? asInt(body.price_kobo ?? body.priceKobo, null) : p.price_kobo,
      stock: body.stock !== undefined ? asInt(body.stock, null) : p.stock,
      condition: body.condition !== undefined ? String(body.condition).slice(0, 20) : p.condition,
      location: body.location !== undefined ? (body.location ? String(body.location).slice(0, 200) : null) : p.location,
      delivery_methods: body.delivery_methods !== undefined ? body.delivery_methods : p.delivery_methods,
      variations: body.variations !== undefined ? body.variations : p.variations,
      media: body.media !== undefined ? body.media : p.media,
      sku: body.sku !== undefined ? (body.sku ? String(body.sku).slice(0, 60) : null) : p.sku,
      status: body.status === 'published' ? 'published' : body.status === 'draft' ? 'draft' : p.status,
    };
    if (!next.title) return send(res, 400, { ok: false, error: 'title-required' });
    if (next.price_kobo === null || next.stock === null) return send(res, 400, { ok: false, error: 'bad-number' });
    await db.query(
      `UPDATE products SET title=$1, description=$2, category_id=$3, price_kobo=$4, stock=$5, condition=$6, location=$7, delivery_methods=$8, variations=$9, media=$10, sku=$11, status=$12 WHERE id=$13`,
      [next.title, next.description, next.category_id, next.price_kobo, next.stock, next.condition, next.location,
       next.delivery_methods, next.variations, next.media, next.sku, next.status, p.id]
    );
    const r = await db.query('SELECT * FROM products WHERE id = $1', [p.id]);
    return send(res, 200, { ok: true, product: pub(r.rows[0]) });
  }

  if (req.method === 'DELETE') {
    await db.query('DELETE FROM products WHERE id = $1', [p.id]);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false, error: 'not-found' });
}

module.exports = { handler };
