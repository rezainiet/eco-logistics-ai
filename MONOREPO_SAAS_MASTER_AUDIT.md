# MONOREPO_SAAS_MASTER_AUDIT.md

**Repository:** `C:\devs\ecommerce-logistics`
**Brand:** **Cordon** — order operations OS for COD-heavy commerce
**Primary stack:** Next.js 14 + Express + Mongoose + BullMQ/Redis
**Audit date:** 2026-05-07
**Audit basis:** filesystem inspection of every router, worker, model, webhook, queue, and provider file. Every claim below maps to a concrete `path:line` or directory. Where a system is partially implemented, "Uncertain / Gap" is called out explicitly.

---

## 1. Executive Summary

### What it is
**Cordon** is a Bangladesh-first SaaS that sits between a merchant's storefront (Shopify, WooCommerce, custom-API, CSV) and their last-mile couriers (Pathao, Steadfast, RedX). It ingests every order in real time, scores fraud / Return-To-Origin (RTO) risk before it ships, automates customer confirmation via SMS, books the best-performing courier per route, tracks the parcel to delivery, and logs every action in a tamper-evident audit chain.

### Target market
- Primary: COD-driven Shopify and WooCommerce merchants in **Bangladesh** (BD), with explicit support for PK / IN / LK / NP / ID / PH / VN / MY / TH (`packages/db/src/models/merchant.ts:9`).
- Languages: en, bn, ur, hi, ta, id, th, vi, ms (`merchant.ts:10`).
- Pricing surfaced primarily in **BDT** with a USD shadow price for Stripe (`packages/types/src/plans.ts:12`).

### Business model
Recurring SaaS subscription. Four tiers — Starter / Growth / Scale / Enterprise — billed monthly (Stripe Subscriptions OR manual bKash / Nagad / bank receipts). Pricing: 999 / 2,499 / 5,999 / 14,999 BDT (`plans.ts:53-187`). Quotas on orders, shipments, fraud-reviews, call-minutes, and integration count (`plans.ts:25-41`, enforced in `apps/api/src/lib/usage.ts`).

### Primary merchant pain solved
1. **COD fraud / RTO bleed**: customers placing fake / repeat / verifiable-bad-actor COD orders the merchant ships, then has returned at their cost. Cordon scores risk pre-ship and forces SMS confirmation on medium/high.
2. **Operational fragmentation**: merchants juggle Shopify admin, courier portals, manual CSV exports, and Excel for fraud screening. Cordon collapses that into one operations console.
3. **Courier reliability**: per-merchant courier-performance ledger picks the best courier for each (district, courier) cell with a circuit breaker (`apps/api/src/lib/courier-intelligence.ts`, `apps/api/src/lib/couriers/circuit-breaker.ts`).

### Maturity level
**Late-stage MVP / early production.** The product is architecturally credible at the level of a series-A startup that has shipped to design partners. Core systems are real (HMAC-verified webhooks, exactly-once webhook idempotency, Stripe Subscriptions, RBAC scopes, tamper-evident audit chain, dead-letter queue replay, tracking pipeline). Several second-order systems are stubbed — the most concrete being Shopify GDPR data-redaction (the receiver is real and Partner-app review-ready, the redaction sweep is a TODO; `apps/api/src/server/webhooks/shopify-gdpr.ts:42-58`).

### Strongest competitive advantages
1. **Cross-merchant fraud network** with privacy-preserving hashes — phone+address fingerprints aggregate across the whole platform; capped merchant-id list bounds linkability (`apps/api/src/lib/fraud-network.ts`, model: `packages/db/src/models/fraudSignal.ts`).
2. **Exactly-once webhook ingestion** with permanent idempotency keys + bounded payload growth (90-day payload reap, infinite dedup-key retention) — `packages/db/src/models/webhookInbox.ts:13-45` is unusually mature for the company's stage.
3. **Tamper-evident audit log** with prev/self hash chain and immutability hooks at the Mongoose level — `packages/db/src/models/auditLog.ts:181-251`.
4. **Self-tuning fraud weights** — monthly worker rewrites per-merchant signal multipliers from labeled outcomes (`apps/api/src/workers/fraudWeightTuning.ts`, `packages/db/src/models/fraudPrediction.ts`).
5. **BD-native payment rails** — first-class bKash / Nagad / bank-receipt manual flow alongside Stripe (`packages/db/src/models/payment.ts:43-153`).

### Biggest current risks
1. **`orderSync.worker.ts` is dead in production** — the file exports `registerOrderSyncWorker` and `scheduleOrderSync` but `apps/api/src/index.ts` does not call either. Polling fallback for upstream order sync is therefore offline; if a webhook delivery is missed, we depend entirely on Shopify/Woo to retry. Verified by grep: only the file itself references the symbols.
2. **Build tolerates type errors** — `apps/api/package.json:8` runs `tsc` with `--noEmitOnError false` so staging deploys can ship with type errors. The strict-build script exists (`build:strict`) but isn't on the deploy path.
3. **Single Redis instance** — every queue, the merchant rate-limit Lua, the session store, and the rate-limit middleware all share one connection; no read replicas or HA configured at the app layer. Operationally fine to ~1k merchants; a known scaling cliff.
4. **CSP is Report-Only** — `apps/web/next.config.mjs:163` ships `Content-Security-Policy-Report-Only`, not enforce. Logged as intentional rollout, but not flipped yet.
5. **Shopify GDPR redaction is a stub** — the receiver verifies HMAC and audits, but the actual data-deletion sweep is a TODO (`shopify-gdpr.ts:48-58`). Hard requirement before flipping the Shopify app to Public Distribution.

---

## 2. Monorepo Architecture

### Layout
```
apps/
  web/              Next.js 14 App Router  (port 3001)  package "@ecom/web"
  api/              Express + tRPC + BullMQ (port 4000)  package "@ecom/api"
packages/
  db/               Mongoose models (built dist)         "@ecom/db"
  types/            Shared TS + tRPC AppRouter re-export "@ecom/types"
  config/           Tailwind base + tsconfig.base.json   "@ecom/config"
```

### Workspace setup
- npm workspaces, root `package.json:5-8` declares `apps/*` and `packages/*`.
- Node ≥ 20 (`package.json:23`).
- `npm run dev` boots api + web in parallel via `npm-run-all` (`package.json:10-12`).

### Build artifacts & gotchas
- `apps/api/dist`, `packages/*/dist`, `apps/web/.next`, `tsbuildinfo` are gitignored (`CLAUDE.md:17`).
- After a clean checkout, `@ecom/db` and `@ecom/types` MUST be built once before `apps/api` and `apps/web` will resolve them — both consume `dist/index.js`.
- `apps/api/package.json:8` deliberately tolerates type errors at build time on the deploy path; only `build:strict` blocks on a clean typecheck.
- `apps/web/next.config.mjs:179` `transpilePackages: ["@ecom/types", "@ecom/db"]` and a webpack `extensionAlias` mapping `.js → .ts` (line 207) lets the web app consume the API's `NodeNext` ESM imports without rebuilding.

### Type-sharing strategy
- `@ecom/api` re-exports its `AppRouter` to `packages/types/src/router.ts` (CLAUDE.md `apps/api/CLAUDE.md:23`).
- `@ecom/web` consumes that single symbol via `@ecom/types`. **`apps/web` never imports from `apps/api/...` directly** — that seam is enforced by convention, not by tooling.
- `@ecom/types` also owns the plan catalogue (`plans.ts`) so the public pricing page and the entitlement enforcement read the same numbers.

### Frontend / backend responsibilities
- **Web (apps/web)** is presentation only — every data write is a tRPC mutation against the API. NextAuth runs on web for session glue, but the canonical session lives in the API's Redis store (`apps/api/src/lib/sessionStore.ts`).
- **API (apps/api)** owns: Mongo connection, Redis connection, queue lifecycle, all 14 BullMQ workers, all webhook receivers, Stripe + courier + SMS integration code, audit log.

### Deployment architecture
- Inferred from env (`apps/api/src/env.ts:33-39`) — sits behind an edge proxy / load balancer (Railway is referenced in comments throughout, and `next.config.mjs:46-49` hints at NEXT_PUBLIC_WEB_URL on Railway/Vercel). `TRUSTED_PROXIES` is the load-bearing config that decides whether `X-Forwarded-For` is honoured.

---

## 3. Frontend System

### Next.js architecture
- App Router (Next.js 14.2.35; `apps/web/package.json:33`), React 18.3, NextAuth 4.24.
- TypeScript strict (`tsconfig.json` consumes `@ecom/config`).
- Single Tailwind tokens source in `tailwind.config.ts` + `globals.css` CSS variables (`apps/web/CLAUDE.md:34-37`).
- Recharts for charts, react-hook-form + zod for forms, Radix for primitives, Framer Motion present (the auth shell uses it). `apps/web/CLAUDE.md:39-40` flags framer-motion as a "fat single-use" suspect to watch.

### Route groups & providers strategy (load-bearing for performance)
The repository has a deliberate split between marketing weight and authenticated weight:

- `app/layout.tsx:89-98` — root layout is `<html><body>` + `next/font` ONLY. **No providers.**
- `app/(marketing)/` — public landing. Inherits the empty root. **Ships zero auth/tRPC weight.** Verified by reading `app/(marketing)/page.tsx`.
- `app/(auth)/layout.tsx` — wraps `<Providers>` (SessionProvider + tRPC + QueryClient) for `/login` and `/signup`.
- `app/dashboard/layout.tsx:18-58` — `getServerSession`-gated, redirects to `/login?callbackUrl=` on miss. Wraps Providers + I18nProvider + CommandPalette + BrandingProvider + TokenRefreshKeeper + ActivationToaster + IncidentBanner + Toaster.
- `app/admin/layout.tsx` — separate admin chrome.
- Top-level routes (`/forgot-password`, `/reset-password`, `/verify-email`) are deliberately outside any group so they work for both signed-in and signed-out users; each ships its own layout (per `apps/web/CLAUDE.md:9-11`).

