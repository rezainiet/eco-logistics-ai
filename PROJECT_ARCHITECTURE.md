# PROJECT_ARCHITECTURE.md

**Project:** Cordon — order operations OS for COD-heavy commerce
**Stack:** Next.js 14 (App Router) · Express · tRPC · Mongoose · BullMQ · Redis
**Audience:** engineers, future team members, technical operators,
investors with technical literacy.

This document is a single point of entry into the platform's architecture.
It is **descriptive** — every claim is backed by a `path:line` reference
to source. For deeper diving:

- `MONOREPO_SAAS_MASTER_AUDIT.md` — comprehensive audit (the most detailed
  reference for any subsystem).
- `RTO_PREVENTION_STRATEGY_MASTERPLAN.md` — product strategy and Bangladesh-
  market context.
- `OPERATIONAL_PLAYBOOKS.md` — incident runbooks.
- `DESIGN_PARTNER_READINESS_CHECKLIST.md` — current launch readiness
  posture per dimension.

---

## 1. Core architecture

### 1.1 Monorepo layout

```
ecommerce-logistics/
├── apps/
│   ├── web/        Next.js 14 App Router (port 3001)   @ecom/web
│   └── api/        Express + tRPC + BullMQ (port 4000) @ecom/api
├── packages/
│   ├── db/         Mongoose models (built to dist/)    @ecom/db
│   ├── types/      Shared TS + tRPC AppRouter re-exp.  @ecom/types
│   └── config/     Shared TS / Tailwind base config    @ecom/config
├── docker-compose.yml   Local Mongo + Redis containers
└── docs/                Public-facing documentation (Shopify dist, etc.)
```

`@ecom/db` and `@ecom/types` are **built packages** — `apps/web` and
`apps/api` consume the compiled `dist/` output. After a clean checkout,
build them once before booting either app:

```bash
npm --workspace packages/db run build
npm --workspace packages/types run build
```

`apps/web/next.config.mjs:179` declares `transpilePackages: ["@ecom/types", "@ecom/db"]`
plus a webpack `extensionAlias` (`.js → .ts/.tsx/.js`) so the web
client can consume the API's NodeNext ESM imports without a
separate compile step.

### 1.2 Runtime separation

- **Web** is presentation only. Every data write is a tRPC mutation
  against the API.
- **API** owns: Mongo connection, Redis connection, queue lifecycle, all
  16 BullMQ workers, all webhook receivers, Stripe + courier + SMS
  integration code, audit log.
- **Auth seam:** NextAuth lives on `web` for session glue; the canonical
  session ledger lives in the API's Redis store
  (`apps/api/src/lib/sessionStore.ts`). NextAuth is the cookie-handling
  layer; the JWT `sid` claim is checked against Redis on every protected
  procedure (`apps/api/src/server/trpc.ts:212-222`).

### 1.3 Type-sharing strategy

The API's tRPC `appRouter` is re-exported through
`packages/types/src/router.ts` so `apps/web` consumes a single
`AppRouter` symbol via `@ecom/types`. **The web app never imports
`apps/api/...` directly** — that seam is enforced by convention.

---

## 2. Operational flow lifecycles

### 2.1 Order ingestion lifecycle

```
                     ┌────────────────────────┐
                     │  Storefront SDK        │
                     │  (window.cordon.track) │
                     └───────────┬────────────┘
                                 │ POST /track (batched events)
                                 ▼
                ┌────────────────────────────────────┐
                │  collector hardening               │
                │   (lib/tracking-guard.ts)          │
                │   rate limit + HMAC + dedupe       │
                └───────────┬────────────────────────┘
                            │
                            ▼
                ┌──────────────────┐  ┌──────────────────┐
                │  TrackingEvent   │  │  TrackingSession │
                │  (raw events)    │→ │  (rollup)        │
                └──────────────────┘  └──────────────────┘

                     ┌─────────────────────────┐
   Order placed →    │  Webhook (Shopify/Woo)  │ ← OR API/dashboard/CSV
                     └───────────┬─────────────┘
                                 │ POST /api/integrations/webhook/:provider/:integrationId
                                 ▼
   ┌────────────────────────────────────────────────────────┐
   │  webhook receiver (server/webhooks/integrations.ts)    │
   │   1. raw-body HMAC verify                              │
   │   2. freshness gate (5min window, 1min skew)           │
   │   3. WebhookInbox upsert ─ permanent dedup key         │
   │   4. ACK 202 in <50ms (logged: evt: webhook.acked)     │
   └───────────────────┬────────────────────────────────────┘
                       │ safeEnqueue
                       ▼
                ┌──────────────────────────┐
                │  webhook-process worker  │  concurrency=8
                └───────────┬──────────────┘
                            │ replayWebhookInbox → adapter.normalize → ingest
                            ▼
   ┌────────────────────────────────────────────────────────┐
   │  ingestNormalizedOrder (server/ingest.ts)              │
   │   - phone E.164 canonicalization                       │
   │   - quota reservation                                  │
   │   - merchantValueRollup (cached) → adaptive thresholds │
   │   - computeRisk → fraud subdoc                         │
   │   - addressIntelligence (sync, pure-fn)                │
   │   - thana extraction (sync, lexicon-based)             │
   │   - Order.create (race-safe via partial-unique index)  │
   │   - FraudPrediction snapshot (frozen weights)          │
   │   - resolveIdentityForOrder (stitch sessions)          │
   │   - scoreIntentForOrder (chained, fire-and-forget)     │
   └────────────────────────────────────────────────────────┘
```

