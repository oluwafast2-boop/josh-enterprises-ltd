// Shared listing helpers (products/services): auth, ownership, serialization.
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

async function sellerCard(db, userId) {
  const u = await db.query('SELECT id, name, verification_level FROM users WHERE id = $1', [userId]);
  const b = await db.query("SELECT id, name FROM businesses WHERE owner_id = $1 AND verification_status = 'verified'", [userId]);
  return u.rows.length === 0 ? null : {
    id: u.rows[0].id, name: u.rows[0].name,
    verificationLevel: u.rows[0].verification_level,
    verifiedBusinesses: b.rows,
  };
}

const asInt = (v, dflt) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : dflt;
};

module.exports = { send, readBody, requireUser, sellerCard, asInt };