### Auth flow
- Cookie-first: HttpOnly `access_token` + HttpOnly `refresh_token` + non-HttpOnly `csrf_token` (double-submit). Server-side: tokens are JWT but every protected procedure validates a `sid` claim against Redis (`apps/api/src/server/trpc.ts:212-222`) so logout-all is real.
- Refresh rotation: `/auth/refresh` revokes the old sid and mints a new one (`apps/api/src/server/auth.ts:344-353`). A captured refresh token used after the legitimate user refreshed is rejected.
- Web side: `apps/web/src/app/providers.tsx:42-55` listens for `UNAUTHORIZED` from any tRPC call and dispatches a `logistics:session-unauthorized` DOM event; `<TokenRefreshKeeper>` (mounted in dashboard layout) does a silent `/auth/refresh` and only signs out on its failure.
- Middleware: `apps/web/src/middleware.ts` redirects unauthenticated users hitting `/dashboard/*` and authenticated users hitting `/login` or `/signup`.

### Onboarding UX
- `components/onboarding/`:
  - `new-merchant-redirect.tsx`
  - `onboarding-checklist.tsx`
  - `dashboard-hero.tsx`
  - `activation-moments.tsx` — once-per-merchant celebrations on first order ingested + first risky order detected, localStorage-gated.
- Primary funnel signal is server-side: `auth.signup` audit row (`apps/api/src/server/auth.ts:251-267`) → `integration.connected` → `integration.first_event` (`apps/api/src/server/webhooks/integrations.ts:269-308` claims this atomically with a guarded `findOneAndUpdate`).

### Marketing surface
- `app/(marketing)/page.tsx` is a full landing page with HERO, ROI calculator, fraud-network section, automation section, pricing — a single inline `<script>` powers the scroll counter + nav state + decorative-animation pause-on-offscreen (line 22-69). Module CSS at `landing.module.css` is the only place hex literals are sanctioned (`apps/web/CLAUDE.md:36`).
- Conversion components in `(marketing)/_components/`:
  - `roi-calculator.tsx` — interactive "money you're losing" widget.
  - `floating-loss-indicator.tsx` — anchored counter.
  - `pricing-highlighter.tsx`.
  - `exit-intent-modal.tsx`.
- Public pages register custom `metadata` per-route; OpenGraph + Twitter card pre-built.
- SEO: `robots.ts`, `sitemap.ts`, `not-found.tsx`, `global-error.tsx`, and `app/icon.svg` all present at top-level.

### Dashboard surface
- `dashboard/page.tsx:58-82` — KPI bar + 7-day order trend (recharts) + fraud queue card; calls `analytics.getDashboard`, `analytics.getOrdersLast7Days`, `fraud.getReviewStats`.
- Sub-routes: `analytics/`, `billing/`, `call-customer/`, `fraud-review/`, `getting-started/`, `integrations/`, `orders/`, `recovery/`, `settings/`.
- `dashboard/integrations/_components/connect-flow.tsx` is the multi-step Shopify/Woo connect modal; `issues/page.tsx` is the inbox-row drilldown for `failed` + `needs_attention` rows.
- Mobile: `components/dashboard/mobile-bottom-nav.tsx` mounted in dashboard layout.

### Design system
- Tokens live in `tailwind.config.ts` + `globals.css` (CSS variables) — utility classes against `bg-brand`, `text-fg-muted`, etc. (`apps/web/CLAUDE.md:34`).
- The previous `lib/design-system.ts` (blue "Logistics" palette) was deleted on the Cordon rebrand and must not be reintroduced (`apps/web/CLAUDE.md:36`).
- A single auth shell `components/shell/cordon-auth-shell.tsx` is shared by every auth-flavored page. Legacy `account-shell.tsx` is **deprecated and being removed** (visible in the current git status: `D apps/web/src/components/shell/account-shell.tsx`).

### Performance strategy
- Self-hosted fonts via `next/font/google` so no Google Fonts request (`layout.tsx:20-40`). CSS variables `--font-inter`, `--font-serif`, `--font-mono`.
- `(marketing)` group ships ~zero JS that touches auth/tRPC — `apps/web/CLAUDE.md:39` calls this an invariant.
- Animation pause-on-offscreen (landing page inline script, line 56-67).
- IntersectionObserver-driven counter animations (line 33-53).

### Strengths
- Provider hoisting pattern correctly keeps the marketing bundle thin.
- Cookie-first auth with CSRF double-submit; HttpOnly access cookie; SameSite=strict (`apps/api/src/server/auth.ts:42-50`).
- Hydration trap is documented in `apps/web/CLAUDE.md:26` — `useSession()` outside `<SessionProvider>` returns `{status:"loading"}` forever.
- Three-layer landing conversion stack (counter, ROI calc, exit-intent) shows mature funnel engineering for an early company.

### Inconsistencies / UX debt
- File naming: `components/sidebar/Sidebar.tsx` is PascalCase; everything else is kebab-case. `apps/web/CLAUDE.md:31` flags PascalCase as legacy.
- `account-shell.tsx` deletion is in-flight (uncommitted in `git status`) — until merged, two shells coexist.
- `apps/web/CLAUDE.md:39` flags `framer-motion` as "fat single-use" — likely on the cleanup queue.

### UX scaling concerns
- The dashboard page issues three independent tRPC queries on mount (`dashboard/page.tsx:59-61`). Fine for now, but a merchant with 10k orders/week will eventually need a single batched aggregate.
- Recharts is heavy. With 4 charts on the dashboard and 6+ in analytics, this is the next bundle-size lever.

---

## 4. Backend / API System

### Express boot order
`apps/api/src/index.ts` is the single entry. Ordered:
1. **Validate env** (`env.ts` zod schema, line 11-167) — exits on bad config.
2. **Connect Mongo** (`lib/db.ts:6-29`) — sets `autoIndex=false` and `autoCreate=false` in production.
3. **Run two one-shot legacy migrations** at boot inside `connectDb`: drop legacy webhook-inbox TTL index (`db.ts:84`) and drop legacy `(merchantId, createdAt:-1, order.status)` index (`db.ts:54`). Both idempotent.
4. **Assert Redis** (`lib/redis.ts:17-34`) — process.exit(1) in production if Redis isn't pingable.
5. **Fire-and-forget index sync** for the 5 hot models (`index.ts:113-135`). Builds run in background; HTTP listener doesn't wait so Railway healthcheck passes.
6. **Init queues** + register every worker (`index.ts:137-173`).
7. **Start repeatable schedules**.
8. **Start Express** with raw-body webhook routes mounted **before** `express.json` (critical for HMAC: `index.ts:194-207`).

### Router organization
- Express REST: `/auth`, `/admin`, `/api/webhooks/courier`, `/api/webhooks/sms-inbound`, `/api/webhooks/sms-dlr`, `/api/integrations/webhook`, `/api/webhooks/shopify/gdpr`, `/api/webhooks/stripe`, `/api/webhooks/twilio`, `/api/integrations` (Shopify OAuth callback), `/track` (behavior collector), `/health`, `/trpc`.
- tRPC routers under `apps/api/src/server/routers/`:
  - `merchants`, `orders`, `analytics`, `callCenter`, `call`, `fraud`, `billing`, `notifications`, `integrations`, `tracking`, `recovery`
  - admin: `adminBilling`, `adminFraudNetwork`, `adminAccess`, `adminObservability`, `adminAudit`
  - Composed in `routers/index.ts:19-38` as `appRouter`. Re-exported via `packages/types/src/router.ts` for the web client.

### Middleware stack
- `helmet()` global (`index.ts:189`).
- `cors({ origin: env.CORS_ORIGIN, credentials: true })`.
- `express.json({ limit: "1mb" })` — only after the raw-body webhook routes.
- Per-route: `webhookLimiter` (120/min/IP, Redis-backed), `loginLimiter` (5/15min keyed on IP+email), `signupLimiter`, `passwordResetLimiter`, `publicTrackingLimiter` (`apps/api/src/middleware/rateLimit.ts`).
- Global `/trpc` has **no** IP limiter — fairness is enforced per-merchant inside `safeEnqueue` (`lib/queue.ts:328-390`) and per-procedure in handlers (deliberate; commented at `index.ts:230-237`).

### Auth / session system
- JWT (HS256) with `typ: "access" | "refresh"` (`apps/api/src/server/auth.ts:51-75`).
  - Access TTL: 1h. Refresh TTL: 14 days.
  - Both carry the same `sid` claim.
- Server-side session ledger in Redis (`apps/api/src/lib/sessionStore.ts`):
  - `session:{merchantId}:{sid}` JSON record + `sessions:{merchantId}` SET for O(N) revoke-all.
  - Falls back to in-process Map when Redis is absent (dev only).
- Token cache (`server/trpc.ts:58`, LRU 10k × 60s) avoids re-verifying every JWT.
- **sid validity cache**: 30s TTL — bounds revocation latency (line 66, comment line 60-65).
- Role cache: 60s TTL for DB-confirmed admin role; protects against forged JWT role claims (`server/trpc.ts:351-368`).
- CSRF: protected mutations from cookie-auth sessions require `x-csrf-token` matching the `csrf_token` cookie (`server/trpc.ts:198-204`). Bearer-token callers exempt (no auto-attached cookie).

### tRPC procedure ladder
1. `publicProcedure` — unauthenticated.
2. `protectedProcedure` — authenticated, sid-validated, CSRF-checked on mutations.
3. `billableProcedure` — adds subscription gate (trial/active/past_due in grace) — `server/trpc.ts:281-328`.
4. `adminProcedure` — adds DB-confirmed `role:"admin"` check.
5. `scopedAdminProcedure(permission)` factory — adds RBAC scope check + writes `admin.unauthorized_attempt` audit on denial (`server/trpc.ts:411-444`).

