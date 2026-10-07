# Josh Enterprises — Detailed Implementation Plan

Source: `JOSH ENTERPRISES .md` (PRD §§1-40, MVP §35, Phase 2 §36, Structure §39, Principle §38, Core Requirement §40)
Repo: `oluwafast2-boop/josh-enterprises-ltd`, branch `main`

> Goal: full marketplace, not a directory — Discover → Connect → Buy → Fulfill → Confirm → Review, with escrow protection end-to-end.

---

## Phase 0 — Foundation & Requirements Freeze (Week 1)

1. **Dedupe PRD:** `JOSH ENTERPRISES .md:1-1058` duplicates `1059-2116`. Keep one copy, rename to `docs/PRD.md`, add `README.md` with vision + MVP scope.
2. **Freeze MVP to §35 only.** Everything in §36 moves to backlog. Explicit out-of-MVP: voice/video calls, wallet withdraw automation, advanced KYC/business verification, bookings calendar, delivery integrations, dispute automation, wishlist v2, recommendations, ads/subscriptions, advanced analytics.
3. **Decide non-functionals now:** target 5k listings / 500 concurrent users for MVP, p95 page <2s, 99.5% uptime, NG-focused (USSD/bank-transfer implies Paystack/Flutterwave region).
4. **Legal/compliance spike:** escrow holding, KYC storage, refund policy, prohibited items policy (§31). Need counsel sign-off before holding funds.

Deliverable: cleaned docs, ADRs folder, frozen MVP backlog in GitHub Issues/Projects.

---

## Phase 1 — Design System & UX (Weeks 2-4)

No UI exists. Build system before screens.

**1.1 Brand & tokens**
- Colors: primary/trust (e.g. deep green/navy), success, warning, danger, neutrals; light/dark mode tokens.
- Typography: 1 display + 1 body font, 4-5 sizes, 1.5 line-height.
- Spacing/radius/shadows scale (4pt grid), icon set (Lucide/Phosphor), motion 150-250ms.
- Store as CSS variables + Tailwind config + Figma variables.

**1.2 Component library (web-first, responsive)**
- Primitives: Button, Input, Select, Checkbox/Radio, Badge (Verified §5), Avatar, Card, Modal, Tabs, Toast, EmptyState, Skeleton, Pagination.
- Domain: PriceDisplay, RatingStars, ListingCard, StorefrontHeader, OrderTimeline (§18), EscrowBadge (§17), ChatBubble, NotificationItem, DisputeEvidenceUploader.
- Storybook + a11y (WCAG AA, keyboard, focus, contrast) + i18n-ready (en-NG first).

**1.3 UX flows & wireframes (§39 structure)**
- Public: Home, Marketplace + filters (§10), Product/Service detail (§11), Storefront, Search results, Category pages.
- User: Auth, Profile, Cart (§13), Checkout 8-step (§14), Orders tracking, Messages (text-only MVP §12), Reviews (§21), Notifications (§24), Settings/2FA.
- Seller: Dashboard (§25 overview/management/financials), Create/Edit listing (§8/§9), Stock, Orders/Bookings-lite, Payout view, Reviews inbox.
- Admin: Dashboard (§28 users/sellers/listings/orders/payments/disputes/reviews), Category manager (§7), Moderation queue, Dispute detail (§23).
- Prototype buyer journey (§34) and seller journey (§34) click-through for UAT before code.

Deliverable: Figma + `design-system/` + Storybook deployed.

---

## Phase 2 — Architectural Decisions (Week 2, parallel with design)

**Recommendation (MVP-balanced, team of 1-3):**

- **Frontend:** Next.js 14+ (App Router) + TypeScript + Tailwind + React Query. SSR for listing/search SEO, client for dashboards/chat. PWA for push.
- **Backend:** Single modular monolith first — NestJS (Node/TS) or Django. Modules: auth, users, catalog, orders, payments, escrow, messaging, reviews, disputes, notifications, admin. Extract services only if load demands.
- **DB:** Postgres (relational for orders/money) + Prisma/Drizzle. Redis for sessions, carts, rate-limit, job queues. S3-compatible object storage for images/video/docs + CDN. Meilisearch/Typesense for §10/§32 search (cheaper than Elastic for MVP); Postgres FTS fallback.
- **Realtime:** WebSocket (Socket.io) for chat + order updates; push via FCM/APNs, email via Resend/SES, SMS via Termii/Twilio for NG.
- **Payments NG:** Paystack or Flutterwave for cards/transfer/USSD/wallets. Webhooks as source of truth. Internal ledger for escrow (§17) — never release on client callback alone.
- **Auth:** Email/phone + password (bcrypt/argon2), OTP via SMS/email, JWT access (15m) + rotating refresh, 2FA TOTP optional (§4). RBAC: buyer, seller, business, admin (§3.5, §30).
- **Infra:** Docker Compose local; staging + prod on Render/Fly/VPS or AWS (ECS+RDS+S3). GitHub Actions CI: lint/type/test/build, preview deploys. Backups PITR, encrypted secrets.

