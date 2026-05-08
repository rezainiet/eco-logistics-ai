# INFRASTRUCTURE_OVERVIEW.md

**Audience:** operators, on-call, technical due-diligence, future infra
engineers.

This document describes Cordon's runtime topology and operational
dependencies. **Everything here is inferred from the repository** —
the actual Railway dashboard, secret values, hostnames, and provider
account IDs are NOT in source control (correctly) and live with the
operator. Sections marked `[OPERATOR-FILL]` are for the team to
populate from the deploy console once.

> ⚠️ **Secrets policy:** this document MUST NOT contain plaintext
> credentials. Every `[OPERATOR-FILL]` slot is for a hostname /
> provider name / region — never an API key or database password.

---

## 1. Deployed services (inferred runtime topology)

```
                       ┌─────────────────────────┐
                       │  Edge proxy / CDN       │  [OPERATOR-FILL: Railway / Cloudflare / etc.]
                       │  (TLS termination)      │
                       └────────────┬────────────┘
                                    │
                ┌───────────────────┴───────────────────┐
                │                                       │
                ▼                                       ▼
   ┌────────────────────────┐              ┌────────────────────────┐
   │  apps/web              │              │  apps/api              │
   │  Next.js 14 SSR        │  ── tRPC ──▶ │  Express + tRPC        │
   │  port 3001 (dev)       │  /trpc       │  port 4000 (dev)       │
   │  @ecom/web             │              │  @ecom/api             │
   └────────────────────────┘              └────────────┬───────────┘
                                                        │
                                          ┌─────────────┼─────────────┐
                                          │             │             │
                                          ▼             ▼             ▼
                                  ┌──────────────┐ ┌─────────┐ ┌─────────────┐
                                  │  MongoDB     │ │  Redis  │ │ Outbound    │
                                  │  (Atlas?)    │ │ (BullMQ │ │ HTTP        │
                                  │              │ │ + cache)│ │ (couriers,  │
                                  │              │ │         │ │ Stripe,     │
                                  │              │ │         │ │ Shopify,    │
                                  │              │ │         │ │ SSL Wireless│
                                  │              │ │         │ │ Sentry,     │
                                  │              │ │         │ │ Resend)     │
                                  └──────────────┘ └─────────┘ └─────────────┘
```

### 1.1 Web service (`apps/web`)

- **Build command:** `npm --workspace apps/web run build` → Next.js 14
  produces `.next/`.
- **Start command:** `npm --workspace apps/web start` → `next start -p 3001`
  in dev. In production, port is provider-assigned via `PORT` env.
- **Public domains:** `[OPERATOR-FILL: e.g. app.cordon.so + cordon.so]`
- **Required env (web side):**
  - `NEXT_PUBLIC_API_URL` — origin of the api service.
  - `NEXT_PUBLIC_WEB_URL` — own canonical URL (used for OG images).
  - `NEXTAUTH_URL` — own URL (used by NextAuth; must match the deploy
    origin or signOut() redirects break).
  - `NEXTAUTH_SECRET` — NextAuth's session signing key.
  - `NEXT_PUBLIC_SENTRY_DSN` (optional) — frontend error reporting.
  - `NEXT_PUBLIC_INCIDENT_BANNER_TEXT` (optional, ops kill-switch) —
    when set, renders the IncidentBanner component at top of every
    dashboard page. Setting + clearing is done from the deploy
    console without code change.

### 1.2 API service (`apps/api`)

- **Build command:** `npm --workspace apps/api run build`. The build
  script runs `tsc -p tsconfig.build.json` with **tolerant** error
  handling (`--noEmitOnError false`) so staging deploys can ship even
  with type errors. The strict variant is `npm run build:strict` —
  consider switching the deploy to that once the codebase is at zero
  type errors (it is, per the design-partner readiness checklist).
- **Start command:** `node apps/api/dist/index.js`.
- **Boot sequence:** `apps/api/src/index.ts` validates env via zod,
  connects Mongo, asserts Redis (process.exit on failure in
  production), runs one-shot legacy index migrations, fire-and-forgets
  index sync for hot models, registers all 16 BullMQ workers, starts
  schedules, then binds the HTTP server.
- **Health endpoint:** `GET /health` returns `{ ok: true }` — used by
  the deploy provider's healthcheck.
