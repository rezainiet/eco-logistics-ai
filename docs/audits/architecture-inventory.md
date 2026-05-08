# Architecture Inventory

**Status:** discovery snapshot, 2026-05-08. No implementation, no proposals.
**Source:** direct read of `apps/api/src/`, `apps/web/src/`, `packages/db/src/`. Cross-checked against root `CLAUDE.md`, `apps/api/CLAUDE.md`, `apps/web/CLAUDE.md`. Where possible, runtime claims are anchored to a `path:line` reference.

## 1. Repository shape

Monorepo (npm workspaces) with two apps and four shared packages.

```
ecommerce-logistics/
├── apps/
│   ├── api/   Express + tRPC + BullMQ workers (port 4000)
│   └── web/   Next.js 14 App Router + tRPC client (port 3001)
├── packages/
│   ├── db/        Mongoose models (consumed via @ecom/db)
│   ├── types/     shared TS types + AppRouter re-export
│   ├── config/    shared TS/ESLint config
│   └── branding/  centralized brand tokens
└── docs/
    ├── adr/
    ├── audits/                  (this audit)
    └── shopify-app-distribution.md
```

Build artifacts (`dist/`, `.next/`, `tsconfig.tsbuildinfo`, `apps/web/test-results`, `.claude-staging/`) are gitignored. After clean checkout, `packages/db` and `packages/types` must be built before `apps/web` will resolve `@ecom/db` / `@ecom/types`.

The repo root contains many top-level audit-style markdown files (`MONOREPO_SAAS_MASTER_AUDIT.md`, `RTO_PREVENTION_STRATEGY_MASTERPLAN.md`, etc.). They are pre-existing strategy/planning docs and were NOT used as authoritative input for this audit — runtime claims here come from the code.

## 2. apps/api layout

```
src/
├── index.ts             boot order (DB → queues → workers → schedules → HTTP)
├── env.ts               env validation
├── lib/                 cross-cutting libraries (scoring, couriers, integrations, ...)
│   ├── couriers/        BD courier adapters (Pathao, RedX, Steadfast) + circuit breaker
│   ├── integrations/    commerce-platform adapters (Shopify, Woo, customApi)
│   ├── observability/   structured-log helpers (courier-webhook, fraud-network)
│   ├── sms/             outbound SMS provider (sslwireless) + verify
│   └── gdpr/            redaction
├── middleware/          rateLimit
├── server/
│   ├── routers/         tRPC routers (orders, fraud, analytics, integrations, …)
│   ├── services/intelligence/  RTO Intelligence v1 handlers + helpers
│   ├── webhooks/        Express routers for inbound webhooks (raw-body)
│   ├── tracking/        public tracking collector (storefront SDK)
│   ├── tracking.ts      single chokepoint: applyTrackingEvents + syncOrderTracking
│   ├── ingest.ts        WebhookInbox + ingestNormalizedOrder + replayWebhookInbox
│   ├── courier-replay.ts replay path for courier inbox rows
│   ├── risk.ts          deterministic risk engine (computeRisk, collectRiskHistory)
│   ├── auth.ts          NextAuth-compatible session + REST auth
│   ├── admin.ts         admin REST surface (auditAutomationStateMachine etc.)
│   └── trpc.ts          tRPC + protected procedure
├── workers/             BullMQ workers (one file per queue)
├── scripts/             one-shot CLI tools (seed, listMerchants, verifyFraudFlow…)
└── tests/               vitest, mongodb-memory-server
```

## 3. apps/web layout (intelligence-relevant subset)