### Ingestion pipeline (the hot path)
1. **Inbound webhook** lands at `/api/integrations/webhook/:provider/:integrationId` (`server/webhooks/integrations.ts:69`).
2. Route mounts `express.raw` so HMAC verification sees raw bytes.
3. **HMAC verify** — Shopify uses `client_secret`, Woo / custom_api use the per-integration `webhookSecret` (line 127-156).
4. **Freshness gate** — rejects deliveries > 5 min old or > 1 min in the future (line 161-176).
5. **Inbox stamp** via `enqueueInboundWebhook` (`server/ingest.ts:377-414`). Unique key `(merchantId, provider, externalId)` — duplicates collapse silently. The constraint is **permanent** (no TTL on row), only the payload is reaped at 90 days (`models/webhookInbox.ts:36-45`).
6. **ACK** in <50ms with 202.
7. **Worker pickup**: `webhookProcess.ts` consumes the inbox id, runs `replayWebhookInbox` which calls `adapter.normalizeWebhookPayload` and then `ingestNormalizedOrder`.
8. `ingestNormalizedOrder` (`server/ingest.ts:70-345`):
   - Phone E.164 normalization at the seam.
   - Dup guard via Order `findOne` on `(merchantId, source.externalId)`.
   - Reserves quota (atomic `$inc` with conditional filter, `usage.ts:82-127`).
   - Loads merchant value rollup (cached 10 min) → adaptive COD thresholds.
   - Computes risk via `computeRisk` (`server/risk.ts`).
   - **Race-safe insert**: relies on the partial unique index `(merchantId, source.externalId)`; on E11000 catches and refunds quota (line 214-247).
   - Persists `FraudPrediction` row for the monthly tuner (line 251-265).
   - Bumps integration counters, fires fraud alert if HIGH, invalidates `dashboard:{merchantId}` cache.
   - Identity-resolves prior anonymous behavior sessions.

### Replay lifecycle
- `replayWebhookInbox` (`server/ingest.ts:639-782`) handles three retry sources: the live route, the retry sweep, and the merchant's "Replay" button.
- Backoff schedule: 1m, 5m, 15m, 30m, 1h (`server/ingest.ts:577-583`). Cap 5 attempts, then dead-letter.
- `needs_attention` is a separate terminal state (missing phone / external id / invalid payload). It does NOT auto-retry — only a manual replay after the merchant fixes the storefront.

### Reliability guarantees
- **Idempotency model**:
  - WebhookInbox: `(merchantId, provider, externalId)` unique, **permanent**.
  - Order: `(merchantId, source.externalId)` partial unique (covers webhook orders); `(merchantId, source.clientRequestId)` partial unique (covers dashboard double-clicks); `(merchantId, orderNumber)` unique.
  - Payment: `providerEventId`, `providerSessionId`, `invoiceId` all sparse-unique; `(merchantId, clientRequestId)` for manual submits.
  - FraudPrediction: `orderId` unique.
  - TrackingEvent: `(merchantId, sessionId, clientEventId)` partial unique for batched-retry idempotency.
- **Two-tier dead-letter**:
  1. WebhookInbox: payload-storage failure path doesn't apply (we own the row); transient ingest failures retry per `nextRetryAt`.
  2. PendingJob: when `safeEnqueue` can't put a job on Redis after 3 retries (50/200/500ms backoff), the job's payload is persisted to Mongo (`pendingJob.ts:1-92`). The `pending-job-replay` sweeper (every 30s) drains it.
- **Optimistic concurrency** on Order: explicit `version` field + helpers in `lib/orderConcurrency.ts`; documented at `models/order.ts:402-422`.
- **Booking lock**: `logistics.bookingInFlight` flag acquired via atomic findOneAndUpdate before any AWB call (`models/order.ts:111-125`); the `awb-reconcile` worker breaks stale locks (`workers/awbReconcile.ts:7-45`).

### Observability structure
- **Sentry-compatible telemetry** (`lib/telemetry.ts`) — direct envelope POST, no SDK dependency. Captures unhandled rejections + uncaught exceptions (line 161-170), tRPC INTERNAL_SERVER_ERROR (`server/trpc.ts:172-187`), Express unhandled errors.
- **Per-queue counters** (`lib/queue.ts:147-200`): `failures`, `retryRecovered`, `deadLettered`, `replayed`, `exhausted` — all surfaced via the admin observability router.
- **Queue wait-time logging** at the BullMQ Worker `active` event when waitMs ≥ 5s (`lib/queue.ts:90-104`).
- **Anomaly engine** (`lib/anomaly.ts`) — short-window-vs-baseline detection across payment volume, webhook failures, automation failures, fraud spikes; emits `alert.fired` audit rows that fan out via `lib/admin-alerts.ts`.
- **Admin observability tRPC router** (`routers/adminObservability.ts`) drives the `/admin/system` page.

---

## 5. Integration Architecture

### Adapter registry
`apps/api/src/lib/integrations/index.ts:7-27` registers three live adapters:
- `shopify` → `shopify.ts`
- `woocommerce` → `woocommerce.ts`
- `custom_api` → `customApi.ts`
- `csv` → null (uses the bulk-upload path; no adapter)

All implement `IntegrationAdapter` (`integrations/types.ts:126-151`):
- `testConnection` returns `{ ok, kind, detail, scopes?, authStrategy? }` with discriminated failure categories.
- `fetchSampleOrders` returns `FetchSampleResult`.
- `normalizeWebhookPayload(topic, payload)` returns `NormalizedOrder | NormalizationSkip | null`.
- `verifyWebhookSignature({ rawBody, headers, secret })` returns boolean.

### Shopify integration
**OAuth flow** — `server/webhooks/integrations.ts:357-731`:
1. `integrations.connect` mints an install URL with a 16-byte random `installNonce` saved to `credentials.installNonce`. Timestamp `installStartedAt` is captured for elapsed-time logging.
2. Shopify redirects to `/api/integrations/oauth/shopify/callback?code=…&state=…&shop=…&hmac=…`.
3. **Three security gates** before the handler does any DB work:
   - Reject `error=access_denied` (user cancelled) cleanly with friendly code.
   - Validate shop domain regex `^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$` after normalizing missing `.myshopify.com` suffix.
   - **Early HMAC** against `env.SHOPIFY_APP_API_SECRET` if present, BEFORE any DB lookup — closes the state-enumeration oracle (line 411-421).
4. Look up pending integration by **install nonce**, not by shop domain — handles Shopify's vanity-vs-canonical hostname rewrite (line 423-445).
5. Custom-app fallback HMAC against the merchant's stored apiSecret if no platform secret (line 535-548).
6. Token exchange via `exchangeShopifyCode`.
7. **Smoke-test token** with `fetchShopifyShopInfo` — distinguishes auth failure from transient blip.
8. **Scope subset detection** — fails the connect if granted scopes are missing requested ones (line 585-593).
9. **Auto-register webhooks** via `registerShopifyWebhooks` — failures don't block the connect but surface as `?warning=webhooks_not_registered` (line 595-635).
10. Save with health snapshot, audit, redirect to `/dashboard/integrations?connected=shopify[&warning=...]`.
11. **Orphan cleanup**: when canonicalizing the accountKey, deletes ONLY `status:"disconnected"` rows that hold the new key — never touches a connected row (line 504-519, comment 487-503).

**Inbound webhooks**:
- Topic `app/uninstalled` short-circuits (line 200-221): flips integration to `disconnected`, never enters the order ingestion pipeline.
- Soft-pause: `pausedAt` set returns 202 with `paused: true` and skips inbox stamp (line 99-105).
- Inbox stamp + worker enqueue.

### WooCommerce integration
**Auth strategy** — HTTP Basic with `consumerKey:consumerSecret`. Webhooks signed with shared secret as base64(HMAC-SHA256(rawBody)).
**SSRF guard** — every outbound Woo call goes through `safe-fetch.ts` (`integrations/safe-fetch.ts`):
- Resolves DNS A/AAAA at call time and rejects any private/loopback/link-local hit (closes DNS rebinding).
- Static check via `isPrivateOrLoopbackHost` from `@ecom/types`.
- Skipped in non-production so dev sandboxes work.
- Test coverage: `apps/api/tests/woo.ssrf.test.ts`.
- Auth-strategy auto-detect (Basic vs querystring) on Cloudflare-fronted hosts; persists the resolved form.

### Custom API integration
- Listed in adapter registry; covers a generic JSON-over-HTTP shape so merchants without Shopify/Woo can push into Cordon. Push-only — `orderSync` worker explicitly excludes `custom_api` from polling (`orderSync.worker.ts:82-83`).

### Polling fallback (CRITICAL GAP)
- `workers/orderSync.worker.ts` IS implemented: scans every 5 min, pulls orders since `lastSyncedAt`, stamps inbox rows (deduped by webhook idempotency keys).
- **It is NOT wired in `apps/api/src/index.ts`.** Verified: the only file that references `registerOrderSyncWorker` or `scheduleOrderSync` is the worker file itself.
- **Operational impact**: missed Shopify/Woo deliveries depend entirely on the upstream's retry semantics. Shopify retries up to 19 times over ~48h, so the gap is recoverable for Shopify; Woo's retry behaviour is configurable per-store and less reliable.

### Inbox strategy
- Single `WebhookInbox` collection for all providers (commerce + courier).
- Status machine: `received → processing → succeeded | failed | needs_attention`; `failed` rows have `nextRetryAt`; cap 5 attempts → dead_letter alert.
- `webhookRetry` worker (every minute) picks up `failed` rows due for retry AND `received` rows older than 5 minutes (orphans from process crash) (`workers/webhookRetry.ts:79-147`).
- Same worker piggybacks the **payload reaper** (`reapWebhookPayloads`, line 56-77) — succeeded rows past `payloadReapAt` get `payload` and `payloadBytes` NULLed but the row stays for dedup.

### Courier webhooks
- `/api/webhooks/courier/:provider/:merchantId` — Steadfast / Pathao / RedX (`server/webhooks/courier.ts`).
- Each verifies its own signature, parses provider-specific payload, synthesizes `externalId` from `(trackingCode, status, timestamp)` hash for idempotency.
- Tenant isolation enforced by URL path: handler never writes to an Order whose `merchantId` doesn't match.

### Edge-case handling strengths
- Shopify vanity vs canonical hostname rewrite handled via install-nonce lookup, not domain match.
- Orphan disconnected rows cleaned up only when status is `disconnected` — never overwrites a connected merchant.
- HMAC gate is the very first thing after route-param validation; no DB read before it.
- Soft-pause respected by both the webhook route and the polling worker (when wired).

