// API route contracts (IMPLEMENTATION_PLAN.md Phase 4).
// All domain routes return 501 until their slice lands (Phase 5).
// Smoke test asserts: known route -> 501 + contract; unknown -> 404.
const ROUTES = [
  // Slice 2: profiles/storefronts/categories — LIVE (see src/me.js, src/businesses.js, src/categories.js)
  // Slice 3: listings + search
  { path: '/api/products', slice: 3, contract: 'CRUD product listings (§8) + media via R2 presigned PUT' },
  { path: '/api/services', slice: 3, contract: 'CRUD service listings (§9)' },
  { path: '/api/search', slice: 3, contract: 'GET ?q&category&price&location&rating&sort (Meili, PG-FTS fallback)' },
  // Slice 4: cart/checkout/pay/escrow/orders
  { path: '/api/cart', slice: 4, contract: 'buyer cart + fee preview' },
  { path: '/api/checkout', slice: 4, contract: '8-step checkout preview (§14)' },
  { path: '/api/orders', slice: 4, contract: 'CRUD orders + status machine (§18)' },
  { path: '/api/payments', slice: 4, contract: 'init + webhook (Paystack source of truth)' },
  { path: '/api/escrow', slice: 4, contract: 'hold/release/refund ledger (§17)' },
  { path: '/api/uploads', slice: 3, contract: 'R2 presigned PUT for listings/KYC/evidence' },
  // Slice 5: messaging + notifications
  { path: '/api/conversations', slice: 5, contract: '1:1 text+image threads (+ WS live)' },
  { path: '/api/notifications', slice: 5, contract: 'in-app + email + push + SMS (§24)' },
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
