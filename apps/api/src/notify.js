// In-app notifications (PRD §24, MVP scope). Email/push/SMS land later;
// every event is recorded here first so nothing is lost.
const crypto = require('crypto');

async function create(db, userId, type, payload = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.query(
    'INSERT INTO notifications (id, user_id, type, payload, channels, read_at, created_at) VALUES ($1,$2,$3,$4,$5,NULL,$6)',
    [id, userId, type, JSON.stringify(payload), JSON.stringify(['inapp']), now]
  );
  return id;
}

module.exports = { create };