### Remaining risks
- **orderSync polling not registered** (covered above).
- WooCommerce HMAC verification depends on a per-merchant secret that the merchant must paste during connect — there's no out-of-band rotation flow yet, only manual via `integration.webhook_secret_rotated` audit action.
- Custom-API adapter has no auto webhook-registration handshake (by design — the merchant configures the URL on their side).

---

## 6. Queue + Worker Infrastructure

### BullMQ architecture
Single Redis connection (`lib/queue.ts:47-58`) via `ioredis` with `maxRetriesPerRequest: null, enableReadyCheck: false`. One queue per logical concern, lazy-instantiated.

### Queue inventory (`lib/queue.ts:11-32`)
| Queue | Worker file | Concurrency | Schedule | Purpose |
|---|---|---|---|---|
| `verify-order` | (unused?) | — | — | Reserved name; no worker registers it |
| `tracking-sync` | `trackingSync.ts` | 1 | every `TRACKING_SYNC_INTERVAL_MIN` (default 60) | Pull courier tracking status |
| `risk-recompute` | `riskRecompute.ts` | 4 | event-driven | Rescore phone-related orders on RTO/no-answer |
| `subscription-sweep` | (unused) | — | — | |
| `fraud-weight-tuning` | `fraudWeightTuning.ts` | 1 | monthly cron `15 3 1 * *` | Per-merchant signal-weight learning |
| `webhook-process` | `webhookProcess.ts` | 8 | event-driven | First-delivery webhook ingest |
| `webhook-retry` | `webhookRetry.ts` | 1 | every 60s | Failed/orphan inbox sweep + payload reap |
| `commerce-import` | `commerceImport.ts` | default 4 | event-driven | Manual "import last N orders" |
| `cart-recovery` | `cartRecovery.ts` | default 4 | every 5 min | Abandoned-cart task creation |
| `trial-reminder` | `trialReminder.ts` | default 4 | every 6h | Trial-ending email |
| `subscription-grace` | `subscriptionGrace.ts` | default 4 | hourly | Past-due → suspended after grace |
| `automation-book` | `automationBook.ts` | 4 | event-driven | Auto-book courier with fallback chain |
| `automation-watchdog` | `automationWatchdog.ts` | default 4 | every 5 min | Stuck-order recovery + queue stall detection |
| `automation-sms` | `automationSms.ts` | default 4 | event-driven | Pending-confirmation SMS with retries |
| `automation-stale` | `automationStale.ts` | default 4 | hourly | Stale-pending escalation + auto-expire |
| `awb-reconcile` | `awbReconcile.ts` | default 4 | every 60s | Stale booking-lock breaker |
| `order-sync` | `orderSync.worker.ts` | 1 | **NOT REGISTERED** | Polling fallback — dead in production |
| `pending-job-replay` | `pendingJobReplay.ts` | 1 | every 30s | DLQ replay sweeper |

### Default job options (`lib/queue.ts:36-41`)
- `attempts: 3`
- `backoff: exponential, 5s base`
- `removeOnComplete: { count: 1000, age: 24h }`
- `removeOnFail: { count: 5000, age: 7d }`

### Reliability features
- **`safeEnqueue`** (`lib/queue.ts:328-390`) is the canonical enqueue:
  - Per-merchant token-bucket fairness (Redis Lua, `lib/merchantRateLimit.ts:26-66`) keyed on (queue, merchant). Bursts allowed up to capacity, sustained over-spend deferred (capped 30s).
  - 3 in-process retries with 50/200/500ms backoff for transient Redis flaps.
  - Persists to `PendingJob` on persistent failure → caller still gets `ok:true` with `deadLettered:true`.
  - Notifies merchant once-per-hour per (queue, merchant) on dead-letter or hard-fail.
  - Returns hard `ok:false` ONLY when both Redis AND Mongo are unreachable.
- **`pending-job-replay` sweeper** (`workers/pendingJobReplay.ts`):
  - Claims `pending` rows whose `nextAttemptAt < now` via atomic `findOneAndUpdate`.
  - Replays via `queue.add`. Success → `deleteOne`. Failure → exponential backoff (1m / 5m / 15m / 1h / 4h).
  - At 5 attempts: status flips to `exhausted`, critical merchant alert fires.
  - Idempotent across multi-instance deploys via the claim semantics.

### Worker isolation quality
- Every worker is a thin BullMQ wrapper around library logic in `lib/`. The library is what tests import (`apps/api/CLAUDE.md:18-19`).
- `registerWorker` is idempotent — returns the existing instance if one is bound to the queue (`lib/queue.ts:77-78`); hot-reload safe.

### Auto-book fallback chain
`workers/automationBook.ts`:
- Selects courier via `selectBestCourier` (district-level performance with global fallback).
- On per-courier failure, **records failure** (1h decaying penalty), enqueues a NEW job for the next-best courier (different `jobId`), capped at `MAX_ATTEMPTED_COURIERS=3`.
- `attemptedCouriers` array on the order is `$slice`-capped at 3 via aggregation pipeline update so a runaway loop can't grow the document (line 230-249).
- Optimistic concurrency: CAS filter on `version` field (line 230-232).

### Queue explosion / scaling risks
- Single Redis instance is the SPOF. Eviction policy not pinned in code; assume the deploy uses `noeviction` (BullMQ requirement).
- `webhookProcess` concurrency 8 + `automationBook` concurrency 4 + others = ~30 concurrent jobs per process. Adequate for 100s of merchants; needs sharding past 10k.
- `removeOnFail: { count: 5000, age: 7d }` keeps ~5k failures per queue × 17 queues = ~85k Redis keys at peak. Bounded.

### Duplicate-processing protection
- BullMQ `jobId`s are deterministic where it matters (`auto-book:{orderId}[:try-N]`, `webhook-retry:sweep`, etc.).
- Webhook idempotency is enforced by the WebhookInbox unique index regardless of how many jobs reference the same row.
- `Order` writes guarded by partial-unique on `(merchantId, source.externalId)` AND the optimistic version counter.

### Replay guarantees
- WebhookInbox replay: exactly-once at the order-creation level via the unique index. The same upstream event landing twice produces at most one Order row.
- PendingJob replay: at-least-once by design; consumers must be idempotent. Most consumers are (auto-book uses jobId-per-attempt; SMS uses jobId-per-order; webhook-process is no-op on already-succeeded inbox rows).

---

## 7. Database + Data Model

### Mongo usage
- Mongoose 8.5.1, single connection per process.
- `strictQuery: true`. `autoIndex: false` and `autoCreate: false` in production (`lib/db.ts:12-16`) — index sync is explicit, run at boot in background or via `npm run db:sync-indexes`.
- All models live in `packages/db/src/models/`, exported through `packages/db/src/index.ts`.

### Models inventory
- **merchant** — auth, subscription, courier configs, fraudConfig, branding, automationConfig, tracking key, Stripe ids, RBAC adminScopes, alert prefs.
- **order** — customer, items, order details, logistics + tracking events ($slice-capped at 100), fraud, automation, source, calls, version (explicit OCC counter), preActionSnapshot.
- **integration** — provider-agnostic connector with credentials (encrypted), webhookStatus, health, counts, lastSync, soft-pause fields, degraded flag.
- **webhookInbox** — exactly-once ledger; idempotency keys live forever, payload reaped at 90d.
- **pendingJob** — DLQ for `safeEnqueue` failures.
- **auditLog** — append-only with hash chain (selfHash + prevHash).
- **payment** — manual + Stripe receipts; cross-merchant fingerprint indices on txnIdNorm/proofHash/metadataHash; dual-approval workflow for high-risk.
- **usage** — monthly counters per (merchantId, period="YYYY-MM").
- **notification** — in-app inbox; severity-tiered with dedupeKey.
- **fraudPrediction** — per-order frozen snapshot; TTL 400 days; feeds the tuner.
- **fraudSignal** — cross-merchant phone+address fingerprint; merchantIds capped at 64.
- **trackingEvent / trackingSession** — behavioral analytics; identity-resolution fields.
- **callLog** — call-center activity.
- **bulkUploadBatch / importJob** — CSV + commerce import progress.
- **courierPerformance** — per (merchantId, courier, district) success/RTO/cancel counters + delivery-hours sum + circuit-breaker recent-failure state.
- **pendingAwb** — booking ledger + reconciler input.
- **recoveryTask** — abandoned-cart outreach queue.
- **merchantStats** — denormalized per-merchant counters (incremented in Order pre/post-save hooks; transaction-aware via `this.$session()`).

### Indexing strategy (verified per file)
- Order: 11 indexes — primary listing follows ESR rule (`merchantId, order.status, createdAt:-1`), partial-uniques on externalId/clientRequestId, partial filters on courier/IP/addressHash, sparse on trackingNumber, tracking-sync polling index. Replaces a legacy index whose prefix forced in-memory status filter (the migration drops it at boot).
- WebhookInbox: 4 indexes — unique on (merchantId, provider, externalId) **with no TTL**; partial filters for failed-retry pickup, needs-attention list, and payload-reap pickup.
- Merchant: sparse-unique on stripeCustomerId / stripeSubscriptionId; partial-filter on subscription.gracePeriodEndsAt for the grace sweep.
- AuditLog: 5 indexes — chain head lookup + scoped scans by merchant/subject/action/actor. selfHash itself is indexed for chain verification.
- FraudPrediction: 4 indexes including a 13-month TTL (`expireAfterSeconds: 0` on `expiresAt`).
- FraudSignal: unique on (phoneHash, addressHash) with `_none_` sentinel for one-sided fingerprints.
- TrackingEvent: 6 indexes incl. partial unique on (merchantId, sessionId, clientEventId) for batched-retry idempotency.
- CourierPerformance: unique on (merchantId, courier, district).
- Payment: 7 indexes — unique on Stripe ids + clientRequestId, non-unique on cross-merchant fingerprints.

### TTL / archival
- Active TTLs:
  - `FraudPrediction.expiresAt` — 400 days.
  - **No TTL on `WebhookInbox`** (was removed; `dropLegacyWebhookInboxTtl` runs at boot, idempotent).
