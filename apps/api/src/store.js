// Tiny JSON file store (stands in for Postgres until Docker phase).
// Data lives in <repo>/data/*.json (gitignored). Atomic via tmp+rename.
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '..', '..', '..', 'data');

function file(name) {
  return path.join(DIR, name);
}

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function write(name, value) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file(name));
}

module.exports = { DIR, read, write };
