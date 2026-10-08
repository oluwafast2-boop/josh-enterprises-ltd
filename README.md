# Josh Enterprises

Multi-vendor marketplace: buy/sell products, offer/hire services, one account. Discover → Connect → Buy → Fulfill → Confirm → Review, with escrow protection.

## Docs

- `docs/PRD.md` — product requirements (single source of truth, deduped)
- `IMPLEMENTATION_PLAN.md` — phased plan: design system → architecture → MVP slices → launch
- `docs/ADRs/` — architecture decisions

## Stack (locked)

Next.js + NestJS-style API, local Postgres (Docker), Better Auth, Cloudflare R2, Meilisearch (+ Postgres FTS fallback), Caddy. No Supabase, no Vercel — hosted on local device.

## Run locally (light scaffold)

- Web: http://localhost:3000 — `node apps/web/server.js`
- API: http://localhost:4000 — `node apps/api/server.js`

Full stack once Docker Desktop + WSL2 are ready: `docker compose up -d --build`, then verify with `scripts/verify-docker.ps1`.
