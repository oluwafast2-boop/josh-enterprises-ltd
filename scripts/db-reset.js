// DANGER: wipes local dev Postgres. Stop the API first (it holds the lock).
// Usage: node scripts/db-reset.js
const fs = require('fs');
const path = require('path');
const dir = path.resolve(__dirname, '..', 'data', 'pglite');
fs.rmSync(dir, { recursive: true, force: true });
for (const f of ['users.json', 'users.json.imported', 'sessions.json', 'otp.json', 'resets.json']) {
  try { fs.rmSync(path.resolve(__dirname, '..', 'data', f), { force: true }); } catch {}
}
console.log('db reset: data/ wiped (recreated on next API boot)');