- Storage bounded primarily by:
  - Webhook payload reaper (90 days, NULLs payload but keeps row).
  - Order `trackingEvents` array $slice cap of 100.
  - Order `attemptedCouriers` cap of 3.
  - FraudSignal `merchantIds` cap of 64.
  - `removeOnComplete/Fail` on every BullMQ queue.

### Scaling readiness
- Most reads scoped by `merchantId` first — sharding on `merchantId` is straightforward when the time comes.
- Every "list all merchants" sweep is bounded (`SCAN_BATCH = 100-200`). Only the anomaly engine runs unbounded counts; it's a 1h+24h window and uses indexes.
- Time-series-heavy collections (TrackingEvent) lean on `(merchantId, occurredAt)` indexes; will be the first to need partitioning past ~50M docs.
- `FraudPrediction` will hit the 13-month TTL at steady state — bounded.
- AuditLog is unbounded by design (append-only, no TTL). Will need a separate cold-storage strategy at 100M rows.

### Unbounded-growth risks
- **AuditLog** — by design. Real risk after ~24 months at scale.
- **TrackingEvent** — public collector accepts at line speed once per merchant token. Spike protection via `lib/tracking-guard.ts` (rate limit, identical-payload dedupe, concurrency cap) is in place.
- **WebhookInbox dedup keys** are permanent — slim row (~200 bytes) bounded by webhook traffic. At 100k events/day × 365d = ~36M rows/year. Single index on the unique key. Manageable to ~3 years before partitioning matters.

---

## 8. Billing + Subscription System

### Pricing structure
- 4 tiers (`packages/types/src/plans.ts:53-187`):
  | Tier | BDT/mo | USD/mo | Orders | Shipments | Couriers | Integrations | Seats | Behavior analytics |
  |---|---|---|---|---|---|---|---|---|
  | Starter | 999 | 9 | 300 | 300 | 1 | 1 (CSV+Shopify) | 1 | retain 30d |
  | Growth | 2,499 | 25 | 1,500 | 1,500 | 3 | 1 (+Woo) | 3 | retain 90d |
  | Scale | 5,999 | 59 | 6,000 | 6,000 | 6 | 5 (+custom_api) | 10 | retain 180d, advanced tables |
  | Enterprise | 14,999 | 149 | 50,000 | 50,000 | 20 | 50 | 50 | unlimited + exports + SLA |
- Stripe Price ids per tier set via env (`env.ts:90-93`); Stripe seed script in `apps/api/src/scripts/seedStripe.ts`.

### Billing providers
- **Manual rails** (`PAY_BKASH_NUMBER`, `PAY_NAGAD_NUMBER`, `PAY_BANK_INFO`):
  - Merchant submits a receipt + screenshot via `billing.submitPayment`.
  - Auto-risk-scored at submit (`lib/manual-payments.ts:scorePaymentRisk`).
  - High-risk (`riskScore ≥ 60`) requires **dual approval** — first admin sets `firstApprovalBy`, second admin (different person, finance scope) flips to approved (`models/payment.ts:107-145`).
  - Cross-merchant fraud detection via three fingerprint hashes (txnIdNorm, proofHash, metadataHash).
  - Spam guard: `PAY_MANUAL_DAILY_CAP` limits submissions per merchant per 24h (default 3).
- **Stripe Subscriptions** — recurring; webhook-driven state machine:
  - `checkout.session.completed` → activate.
  - `invoice.payment_succeeded` → bump `currentPeriodEnd`.
  - `invoice.payment_failed` → status=past_due, set `gracePeriodEndsAt = now + STRIPE_GRACE_DAYS` (default 7).
  - `customer.subscription.deleted` → cancel.
  - Idempotency via `Payment.providerEventId` unique index.
- **One-shot Stripe Checkout** legacy mode also supported.
- Currency: `STRIPE_USE_USD` env toggle — default USD pricing.

### Quota enforcement
`apps/api/src/lib/usage.ts`:
- `bumpUsage` — atomic `$inc` with upsert; race-free.
- `reserveQuota` — conditional `$inc` with `[metric]: { $lte: limit - amount }` filter; two concurrent callers can't both grab the last slot.
- `releaseQuota` — refund on failure paths (`server/ingest.ts:329` releases on E11000 race).
- `checkQuota` — non-throwing read for UI gates.
- One row per `(merchantId, period="YYYY-MM")`; unique compound index.

### Plan gating
`apps/api/src/lib/entitlements.ts`:
- `assertIntegrationProvider(tier, provider)` — throws `entitlement_blocked:integration_provider_locked` (TRPCError, code FORBIDDEN). Web client splits on `:` to drive upgrade modal.
- `assertIntegrationCapacity` — checks `maxIntegrations`.
- `assertBehaviorAnalytics`, `assertAdvancedBehaviorTables`, `assertBehaviorExports`, `assertRetentionWindow` cap behavior-analytics features.
- `previewIntegrationCapacityChange` — dry-run of a downgrade; surfaces exact list of integrations that would be disabled. Powers the dashboard's downgrade-warning modal (`routers/billing.ts:108-150`).
- `enforceDowngradeIfNeeded` — actual enforcement on plan change; fires `subscription.plan_downgrade_enforced` notification.

### Subscription state machine (`models/merchant.ts:24-32`)
`trial → active → past_due → suspended` (with `paused` and `cancelled` orthogonal). The `billableProcedure` ladder on every revenue-adjacent procedure (`server/trpc.ts:281-328`) enforces:
- `trial`: allowed until `trialEndsAt` (default 14 days).
- `active`: allowed; if `currentPeriodEnd` lapsed, treated as past_due.
- `past_due`: allowed during grace window; otherwise FORBIDDEN.
- `suspended`/`paused`/`cancelled`: hard-block.

### Trust / safety considerations
- bKash/Nagad fraud:
  - Risk score embedded in Payment doc at submit time, can't be tuned post-hoc.
  - Cross-merchant fingerprint hashes detect screenshot reuse, txn-id reuse, metadata replay.
  - Two-stage review (`pending → reviewed → approved`); instant approve from pending is rejected.
- Receipt files inline-stored on Payment doc, capped at 4MB (`models/payment.ts:53`).
- Spam: per-merchant daily submit cap.

### Missing production requirements
- Refunds: schema field `refunded` exists but no flow implemented; comment notes "separate flow, not in this PR".
- Pro-ration on plan change: not modeled. The `subscription.extended` audit action exists but the math is admin-driven via `/admin/activate`.
- Tax invoices / VAT: not modeled in either model or router.
- Dunning email cadence beyond initial trial-ending warning is not present.

### Risks
- Manual-payment risk relies on small-scale fingerprinting; an attacker who controls multiple merchants can probe the system. Capped at 3 submits/day partially mitigates.
- Stripe webhook signing secret (`STRIPE_WEBHOOK_SECRET`) — endpoint hard-refuses 503 if unset (`webhooks/stripe.ts:111-114`). Good — no silent acceptance.
- Customer-confusion risk: trial expiry without payment leads to `FORBIDDEN: trial_expired` from billable procedures; the dashboard banner system (`components/billing/dashboard-banners.tsx`) is the recovery surface.

---

## 9. Fraud / Risk System

### Risk-scoring engine (`apps/api/src/server/risk.ts`)
Pure-ish function — given the order draft + pre-fetched history, emits 0–100 score, contributing signals, level, and reviewStatus.

### Signals + weights (`risk.ts:33-60`)
- COD-based: `highCod` (18), `extremeCod` (40) with adaptive thresholds from p75/avg merchant rollup.
- Phone history: `duplicatePhone` (10), `duplicatePhoneHeavy` (25), `priorReturns` (22), `priorCancelled` (14), `unreachableHistory` (20).
- Address: `duplicateAddress` (22).
- Velocity: `velocityBreach` (75 — single-occurrence HIGH).
- Pattern: `fakeNamePattern` (25 — keyboard walks, placeholders, vowel-less, Bangla placeholders), `garbagePhone` (30).
- Context: `suspiciousDistrict` (16), `ipVelocity` (16).
- Hard-block: `blockedPhone` (100), `blockedAddress` (100) — single hit forces HIGH.
- Time-decay: every contributing past order weighted by `exp(-ageDays / halfLife)` (default 30d half-life).

### Tiers (`risk.ts:26-29`)
- Low: 0–39.
- Medium: 40–69.
- High: 70+.

### Customer tier (`risk.ts:78-80`)
- gold: ≥5 delivered + ≥85% success rate.
- silver: ≥3 delivered + ≥70% success rate.
- standard / new otherwise.
- Higher-tier buyers bypass soft signals.

### Adaptive learning
- `FraudPrediction` row written per order at scoring time with frozen weights snapshot + outcome slot.
- Tracking pipeline stamps `outcome` when delivered/rto/cancelled.
- Monthly worker (`fraudWeightTuning.ts`):
  - 90-day lookback.
  - Per-signal precision = P(rto | signal fired); lift = precision / merchant base RTO.
  - Multiplier in [0.5, 1.5] capped to bound month-to-month whiplash.
  - Recomputes per-merchant `baseRtoRate` from observed outcome mix.
  - Persists `signalWeightOverrides`, `baseRtoRate`, `lastTunedAt`, `weightsVersion`.
  - Floor: 50 resolved predictions to tune; 10 hits per signal to adjust.

### Cross-merchant fraud network (`apps/api/src/lib/fraud-network.ts`)
- Read: `lookupNetworkRisk({ phoneHash, addressHash, merchantId })` returns merchant-count + RTO-rate aggregates, never identities.
- Write: `contributeOutcome` upserts FraudSignal row, increments delivered/rto/cancelled, adds caller's merchantId to capped list.
- **Privacy posture** (model: `fraudSignal.ts:1-89`):
  - Only SHA-256 hashes persist globally; raw values never cross merchants.
  - `merchantIds` capped at 64 to bound linkability.
  - Single-merchant signals are suppressed at lookup (no network confidence).
- Bonus capped at +25 score to keep network signal subordinate to merchant-local features.
- Master kill-switch: `FRAUD_NETWORK_ENABLED=0` disables both lookup and contribution.
- Decay: signals older than `FRAUD_NETWORK_DECAY_DAYS` (default 180) yield no bonus.
- Warming floor: `FRAUD_NETWORK_WARMING_FLOOR` (default 50) below which the bonus is damped ×0.5.

