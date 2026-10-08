// GET /api/me, PATCH /api/me — personal profile (PRD §6).
const { getDb } = require('./db');
const { requireUser, publicUser } = require('./auth');

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

async function handler(req, res) {
  const user = await requireUser(req);
  if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
  const db = await getDb();

  if (req.method === 'GET') {
    const b = await db.query('SELECT id, name FROM businesses WHERE owner_id = $1', [user.id]);
    return send(res, 200, { ok: true, user: publicUser(user), businesses: b.rows });
  }

  if (req.method === 'PATCH') {
    let body = {};
    try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
    const name = body.name !== undefined ? String(body.name).trim().slice(0, 120) || null : user.name;
    const location = body.location !== undefined ? String(body.location).trim().slice(0, 200) || null : user.location;
    const bio = body.bio !== undefined ? String(body.bio).trim().slice(0, 500) || null : user.bio;
    await db.query('UPDATE users SET name = $1, location = $2, bio = $3 WHERE id = $4', [name, location, bio, user.id]);
    const fresh = await db.query('SELECT * FROM users WHERE id = $1', [user.id]);
    const { rowToUser } = require('./db');
    return send(res, 200, { ok: true, user: publicUser(rowToUser(fresh.rows[0])) });
  }

  return send(res, 404, { ok: false, error: 'not-found' });
}

module.exports = { handler };