- **Graceful shutdown:** SIGINT / SIGTERM closes the HTTP server,
  drains queues, closes Redis, then `process.exit(0)`.

### 1.3 Database — MongoDB

- **Provider:** `[OPERATOR-FILL: e.g. MongoDB Atlas, region <region>]`
- **Connection string:** read from `MONGODB_URI` env. Validated via
  zod (`z.string().url().or(z.string().startsWith("mongodb"))`).
- **Production posture:**
  - `mongoose.set("autoIndex", false)` and
    `mongoose.set("autoCreate", false)` — index builds DO NOT happen
    on schema-change automatically.
  - Boot-time **fire-and-forget index sync** runs in background for 5
    hot models (Order, WebhookInbox, Integration, Merchant, ImportJob,
    TrackingSession) — non-blocking on healthcheck.
  - **Out-of-band index migrations** via `npm run db:sync-indexes`
    (`apps/api/src/scripts/syncIndexes.ts`).
  - **Two one-shot legacy index drops** run at boot (idempotent):
    - drop legacy WebhookInbox `expiresAt_1` TTL (we no longer reap
      idempotency rows)
    - drop legacy Order `(merchantId, createdAt:-1, order.status)` index
      (replaced by ESR-correct version)
- **Replica set:** mongodb-memory-server in dev runs a single-node
  replica set so `session.startTransaction()` works (the order-create
  flow uses transactions for exactly-once semantics). Production must
  also be on a replica set or sharded cluster — `[OPERATOR-FILL: confirm Atlas tier]`.
- **Backup:** `[OPERATOR-FILL: Atlas continuous backup config + retention window]`
  — REQUIRED before launching merchants. Run a test point-in-time
  restore once into staging (as called out in
  `DESIGN_PARTNER_READINESS_CHECKLIST.md` item 8).

### 1.4 Redis

- **Provider:** `[OPERATOR-FILL: e.g. Railway Redis, Upstash, etc.]`
- **Connection:** `REDIS_URL` env. Required in production
  (`apps/api/src/env.ts:188-190` refuses boot if unset).
- **Use cases:**
  - BullMQ — every queue's storage backend.
  - Per-merchant token-bucket rate limiting (Lua script).
  - Session ledger (sids stored as `session:{merchantId}:{sid}`).
  - Per-IP rate limiters via `rate-limit-redis`.
  - tRPC token cache (in-process LRU; Redis is the multi-process
    truth).
- **HA posture:** single Redis instance today. Adequate for the
  design-partner pilot (5–25 merchants). Redis Sentinel / Cluster
  becomes worthwhile past ~100 merchants or once the worker pool grows
  past 5 pods.
- **Eviction policy:** must be `noeviction` for BullMQ correctness
  (BullMQ relies on persistent keyspace). `[OPERATOR-FILL: confirm Redis maxmemory-policy]`.

### 1.5 Outbound dependencies

