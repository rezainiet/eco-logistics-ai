# SYSTEM ARCHITECTURE MASTER

Cordon — canonical operational architecture, grounded in real code as of 2026-05-08.
Every claim in this document corresponds to a file under `apps/` or `packages/`.
Aspirational systems are **not** documented here unless explicitly labeled `PLANNED`.

---

## 1. Monorepo shape

```
ecommerce-logistics/
├── apps/
│   ├── api/        Express + tRPC server (port 4000), BullMQ workers, HTTP webhooks
│   └── web/        Next.js 14 App Router (port 3001), NextAuth, tRPC client, Tailwind
├── packages/
│   ├── db/         Mongoose models  → @ecom/db
│   ├── types/      Shared TS types + AppRouter re-export → @ecom/types
│   ├── branding/   Pure branding resolver/types → @ecom/branding
│   └── config/     Shared Tailwind + tsconfig.base
├── scripts/        backup-mongo.sh, e2e-stack.mjs
├── docs/           ADRs, shopify-app-distribution.md
└── docker-compose.yml
```

Workspaces declared in root `package.json` (`workspaces: ["apps/*", "packages/*"]`).
`npm run dev` boots api + web in parallel via `npm-run-all`.

### Package responsibilities (real, not aspirational)

| Package           | Role                                                                                          | Ships to runtime?    |
| ----------------- | --------------------------------------------------------------------------------------------- | -------------------- |
| `@ecom/api`       | The data plane: tRPC + REST + workers. Owns all writes to Mongo + Redis.                       | yes (api server)     |
| `@ecom/web`       | The control plane UI: marketing, auth, dashboard, admin, public tracking page.                 | yes (Next.js server) |
| `@ecom/db`        | Mongoose models + indexes. Exported via compiled `dist/`.                                      | yes (transitive)     |
| `@ecom/types`     | Shared TS types and re-export of `AppRouter` so `apps/web` never imports `apps/api/...` paths. | yes (build-time)     |
| `@ecom/branding`  | Pure branding resolver — defaults, schema, derive, cssVars. No DB calls.                       | yes (api + web)      |
| `@ecom/config`    | Tailwind preset + tsconfig base. Build-time only.                                              | no                   |

Critical seam: **`apps/web` consumes `AppRouter` only through `@ecom/types`**. `packages/types/src/router.ts` re-exports the type so `apps/web` cannot accidentally pull `apps/api` source. (See `apps/api/CLAUDE.md` § Routers.)

---

## 2. Runtime topology

```
                  ┌────────────────────────────────────────────────────┐
                  │                   public internet                  │
                  └────────────────────────────────────────────────────┘
                         │              │              │
                         ▼              ▼              ▼
              ┌──────────────┐ ┌─────────────┐ ┌──────────────┐
              │ apps/web     │ │ apps/api    │ │ webhook   ↑   │
              │ Next.js :3001│ │ Express:4000│ │ ingress      │
              └──────┬───────┘ └─────┬───────┘ └──────┬───────┘
                     │tRPC over HTTP │REST + tRPC      │
                     └────►tRPC ─────┤                 │
                                     ▼                 ▼
                            ┌──────────────────────────────┐
                            │ apps/api (boot order):        │
                            │  1. connectDb (Mongo)         │
                            │  2. assertRedisOrExit         │
                            │  3. seedBranding singleton    │
                            │  4. syncIndexes (background)  │
                            │  5. initQueues                │
                            │  6. register* workers         │
                            │  7. schedule* repeatables     │
                            │  8. app.listen(API_PORT)      │
                            └────────────┬─────────────────┘
                                         │
                  ┌──────────────────────┼──────────────────────┐
                  ▼                      ▼                      ▼
            ┌──────────┐           ┌──────────┐           ┌──────────────┐
            │ MongoDB  │           │  Redis   │           │ external     │
            │ (Atlas)  │           │ (BullMQ +│           │ providers:   │
            │          │           │  rate    │           │ Stripe,      │
            │          │           │  limit)  │           │ Resend,      │
            │          │           │          │           │ SSL Wireless,│
            │          │           │          │           │ Twilio,      │
            │          │           │          │           │ Pathao/RedX/ │
            │          │           │          │           │ Steadfast,   │
            │          │           │          │           │ Sentry       │
            └──────────┘           └──────────┘           └──────────────┘
```