### COD verification workflow
- Medium/high orders go to `pending_confirmation` → SMS prompt with 6-digit confirmation code minted by automation.
- Inbound SMS handler (`server/webhooks/sms-inbound.ts`) parses "YES <code>" / "NO <code>" replies to confirm/reject.
- `automation-stale` worker (hourly): at 24h no-reply → escalate to `pending_call`; at 72h → auto-cancel.
- `automation-watchdog` (every 5m): re-enqueues stuck orders that auto-confirmed but never got to auto-book.

### Phone normalization
- E.164 at every ingest seam (`apps/api/src/lib/phone.ts`).
- `phoneLookupVariants` produces all canonical/non-canonical forms for joining behavior sessions to orders (`server/ingest.ts:944-953`).
- Test coverage: `apps/api/tests/phone.test.ts`.

### Courier intelligence (`apps/api/src/lib/courier-intelligence.ts`)
- Score = 60·successRate − 30·rtoRate + 10·speedScore (24h baseline) + preferred bonus.
- District-level evidence preferred; falls back to merchant `_GLOBAL_` aggregate when district has < MIN_OBSERVATIONS (10) hits.
- Cold-start: < 10 observations → neutral 50.
- Stale stats (older than 180 days lastOutcomeAt) treated as cold-start.
- Recent-failure penalty: rolling 1h window, 4 points per hit, capped at 20.
- Per-key circuit breaker (`couriers/circuit-breaker.ts`) — closed/open/half_open with 5-failure trip, 30s open duration, 5s wall-time ceiling. Keyed `(provider, accountId)` so one merchant's bad creds don't trip the breaker for everyone else.

### Operator workflows
- `dashboard/fraud-review/page.tsx` — `pending_call` queue with riskScore-desc sort.
- `dashboard/call-customer/page.tsx` — agent surface.
- Bulk verify/reject via `automation.bulk_confirmed` / `bulk_rejected` audit actions.
- Reject is reversible: `preActionSnapshot` field on Order captures full state at reject time (`models/order.ts:386-399`); `restoreOrder` puts it back exactly.

### Trust model
- Tamper-evident audit chain (selfHash + prevHash) makes "show me what the operator did to this order" verifiable (`auditLog.ts:181-251`).
- Mongoose immutability hooks block updateOne/deleteOne/findOneAndUpdate at the model level (lines 217-243).
- Chain verification: `verifyAuditChain` walks forward, surfaces the first break with id + timestamp.

### Operational limitations
- The fraud-weight tuner runs ONCE/month; merchants experiencing a sudden vertical shift (Eid, flash sale) won't see weights adapt for up to 31 days. Documented as a deliberate trade-off (`workers/fraudWeightTuning.ts:21-29`).
- Cross-merchant signal needs ≥2 distinct merchants AND ≥2 observations to fire; new fingerprints carry no network confidence by design.

---

## 10. Reliability + Production Hardening

### Replay durability
- **Webhook idempotency keys persist forever** (`webhookInbox.ts:13-45`). Concrete failure scenario this fixes: a 32-day-old Shopify replay producing a duplicate order — closed.
- Defense-in-depth: even if a WebhookInbox row is deleted, the Order partial-unique on `(merchantId, source.externalId)` still blocks duplicates.
- Dead-letter replay (PendingJob) for queue outages.

### Exactly-once guarantees
- WebhookInbox + Order's partial-unique index combine to give exactly-once at the order-creation level for inbound webhooks.
- `Payment.providerEventId` unique index gives exactly-once for Stripe events.
- Manual order creation: `(merchantId, source.clientRequestId)` partial-unique blocks dashboard double-clicks.
- Auto-book uses jobId-per-attempt + booking-lock + version field — at-most-once at the upstream courier (idempotency-key forwarded; `couriers/types.ts:71`).

### Webhook durability
- Raw-body parsing mounted before `express.json` (`index.ts:194-207`) — HMAC verification is mathematically correct.
- Freshness gate (5 min window) on commerce webhooks rejects captured-payload replays.
- Per-IP `webhookLimiter` (120/min) in front of every webhook receiver.
- 5xx ack on inbox-stamp failure → upstream retries (`webhooks/integrations.ts:255-257`).

### Queue recovery
- `pending-job-replay` sweeper runs every 30s — a Redis blip is invisible to callers.
- `webhook-retry` sweeper runs every 60s and picks up `received` rows older than 5 min (orphans from worker crash).
- `automation-watchdog` runs every 5 min and re-enqueues stuck orders.
- `awb-reconcile` runs every 60s — breaks stale booking locks past 90s.

### Observability
- Sentry-compatible telemetry (lazy, DSN-gated, no SDK weight).
- Per-queue counters surfaced via `/admin/system`.
- BullMQ wait-time logging at ≥5s threshold.
- Anomaly detection across payments / webhooks / automation / fraud.
- Tamper-evident audit log; `verifyAuditChain` callable from admin UI (super_admin scope only).

### Incident management
- `IncidentBanner` env-var driven (`NEXT_PUBLIC_INCIDENT_BANNER_TEXT`) — critical-level non-dismissible banner mounted at the top of every dashboard page.
- Admin notifications fan out via `lib/admin-alerts.ts` per-admin email/SMS prefs (severity-tiered; in-app always on).

### CSP / security posture
- Helmet global (`index.ts:189`).
- CSP **Report-Only** — comprehensive policy in `next.config.mjs:107-146` with violation reporting to `/api/csp-report`. Will flip to enforce.
- HSTS in production only (`next.config.mjs:166-173`).
- `X-Frame-Options: DENY` everywhere except `/track/*` (intentional embeddability for merchant storefronts).
- `Permissions-Policy` locks down camera/mic/geolocation/payment/interest-cohort.
- Cookies: HttpOnly + Secure (prod) + SameSite=strict.
- TRUSTED_PROXIES is OFF by default — req.ip falls back to socket peer; production warning at boot if unset (`index.ts:182-188`).
- SSRF guard for Woo connect (DNS rebinding aware).
- Bcrypt passwords (cost 10).
- Constant-time compare on CSRF + admin secret + reset-token hashes.
- Rate limits scope login/signup/reset/webhook/public-tracking individually; trpc deliberately not globally limited (per-tenant fairness instead).

### Audit logging
- Append-only with hash chain (covered above).
- Mongoose immutability hooks at every mutation method.
- Admin-flavored writes (`writeAdminAudit`) require prevState/nextState.
- Funnel audit signals (`auth.signup`, `integration.connected`, `integration.first_event`).
- Unauthorized-attempt audit on RBAC denials.

