// Better Auth wiring. Zero-dep runnable: without `better-auth` installed
// (pre-Docker phase) it exports a stub with the same interface so the
// API boots and smoke tests pass. After `npm i better-auth` + Postgres,
// set BETTER_AUTH_SECRET + DATABASE_URL and it uses the real adapter.
//
// Install later: npm i better-auth
// Schema: apps/api/prisma/schema.prisma (user/session/account/verification)
const MODE = (() => {
  try {
    require.resolve('better-auth');
    return process.env.BETTER_AUTH_SECRET ? 'real' : 'stub-no-secret';
  } catch {
    return 'stub-no-dep';
  }
})();

const stub = {
  mode: MODE,
  // Slice 1 contract (IMPLEMENTATION_PLAN.md Phase 5.1)
  routes: [
    'POST /api/auth/register',
    'POST /api/auth/login',
    'POST /api/auth/logout',
    'POST /api/auth/verify-email',
    'POST /api/auth/verify-phone',
    'POST /api/auth/forgot-password',
    'POST /api/auth/reset-password',
  ],
  handler(req, res) {
    res.writeHead(501, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, mode: MODE, error: 'auth-not-wired', hint: 'npm i better-auth + set BETTER_AUTH_SECRET + DATABASE_URL' }));
  },
};

let real = null;
if (MODE === 'real') {
  // Real wiring lands with Docker phase (Prisma adapter + Postgres).
  // const { betterAuth } = require('better-auth');
  // const { prismaAdapter } = require('better-auth/adapters/prisma');
  real = { mode: MODE };
}

module.exports = MODE === 'real' ? real : stub;