Source of truth: `apps/api/src/index.ts` lines 97–206 (boot order), 299–369 (graceful shutdown).
Both apps share the same Mongo + Redis. Web never talks to Redis directly; it goes through `apps/api` over tRPC.

### Process model

- **api**: single Node process, internally multiplexes Express request handling + 16 BullMQ workers (each its own concurrency).
- **web**: Next.js server (Node runtime); SSR/RSC/route handlers + static asset cache.
- Multi-instance ready: BullMQ workers cooperate via Redis (one job claimed by one instance); repeatable schedules are keyed by `(name, repeat opts)` so duplicate boot calls are no-ops; `pendingJobReplay` claims rows atomically (`findOneAndUpdate` + forward-bump `nextAttemptAt`).

---

## 3. Boundaries: API, frontend, SSR, auth, worker, queue

### 3.1 API server (`apps/api`)

Mount order matters — webhooks must register **before** `express.json` so HMAC verification can sign over raw bytes. Verbatim from `index.ts`:

> *"Courier webhooks must mount BEFORE the global JSON parser so HMAC verification sees the raw, unmutated request body. Per-IP rate limit sits in front so a captured payload cannot be replayed at line speed."*

Mount table (literal, from `index.ts:226–276`):

| Route prefix                       | Auth                | Body parser    | Notes                                    |
| ---------------------------------- | ------------------- | -------------- | ---------------------------------------- |
| `/api/webhooks/courier`            | per-courier HMAC    | raw            | rate-limited via `webhookLimiter`        |
| `/api/webhooks/sms-inbound`        | shared HMAC         | raw            | SSL Wireless inbound                     |
| `/api/webhooks/sms-dlr`            | shared HMAC         | raw            | SSL Wireless DLR                         |
| `/api/integrations/webhook`        | per-provider HMAC   | raw            | Shopify / Woo / custom_api               |
| `/api/webhooks/shopify/gdpr`       | platform HMAC       | raw            | App-Store mandatory privacy webhooks     |
| `/api/webhooks/stripe`             | Stripe sig          | raw (in-route) | placed AFTER `express.json` global       |
| `/api/webhooks/twilio`             | Twilio sig          | mixed          | call/SMS callbacks                       |
| `/auth`                            | none / token        | JSON           | `auth.ts` REST: signup/login/reset/etc.  |
| `/admin`                           | admin token         | JSON           | `admin.ts` REST out-of-band ops          |
| `/api/integrations` (GET)          | OAuth state cookie  | JSON           | Shopify OAuth completion                 |
| `/track` (CORS open)               | merchant trackingKey| JSON           | storefront SDK collector                 |
| `/trpc/*`                          | session JWT         | JSON           | the data plane                           |
| `/health`                          | none                | JSON           | platform healthcheck                     |

**No global IP rate limiter on `/trpc`** — verbatim:

> *"A single merchant pulling 1M orders/day legitimately burns ~12 req/sec from one egress. Fairness and abuse protection come from two layers that DO discriminate by tenant: (1) auth-gated procedures via the per-merchant token bucket in safeEnqueue / mutation paths, and (2) the dedicated login/signup/passwordReset/webhook/publicTracking limiters mounted on their own routes above."*

### 3.2 tRPC composition (`apps/api/src/server/trpc.ts` + `routers/index.ts`)

`appRouter` is composed of these mounted routers (from `routers/index.ts`):

```
merchants       analytics            adminAccess
orders          billing              adminAudit
fraud           call                 adminBilling
integrations    callCenter           adminBranding
tracking        feedback             adminFraudNetwork
recovery        notifications        adminObservability
```

Procedure tiers (from `trpc.ts`):
- `publicProcedure` — no session.
- `merchantProcedure` — requires session JWT; resolves merchant from token; rejects suspended/cancelled (subscription-gated procedures live separately).
- `billableProcedure` — merchantProcedure + plan/quota gate (`reserveQuota`).
- `adminProcedure` — `role === "admin"`; reads `adminScopes` for fine-grained gates.
- `scopedAdminProcedure(...scopes)` — RBAC: super_admin / finance_admin / support_admin (additive; super_admin implies all).

CSRF: double-submit (header + cookie), enforced inside the procedure builder.
Step-up: short-lived token (5-min TTL, single-use, permission-scoped) gated by `lib/admin-stepup.ts` for high-blast-radius admin actions.