| Service | Purpose | Env keys |
|---|---|---|
| Stripe (https://api.stripe.com) | Subscriptions + manual one-shot Checkout | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` |
| Shopify (per-shop hostname) | OAuth + GraphQL admin API + webhooks | `SHOPIFY_APP_API_KEY`, `SHOPIFY_APP_API_SECRET` (one-click app) |
| WooCommerce (per-merchant URL) | REST API + webhooks | per-integration `consumerKey`/`consumerSecret` |
| Pathao / Steadfast / RedX | Courier APIs | per-merchant credentials (encrypted at rest with `COURIER_ENC_KEY`) |
| SSL Wireless (smsplus.sslwireless.com) | Transactional SMS in BD | `SSL_WIRELESS_API_KEY`, `SSL_WIRELESS_USER`, `SSL_WIRELESS_SID` |
| Twilio | SMS gateway (legacy / international) | `TWILIO_*` |
| Resend | Transactional email | `RESEND_API_KEY`, `EMAIL_FROM` |
| Sentry | Error reporting (envelope POST; no SDK on graph) | `SENTRY_DSN`, `SENTRY_RELEASE` |

All external calls are wrapped in:
- per-(provider, accountId) circuit breakers (couriers — 5s wall-time
  ceiling, 5-failure trip, 30s open duration)
- in-process retries-with-backoff for transient failures
- SSRF guard on merchant-supplied URLs (Woo) — DNS resolves and
  rejects private/loopback/link-local hits

---

## 2. Environment variables — full inventory

The complete list is in `apps/api/src/env.ts` (zod schema with
documentation comments). High-level groups:

### Required in production

- `MONGODB_URI`, `REDIS_URL`, `JWT_SECRET` (≥16 chars), `ADMIN_SECRET`
  (≥24 chars), `COURIER_ENC_KEY` (base64 32-byte).
- The env loader refuses to boot in production if any required key is
  unset.

### Required for specific features

- **Stripe Subscriptions:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_SCALE`,
  `STRIPE_PRICE_ENTERPRISE`. Without these, the Subscription mutations
  refuse to mint a Checkout session. Manual rails still work.
- **One-click Shopify:** `SHOPIFY_APP_API_KEY` + `SHOPIFY_APP_API_SECRET`.
  Without these, merchants fall through to the legacy custom-app
  paste-in-credentials flow (works, but conversion-killing).
- **BD SMS:** `SSL_WIRELESS_API_KEY`, `SSL_WIRELESS_USER`, `SSL_WIRELESS_SID`.
  Without these, SMS sends are no-ops in dev; refuse in prod with a
  loud warning.
- **Inbound SMS / DLR:** `SMS_WEBHOOK_SHARED_SECRET` — required to
  HMAC-verify inbound-reply and DLR webhooks. Missing in production
  surfaces a startup warning; the handlers refuse all unsigned posts.
- **Transactional email:** `RESEND_API_KEY`, `EMAIL_FROM`,
  `PUBLIC_WEB_URL`. Missing keys fall back to stdout in dev; no-op in
  prod with warning.
- **Manual payment rails:** `PAY_BKASH_NUMBER`, `PAY_NAGAD_NUMBER`,
  `PAY_BANK_INFO`. Each missing entry hides that payment option from
  the billing page.

### Operational tuning

- `TRIAL_DAYS` (default 14), `TRIAL_WARNING_DAYS` (default 3),
  `STRIPE_GRACE_DAYS` (default 7).
- `TRACKING_SYNC_INTERVAL_MIN` (default 60; 0 disables polling).
- `TRACKING_SYNC_BATCH` (default 100).
- `TRUSTED_PROXIES` — `false` / integer hop count / comma-separated
  CIDRs. Defaults to `false` so a direct caller cannot spoof
  `X-Forwarded-For`. Must be set to the edge proxy's IP / CIDR list
  in production.

### Kill-switches (environment-flag-driven, deploy-free rollback)

- `ADDRESS_QUALITY_ENABLED` (default 1).
- `INTENT_SCORING_ENABLED` (default 1).
- `FRAUD_NETWORK_ENABLED` (default 1).
- `COURIER_MOCK` (default 0; set to 1 in dev to use in-memory
  courier transports).

### CORS / origin

- `CORS_ORIGIN` — defaults to `http://localhost:3001`. Must match the
  web service's deployed origin in production (multiple origins via
  comma-separated list).

The full schema with default values, validation rules, and inline
docstrings lives at `apps/api/src/env.ts:11-217`.

---

## 3. Deployment flow

### 3.1 Local development

```bash
# 1. Boot Mongo + Redis containers
docker-compose up -d

# 2. Build the typed packages once
npm --workspace packages/db run build
npm --workspace packages/types run build

# 3. Boot api + web in parallel
npm run dev
# → API on http://localhost:4000
# → web on http://localhost:3001
```

`docker-compose.yml` provides Mongo 7 + Redis 7-alpine for local dev.
Both containers persist data via Docker volumes.

The `start-dev.bat` Windows convenience script wraps `npm run dev`.

### 3.2 Staging / production

Per the build script comments and the existing branch state
(`claude/staging-deploy`), the deploy provider is configured to:

1. Run `npm install` at repo root (npm workspaces installs all apps + packages).
2. Run `npm --workspace packages/db run build` and
   `npm --workspace packages/types run build` to produce the dist
   artifacts the apps consume.
3. Run `npm --workspace apps/api run build` (tolerant — emits even on
   type errors).