```
src/
├── app/
│   ├── dashboard/
│   │   ├── analytics/
│   │   │   ├── page.tsx           mounts <RtoIntelligenceSection />
│   │   │   ├── behavior/page.tsx
│   │   │   └── couriers/page.tsx  trpc.analytics.getCourierPerformance
│   │   ├── fraud-review/page.tsx  trpc.fraud.* queue + actions
│   │   ├── orders/page.tsx        list + tracking drawer
│   │   ├── recovery/page.tsx      RTO recovery tasks
│   │   └── ...
├── components/
│   ├── intelligence/
│   │   └── rto-intelligence-section.tsx  4 cards (intent, address, thanas, campaigns)
│   ├── orders/
│   │   ├── intelligence-panels.tsx       IntentPanel + AddressQualityPanel
│   │   ├── operational-hint-panel.tsx    OperationalHintPanel
│   │   └── tracking-timeline-drawer.tsx  mounts the three above
│   ├── fraud/network-signal.tsx          NetworkSignalPill + Card
│   └── analytics/fraud-section.tsx       trpc.fraud.getReviewStats
└── lib/trpc.ts          tRPC client
```

## 4. Persistence layer (`packages/db/src/models`)

22 Mongoose models. Names that show up in scoring / replay flows:

| Model              | Role in scoring/replay |
|--------------------|------------------------|
| `Order`            | canonical order; carries `fraud.*`, `intent.*`, `address.quality`, `logistics.*`, `automation.*`, `version` (optimistic CC). |
| `WebhookInbox`     | **canonical webhook durability ledger.** State machine `received → processing → succeeded` / `failed` (with backoff) / `needs_attention` / `dead_lettered`. Idempotency: unique `(merchantId, provider, externalId)`. |
| `PendingJob`       | dead-letter store for `safeEnqueue`. Drained by `pending-job-replay` worker. |
| `PendingAwb`       | ledger for in-flight courier AWB bookings. Reconciled by `awb-reconcile` worker. |
| `TrackingEvent`    | append-only behavior events from storefront SDK. |
| `TrackingSession`  | session aggregate (page views, dwell, conversion); resolves to an order via `resolvedOrderId`. |
| `FraudPrediction`  | per-order risk snapshot; outcome stamped on terminal status flip. Feeds the monthly weight tuner. |
| `FraudSignal`      | cross-merchant aggregate keyed by hashed fingerprint (phone/address). |
| `CourierPerformance` | per-(merchantId, courier, district) delivery outcome stats + recent-failure window. |
| `Merchant`         | `couriers[]` config (encrypted secrets), `fraudConfig`, `automationConfig`, `subscription.tier`. |
| `MerchantStats`    | running counters per status. Bumped on `applyTrackingEvents` terminal transitions. |
| `Notification`, `AuditLog`, `CallLog`, `RecoveryTask`, `MerchantFeedback`, etc. — peripheral. |

## 5. Boot order (`apps/api/src/index.ts`)

1. Validate env.
2. `connectDb()` (Mongo).
3. `assertRedisOrExit()` and `initQueues()` (BullMQ + Redis, skipped in dev when `REDIS_URL` unset; required in production).
4. Register every BullMQ worker (16 total — see *Workers wired* in `apps/api/CLAUDE.md` and the [execution flow doc](./execution-flow.md)).
5. Schedule every repeatable: `tracking-sync`, `webhook-retry`, `cart-recovery`, `trial-reminder`, `subscription-grace`, `automation-stale`, `automation-watchdog`, `awb-reconcile`, `fraud-weight-tuning`, `order-sync`, `pending-job-replay`.
6. Mount Express middleware:
   - `helmet`, `cors`.
   - **Raw-body webhook routers BEFORE `express.json`** — courier, SMS inbound/DLR, integrations webhook, Shopify GDPR.
   - `express.json({ limit: "1mb" })`.
   - `/health`, `/auth`, `/admin`, Stripe webhooks (raw inside), Twilio webhooks, Shopify OAuth, tracking collector (`/api/track`).
   - tRPC at the end.
7. `server.listen(API_PORT)`.

Graceful shutdown contract (`shutdown(signal)`): close server → drain workers + queues → close Mongo → exit. 25s watchdog `unref()`'d to bound to Railway's 30s drain window. Idempotent.

## 6. tRPC routers (`apps/api/src/server/routers/`)

