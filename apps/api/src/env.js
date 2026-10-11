// Zero-dep .env loader: fills missing process.env entries from repo-root .env.
// Never overrides real environment values.
const fs = require('fs');
const path = require('path');

function load() {
  const f = path.resolve(__dirname, '..', '..', '..', '.env');
  let raw = '';
  try { raw = fs.readFileSync(f, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}

module.exports = { load };
