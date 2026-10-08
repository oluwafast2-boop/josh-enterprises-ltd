// Hosting-gate smoke test: node scripts/smoke.js (exit 1 on any failure)
const cases = [
  ['http://localhost:3000/health', 200, (b) => b.ok === true && b.service === 'web'],
  ['http://localhost:4000/health', 200, (b) => b.ok === true && b.service === 'api'],
  ['http://localhost:4000/api/status', 200, (b) => b.ok === true && b.routes === 18],
  ['http://localhost:4000/api/auth/login', 501, (b) => b.error === 'auth-not-wired'],
  ['http://localhost:4000/api/products', 501, (b) => b.error === 'not-implemented' && b.slice === 3],
  ['http://localhost:4000/api/orders', 501, (b) => b.error === 'not-implemented' && b.slice === 4],
  ['http://localhost:4000/api/nope', 404, (b) => b.error === 'not-found'],
];

(async () => {
  let fail = 0;
  for (const [url, code, check] of cases) {
    try {
      const res = await fetch(url, { headers: { connection: 'close' } });
      const body = await res.json();
      const pass = res.status === code && check(body);
      console.log(`${pass ? 'PASS' : 'FAIL'} ${res.status} ${url}`);
      if (!pass) { fail++; console.log('  body:', JSON.stringify(body)); }
    } catch (e) {
      fail++;
      console.log(`FAIL (fetch) ${url}: ${e.message}`);
    }
  }
  // design tokens load check
  try {
    const tokens = require('../packages/design-tokens/tokens.json');
    const pass = tokens.colors.primary === '#0E6B4F' && !!tokens.typography;
    console.log(`${pass ? 'PASS' : 'FAIL'} design-tokens`);
    if (!pass) fail++;
  } catch (e) { fail++; console.log(`FAIL tokens: ${e.message}`); }
  console.log(fail === 0 ? 'SMOKE OK' : `SMOKE FAIL (${fail})`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