Composed in `routers/index.ts` as `appRouter`. The router type is re-exported from `packages/types/src/router.ts` so `apps/web` consumes a single `AppRouter` symbol.

| Router               | Lines | Notes |
|----------------------|-------|-------|
| `orders.ts`          | 3279  | order CRUD, list, getOrder (computes `operationalHint` and `risk` inline), bulk upload preview, listCouriers, network risk lookup. |
| `integrations.ts`    | 2380  | merchant-side commerce platform CRUD + previews. |
| `billing.ts`         | 902   | Stripe billing + plan switching. |
| `fraud.ts`           | 750   | review queue, mark verified/rejected/no_answer, weight tuning admin surface, network risk read. |
| `merchants.ts`       | 720   | merchant settings (couriers, automation, fraud config). |
| `tracking.ts`        | 682   | merchant-facing tracking timeline; admin replay. |
| `adminBilling.ts`    | 682   | platform admin billing. |
| `adminObservability.ts` | 545 | queue counters, anomaly alerts feed. |
| `analytics.ts`       | 368   | dashboard counters + delegates intelligence cards to `services/intelligence/intelligenceHandlers.ts`. |
| `adminAccess.ts`     | 295   | admin RBAC. |
| `recovery.ts`        | 193   | RTO recovery tasks. |
| `callCenter.ts`      | 207   | call center surface. |
| Others (notifications, feedback, adminAudit, adminBranding, adminFraudNetwork, call) | < 200 each |

## 7. Three classes of inbound traffic

1. **Webhook-first ingestion** — commerce platforms (Shopify, Woo, customApi) and couriers (Pathao, RedX, Steadfast). All verify signature on raw body, write a `WebhookInbox` row, return 2xx in <50ms, and enqueue processing on BullMQ. Replay-safe via the inbox unique key. Detail: [execution-flow.md §1](./execution-flow.md).
2. **Polling fallback** — `tracking-sync` worker (every `TRACKING_SYNC_INTERVAL_MIN`) and `order-sync` worker (every 5 min) cover the gap when a webhook is missed or delayed. They funnel through the same chokepoints (`applyTrackingEvents` and `enqueueInboundWebhook`) as the webhook path so duplicates are impossible.
3. **Storefront SDK** — `/api/track/collect` is the public endpoint for the behavior collector. Ships through `tracking-guard` (HMAC, rate limits, validation) into `TrackingEvent` + `TrackingSession`, with identity stitching back to recent orders.

## 8. Engineering invariants observed in code

- **Replay safety / idempotency** — every entry point that mutates state goes through the `WebhookInbox` (or `PendingJob`, or `PendingAwb`) ledger first. Unique indexes enforce the dedup contract; race-safe writes catch E11000 and re-fetch the winner.
- **Tenant isolation** — every webhook handler scopes by the `merchantId` from the URL path, NOT from payload. `replayCourierInbox` re-validates `String(order.merchantId) === String(inbox.merchantId)` before applying. The collector pins each `sessionId` to the first merchant that claims it.
- **Additive architecture** — `intent`, `addressQuality`, `operationalHint` are observation-only outputs that NEVER feed `computeRisk` (intent.ts:17, operational-hints.ts:10). Risk + courier-intelligence write side is best-effort and `void`-able from the caller.
- **Single chokepoints** — `applyTrackingEvents` is the one writer for tracking timeline + order.status transitions, regardless of whether the event came from a webhook or a polling adapter. `ingestNormalizedOrder` is the one writer for new orders (webhook, poll, CSV, dashboard).

## 9. What this inventory deliberately does NOT cover

- ADRs in `docs/adr/` (not read).
- Pre-existing strategy/audit MDs at the repo root (not load-bearing for runtime).
- Marketing surface / landing pages (`(marketing)` route group, `landing.html`).
- Stripe billing internals beyond the fact that they exist.
- Test files (only counted; not analyzed for behavior).
