// Categories (PRD §7). Public read (tree), admin write.
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
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

async function handler(req, res) {
  const parts = req.url.split('?')[0].split('/').filter(Boolean);
  const db = await getDb();

  // GET /api/categories — public tree
  if (req.method === 'GET' && parts.length === 2) {
    const r = await db.query('SELECT * FROM categories ORDER BY sort_order, name');
    const byId = {};
    r.rows.forEach((c) => { byId[c.id] = { id: c.id, name: c.name, slug: c.slug, sortOrder: c.sort_order, children: [] }; });
    const roots = [];
    r.rows.forEach((c) => {
      if (c.parent_id && byId[c.parent_id]) byId[c.parent_id].children.push(byId[c.id]);
      else roots.push(byId[c.id]);
    });
    return send(res, 200, { ok: true, categories: roots });
  }

  const user = await requireUser(req);
  if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
  if (user.role !== 'admin') return send(res, 403, { ok: false, error: 'forbidden' });
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') {
    try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
  }

  // POST /api/categories {name, parent_id?, sort_order?}
  if (req.method === 'POST' && parts.length === 2) {
    const name = String(body.name || '').trim().slice(0, 120);
    if (!name) return send(res, 400, { ok: false, error: 'name-required' });
    const slug = body.slug ? slugify(body.slug) : slugify(name);
    if (body.parent_id) {
      const p = await db.query('SELECT id FROM categories WHERE id = $1', [body.parent_id]);
      if (p.rows.length === 0) return send(res, 400, { ok: false, error: 'bad-parent' });
    }
    const id = crypto.randomUUID();
    try {
      await db.query('INSERT INTO categories (id, parent_id, name, slug, sort_order) VALUES ($1,$2,$3,$4,$5)',
        [id, body.parent_id || null, name, slug, Number(body.sort_order) || 0]);
    } catch (e) {
      if (String(e.message).includes('slug')) return send(res, 409, { ok: false, error: 'slug-taken' });
      throw e;
    }
    const r = await db.query('SELECT * FROM categories WHERE id = $1', [id]);
    return send(res, 201, { ok: true, category: r.rows[0] });
  }

  if (parts.length !== 3) return send(res, 404, { ok: false, error: 'not-found' });
  const existing = await db.query('SELECT * FROM categories WHERE id = $1', [parts[2]]);
  if (existing.rows.length === 0) return send(res, 404, { ok: false, error: 'not-found' });

  if (req.method === 'PATCH') {
    const name = body.name !== undefined ? String(body.name).slice(0, 120) : existing.rows[0].name;
    if (!name) return send(res, 400, { ok: false, error: 'name-required' });
    const slug = body.slug !== undefined ? slugify(body.slug) : existing.rows[0].slug;
    try {
      await db.query('UPDATE categories SET name=$1, slug=$2, sort_order=$3 WHERE id=$4',
        [name, slug, body.sort_order !== undefined ? Number(body.sort_order) || 0 : existing.rows[0].sort_order, parts[2]]);
    } catch (e) {
      if (String(e.message).includes('slug')) return send(res, 409, { ok: false, error: 'slug-taken' });
      throw e;
    }
    const r = await db.query('SELECT * FROM categories WHERE id = $1', [parts[2]]);
    return send(res, 200, { ok: true, category: r.rows[0] });
  }

  if (req.method === 'DELETE') {
    const kids = await db.query('SELECT COUNT(*)::int AS n FROM categories WHERE parent_id = $1', [parts[2]]);
    if (kids.rows[0].n > 0) return send(res, 400, { ok: false, error: 'has-children' });
    await db.query('DELETE FROM categories WHERE id = $1', [parts[2]]);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false, error: 'not-found' });
}

module.exports = { handler };
