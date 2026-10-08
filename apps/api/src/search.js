// Unified search (PRD §10). Postgres ILIKE fallback until Meilisearch lands.
// GET /api/search?q=&type=all|product|service&category=&min_kobo=&max_kobo=&location=&sort=newest|price_asc|price_desc&limit=
const { getDb } = require('./db');
const { send } = require('./listings');

const SORTS = {
  newest: 'created_at DESC',
  price_asc: 'price_kobo ASC, created_at DESC',
  price_desc: 'price_kobo DESC, created_at DESC',
};

function filters(q, alias, params) {
  const where = [`${alias}.status = 'published'`];
  if (q.q) {
    params.push(`%${q.q}%`, `%${q.q}%`);
    where.push(`(${alias}.title ILIKE $${params.length - 1} OR ${alias}.description ILIKE $${params.length})`);
  }
  if (q.category) { params.push(q.category); where.push(`${alias}.category_id = $${params.length}`); }
  if (q.min_kobo !== undefined) { params.push(Number(q.min_kobo) || 0); where.push(`${alias}.price_kobo >= $${params.length}`); }
  if (q.max_kobo !== undefined) { params.push(Number(q.max_kobo)); where.push(`${alias}.price_kobo <= $${params.length}`); }
  if (q.location) { params.push(`%${q.location}%`); where.push(`${alias}.location ILIKE $${params.length}`); }
  return where;
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const numOrUndef = (k) => {
    const v = url.searchParams.get(k);
    return v === null || v === '' ? undefined : v;
  };
  const q = {
    q: (url.searchParams.get('q') || '').slice(0, 100),
    type: url.searchParams.get('type') || 'all',
    category: url.searchParams.get('category') || null,
    min_kobo: numOrUndef('min_kobo'),
    max_kobo: numOrUndef('max_kobo'),
    location: (url.searchParams.get('location') || '').slice(0, 100) || null,
    sort: SORTS[url.searchParams.get('sort')] ? url.searchParams.get('sort') : 'newest',
    limit: Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50),
  };
  const db = await getDb();
  const items = [];

  if (q.type === 'all' || q.type === 'product') {
    const params = [];
    const where = filters(q, 'p', params);
    params.push(q.limit);
    const r = await db.query(
      `SELECT 'product' AS kind, id, title, price_kobo, location, category_id, created_at FROM products p
       WHERE ${where.join(' AND ')} ORDER BY ${SORTS[q.sort]} LIMIT $${params.length}`, params);
    r.rows.forEach((row) => items.push(row));
  }
  if (q.type === 'all' || q.type === 'service') {
    const params = [];
    const where = filters(q, 's', params);
    params.push(q.limit);
    const r = await db.query(
      `SELECT 'service' AS kind, id, title, price_kobo, location, category_id, created_at FROM services s
       WHERE ${where.join(' AND ')} ORDER BY ${SORTS[q.sort]} LIMIT $${params.length}`, params);
    r.rows.forEach((row) => items.push(row));
  }
  items.sort((a, b) => q.sort === 'price_asc' ? a.price_kobo - b.price_kobo
    : q.sort === 'price_desc' ? b.price_kobo - a.price_kobo
    : new Date(b.created_at) - new Date(a.created_at));
  return send(res, 200, { ok: true, engine: 'pg-ilike', query: q, count: items.length, items: items.slice(0, q.limit) });
}

module.exports = { handler };