**Alternatives rejected:** microservices day 1 (ops overhead), Firebase-only (escrow/money needs ACID), Elastic day 1 (cost).

**Key ADRs to record:** 01-monolith-first, 02-postgres-ledger, 03-paystack-vs-flutterwave, 04-meilisearch, 05-websocket-vs-SSE, 06-s3-media-pipeline.

---

## Phase 3 — Domain & Data Model (Week 3)

Core tables (Postgres):

- `users(id, name, email, phone, password_hash, role, verification_level, kyc_status, avatar, bio, location, is_business, created_at)` — §4/§5/§6
- `businesses(id, owner_id, name, logo, banner, description, location, verification_status, policies)` — §6
- `categories(id, parent_id, name, slug, sort_order)` — §7 dynamic tree
- `products(id, seller_id, title, description, category_id, price_kobo, stock, condition, location, delivery_methods[], variations JSONB, sku, status, created_at)` — §8
- `services(id, provider_id, title, description, category_id, price_kobo, location, is_online, availability JSONB, packages JSONB, portfolio_urls[])` — §9
- `media(id, listing_type, listing_id, url, kind, sort_order)`; `carts(id, buyer_id, items JSONB)` — §13
- `orders(id, buyer_id, seller_id, type[product|service], status, subtotal, delivery_fee, platform_fee, total, escrow_id, delivery_info JSONB, timeline JSONB)` — statuses §18
- `escrow_ledger(id, order_id, amount, state[held|released|refunded|disputed], holds, audit_trail)` — §17, append-only, double-entry
- `payments(id, order_id, provider, reference, amount, status, webhook_log)` — §15
- `bookings(id, service_id, buyer_id, slot, status)` — stub for Phase 2 (§20/§36)
- `messages(id, conversation_id, sender_id, body, attachments[], created_at)`, `conversations(id, buyer_id, seller_id, order_id?)` — text-only MVP §12
- `reviews(id, order_id, author_id, target_id, rating_1_5, dimensions JSONB, photos[], verified_purchase)` — §21
- `refunds(id, order_id, type[full|partial], amount, reason, status)` — §22
- `disputes(id, order_id, reason, evidence_urls[], status, resolution, resolver_id)` — §23 hybrid
- `notifications(id, user_id, type, payload, channel[], read_at)` — §24
- `audit_logs(id, actor_id, action, entity, diff, ip)` — §30

Money in kobo (integer), all state transitions via server-side state machine with idempotency keys.

Proposed monorepo layout:
```
/apps/web (Next.js) /apps/api (NestJS) /packages/ui /packages/config
/docs/PRD.md /docs/ADRs /design-system
/docker-compose.yml .github/workflows/ci.yml
```

---

## Phase 4 — API Contracts (sliced by journey)

- Auth: `POST /auth/register|login|logout|verify-email|verify-phone|forgot|reset|2fa/*`
- Users/Business: `GET/PATCH /me, /users/:id, /businesses/:id, /businesses/:id/verify`
- Catalog: `CRUD /products, /services, /categories, GET /search?q&category&price&location&rating&sort`
- Cart/Checkout: `GET/POST/PATCH /cart, POST /checkout/preview, POST /orders`
- Payments/Escrow: `POST /payments/init, POST /webhooks/paystack, GET /orders/:id/escrow, POST /orders/:id/confirm-completion`
- Orders: `GET /orders(buyer|seller), PATCH /orders/:id/status, POST /orders/:id/cancel|refund`
- Messaging: `WS /conversations, POST /conversations/:id/messages (text+image MVP)`
- Reviews/Disputes: `POST /orders/:id/review, POST /disputes, POST /disputes/:id/evidence|resolve`
- Admin: `GET /admin/*, POST /admin/users/:id/suspend|ban|restore, /listings/:id/approve|remove, /disputes/:id/resolve`

