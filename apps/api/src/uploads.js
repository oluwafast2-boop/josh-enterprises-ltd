// R2 upload URLs. Auth required; keys namespaced per user.
// Stub until R2 creds + SDK land (returns key plan + hint).
const crypto = require('crypto');
const { getDb } = require('./db');
const { send, readBody, requireUser } = require('./listings');
const r2 = require('./storage/r2');

async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'not-found' });
  const user = await requireUser(req);
  if (!user) return send(res, 401, { ok: false, error: 'unauthorized' });
  let body = {};
  try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
  void getDb;
  const filename = String(body.filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const kind = ['listing', 'kyc', 'evidence'].includes(body.kind) ? body.kind : 'listing';
  const bucket = kind === 'listing' ? r2.buckets.listings : r2.buckets.private;
  const key = `${kind}/${user.id}/${crypto.randomUUID()}-${filename}`;
  const out = await r2.presignedPut(bucket, key, body.contentType);
  return send(res, 200, { ok: true, ...out });
}

module.exports = { handler };
