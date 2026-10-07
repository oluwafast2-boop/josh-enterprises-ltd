// Minimal local host for Josh Enterprises (no Docker yet).
// Serves landing + health on PORT (default 3000).
const http = require('http');
const PORT = process.env.WEB_PORT || 3000;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Josh Enterprises — Local</title>
<style>body{font-family:system-ui;margin:0;background:#0f172a;color:#e2e8f0}main{max-width:720px;margin:10vh auto;padding:24px}.card{background:#1e293b;border-radius:12px;padding:24px}a{color:#38bdf8}</style>
</head><body><main><div class="card">
<h1>Josh Enterprises — locally hosted</h1>
<p>Marketplace scaffold live. API: <a href="http://localhost:4000/health">:4000/health</a></p>
<ul><li>Web health: <a href="/health">/health</a></li><li>Plan: <a href="https://github.com/oluwafast2-boop/josh-enterprises-ltd">GitHub</a></li></ul>
<p>Next: full stack (local Postgres + Better Auth + R2) once Docker is installed.</p>
</div></main></body></html>`;

http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'web', time: new Date().toISOString() }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
}).listen(PORT, () => console.log(`web live on http://localhost:${PORT}`));
