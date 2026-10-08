# ADRs

- `01-monolith-first.md` — single modular monolith; extract services only on load evidence.
- `02-local-postgres-docker.md` — Postgres 16 in Docker Compose, no paid Neon/Supabase.
- `03-better-auth.md` — Better Auth over custom JWT/Supabase Auth.
- `04-paystack-vs-flutterwave.md` — NG payments; webhooks as source of truth.
- `05-meilisearch-with-pgfts-fallback.md` — Meili primary, Postgres FTS fallback.
- `06-websocket-vs-sse.md` — Socket.io for chat + order updates.
- `07-r2-media-pipeline.md` — Cloudflare R2, presigned URLs, private buckets for KYC/evidence.
- `08-caddy-local-hosting.md` — Caddy reverse proxy + TLS on local device, no Vercel.