### Runtime protections
- Optimistic concurrency on Order via explicit `version` (over Mongoose's `__v` because findOneAndUpdate ignores `__v`).
- Booking lock prevents two simultaneous AWB attempts.
- Token-bucket per-merchant fairness on every queue.
- Circuit breaker per (courier, account) so one merchant's bad creds don't poison shared infrastructure.
- Graceful shutdown: SIGINT/SIGTERM closes server, drains workers, closes queues + Redis (`index.ts:270-278`).

### Strongest reliability systems
1. WebhookInbox (permanent dedup + bounded payload growth).
2. PendingJob dead-letter replay.
3. Audit hash chain + immutability hooks.
4. Per-merchant token-bucket fairness.
5. Adaptive courier intelligence with circuit breaker.

### Weakest operational areas
1. **`order-sync` worker not registered** — polling fallback offline.
2. **CSP not enforced** — Report-Only only.
3. **Shopify GDPR redaction stubbed** — receiver real, deletion is TODO.
4. **Single Redis** — no HA at app layer.
5. **Build tolerates type errors** on the deploy path.

### Production-readiness score
**6.5 / 10** — for a company at this stage, that score is *high*. Architecturally credible, several systems unusually mature for the stage, but with explicit un-shipped pieces that block enterprise procurement (GDPR redaction, CSP enforce, polling fallback, HA Redis).

---

## 11. Testing + Engineering Quality

### TypeScript discipline
- Strict mode across all packages.
- `apps/api`: `tsc --noEmit` for `typecheck`, `tsc -p tsconfig.build.json` for build (tolerant — does not gate on type errors). `build:strict` exists.
- `apps/web`: `next build` with `typescript: { ignoreBuildErrors: false }` — gates on type errors (`next.config.mjs:185`).
- Shared `@ecom/config` ships `tsconfig.base.json`.

### Test architecture
- **API**: Vitest 2.0.5 + `mongodb-memory-server` (`apps/api/tests/globalSetup.ts`). 56 test files inventoried.
- **Web**: Playwright 1.48 (`apps/web/e2e/`). No unit-test runner configured (logic-heavy code lives in api per `apps/web/CLAUDE.md:43-45`).
- **Test naming**: mirrors the unit covered (`tests/<router-or-lib>.test.ts`).

### Coverage hot-spots (verified by file inventory in `apps/api/tests`)
- Webhook idempotency durability + Shopify HTTP path: `webhookIdempotencyDurability.test.ts`, `shopifyWebhookHttp.test.ts`.
- Pending-job replay: `pending-job-replay.test.ts`.
- Order idempotency races: `orderIdempotency.test.ts`.
- Reject/restore round-trip: `reject-restore-roundtrip.test.ts`.
- Courier reliability: `courier.circuit-breaker.test.ts`, `courier.retry.test.ts`, `courier.observability.test.ts`, `courier.pathao-redx.test.ts`, `couriers/{pathao,redx,steadfast}.test.ts`.
- Fraud network + adaptive: `fraud-network*.test.ts`, `fraud.adaptive.test.ts`, `fraud.v2.test.ts`.
- Admin security: `admin.security.test.ts`.
- SSRF: `woo.ssrf.test.ts`.
- Plan downgrade enforcement: `downgrade.enforcement.test.ts`.
- Manual payments: `manual-payments.test.ts`.
- SMS: `sms.test.ts`, `sms-inbound.test.ts`, `sms-dlr.test.ts`, `sms-webhook-verify.test.ts`.
- Audit funnel: `audit-funnel.test.ts` (in untracked changes).
- Tracking collector: `tracking-collector-hardening.test.ts`, `tracking.sync.test.ts`.
- Sprint suites: `sprintA/B/C/D` plus `sprintC.launch.test.ts`.
- Performance/scaling: `scaling.test.ts`, `queue-reliability.test.ts`.

### Strengths
- Real Mongo via `mongodb-memory-server` — tests exercise indexes + dup-key races authentically.
- Adapter tests + integration HTTP tests — webhook signature verification and HMAC paths exercised.
- SSRF / security tests present.
- Per-worker tests target the library function directly (per CLAUDE convention) — wrappers tested only when scheduling logic matters.

### Missing test coverage
- No automated test for the `order-sync` worker registration (which would have caught the dead worker).
- No e2e test for the multi-step Shopify install flow (manual via Partner sandbox).
- No load/perf test in CI; `scaling.test.ts` exists but is functional, not load.
- Front-end has no unit test runner — every assertion lives in Playwright e2e.

### Build safety
- API build is *intentionally* tolerant on the deploy path — staging accepts type errors so a hotfix doesn't block on a dev-environment type drift. **This means production can ship with regressions a strict typecheck would catch.** The strict variant exists; consider gating CI on `build:strict` even if deploy uses `build`.

### Dangerous gaps
1. orderSync wiring isn't a test gap exactly — it's an integration gap. A "ensure every worker file has a registration call in index.ts" lint check would have caught it (this exact pattern is documented in `apps/api/CLAUDE.md:13-16` as "treat as a bug, not a feature flag").
2. The `verify-order` queue name in `QUEUE_NAMES` (`lib/queue.ts:12`) has no consumer — possibly dead.
3. The `subscription-sweep` queue name has no consumer — possibly dead.

---

## 12. UX + Conversion Strategy

### Landing storytelling
- Single hero narrative: **"You're losing ৳540,000+ a month to fake COD orders. We give it back — before the courier picks up."** (`(marketing)/page.tsx:114-117`).
- The serif italic accent (`<span className="serif">We give it back</span>`) is the rebrand's signature voice.
- Animated counter on the loss number; eyebrow with pulse dot ("Built for Bangladesh's COD economy"); decorative-animation pause-on-offscreen.
- Sections: how it works → fraud network → automation → pricing.

### Emotional UX
- ROI calculator with floating loss indicator anchored to the viewport — keeps the cost-of-inaction in front of the user as they scroll.
- Exit-intent modal as the last conversion lever.

### Onboarding psychology
- Server-side activation funnel:
  - signup → `auth.signup` audit row.
  - integration.connect → `integration.connected` audit row.
  - first verified webhook → atomic `integration.first_event` claim (`webhooks/integrations.ts:269-308`).
- Client-side: `<ActivationToaster />` fires once-per-merchant celebrations the moment Cordon delivers measurable value (first order ingested, first risky order detected) — localStorage-gated (`dashboard/layout.tsx:30-34`).
- `<NewMerchantRedirect>`, `<DashboardHero>`, `<OnboardingChecklist>` in `components/onboarding/`.
- `<NextStepBanner>` on the dashboard surfaces the highest-value next action (connect courier, paste tracking key, etc.).

### Activation moments
- **First order ingested** — the merchant sees Cordon do the thing they signed up for.
- **First risky order detected** — proves the fraud engine is real.
- **First webhook delivered** — proves the integration loop closed.

### Trust-building systems
- TrustStrip component on dashboard (`components/dashboard/trust-strip.tsx`).
- `<OperationalBanner>` flags real platform incidents.
- `<SystemActionsLog>` visible activity feed — "Cordon just did X" — converts background work into perceived value.
- Audit log surfaced in `/admin/audit` for finance/security review.

### Merchant confidence flows
- Shopify connect: per-merchant elapsed-time logging (line 462-474 of integrations.ts) plus warning bands for partial scope grants and webhook-registration failures — the merchant sees specific yellow banners instead of a generic "something went wrong".
- Webhook test/replay buttons on the integration card.
- `needs_attention` inbox bucket distinguishes "your storefront is misconfigured" from "we hit a bug" — recoverable on click rather than mystifying.

### Auth consistency
- One shell (`cordon-auth-shell.tsx`) for every auth-flavored page — login, signup, forgot-password, reset-password, payment-success/failed, verify-email-sent.
- Brand wordmark + animated dot consistent with marketing.

### Mobile UX maturity
- `<MobileBottomNav>` mounted in dashboard layout for primary nav.
- The marketing landing is mobile-first by design (CSS module).
- No native app; web is the surface.

### Conversion strengths
- ROI math front-and-center on landing.
- Three-tier urgency stack (counter, exit-intent, floating indicator).
- Server-confirmed activation events (no client-side gaming).
- Clear pricing in BDT + USD.

### Onboarding friction (observed)
- Shopify connect requires the platform to have `SHOPIFY_APP_API_KEY` + `SHOPIFY_APP_API_SECRET` configured to give the one-click experience; without those, merchants are dropped to the legacy custom-app flow with manual key paste — a real funnel cliff.
- Custom-API integration has no auto-handshake; merchant must wire the URL on their side. Zero in-app guide page surfaced (no "custom_api setup wizard" component found).
- WooCommerce connect requires the merchant to generate API keys in their Woo admin and paste them — known step-friction.

### UX inconsistencies
- File-naming drift (PascalCase Sidebar vs kebab-case rest).
- Stripe redirect URL convention (`/dashboard/billing?stripe=...`) is real; `/payment-success` and `/payment-failed` ARE in `app/`, but `apps/api/CLAUDE.md:38-40` explicitly states "no /payment-success or /payment-failed route in production". Either dead or misdocumented.

### Production trust signals
- Verified-by-design audit chain.
- Webhook delivery dashboard surfaces real-time `integration.webhook_replayed`, `_dead_lettered`, `_needs_attention` rows.
- Merchant-controlled tracking secret + strict-HMAC toggle (`models/merchant.ts:344-346`).
- Public tracking page is rate-limited (30/min/IP) so merchants can embed it confidently.

---

## 13. Operational Maturity Assessment

### Production-ready
- Express + tRPC + Mongoose runtime.
- Auth (cookie + bearer + sid revocation + CSRF).
- Webhook idempotency (commerce + courier + Stripe).
- BullMQ workers (most of them) with safe-enqueue + dead-letter.
- Quota/usage enforcement.
- Manual payment workflow (with dual-approval for high-risk).
- Stripe Subscriptions full state machine.
- Tamper-evident audit chain.
- Per-merchant fairness via token bucket.
- Per-courier circuit breaker with wall-time ceiling.
- SSRF defense for Woo.
- Behavior collector with multi-tier rate limiting + concurrency cap.
- Identity resolution (orders ↔ behavior sessions).
- RBAC with three scopes + step-up for critical actions.

### Stable but evolving
- Fraud weight self-tuning (monthly cadence is a known trade-off).
- Cross-merchant fraud network (single instance — no admin-facing tools to query/audit signals beyond the network observability page).
- Courier intelligence (3 adapters; `pathao`, `steadfast`, `redx` modeled but `ecourier`, `paperfly` only as enum entries).
- CSP (Report-Only mode pending production validation period).
- Anomaly engine (live but threshold tuning likely needed).
- AdminAccess RBAC (real, but only one super_admin step-up flow tested in CI).

### Needs hardening
- Build tolerance on the deploy path (api).
- orderSync polling worker (file exists, not registered).
- Shopify GDPR redaction (receiver is real; deletion sweep TODO).
- Telemetry (custom Sentry envelope; works but no breadcrumbs/tracing).
- Verify-order and subscription-sweep queue names with no consumer (likely dead).

### Missing for scale
- Read replicas for Mongo.
- Redis HA (sentinel/cluster) — single-instance assumption everywhere.
- Multi-region deployment (no edge config visible).
- Object storage for proof files (currently inline base64 on Payment doc capped at 4MB).
- CDC / event-bus for analytics offload (today, dashboards query Mongo directly).
- Load shedding under upstream degradation (circuit breaker exists per courier; nothing similar for upstream Stripe / Twilio outages).
- Worker process separation — today every worker shares the API process. A 10k-merchant deploy will need a dedicated worker pool.

---

## 14. Scaling Assessment

| Dimension | 10 merchants | 100 merchants | 1,000 merchants | 10,000 merchants |
|---|---|---|---|---|
| **Mongo** | trivial | comfortable on single primary | needs `(merchantId, ...)` shard key for hot collections (Order, TrackingEvent, WebhookInbox) | sharding mandatory; AuditLog cold-storage |
| **Redis** | one instance | one instance | sentinel + read replica recommended | cluster, separate Redis per queue concern |
| **Workers** | shared with API | shared with API | move to dedicated pool | dedicated pool per queue, autoscale on lag |
| **Queues** | adequate | adequate | webhook-retry sweep batch likely tunes up | webhook-retry must shard by tenant or queue depth becomes seek-heavy |
| **Infra** | single Railway/Vercel deploy | single deploy + DB Atlas tier-up | multi-region for failover | multi-region active/active |
| **Support** | founder-led | dedicated support_admin | shift coverage; fraud-override SLA | tiered support; named TAM for enterprise |
| **Operational** | one ops engineer | small ops team | dedicated SRE | NOC / on-call rotation |

### Mongo bottlenecks
- TrackingEvent inserts are the highest write rate (line-rate from collector). Index on `(merchantId, occurredAt)` covers the hot reads. At 10k merchants × 100 events/day = 1M/day = ~3GB/year — manageable but want partitioning.
- AuditLog writes serialize through the chain-head cache; multi-process correctness depends on the verifier walking by `at+_id` sort, which works regardless. At 10k merchants the chain-head cache contention will dominate; consider per-merchant chains.
- Order partial-unique on (merchantId, externalId) is the throttling index for webhook bursts; fine to ~1B docs.

### Redis bottlenecks
- Single instance is the hardest cliff. The merchant token-bucket Lua script, BullMQ queues, session store, and rate-limit middleware all share it.
- BullMQ alone keeps `removeOnComplete: { count: 1000, age: 24h }` × 17 queues + repeatable jobs. Bounded.

### Worker bottlenecks
- All workers share the API process — a tracking-sync surge will eat CPU from /trpc.
- `webhookProcess` concurrency 8 is the highest; will saturate at ~10k webhooks/sec.

### Queue bottlenecks
- The 30s sweep cadence on `pending-job-replay` is fine until backlog exceeds batch×interval = 50/30s = ~6k/hr. Past that, sweep gets behind.
- `webhook-retry` similar: batch 50 / 60s = ~3k/hr; tune up before 10k-merchant scale.

### Infra bottlenecks
- No CDN config visible for assets (Next.js handles its own _next/static, but custom assets like merchant logos served inline via base64).
- No queue-depth dashboard surfaced; counters exist, but no Grafana / Datadog wiring in repo.

### Support bottlenecks
- Manual payment review is human-in-loop by design. At 1k merchants × 1 receipt/month with 60% manual + 5 min/review = 50 hours/month of finance-admin work. Self-service Stripe Subscription is the funnel-shifter.

---

## 15. Strategic Recommendations

### Immediate priorities (this sprint)
1. **Wire `orderSync.worker.ts` in `apps/api/src/index.ts`** — three lines (`registerOrderSyncWorker(); await scheduleOrderSync();`). This is the single highest-impact fix in the repo. Operational risk today is real and silent.
2. **Implement Shopify GDPR redaction sweep** — the receiver is real; the deletion across `Order`, `TrackingEvent`, `TrackingSession`, `RecoveryTask`, `Notification`, `Payment` is a finite TODO. Required to flip the Shopify app to Public Distribution.
3. **Flip CSP from Report-Only to enforce** — one header rename in `apps/web/next.config.mjs:163`. Watch the report stream for a few prod days first.
4. **Switch deploy build to `build:strict`** — same emit, fails on type errors. The repo claims "0 TS errors" already (`next.config.mjs:181-185`).
5. **Add a CI lint check that every `src/workers/*.ts` has a `register*` call in `src/index.ts`** — would have caught the orderSync gap and the `verify-order` / `subscription-sweep` dead queues.
6. **Garbage-collect `verify-order` and `subscription-sweep` queue names in `QUEUE_NAMES`** if they're truly unused; they're listed in `initQueues` so they create empty Redis keyspace.

### Near-term priorities (next quarter)
1. **Dedicated worker pool** — split workers from the API process; communicate via Redis only.
2. **Redis Sentinel or managed HA** — single-instance is the most explicit SPOF.
3. **Object storage for proof files** — Payment.proofFile.data inline base64 will be the first row to break 16MB Mongo doc limit at scale. Migrate to S3/R2 with signed URLs.
4. **OAuth flow for WooCommerce REST** — Woo's "Auth Endpoint" exists but the connect flow asks merchants to paste keys. Enables one-click Woo connect parity with Shopify.
5. **Stripe Customer Portal deeper integration** — already wired (`createPortalSession` in `lib/stripe.ts`); surface invoices + payment methods + cancellation in a polished `/dashboard/billing` view.
6. **Surface queue-depth + worker-lag metrics on `/admin/system`** — counters exist; ship the visualization.
7. **Sentry breadcrumbs / performance traces** — the lazy custom telemetry shim is good; `@sentry/node` SDK adds observability juice without much weight.
8. **Public Cordon Storefront SDK** — currently `lib/tracking-guard.ts` accepts events; ship the JS SDK as `cordon-track` on a CDN with fingerprint pinning so merchants don't have to hand-roll the integration.

### Long-term moats
1. **Cross-merchant fraud network as a paid tier** — gold-tier feature; merchants get +10% RTO reduction by joining; freezes lock-in.
2. **Adaptive automation policy** — today the merchant chooses manual/semi/full per their automationConfig. Learn the right policy per merchant from outcome data.
3. **AI-assisted call-center scripts** — the call-center surface logs every interaction in `CallLog`. With enough volume, generate dynamic scripts per riskScore + customer_tier.
4. **Bangladesh courier coverage expansion** — `ecourier` and `paperfly` are enum entries with no adapter. Each adapter is ~600 LOC; finishing them widens the moat.
5. **Embedded finance** — merchants accept COD; cash flow is the bottleneck. A receivables-advance product sitting on top of the trusted order ledger is a multiplier.

### Acquisition improvements
- Self-serve trial: works today (signup → trial → integration connect).
- Shopify App Store listing: blocked on GDPR redaction sweep (above).
- Partner program: nothing visible in repo; opportunity for a "Built on Cordon" badge.
- Public ROI calculator: lives on landing — push it to its own URL to share.

### Onboarding improvements
- WooCommerce connect wizard with screenshots of where to find consumer keys (currently a generic form).
- Custom-API setup wizard with a copy-paste curl example.
- Sample data seeder accessible from the dashboard (today, `npm run seed` is CLI-only).
- Test-shipment button per courier so merchants don't have to wait for a real order to verify.

### Observability improvements
- Wire `lib/telemetry.ts` to capture tRPC procedure names + p95 latency.
- Per-tenant queue-depth dashboard.
- Add a "Webhook health" widget per integration — 30-day delivery success rate, average latency from upstream timestamp to ingest.

### Scalability improvements
- Mongo connection pool tuning (currently default).
- Redis pipelining on the merchant-rate-limit Lua.
- Bulk-import worker pagination to avoid loading entire merchant catalogs.

### Monetization improvements
- Pro-rated plan changes.
- Annual billing at 2-month discount (common funnel lever).
- Add-on SKUs: extra fraud-review credits, extra call-minutes, behavior-export bundle.
- Self-serve seat purchase (today seats are derived from the plan; no per-seat add).

---

## 16. Final CTO Verdict

### Is this SaaS architecturally credible?
**Yes.** The architecture has the kind of texture that takes a senior team months of production fire to produce:
- Two-layer dead-letter system (BullMQ retries + PendingJob persistence).
- Permanent webhook idempotency with bounded payload growth.
- Tamper-evident audit log at the model layer, not the application layer.
- Per-tenant fairness via Lua-script token buckets.
- Per-(courier, account) circuit breaker with 5s wall-time ceiling.
- Adaptive risk weights with frozen-snapshot learning.
- Cross-tenant fraud network with explicit privacy posture (hashes, capped merchant lists, single-merchant suppression).
- E.164 phone normalization at the seam with multi-variant lookup for stitching.
- Per-merchant token-pinned behavior collector with HMAC-strict mode.

### Is it production credible?
**Mostly.** It runs in production today by all evidence (commits like `0c006c3 baseline hardening`, `f411043 repo cleanup`, the staging-deploy branch). The production risks are explicit and few:
- Polling fallback offline (orderSync).
- CSP not enforced.
- GDPR redaction stubbed.
- Build tolerates type errors on deploy.
- Single Redis.

None of these are architectural — all are finishable in a sprint or two.

### Is it operationally credible?
**Mostly.** The operator surface is unusually mature for the stage:
- Real RBAC with step-up for critical actions.
- Tamper-evident audit log with chain verification UI.
- Anomaly engine fanning into admin alerts.
- Per-queue counter snapshots.
- Per-merchant rate-limit observability.
- Graceful shutdown.

What's missing is the *external* operations surface: Grafana wiring, on-call runbooks (no `RUNBOOK.md` in the repo), documented incident severity matrix, and the queue-depth dashboard.

### What stage is the company realistically at?
**Late seed / early Series A.** Productized; revenue-capable; design-partner-tested; not yet at scale. The codebase carries deliberate "we shipped this on purpose" markers (every Mongoose model has long doc comments explaining trade-offs; every worker calls out its idempotency contract; the CLAUDE.md files document past gotchas). That's the signature of a small team that has shipped to real merchants, learned from concrete production incidents, and codified the lessons.

### What are the strongest assets?
1. **The fraud + courier intelligence engines** — adaptive, observable, learn from outcomes.
2. **The cross-merchant fraud network** — privacy-preserving, capped linkability, kill-switched.
3. **The audit log** — tamper-evident chain at the Mongoose layer is a feature most enterprises ask for and most early SaaS companies don't ship.
4. **The webhook idempotency + dead-letter durability** — every accepted event is guaranteed eventual delivery, and the constraint on the dedup window is "infinite" by design.
5. **The Bangladesh-native economics** — bKash/Nagad/bank rails as first-class, BDT pricing, district-aware risk signals.

### What are the biggest dangers?
1. **The orderSync polling gap** — silent risk; one merchant who ever loses a Shopify webhook and our reputation is in the inbox before the CS team sees it.
2. **Single Redis** — first hardware-fault impact is total queue stoppage. PendingJob mitigates *write-side* loss; doesn't help workers consume.
3. **Build-tolerance on deploy** — the day a real type error matters in production it's going to be a memorable Saturday.
4. **GDPR redaction** — until the deletion sweep is real, a Shopify Partner-app review will surface this.
5. **No load-test in CI** — scaling test exists but doesn't run as a gate. The first 10k-merchant flash-sale will be a learning experience.

### What should happen next?
**Sprint-1 fix-it list (from §15.1)**:
1. Wire `orderSync` worker — 3 lines.
2. Implement GDPR data redaction sweep — 1 sprint.
3. Flip CSP to enforce — 1 commit + 1 week of monitoring.
4. Switch deploy to `build:strict` — 1 line.
5. CI lint that every worker is registered — 1 day.

After that the strategic move is **dedicated worker process** (separates HTTP latency from queue throughput) and **Redis HA** (bounds the SPOF). Both unlock the 1k-merchant tier without further code change.

Beyond hardening, the **cross-merchant fraud network as a paid tier** is the highest-leverage growth lever. The data exists, the infrastructure is built, the privacy posture is correct — package it as a Growth-tier-and-up feature and the platform compounds.

The team that built this is ready to take a Series A check.

---

**End of audit.**

*Generated by inspecting the actual code paths, models, and worker registrations. All "Uncertain / Gap" claims map to verifiable file:line locations cited inline. The dead-worker call-out (`orderSync.worker.ts`) was verified via Grep across the entire `apps/api/src` tree — no file other than the worker itself references `registerOrderSyncWorker` or `scheduleOrderSync`.*