**Key idempotency keys (all permanent, no TTL):**

- `WebhookInbox.(merchantId, provider, externalId)` — receiver dedup
- `Order.(merchantId, source.externalId)` — order-create defense in depth
- `Order.(merchantId, source.clientRequestId)` — dashboard double-click
- `Payment.providerEventId` — Stripe webhook event dedup

### 2.2 Webhook replay lifecycle

Two-tier dead-letter system:

1. **BullMQ retry** — transient worker errors retried 3× with exponential
   backoff, configured per queue.
2. **`PendingJob` Mongo dead-letter** — when `safeEnqueue` cannot land a
   job on Redis after 3 retries (50/200/500ms), the job description is
   persisted to a Mongo collection. The `pending-job-replay` worker
   sweeps every 30s and re-attempts up to 5 times with backoff
   (1m / 5m / 15m / 1h / 4h). Status flips to `exhausted` after the cap
   with a critical merchant alert.

```
   safeEnqueue
      │
      ├─ try BullMQ.add (Redis healthy) → success
      │
      └─ Redis flapping
         ├─ 3 in-process retries (50/200/500ms)
         │
         ├─ all retries succeed → return {ok:true, recovered:true}
         │
         └─ all retries fail
            ├─ persist to PendingJob (Mongo)
            │  → return {ok:true, deadLettered:true, pendingJobId}
            │  → fire merchant Notification (rate-limited per hour)
            │
            └─ Mongo also down
               → return {ok:false}  ◄─── only path where work is actually lost
```

The `webhook-retry` worker (every 60s) ALSO sweeps `WebhookInbox` rows
with `status: "received"` older than 5 minutes — this catches orphans
from a worker process that died mid-pickup.

### 2.3 Integration sync lifecycle

For Shopify / WooCommerce / custom-API integrations:

- **Push (real-time)** — webhooks fire on every order create / update.
  This is the primary path.
- **Polling fallback** — `orderSync.worker.ts` exists to sweep every 5
  minutes and pull new orders since `Integration.lastSyncedAt` via
  adapter. **Currently NOT registered** in `apps/api/src/index.ts` (master
  audit §2). Pre-launch must-do.
- **Manual import** — dashboard "Import recent orders" button enqueues a
  `commerce-import` worker job; one-shot pull bounded at 50 orders.
- **OAuth completion** — Shopify's install URL leads to
  `/api/integrations/oauth/shopify/callback`. The callback handler does
  HMAC verification, token exchange, scope-subset detection, smoke-test
  shop info fetch, and auto-registers webhooks
  (`apps/api/src/server/webhooks/integrations.ts:357-731`).

### 2.4 Fraud scoring lifecycle

Pure deterministic engine in `apps/api/src/server/risk.ts`:

- Inputs: order draft + merchant config + history aggregates +
  cross-merchant network lookup.
- Output: 0-100 score, signal contributions with `key/weight/detail`,
  level (low/medium/high), reviewStatus, customerTier (new/silver/gold),
  P(RTO) calibrated to merchant base rate.
- **Frozen-weights snapshot** persisted to `FraudPrediction` per order.
  The monthly tuner (`apps/api/src/workers/fraudWeightTuning.ts`) reads
  the labeled outcomes and rewrites per-merchant `signalWeightOverrides`.