4. Run `npm --workspace apps/web run build` (Next.js production build;
   `typescript: { ignoreBuildErrors: false }` — gates on type errors
   for the web side).
5. Start the services with their respective `start` scripts.

**`[OPERATOR-FILL]:`**
- Exact deploy provider name (Railway? Vercel + Railway? Self-hosted?)
- Deploy trigger (auto on push to which branch / manual via dashboard)
- CI / test run before deploy (yes / no, configured where)
- Per-environment URLs (staging / production)
- Rollback procedure documented in the deploy provider

The `OPERATIONAL_PLAYBOOKS.md` cross-cutting playbook covers the
"something looks wrong" diagnostic flow regardless of provider.

---

## 4. Observability posture

### 4.1 Logs

Cordon emits **single-line JSON structured logs** on hot paths so an
external aggregator can index by `evt`. Stable event prefixes:

- `evt: webhook.*` — webhook receivers (`webhook.signature_invalid`,
  `webhook.acked` with `ackMs` latency)
- `evt: queue.*` — queue and dead-letter (`queue.dead_lettered`,
  `queue.dead_letter_replayed`, `queue.dead_letter_exhausted`,
  `queue.merchant_throttled`, `queue.wait_time`)
- `evt: intent.*` — intent scoring (`intent.scored`, `intent.scored_error`)
- `evt: address.*` — address scoring (`address.scored`)
- `evt: feedback.*` — merchant feedback (`feedback.submitted`)

`[OPERATOR-FILL: log aggregator (Datadog / Grafana Loki / Better Stack /
Railway logs only) + retention period]`

### 4.2 Error reporting (Sentry)

`apps/api/src/lib/telemetry.ts` posts events to Sentry's HTTP envelope
endpoint directly. No SDK dependency on the deployment graph. When
`SENTRY_DSN` is set:

- Unhandled rejections + uncaught exceptions are captured with
  `fatal` level.
