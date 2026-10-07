// Minimal API for local hosting. Endpoints: /health, /api/status
const http = require('http');
const PORT = process.env.API_PORT || 4000;

http.createServer((req, res) => {
  const body = (obj) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url === '/health') return body({ ok: true, service: 'api', time: new Date().toISOString() });
  if (req.url === '/api/status') return body({ ok: true, stack: 'local-postgres-pending + better-auth-pending + r2-pending', db: 'not-connected (docker missing)', version: '0.1.0' });
  return body({ ok: true, service: 'api', routes: ['/health', '/api/status'] });
}).listen(PORT, () => console.log(`api live on http://localhost:${PORT}`));