**v2.0 weight set** (`apps/api/src/server/risk.ts:33-60`):

- highCod 18, extremeCod 40, duplicatePhone 10/25,
- priorReturns 22, priorCancelled 14, suspiciousDistrict 16,
- fakeNamePattern 25, unreachableHistory 20, ipVelocity 16,
- duplicateAddress 22, velocityBreach 75 (single-occurrence HIGH),
- garbagePhone 30, blockedPhone 100, blockedAddress 100.

Time-decayed history: every contributing past order weighted by
`exp(-ageDays / halfLife)`. Default half-life 30 days, configurable per
merchant.

### 2.5 Intelligence pipeline (observation-only)

```
   Order ingested
      │
      ├─ resolveIdentityForOrder
      │  → matches anonymous TrackingSession rows by phone variants + email
      │  → sets TrackingSession.resolvedOrderId (30-day window)
      │
      ├─ scoreIntentForOrder (chained, fire-and-forget)
      │  → reads stitched sessions
      │  → computeIntentScore (pure function in lib/intent.ts)
      │  → writes Order.intent.{score, tier, signals[], sessionsConsidered}
      │  → emits evt: "intent.scored" structured log
      │
      └─ Address Intelligence (synchronous, pure-fn)
         → computeAddressQuality(address, district)
         → extractThana(address, district)
         → writes Order.address.quality + Order.customer.thana at create
         → emits evt: "address.scored" structured log
```

**Observation-only contract:** intent / address-quality NEVER feed
`computeRisk` decisions in v1. Surfaced to merchants via the order
detail drawer panels and the `/dashboard/analytics` Intelligence
section. Two kill-switches gate stamping:

- `INTENT_SCORING_ENABLED=0` halts new intent stamps
- `ADDRESS_QUALITY_ENABLED=0` halts new address-quality stamps

### 2.6 NDR-preparation lifecycle (visibility only)

The operational hint classifier (`apps/api/src/lib/operational-hints.ts`)
runs as a pure function over `Order.{order.status, address.quality,
fraud.reviewStatus, automation.*, logistics.*, trackingEvents}` and
returns one of 8 stable codes:

- `address_clarification_needed`
- `customer_unreachable_pending_call`
- `delivery_failed_attempt`
- `delivery_attempt_in_progress`
- `stuck_in_transit`
- `stuck_pending_pickup`
- `awaiting_customer_confirmation`
- `confirmation_sms_undelivered`

Surfaced in `orders.getOrder` as the `operationalHint` field. **No
automated NDR engagement** — the merchant decides what to do. The
detection layer is the platform's recovery feature; engagement
automation (WhatsApp / IVR / agent escalation) is a future milestone.

---

## 3. Queue / worker architecture

Single Redis connection; one BullMQ Queue per logical concern; lazy
instantiation. Source of truth: `apps/api/src/lib/queue.ts` `QUEUE_NAMES`.

