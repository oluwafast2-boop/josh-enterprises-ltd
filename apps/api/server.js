// Minimal API for local hosting. Endpoints: /health, /api/status
// + auth (Slice 1) + me/businesses/categories (Slice 2) + route contracts (501).
require('./src/env').load();
const http = require('http');
const auth = require('./src/auth');
const me = require('./src/me');
const businesses = require('./src/businesses');
const categories = require('./src/categories');
const products = require('./src/products');
const services = require('./src/services');
const search = require('./src/search');
const uploads = require('./src/uploads');
const cart = require('./src/cart');
const orders = require('./src/orders');
const chat = require('./src/chat');
const notifications = require('./src/notifications');
const reviews = require('./src/reviews');
const refunds = require('./src/refunds');
const disputes = require('./src/disputes');
const admin = require('./src/admin');
const routes = require('./src/routes');
const r2 = require('./src/storage/r2');
const PORT = process.env.API_PORT || 4000;

const buckets = new Map();
function checkRate(req, res, rules) {
  const path = req.url.split('?')[0];
  const rule = rules.find((r) => path.startsWith(r.prefix));
  if (!rule) return true;
  const ip = req.socket.remoteAddress || '?';
  const key = ip + ' ' + rule.prefix;
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < rule.windowMs);
  hits.push(now);
  buckets.set(key, hits);
  if (hits.length > rule.max) {
    res.writeHead(429, { 'content-type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ ok: false, error: 'rate-limited' }));
    return false;
  }
  return true;
}

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  // In-memory rate limits per IP+route (single instance; Redis when multi-instance).
  const LIMITS = [
    { prefix: '/api/auth/', max: 60, windowMs: 60000 },
    { prefix: '/api/', max: 600, windowMs: 60000 },
  ];
  const hit = checkRate(req, res, LIMITS);
  if (!hit) return;
  const body = (obj, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url === '/health') return body({ ok: true, service: 'api', time: new Date().toISOString() });
  if (req.url === '/api/status') return body({ ok: true, authMode: auth.mode || auth.MODE, storageMode: r2.MODE, routes: routes.ROUTES.length, version: '0.7.0' });
  if (req.url.startsWith('/api/auth/')) return auth.handler(req, res);
  if (req.url === '/api/me' || req.url.startsWith('/api/me?')) return me.handler(req, res);
  if (req.url.startsWith('/api/businesses')) return businesses.handler(req, res);
  if (req.url.startsWith('/api/categories')) return categories.handler(req, res);
  if (req.url.startsWith('/api/products')) return products.handler(req, res);
  if (req.url.startsWith('/api/services')) return services.handler(req, res);
  if (req.url.startsWith('/api/search')) return search.handler(req, res);
  if (req.url.startsWith('/api/uploads')) return uploads.handler(req, res);
  if (req.url.startsWith('/api/cart')) return cart.handler(req, res);
  if (req.url.startsWith('/api/conversations')) return chat.handler(req, res);
  if (req.url.startsWith('/api/notifications')) return notifications.handler(req, res);
  if (req.url.startsWith('/api/reviews') || (req.url.startsWith('/api/orders/') && req.url.endsWith('/review'))) return reviews.handler(req, res);
  if (req.url.startsWith('/api/disputes')) return disputes.handler(req, res);
  if (req.url.includes('/refund')) return refunds.handler(req, res);
  if (req.url.startsWith('/api/reports') || req.url.startsWith('/api/admin')) return admin.handler(req, res);
  if (req.url.startsWith('/api/checkout') || req.url.startsWith('/api/orders') || req.url.startsWith('/api/payments') || req.url.startsWith('/api/escrow')) return orders.handler(req, res);
  if (req.url.startsWith('/api/')) return routes.handler(req, res);
  return body({ ok: true, service: 'api', routes: ['/health', '/api/status'] });
}).listen(PORT, () => console.log(`api live on http://localhost:${PORT}`));