### 3.3 Frontend boundaries (`apps/web`)

Three route classes, intentional bundle separation (`apps/web/CLAUDE.md`):

- **`(marketing)`** — public landing. **Ships zero auth/tRPC weight.** No `<Providers>` wrap.
- **`(auth)`** — `/login`, `/signup`. `<Providers>` (SessionProvider + tRPC + QueryClient). Authenticated sessions redirect to `/dashboard`.
- **Top-level routes** — `/forgot-password`, `/reset-password`, `/verify-email`, `/payment-success`, `/payment-failed`, `/track/[code]`, `/legal/*`. Each ships its own layout under `CordonAuthShell`. **Do NOT redirect authenticated users.**

Hydration trap, verbatim:
> *"any component that calls `useSession()`, `trpc.x.useQuery()`, or `useQueryClient()` must live under a `<Providers>` ancestor."*

NextAuth config: JWT session strategy with CredentialsProvider; custom `/login` page; the session callback refreshes the access token by calling `apps/api`'s `/auth/refresh` on 401 (`SESSION_UNAUTHORIZED_EVENT`). See `apps/web/src/app/api/auth/[...nextauth]/route.ts`.

Middleware (`apps/web/src/middleware.ts`):
- Authenticated → push out of `/login`, `/signup`.
- Unauthenticated → push into `/login` for `/dashboard/**`.
- Admin gating happens server-side at the `apps/api` layer (no client-side admin gate).

### 3.4 Auth flow

```
signup ─► Merchant.create ─► email verify token ─► /verify-email ─► emailVerified=true
                                              │
login ─► /auth/login (REST) ─► JWT ─────────► NextAuth session
                                              │
mutation ─► merchantProcedure middleware ─► token verified ─► merchant resolved
                                              │
401 ─► SESSION_UNAUTHORIZED_EVENT ─► silent /auth/refresh ─► retry
```

Sessions are stored in Mongo (`lib/sessionStore.ts`) so logout-all and password-reset can revoke per-device + all-devices.

Admin step-up: `lib/admin-stepup.ts` mints 32-byte single-use tokens with 5-minute TTL, permission-scoped to a specific action. Required by `scopedAdminProcedure`'s most destructive paths (e.g. payment approval, plan change).

### 3.5 Worker boundaries

Every BullMQ worker file in `apps/api/src/workers/`:
1. Defines its queue name in `lib/queue.ts` `QUEUE_NAMES` (one source of truth).
2. Exports `register<Name>Worker()` calling `registerWorker(QUEUE_NAMES.<name>, processor, opts)`.
3. If repeatable, exports `schedule<Name>(intervalMs?)` calling `getQueue(...).add(...)`.
4. Is wired in `apps/api/src/index.ts`.

A worker file in `src/workers/` with no `register*` call in `index.ts` is **dead code in production** (`apps/api/CLAUDE.md` § Worker registration).

---

## 4. Queue topology (real)

Queue names are exported as a const object — verbatim from `lib/queue.ts`:

| Symbol                          | Queue name (Redis key)         | Domain                                       |
| ------------------------------- | ------------------------------ | -------------------------------------------- |
| `tracking`                      | `tracking-sync`                | poll couriers for shipment status            |
| `risk`                          | `risk-recompute`               | rescore Order.fraud after outcome events     |
| `fraudWeightTuning`             | `fraud-weight-tuning`          | monthly per-merchant signal weight tuning   |
| `webhookProcess`                | `webhook-process`              | event-driven inbox replay                    |
| `webhookRetry`                  | `webhook-retry`                | sweep of failed inbox rows                   |
| `commerceImport`                | `commerce-import`              | one-shot pull of N orders from connector     |
| `cartRecovery`                  | `cart-recovery`                | identify abandoned carts → notify merchant   |
| `trialReminder`                 | `trial-reminder`               | one-shot trial-ending email                  |
| `subscriptionGrace`             | `subscription-grace`           | flip past_due → suspended after grace        |
| `automationBook`                | `automation-book`              | auto-book courier; fallback chain            |
| `automationWatchdog`            | `automation-watchdog`          | watchdog over auto-book exhaustion           |
| `automationSms`                 | `automation-sms`               | reliable outbound confirmation SMS           |
| `automationStale`               | `automation-stale`             | escalate / cancel stale pending_confirmation |
| `awbReconcile`                  | `awb-reconcile`                | reconcile pending-AWB ledger after stale lock|
| `orderSync`                     | `order-sync`                   | polling fallback for upstream order ingest   |
| `pendingJobReplay`              | `pending-job-replay`           | DLQ replay sweeper for `safeEnqueue`         |