| Queue | Worker | Concurrency | Cadence | Responsibility | Retry / DLQ |
|---|---|---:|---|---|---|
| `webhook-process` | `webhookProcess.ts` | 8 | event-driven | First-delivery webhook ingest (passes inboxId to `replayWebhookInbox`) | Job retries=1; row owns its own backoff via `nextRetryAt` |
| `webhook-retry` | `webhookRetry.ts` | 1 | every 60s | Failed-row replay sweep + `received` orphan sweep + payload reaper | 5 attempts in inbox state machine; row → `dead_lettered` after cap |
| `automation-book` | `automationBook.ts` | 4 | event-driven | Auto-book chosen courier + 3-courier fallback chain | 3 attempts × exponential 30s; `attemptedCouriers[]` capped at 3 |
| `automation-sms` | `automationSms.ts` | 4 | event-driven | Confirmation SMS dispatch (DLR-tracked) | 5 attempts × exponential 15s; idempotent via deterministic jobId |
| `automation-stale` | `automationStale.ts` | 4 | hourly | Pending_confirmation escalation: 24h → call queue, 72h → cancel | Idempotent via state guard |
| `automation-watchdog` | `automationWatchdog.ts` | 4 | every 5 min | Recover orders that auto-confirmed but never got to auto-book | Re-enqueues stuck orders |
| `tracking-sync` | `trackingSync.ts` | 1 | hourly (env-configurable) | Pull courier tracking status for active shipments | Per-courier circuit-breaker wraps the call |
| `risk-recompute` | `riskRecompute.ts` | 4 | event-driven | Fan-out rescore on RTO/no-answer events for related orders | At-most-once via order version CAS |
| `cart-recovery` | `cartRecovery.ts` | 4 | every 5 min | Identify abandoned-cart sessions; create `RecoveryTask` | Idempotent via `(merchantId, sessionId)` unique |
| `commerce-import` | `commerceImport.ts` | 4 | event-driven | One-shot "import recent orders" from a connected integration | At-most-once via `ImportJob` state machine |
| `awb-reconcile` | `awbReconcile.ts` | 4 | every 60s | Break stale booking locks past 90s (process-crash recovery) | Bounded probe attempts |
| `subscription-grace` | `subscriptionGrace.ts` | 4 | hourly | Flip past-due → suspended after grace expires | Idempotent via state guard |
| `trial-reminder` | `trialReminder.ts` | 4 | every 6h | One-shot trial-ending email; stamps `notificationsSent.trialEndingAt` | At-most-once via stamp guard |
| `fraud-weight-tuning` | `fraudWeightTuning.ts` | 1 | monthly cron | Per-merchant weight calibration from `FraudPrediction` outcomes | Read-only retry-safe |
| `pending-job-replay` | `pendingJobReplay.ts` | 1 | every 30s | Sweeper for `PendingJob` dead-letter | 5 attempts × backoff (1m/5m/15m/1h/4h); `exhausted` terminal |
| `order-sync` | `orderSync.worker.ts` | 1 | every 5 min | **Polling fallback** — pull missed orders via adapter | **Currently unregistered** — see §6 gap |

Each new enqueue MUST go through `safeEnqueue` (not raw `queue.add`) so
the per-merchant token bucket fairness + dead-letter durability
contract is honored.

---

## 4. Data models — WHY they exist

### 4.1 `Order` (`packages/db/src/models/order.ts`)

The central document. Subdocs are the architectural seams between
concerns:

- **`order.{cod, total, status}`** — the merchant's commercial line item.
- **`customer.{name, phone, address, district, thana}`** — buyer identity.
  `phone` is canonicalized to E.164 at every ingest seam. `thana` is the
  Bangladesh-specific delivery-zone field added in Milestone 1.
- **`logistics.{courier, trackingNumber, trackingEvents[], shippedAt,
  deliveredAt, returnedAt, bookingInFlight, bookingAttempt}`** — courier
  state. The booking lock prevents concurrent AWB creation.
- **`fraud.{score, level, signals[], reviewStatus, ...}`** — risk
  decisions. Indexed for the fraud-review queue.
- **`automation.{state, confirmationCode, selectedCourier,
  attemptedCouriers[], ...}`** — automation-engine state machine.
  `preRejectState` snapshots are taken so `restoreOrder` is reversible.
- **`source.{ip, userAgent, channel, externalId, sourceProvider,
  integrationId, customerEmail, addressHash}`** — provenance + idempotency.
- **`intent.{score, tier, signals[], sessionsConsidered}`** — Intent
  Intelligence v1 (observation-only).
- **`address.quality.{score, completeness, landmarks[], hasNumber,
  scriptMix, missingHints[]}`** — Address Intelligence v1 (observation-only).
- **`version`** — explicit optimistic-concurrency counter (Mongoose's
  `__v` is silently ignored by `findOneAndUpdate`; the explicit counter
  closes the gap).

Indexes follow the **ESR rule** (Equality, Sort, Range). The primary
listing index is `(merchantId, order.status, createdAt:-1)` — replaces
an older index whose prefix forced an in-memory status filter.

### 4.2 `Merchant` (`packages/db/src/models/merchant.ts`)

The tenant root. Holds:
- credentials (bcrypt password, single-use email-verify + reset tokens)
- `subscription.{tier, status, trialEndsAt, currentPeriodEnd, gracePeriodEndsAt, billingProvider, ...}`
- `couriers[]` — encrypted per-merchant courier configs
- `fraudConfig.*` — per-merchant tunables (suspiciousDistricts, blockedPhones, signalWeightOverrides, baseRtoRate, weightsVersion)
- `automationConfig.{enabled, mode, maxRiskForAutoConfirm, autoBookEnabled, autoBookCourier}`
- `branding.{displayName, logoUrl, primaryColor, ...}` for the public tracking page
- `adminScopes[]` (RBAC) and `adminAlertPrefs.*`
- `trackingKey` (public SDK identifier) and `trackingSecret` (HMAC for collector)

