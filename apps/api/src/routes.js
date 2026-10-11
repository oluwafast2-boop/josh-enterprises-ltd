// API route contracts (IMPLEMENTATION_PLAN.md Phase 4).
// All domain routes return 501 until their slice lands (Phase 5).
// Smoke test asserts: known route -> 501 + contract; unknown -> 404.
const ROUTES = [
  // All MVP slices LIVE — no stubs remain. New endpoints go straight to src/ modules.
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
