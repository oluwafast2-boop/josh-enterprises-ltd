// Cart (PRD §13). One cart per buyer; items reference published products.
const { getDb } = require('./db');
const { send, readBody, requireUser } = require('./listings');

async function getCart(db, buyerId) {
  const r = await db.query('SELECT items FROM carts WHERE buyer_id = $1', [buyerId]);
  return r.rows.length === 0 ? [] : r.rows[0].items;
}
async function saveCart(db, buyerId, items) {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO carts (buyer_id, items, updated_at) VALUES ($1,$2,$3)
     ON CONFLICT (buyer_id) DO UPDATE SET items = $2, updated_at = $3`,
    [buyerId, JSON.stringify(items), now]
  );
}

async function priceCart(db, items) {
  // Returns {lines, subtotal_kobo} or throws {code} on invalid item.
  const lines = [];
  let subtotal = 0;
  for (const it of items) {
    const qty = Number(it.qty);
    if (!it.product_id || !Number.isInteger(qty) || qty < 1) {
      const e = new Error('bad-item'); e.code = 400; throw e;
    }
    const r = await db.query("SELECT * FROM products WHERE id = $1 AND status = 'published'", [it.product_id]);
    if (r.rows.length === 0) { const e = new Error('not-for-sale'); e.code = 400; throw e; }
    const p = r.rows[0];
    if (p.stock < qty) { const e = new Error('insufficient-stock'); e.code = 400; e.stock = p.stock; throw e; }
    lines.push({ product_id: p.id, seller_id: p.seller_id, title: p.title, price_kobo: p.price_kobo, qty, line_kobo: p.price_kobo * qty });
    subtotal += p.price_kobo * qty;
  }
  return { lines, subtotal_kobo: subtotal };
}

async function handler(req, res) {
  const user = await requireUser(req);
  if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
  const db = await getDb();

  if (req.method === 'GET') {
    const items = await getCart(db, user.id);
    try {
      const priced = await priceCart(db, items);
      return send(res, 200, { ok: true, items: priced.lines, subtotal_kobo: priced.subtotal_kobo });
    } catch {
      return send(res, 200, { ok: true, items: [], subtotal_kobo: 0, stale: true });
    }
  }

  let body = {};
  try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }

  // POST /api/cart {items: [...]} — replace whole cart (validated)
  if (req.method === 'POST') {
    if (!Array.isArray(body.items)) return send(res, 400, { ok: false, error: 'items-required' });
    try {
      const priced = await priceCart(db, body.items);
      await saveCart(db, user.id, body.items);
      return send(res, 200, { ok: true, items: priced.lines, subtotal_kobo: priced.subtotal_kobo });
    } catch (e) {
      return send(res, e.code || 400, { ok: false, error: e.message, stock: e.stock });
    }
  }

  // DELETE /api/cart — clear
  if (req.method === 'DELETE') {
    await saveCart(db, user.id, []);
    return send(res, 200, { ok: true, items: [] });
  }

  return send(res, 404, { ok: false, error: 'not-found' });
}

module.exports = { handler, getCart, saveCart, priceCart };