### 4.3 `WebhookInbox` (`packages/db/src/models/webhookInbox.ts`)

The exactly-once webhook ledger.

**Why it exists:** every webhook receiver stamps a row with
`(merchantId, provider, externalId)` BEFORE processing. The unique index
makes duplicate deliveries no-ops. **The dedup key has no TTL** — a
Shopify event delivered a year later still resolves to "duplicate" and
short-circuits.

Storage is bounded by reaping the **payload**, not the row, at 90 days.
The slim row (~200 bytes) is enough to dedup a future delivery and
echo the resolved order id.

### 4.4 `FraudPrediction` (`packages/db/src/models/fraudPrediction.ts`)

The per-order frozen-prediction ledger. **Why a separate collection:**
- Order writes stay narrow on the hot path.
- The prediction snapshot is **immutable** — once we wrote "we
  predicted X with weights v2.0", we don't want a future schema change
  to silently rewrite history.
- The TTL (400 days) lapses independently of Order so the tuner gets
  13 months of history × every active merchant.

`outcome` is stamped when the tracking pipeline lands a terminal status.
The tuner reads `outcome` × `signals[].key` × `levelPredicted` to
compute per-signal lift per merchant.

### 4.5 `TrackingSession` (`packages/db/src/models/trackingSession.ts`)

Aggregated rollup of a buyer's behavioral session — the join target for
intent intelligence.

**Why it exists:** raw `TrackingEvent` rows are append-only. Sessions
let us answer "did this buyer return three times before placing this
order?" in O(1) instead of scanning events.

- `(merchantId, sessionId)` unique
- `resolvedOrderId` — set by `resolveIdentityForOrder` when a session
  matches a buyer's phone/email post-checkout. Indexed partial-sparse
  for the intent-scoring lookup.

### 4.6 `CourierPerformance` (`packages/db/src/models/courierPerformance.ts`)

Per `(merchantId, courier, district)` outcome bucket. **Why it exists:**
courier behaviour varies wildly across merchants — same courier can
deliver 95% for one merchant and 70% for another. Cross-merchant
benchmarking would average the variance away. We score each courier
**on each merchant's own history** (with `_GLOBAL_` district fallback
for sparse cells).

### 4.7 `MerchantFeedback` (`packages/db/src/models/merchantFeedback.ts`)

Lightweight design-partner-phase feedback ledger. **Why it exists:**
direct merchant→ops feedback channel without building a CRM. One row
per "send feedback" submission; admin-side triage flips status through
new → triaged → resolved/dismissed.

### 4.8 `PendingJob` (`packages/db/src/models/pendingJob.ts`)

Mongo-backed dead-letter for `safeEnqueue` when Redis is unreachable.

**Why it exists:** without it, the `void safeEnqueue(...)` call sites
silently lose work on Redis flakiness. The PendingJob row is the
durable receipt — the sweeper drains it within minutes of recovery.

### 4.9 `AuditLog` (`packages/db/src/models/auditLog.ts`)

Append-only with `selfHash` + `prevHash` chain.

**Why it exists:** every state-changing decision (review verified,
order ingested, payment approved, admin role granted, …) gets a row.
Mongoose immutability hooks throw on update / delete. The hash chain
makes ex-post tampering visible — `verifyAuditChain` walks forward and
surfaces the first break.

---

## 5. Operational guarantees

### 5.1 Idempotency

| Boundary | Mechanism |
|---|---|
| Inbound webhook | `WebhookInbox.(merchantId, provider, externalId)` unique, **permanent** |
| Order create from webhook | `Order.(merchantId, source.externalId)` partial-unique |
| Order create from dashboard / API | `Order.(merchantId, source.clientRequestId)` partial-unique |
| Stripe webhook | `Payment.providerEventId` unique |
| Fraud prediction (one row per order) | `FraudPrediction.orderId` unique |
| Cross-merchant signal | `FraudSignal.(phoneHash, addressHash)` unique |
| `MerchantFeedback` | none — duplicates allowed; merchant may submit twice |

### 5.2 Replay durability

- `safeEnqueue` returns `{ok:true}` on every accepted event, even if it
  had to dead-letter to Mongo.