Default job options (every queue): `attempts: 3`, exponential backoff 5s start, `removeOnComplete: { count: 1000, age: 24h }`, `removeOnFail: { count: 5000, age: 7d }`. Per-worker overrides in their files.

`safeEnqueue` is the canonical enqueue path:
1. Per-merchant token bucket (`lib/merchantRateLimit.ts`) — fairness across tenants.
2. Up to 3 in-process Redis retries (50ms, 200ms, 500ms backoff).
3. On persistent Redis failure, persist `(queueName, jobName, data, opts, ctx)` to `PendingJob` (Mongo). Caller sees `{ ok: true, deadLettered: true, pendingJobId }`.
4. `pendingJobReplay` worker drains `PendingJob` rows back onto BullMQ once Redis is healthy.

The discriminated union return type is the contract — verbatim from `queue.ts:285–288`:

```
SafeEnqueueResult =
  | { ok: true; jobId?: string; recovered?: boolean }
  | { ok: true; deadLettered: true; pendingJobId: string }
  | { ok: false; error: string; originalError?: string }
```

The `ok: false` branch requires **both Redis AND Mongo** to be unreachable. That is the one path that genuinely loses work.

---

## 5. Data plane: Mongo

Connection: `lib/db.ts` (autoIndex OFF in prod, autoCreate OFF). Index sync runs at boot in the background (`index.ts:131–153`) — port-bind happens immediately, index builds proceed in parallel so the Railway healthcheck never blocks on a long index build.

Models live under `packages/db/src/models/`. Full inventory in `DATABASE_SCHEMA_MASTER.md`. Cardinality of operational interest:

- **High-write**: `Order` (every customer order), `TrackingEvent` (every storefront pixel hit).
- **High-read, high-fan-out**: `Merchant`, `Integration`, `BrandingConfig`.
- **Append-only ledger**: `AuditLog` (tamper-evident SHA-256 chain).
- **TTL-managed**: `FraudPrediction` (400d), inbox payload reaped on `WebhookInbox` (90d).
- **Idempotency**: `WebhookInbox`, `Order.source.externalId` partial-unique, `BulkUploadBatch.externalBatchId`, `Payment.providerEventId/invoiceId`.
- **Dead-letter**: `PendingJob`, `PendingAwb`, `WebhookInbox(status: needs_attention)`.

---

## 6. Operational dependencies

Critical externals (without which the api refuses to boot or core flows fail):

| Dependency       | Used by                                                       | Failure mode                                                                                |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| MongoDB          | every model write/read                                        | api refuses to boot (`connectDb` throws); `safeEnqueue` falls through to `ok: false`        |
| Redis            | BullMQ + per-merchant rate limit + step-up                    | api boots in dev with warning; in prod `assertRedisOrExit` — workers don't register         |
| Resend           | trial reminders, payment receipts, password reset             | dev: stdout; prod: silent no-op + warn (never fails order creation)                          |
| SSL Wireless SMS | order confirmation SMS                                        | dev: stdout; prod: silent no-op + warn                                                       |
| Twilio           | call-center voice + recording, optional callback SMS          | endpoints 503; CallLog rows still written                                                   |
| Stripe           | card subscriptions, billing portal                            | manual-payment rails (bKash/Nagad/bank) remain the BD primary path                          |
| Sentry           | telemetry                                                     | fire-and-forget; never breaks request paths                                                  |
| Pathao/RedX/etc  | per-courier booking + tracking                                | circuit breaker (lib/couriers/circuit-breaker.ts) trips at threshold; selection engine routes to next-best courier|

Internal critical seams (cannot fail without merchant-visible impact):

- `index.ts` → workers wire-up → if a worker file isn't registered, "it is dead in production no matter how many tests cover it."
- `lib/queue.ts` `QUEUE_NAMES` → the *only* source of truth for queue name strings. Hardcoding strings elsewhere is a bug.
- `lib/orderConcurrency.ts` `version` field (CAS) — every Order mutation routes through `updateOrderWithVersion` / `runWithOptimisticRetry`. Bypassing it can stale-overwrite booking lock vs fraud worker, restore vs riskRecompute, etc.
- `lib/branding-store.ts` singleton row (`key:"saas"`) is seeded at boot; missing row falls back to defaults but admin Branding Panel needs the row to update.