All money endpoints: auth + RBAC + idempotency + audit log.

---

## Phase 5 — MVP Build Slices (Weeks 5-12)

Slice by §34 journeys, demo each:

1. **Auth + Verification (wk5):** register/login, email/phone OTP, forgot/reset, basic KYC upload, Verified Badge UI.
2. **Profiles + Storefronts + Categories (wk6):** personal profile, business storefront (§6), admin category CRUD (§7).
3. **Listings + Detail + Search (wk7-8):** product/service CRUD with media pipeline (compress, thumb, moderate), detail page (§11: chat/call/share/report buttons — call stubs to chat in MVP), search + filters + sort + discovery sections (§10).
4. **Cart → Checkout → Pay → Escrow → Order (wk9-10, riskiest):** cart math (subtotal+delivery+platform fee), 8-step checkout (§14), Paystack init/verify, escrow hold, order timelines (§18), seller status updates, buyer confirm → release, cancel/refund paths.
5. **Messaging + Notifications (wk11):** 1:1 text+image chat, block/report, order-linked threads, in-app+email+push (§24).
6. **Reviews + Admin + Safety (wk12):** verified-purchase reviews, report flow, admin queues for users/listings/orders/payments/disputes (§28), suspend/ban, audit logs.

Definition of done per slice: happy path + empty/error states + RBAC tests + webhook replay test + mobile responsive.

---

## Phase 6 — Trust, Security, Compliance (§30/§31)

- Hashing (argon2), TLS, encryption at rest for KYC, secrets manager, RBAC middleware, rate-limit login/OTP/search, session rotation.
- Escrow invariants tested: no double-release, no release on disputed, refund links to original payment, full audit trail.
- Abuse: report user/listing/message, block, prohibited-items filter, image MIME/size checks, virus scan on docs.
- Never store card PAN; rely on provider tokens.

---

## Phase 7 — QA & UAT

- Unit (ledger math, state machines), integration (checkout→webhook→escrow→release), e2e (Playwright: buyer + seller journeys §34), contract tests for webhooks.
- Seed script: 20 users, 5 businesses, 100 listings, 30 orders across statuses.
- UAT checklist: can a new seller register → verify → list → receive order → get paid, and buyer discover → chat → pay → track → confirm → review, all in-platform (§40)?

---

## Phase 8 — DevOps & Observability

- CI: typecheck/lint/unit/e2e, preview per PR. CD: staging auto, prod manual approval. Migrations gated.
- Observability: structured logs, Sentry, uptime check, payment/webhook dashboard, escrow pending alert, dispute SLA alert.
- Backups: daily Postgres PITR test-restore monthly. Runbooks for failed webhook, stuck escrow, chargeback.

---

## Phase 9 — Analytics & Success Metrics (§33/§37)

MVP events: signup, verify, listing_created, search, view, chat_started, cart_add, checkout_start, paid, order_status, confirmed, review, dispute_opened/resolved.
Admin dashboard v1: users/sellers/listings/orders/completed/cancelled/disputed/refunds/GTV/revenue/payouts/pending-escrow + engagement counts. Track §37 KPIs weekly.

---

## Phase 10 — Launch then Phase 2 (§36, post-MVP)

- Soft launch: 10-20 trusted sellers, manual payout review, feature flags.
- Then in order: wallet + withdrawals, service booking calendar, wishlist, voice/video (separate spike — cost/complexity high), advanced KYC/business verification, delivery integrations, dispute auto-rules, recommendations/featured/subs/ads, advanced analytics.

---

## Risks & Mitigations

- Escrow/money bugs → ledger tests + staging webhook replays + manual release approval early.
- Scope creep (all categories) → launch with 5-8 curated categories, expand via admin tool.
- Calls/video cost → keep as chat/call-seller button → chat in MVP.
- Duplicate PRD drift → single `docs/PRD.md` source.

## Immediate Next Actions

1. Dedupe + move PRD to `docs/PRD.md`
2. Approve stack (Next.js + NestJS + Postgres + Paystack + Meilisearch)
3. Figma design-system tokens + buyer/seller journey prototypes
4. Scaffold monorepo + CI + Docker Compose
5. Implement Slice 1 (auth) as first GitHub Milestone