- The only `{ok:false}` path requires BOTH Redis AND Mongo to be down.
- `pending-job-replay` sweeper drains the dead-letter every 30s.

### 5.3 Queue fairness

- Per-merchant token bucket via Redis Lua (`apps/api/src/lib/merchantRateLimit.ts`).
- Atomic via single Lua script — one merchant cannot starve another.
- Fail-open on Redis outage (don't make a bad infra day worse).

### 5.4 Append-only audit

- Mongoose schema-level immutability hooks on `updateOne`, `updateMany`,
  `findOneAndUpdate`, `replaceOne`, `deleteOne`, `deleteMany`,
  `findOneAndDelete`, `findOneAndReplace`, `save` (re-save).
- Hash chain (`selfHash` + `prevHash`) makes any ex-post tampering
  visible to the verifier.
- In-memory chain head cache; pending tail synchronizes concurrent
  inserts via a single in-flight Promise.

### 5.5 Safe enqueue

Documented in `apps/api/src/lib/queue.ts:328-390`. Three-layer pipeline:

1. Per-merchant fairness check (token bucket).
2. Up to 3 in-process retries on Redis flake.
3. Persist to `PendingJob` if all retries fail.

The discriminated `SafeEnqueueResult` union forces callers to
distinguish "queued cleanly" / "queued after retry recovery" /
"dead-lettered, will run later" / "lost" — caller code can branch
explicitly.

### 5.6 Rollback strategy

Three independent kill-switches, all environment-flag-driven, all
deploy-free:

- `INTENT_SCORING_ENABLED=0` — halts intent stamping; existing values
  remain.
- `ADDRESS_QUALITY_ENABLED=0` — halts address-quality stamping.
- `FRAUD_NETWORK_ENABLED=0` — halts cross-merchant lookup AND
  contribution.

Per-feature kill-switches gate the **write**, not the **read** — UI
continues showing previously-stamped values while we stop minting new
ones.

For deployments:
- Build emits `dist/` artifacts; rolling back to a prior tag is the
  standard path.
- Schema additions are always additive (subdocs default to `undefined`,
  new enum entries are append-only) so rolling back the API doesn't
  invalidate already-stored documents.

---

## 6. Known gaps (carried forward, not fixed in this milestone)

These are documented in the prior audit reports and are not blockers
for the design-partner pilot, but the team should land them before
broader rollout:

1. **`orderSync.worker.ts` registration gap** — file exists, never
   registered in `apps/api/src/index.ts`. Polling fallback is offline.
2. **CSP is Report-Only** — flip to enforce after one production-clean
   week.
3. **Shopify GDPR data redaction sweep stubbed** — receiver real,
   deletion is TODO; required for Public Distribution submission.
4. **Single Redis** — no HA. Fine for design-partner volume; plan for
   Sentinel/Cluster past 100 merchants.
5. **Build tolerates type errors on deploy path** — `apps/api/package.json:8`.
   Strict variant exists; switch deploy to `build:strict`.

---

## 7. Pointers to deeper reading

| Concern | Authoritative document |
|---|---|
| End-to-end audit | `MONOREPO_SAAS_MASTER_AUDIT.md` |
| BD-market product strategy | `RTO_PREVENTION_STRATEGY_MASTERPLAN.md` |
| Intent + Address Intelligence design | `RTO_ENGINE_EXECUTION_ROADMAP.md` |
| Validation methodology + readiness gates | `INTENT_INTELLIGENCE_VALIDATION_REPORT.md` |
| Operational polish + observability | `POST_VALIDATION_OPERATIONAL_POLISH_REPORT.md` |
| Launch readiness checklist | `DESIGN_PARTNER_READINESS_CHECKLIST.md` |
| Incident runbooks | `OPERATIONAL_PLAYBOOKS.md` |
| Repository state at this commit | `REPOSITORY_HYGIENE_AUDIT.md` |
| Merchant-facing feature catalogue | `MERCHANT_FEATURES.md` |
| Runtime / deployment | `INFRASTRUCTURE_OVERVIEW.md` |

The repository's `CLAUDE.md` files (root + `apps/api/CLAUDE.md` +
`apps/web/CLAUDE.md`) hold engineer-facing conventions: build script
quirks, Mongoose strict-mode gotchas, route-group rules,
worker-registration discipline. **Read those first** before adding
new code.

---

**End of architecture document.**

*Every file path and line number cited in this document was verified
against the current `main` branch.*
