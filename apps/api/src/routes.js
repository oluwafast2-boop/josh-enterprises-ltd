// API route contracts (IMPLEMENTATION_PLAN.md Phase 4).
// All domain routes return 501 until their slice lands (Phase 5).
// Smoke test asserts: known route -> 501 + contract; unknown -> 404.
const ROUTES = [
  // Slices 2-5 LIVE (me, businesses, categories, products, services, search, uploads, cart, checkout, orders, payments-sim, escrow, conversations, notifications)
  // Slice 6: reviews + admin
  // (conversations + notifications live — Slice 5)
  // Slice 6: reviews + admin
  { path: '/api/reviews', slice: 6, contract: 'verified-purchase reviews (§21)' },
  { path: '/api/disputes', slice: 6, contract: 'hybrid dispute flow + evidence (§23)' },
  { path: '/api/refunds', slice: 6, contract: 'full/partial refunds linked to payment (§22)' },
  { path: '/api/admin', slice: 6, contract: 'RBAC admin queues (§28)' },
];

function match(url) {
  const pathname = url.split('?')[0];
  return ROUTES.find((r) => pathname === r.path || pathname.startsWith(r.path + '/')) || null;
}

function handler(req, res) {
  const route = match(req.url);
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not-found' }));
    return true;
  }
  res.writeHead(501, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not-implemented', slice: route.slice, contract: route.contract }));
  return true;
}

module.exports = { ROUTES, handler };