---

## 7. Diagrammatic overview (text)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              MERCHANT JOURNEY                                │
│                                                                              │
│  signup (apps/web /(auth)) ─► /auth/signup ─► Merchant created ─►            │
│  email verify ─► /dashboard/getting-started ─► onboarding state machine:     │
│       1 connect store  2 import orders  3 add courier                        │
│       4 enable automation  5 test SMS                                        │
│                                                                              │
│  storefront install ─► JS SDK ─► /track collector ─► TrackingEvent +         │
│       TrackingSession (rollup)                                               │
│                                                                              │
│  webhook lands ─► /api/integrations/webhook/{provider} ─► HMAC verify ─►     │
│       WebhookInbox row ─► safeEnqueue(webhookProcess) ─► replay ─►           │
│       ingestNormalizedOrder ─► computeRisk ─► Order.create ─►                │
│       FraudPrediction.create ─► identityResolution ─► scoreIntentForOrder    │
│                                                                              │
│  Order ─► automation engine ─► auto_confirmed | pending_confirmation ─►      │
│       automationSms (reliable outbound) ─► automationStale (24h/72h escalate)│
│       auto_confirmed + autoBookEnabled ─► automationBook ─► PendingAwb       │
│       row ─► courier API ─► Order.logistics.{trackingNumber, shippedAt}      │
│                                                                              │
│  trackingSync (cron) ─► poll couriers ─► trackingEvents.push ─►              │
│       on RTO/cancelled: enqueueRescore ─► riskRecompute ─►                   │
│       fan-out fraud rescore on phone cohort                                  │
│                                                                              │
│  outcome ─► FraudPrediction.outcome stamped ─► (monthly) fraudWeightTuning  │
│       ─► Merchant.fraudConfig.signalWeightOverrides updated                  │
│                                                                              │
│  reject (merchant or system) ─► buildPreActionSnapshot ─►                    │
│       Order.preActionSnapshot ─► restore reverses fraud + automation +       │
│       status atomically                                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. What this architecture enables (and what it doesn't)

What it enables today:
- Multi-tenant Order ingest with idempotency on every plausible re-delivery surface.
- Cross-merchant fraud signal aggregation with privacy-preserving hashes only.
- Hot-path explainability: every fraud signal is a `(key, weight, detail)` tuple, not an opaque ML score.
- Auto-book + fallback-chain courier selection with per-merchant historical evidence.
- Graceful degradation: Redis flap → dead-letter → replay; Resend down → email skipped, order still created.
- Tamper-evident audit log (every admin and system action chained by SHA-256).

What it does **not** do today (status, NOT roadmap fantasy):
- Intent score does **not** feed `computeRisk` — observation-only in v1 (`lib/intent.ts:16–17`).
- Address quality does **not** block ingest — observation-only by design.
- Operational hints do **not** dispatch agents or auto-reschedule — visibility only (`lib/operational-hints.ts:6–10`).
- Thana lexicon is a v1 seed; not full BD coverage.
- Admin web UI cannot grant share permissions for documents (architectural prohibition is a Cordon-mode constraint, not a product requirement).

These are explicitly labeled in `FRAUD_AND_INTELLIGENCE_ENGINE_MASTER.md` and `FUTURE_EVOLUTION_GUIDE.md`.

---

## 9. Pointers

- Workers operational reference → `QUEUE_AND_WORKER_MASTER.md`
- Models → `DATABASE_SCHEMA_MASTER.md`
- Features end-to-end → `FEATURE_LOGIC_MASTER.md`
- User journeys → `USER_FLOW_MASTER.md`
- Integrations → `INTEGRATION_ARCHITECTURE_MASTER.md`
- Fraud/intelligence → `FRAUD_AND_INTELLIGENCE_ENGINE_MASTER.md`
- Runtime/infra/env/deploy → `OPERATIONAL_RUNTIME_MASTER.md`
- Risk + dependency graph → `DEPENDENCY_AND_RISK_MAP.md`
- Safe extension points → `FUTURE_EVOLUTION_GUIDE.md`
- Top-level synthesis → `CANONICAL_PRODUCT_INTELLIGENCE_SUMMARY.md`
