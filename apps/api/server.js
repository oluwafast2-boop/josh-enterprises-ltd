// Minimal API for local hosting. Endpoints: /health, /api/status
// + auth (Slice 1) + me/businesses/categories (Slice 2) + route contracts (501).
const http = require('http');
const auth = require('./src/auth');
const me = require('./src/me');
const businesses = require('./src/businesses');
const categories = require('./src/categories');
const routes = require('./src/routes');
const r2 = require('./src/storage/r2');
const PORT = process.env.API_PORT || 4000;

http.createServer((req, res) => {
  const body = (obj, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url === '/health') return body({ ok: true, service: 'api', time: new Date().toISOString() });
  if (req.url === '/api/status') return body({ ok: true, authMode: auth.mode || auth.MODE, storageMode: r2.MODE, routes: routes.ROUTES.length, version: '0.3.0' });
  if (req.url.startsWith('/api/auth/')) return auth.handler(req, res);
  if (req.url === '/api/me' || req.url.startsWith('/api/me?')) return me.handler(req, res);
  if (req.url.startsWith('/api/businesses')) return businesses.handler(req, res);
  if (req.url.startsWith('/api/categories')) return categories.handler(req, res);
  if (req.url.startsWith('/api/')) return routes.handler(req, res);
  return body({ ok: true, service: 'api', routes: ['/health', '/api/status'] });
}).listen(PORT, () => console.log(`api live on http://localhost:${PORT}`));