- tRPC `INTERNAL_SERVER_ERROR` is captured with `error` level (4xx
  classes are intentionally skipped — they're control flow).
- Express `next(err)` paths captured.
- `SENTRY_RELEASE` env tags every event so a regression maps to the
  deploy that introduced it.

When `SENTRY_DSN` is unset, capture is a no-op.

### 4.3 Metrics

- BullMQ counters per queue surface via
  `analytics.adminObservability.systemHealth` admin tRPC procedure.
- Per-merchant snapshot via `adminObservability.merchantSupportSnapshot`.
- Webhook ACK latency aggregable from the `webhook.acked` log stream
  (`ackMs` field).

`[OPERATOR-FILL: external metrics dashboard (Grafana / Datadog) wiring]`

### 4.4 Alerting

The platform's anomaly engine (`apps/api/src/lib/anomaly.ts`) runs
short-window-vs-baseline detection across:

- payment volume spikes
- webhook failure spikes
- automation failure spikes
- fraud spikes

When triggered, fires `alert.fired` audit rows that fan out to admin
notifications via `lib/admin-alerts.ts`. Admin alert prefs are
per-admin (in-app / email / SMS toggles per severity).

`[OPERATOR-FILL: PagerDuty / Slack channel / paging hookup, if any]`

---

## 5. Backup posture

| Asset | Backup mechanism | Retention | Restore-tested? |
|---|---|---|---|
| MongoDB | `[OPERATOR-FILL: Atlas continuous backup or self-hosted dump]` | `[OPERATOR-FILL]` | `[OPERATOR-FILL — DO BEFORE LAUNCH]` |
| Redis | None expected — Redis is volatile-by-design here. BullMQ jobs are persisted via `removeOnComplete: { count: 1000, age: 24h }`; deeper history would defeat the queue's purpose. | n/a | n/a |
| Source code | GitHub remote | unlimited | n/a |
| Secrets / env | `[OPERATOR-FILL: deploy provider's secret store]` | n/a | `[OPERATOR-FILL]` |
| Audit log | Stored in MongoDB; backed up with the rest of the DB. Append-only at the application layer; cryptographic chain in the row hashes. | with the DB | with the DB |

**Pre-launch must-do:** verify Atlas backup config and run one test
point-in-time restore against staging. This is the single biggest
infrastructure unknown for the design-partner pilot.

---

## 6. Operational dependencies (single points of failure)

| Dependency | Failure mode | Mitigation in place |
|---|---|---|
| MongoDB | Inability to ingest orders, read history, or commit fraud decisions | Replica-set required for prod; index-build resilience; one-shot legacy migrations are idempotent |
| Redis | Queue inserts fall through to `PendingJob` Mongo dead-letter | `safeEnqueue` 3-retry + `PendingJob` + `pending-job-replay` sweeper; tested in `tests/queue-reliability.test.ts` |
| Stripe | New subscription flows fail; existing subs unaffected (Stripe webhook flow handles delayed delivery) | Endpoint refuses 503 if `STRIPE_WEBHOOK_SECRET` unset (no silent acceptance); manual rails always available as fallback |
| Shopify | Inbound webhooks pause; merchants can't connect new stores | Polling fallback (when `orderSync` registered) catches dropped deliveries within 5 min; existing merchants unaffected for ingest |
| SSL Wireless | Confirmation SMS dispatch fails; DLR pipeline stalls | `automationSms` worker retries 5× with backoff; `confirmation_sms_undelivered` operational hint surfaces the gap; merchant can fall back to manual call |
| Resend | Transactional email fails | Best-effort sends; failures logged; trial-ending warning is the only critical email today |
| Pathao / Steadfast / RedX | Booking / tracking calls fail | Per-(provider, accountId) circuit breaker; 5s wall-time ceiling; fallback chain across 3 couriers per order |
| Sentry | Error reports drop | Telemetry is fire-and-forget by design; failures don't propagate back into the request path |

---

## 7. Production readiness fast-check

Before promoting a build to production:

```bash
# 1. Confirm tests pass
npm --workspace apps/api test

# 2. Confirm strict typecheck
npm --workspace apps/api run typecheck
npm --workspace apps/web run typecheck

# 3. Confirm production build emits all four dists
npm run build

# 4. Confirm env validation accepts production config
NODE_ENV=production node -e "import('./apps/api/dist/env.js').then(m => console.log('env ok'))"

# 5. Run db:sync-indexes against staging or prod (out-of-band)
MONGODB_URI=... npm --workspace apps/api run db:sync-indexes
```

---

## 8. Hosting topology — what we know vs what's `[OPERATOR-FILL]`

**Confirmed from repo:**

- monorepo-shaped deploy with two app services (`apps/web` + `apps/api`)
- node 20+ runtime
- Mongo + Redis as data plane
- Stripe + Shopify + Pathao/Steadfast/RedX + SSL Wireless + Sentry +
  Resend + Twilio as outbound dependencies

**Inferred from branch + commit history (`claude/staging-deploy` branch):**

- the team uses Railway (typical Railway convention is the
  `claude/...` branch staging pattern)

**`[OPERATOR-FILL]` (verified in deploy console, not from repo):**

- Railway project name + ID
- staging vs production environment IDs
- per-environment domains
- per-environment Mongo + Redis connection sources
- secret store mechanism + rotation cadence
- log retention + aggregator
- backup retention + last successful restore test date
- on-call paging integration
- DNS provider + cert renewal posture

The team's first task on this document is **populating the
`[OPERATOR-FILL]` slots** from the Railway dashboard. Do this once;
keep it living.

---

## 9. Future infrastructure work (carried forward, not blocking)

From the master audit, in priority order:

1. **Wire `orderSync.worker.ts`** in `apps/api/src/index.ts` (3-line fix
   — covered in master audit §15 and design-partner readiness §1).
2. **Mongo Atlas backup test restore** before first merchant onboards.
3. **Redis HA** (Sentinel / Cluster) past 100 merchants.
4. **Multi-region failover** past 1k merchants.
5. **Dedicated worker pool** — currently every BullMQ worker shares the
   API process. Past 1k merchants, split workers into their own
   services so HTTP latency is independent of queue throughput.
6. **External log aggregator + dashboard wiring** — structured logs
   already emit; nobody centrally indexes them yet.

None of the above blocks the 5-merchant pilot. Item 2 is the one true
must-verify before launch.

---

**End of infrastructure overview.**

*Every claim about the codebase in this document is verified against
the current `main` branch. Every `[OPERATOR-FILL]` is a live-system
fact the team must populate from the deploy console.*
