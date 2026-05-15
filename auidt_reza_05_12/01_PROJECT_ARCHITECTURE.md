# 01 — Project Architecture (as built, not as marketed)

> Evidence-based map of `C:/devs/ecommerce-logistics/`. Every section points to
> a real file. Where the code is ambiguous it is marked `[unclear]`.

ConfirmX is a Bangladesh-first COD logistics SaaS. It sits between a
merchant's storefront (Shopify / WooCommerce / custom / CSV) and the BD courier
network (Pathao, Steadfast, RedX), and uses SMS (+ planned IVR) to confirm COD
orders with customers before booking, in order to push down RTO (return-to-origin).

## 1. Monorepo layout

```
ecommerce-logistics/
├── apps/
│   ├── api/   Express + tRPC + BullMQ workers      (port 4000)
│   └── web/   Next.js 14 App Router + NextAuth     (port 3001 in dev)
├── packages/
│   ├── db/        Mongoose models (@ecom/db)
│   ├── types/     Shared TS + AppRouter re-export (@ecom/types)
│   ├── branding/  Pure data/colour math (@ecom/branding)
│   └── config/    Shared TS/ESLint config
├── docker-compose.yml   MongoDB + Redis (dev only)
└── package.json         npm workspaces
```

Run `npm run dev` from root to boot api + web in parallel. `@ecom/db` and
`@ecom/types` must have `dist/` built before the apps will import them — the
postinstall builds `@ecom/branding` but **not** db/types, which is a recurring
new-checkout footgun.

## 2. API process boot — `apps/api/src/index.ts`

In order:

1. Env validation via `env.ts` (Zod; fail-fast in production).
2. Process hooks (telemetry, uncaught-exception capture).
3. `connectDb()` → MongoDB.
4. `assertRedisOrExit()` → Redis must be reachable.
5. Idempotent seeds: branding singleton + Bangladesh gazetteer + in-memory prime.
6. Background `Mongoose.syncIndexes()` on hot models: Order, WebhookInbox,
   Integration, Merchant, ImportJob, CustomerReliability, AddressReliability,
   EmailEvent (TTL), EmailSuppression.
7. `initQueues()` (BullMQ).
8. Worker registration (see §6) — only if `REDIS_URL` is set.
9. Express stack mounted in **strict order** (raw-body parsers must come
   BEFORE `express.json` — getting this wrong breaks every signature check).
10. Graceful shutdown handler (SIGINT/SIGTERM): drain HTTP → workers → Mongo,
    25s watchdog.

Health surface:

- `GET /health` — process alive + event loop responsive (no DB ping).
- `GET /ready` — Mongo `readyState===1` + Redis `PING` with 1.5s timeout.
  Returns 503 if either dep is down. Suitable for Kubernetes/Railway probes.

## 3. HTTP surface (`apps/api`)

Mounted in this order so the raw-body webhooks survive:

| Path | Handler file | Purpose |
|------|--------------|---------|
| `/api/webhooks/courier/<provider>/<merchantId>` | `server/webhooks/courier.ts` | Pathao/Steadfast/RedX delivery status. Raw body; HMAC. Idempotent via WebhookInbox. |
| `/api/webhooks/sms-inbound` | `server/webhooks/sms-inbound.ts` | Customer SMS replies ("YES …", "NO …"). HMAC-verified. |
| `/api/webhooks/sms-dlr` | `server/webhooks/sms-dlr.ts` | SMS delivery receipts from SSL Wireless / BulkSMSBD. |
| `/api/integrations/webhook` | `server/webhooks/integrations.ts` | Shopify + WooCommerce + custom API order webhooks. HMAC. |
| `/api/webhooks/shopify/gdpr` | `server/webhooks/shopify-gdpr.ts` | `customers/data_request`, `customers/redact`, `shop/redact`. Mandatory. |
| `/api/webhooks/stripe` | `server/webhooks/stripe.ts` | Subscription / invoice events. Returns 503 if `STRIPE_WEBHOOK_SECRET` unset. |
| `/api/webhooks/resend` | `server/webhooks/resend.ts` | Bounce / complaint / click. Svix-signed; idempotent on svix-id. |
| `/api/webhooks/twilio` | `server/webhooks/twilio.ts` | Voice call status callbacks. Currently legacy (see `02`). |
| `/api/shopify/install` | `server/webhooks/shopify-install.ts` | App Store install entry → OAuth redirect. |
| `/api/integrations/oauth/shopify/callback` | `server/webhooks/integrations.ts` | OAuth completion, writes Integration row, claims public-install token. |
| `/auth/*` | `server/auth.ts` | Login / signup / refresh / logout / password reset / email verify. |
| `/admin/*` | `server/admin.ts` | Admin panel REST (small surface — most admin is tRPC). |
| `/track` | `server/tracking/collector.ts` | Storefront beacon: page view / checkout / behavior. CORS wide-open, HMAC public-key. |
| `/trpc` | `server/trpc.ts` + `routers/index.ts` | Main app API. |
| `/health`, `/ready` | inline | Probes. |

## 4. tRPC routers — `apps/api/src/server/routers/index.ts`

Composed `appRouter`:

| Router | Audience | What it does (top procedures) |
|--------|----------|-------------------------------|
| `merchants` | merchant | profile read/write, couriers CRUD, webhook test, GDPR redact preview |
| `orders` | merchant + billable | create / list / bulkUpload / confirm / reject / book / pick courier |
| `analytics` | billable (plan-gated) | behavior heatmap, courier performance, order funnel |
| `callCenter` | merchant | logCall, listCalls |
| `call` | merchant + billable | isConfigured, initiateCall, terminateCall |
| `fraud` | merchant | listFraudReviews, confirm/reject (with rejectSnapshot) |
| `billing` | merchant | subscription, portal (Stripe), manualPayment (receipt upload) |
| `adminBilling` | admin | merchant subs, invoices, past-due |
| `adminFraudNetwork` | admin | global signal aggregates, RTO rates |
| `adminAccess` | admin | users, roles, API tokens |
| `adminObservability` | admin | system health, delivery reliability, lane intelligence |
| `adminAudit` | admin | audit-log search |
| `notifications` | merchant | list, mark read (settings UI is stubbed — see `02`) |
| `integrations` | merchant | list / connect / disconnect / testWebhook / completeShopifyInstall |
| `tracking` | mixed | rotateSecret (merchant), publicTimeline (public, IP-rate-limited) |
| `recovery` | merchant | cart recovery tasks |
| `feedback` | merchant | submit MerchantFeedback row |
| `branding` | public | fetch SaaS branding (SSR-safe) |
| `adminBranding` | admin | edit branding singleton |

## 5. Web app surface — `apps/web/src/app/`

Route groups (App Router):

| Group / Path | Audience | Notes |
|--------------|----------|-------|
| `(marketing)/` | public | Landing + ROI calc. No SessionProvider/tRPC → small bundle. |
| `pricing/` | public | 4 plans, BDT pricing, feature gates synced with runtime caps. |
| `(auth)/login`, `(auth)/signup` | public | NextAuth Credentials. |
| `forgot-password`, `reset-password`, `verify-email`, `verify-email-sent` | public | Hash-token flows. |
| `(direct)/install/shopify/complete` | Shopify OAuth | `FinalizeClient` auto-claims install token. |
| `(embedded)/embedded/*` | Shopify Admin iframe | Phase D scaffold. CSP still `frame-ancestors 'none'` — embedded path **does not yet work**. See `02`. |
| `dashboard/` | merchant | Main app shell. Sub-routes: orders, fraud-review, call-customer, recovery, getting-started, integrations, analytics, billing, settings/* |
| `dashboard/settings/notifications` | merchant | `<ComingSoon />` stub. |
| `dashboard/settings/team` | merchant | `<ComingSoon />` stub. |
| `admin/` | super_admin | access / billing / fraud / audit / system / branding / alerts |
| `track/[code]` | public customer | Server-rendered tracking page with merchant branding. |
| `legal/{privacy,terms}` | public | Boilerplate; no BD DPA mention. |
| `payment-{success,failed}` | merchant | Stripe redirect landings. |

## 6. Background workers — `apps/api/src/workers/`

All registered from `index.ts` if `REDIS_URL` is set. Queue names live in
`apps/api/src/lib/queue.ts` (`QUEUE_NAMES`).

| Worker | Trigger | What it does |
|--------|---------|--------------|
| `trackingSync` | cron | Polls couriers; syncs TrackingEvent; updates order status (recovery rail for missed webhooks). |
| `riskRecompute` | event | Rescore orders after SMS DLR / reply / RTO. |
| `webhookProcess` | event | Consume inbound order webhooks idempotently. |
| `webhookRetry` | cron | Retries stale outbound webhook deliveries. |
| `fraudWeightTuning` | cron | Refit fraud-scoring weights. |
| `commerceImport` | event | Bulk-import historical orders from Shopify/WooCommerce. |
| `automationBook` | event | Auto-create courier shipment after confirmation. |
| `automationSms` | event | Send confirmation SMS, 5 attempts, expo backoff (15s base). |
| `automationStale` | cron | Escalate orders stuck in `pending_confirmation`. |
| `automationWatchdog` | cron | Alert merchant if automation queue is jammed. |
| `cartRecovery` | cron | SMS abandoned carts. |
| `trialReminder` | cron | Nudge before trial expiry (7d / 3d / 1d). |
| `subscriptionGrace` | cron | Flip past_due → suspended on grace expiry. |
| `shopifyReconnectNudge` | cron | One-shot email to merchants with legacy non-expiring tokens. |
| `awbReconcile` | cron | Reconcile PendingAwb rows. |
| `orderSync` | cron (~5 min) | Polling fallback when Shopify/Woo webhook delivery is broken. |
| `customerDataRetention` | cron (daily) | GDPR / DPA pseudonymisation of PII older than `CUSTOMER_DATA_RETENTION_DAYS`. |
| `pendingJobReplay` | cron (~30s) | DLQ sweeper. Drains PendingJob rows back onto BullMQ (Redis outage recovery). |
| `email.worker` | event | Transactional email via Resend. Idempotent on `email:<correlationId>`. |

All jobs default to 3 attempts, exponential backoff, `removeOnComplete` last
1000 / 24h, `removeOnFail` last 5000 / 7d.

## 7. Data model — `packages/db/src/models/`

Thirty Mongoose models, exported through `@ecom/db`. Grouped:

**Tenant** — `merchant`, `integration`, `merchantStats`
**Orders** — `order`, `bulkUploadBatch`, `pendingAwb`
**Intelligence / risk** — `fraudSignal`, `fraudPrediction`, `courierPerformance`,
`customerReliability`, `addressReliability`, `areaReliability`, `courierLane`,
`externalDeliveryProfile`, `geography`
**Billing / usage** — `payment`, `usage`
**Webhooks / imports** — `webhookInbox`, `importJob`
**Comms** — `callLog`, `notification`
**Tracking / behavior** — `trackingEvent`, `trackingSession`
**Ops / admin** — `auditLog`, `emailEvent`, `emailSuppression`, `merchantFeedback`,
`brandingConfig`, `recoveryTask`, `pendingJob`

Compound indexes for race-safety are present on CustomerReliability,
AddressReliability, WebhookInbox, EmailEvent (TTL).

## 8. External services (production dependencies)

- **Courier** — Pathao, Steadfast, RedX. Each adapter in
  `apps/api/src/lib/couriers/*.ts`, behind a circuit breaker
  (`couriers/circuit-breaker.ts`). Webhook signature verified per provider.
  Mock transport gated by `COURIER_MOCK=1`.
- **SMS** — SSL Wireless (`lib/sms/sslwireless.ts`), BulkSMSBD
  (`lib/sms/bulksmsbd.ts`, currently untracked — see `02`). Provider chosen by
  `SMS_PROVIDER` env enum. DLR via `/api/webhooks/sms-dlr`. Inbound via
  `/api/webhooks/sms-inbound`.
- **Voice** — `lib/voice/{index,stub,twilio,types}.ts`. Stub default; Twilio
  is demo-only (TwiML URL is `http://demo.twilio.com/docs/voice.xml`).
  **No BD-local provider** — see saved memory `project_call_stack_state` and `02`.
- **Commerce** — Shopify (OAuth + REST + webhooks), WooCommerce (REST + custom
  HMAC), custom API (generic HMAC/JWT), CSV (BulkUploadBatch worker).
- **Payments** — Stripe (subscriptions + portal; card checkout marked
  "Coming soon" in UI). Manual: bKash, Nagad, bank transfer via
  `lib/manual-payments.ts` with cross-merchant fraud detection (txnId reuse,
  proof-file reuse, metadata reuse → dual-approval at score ≥ 60).
- **Email** — Resend transactional. Bounce/complaint suppression list enforced.
- **Observability** — Sentry DSN optional; not currently mandatory. Audit log
  is the primary in-app trace.

## 9. Five critical data flows (from code)

### A. Shopify order → confirmation SMS → outcome
```
Shopify POST /api/integrations/webhook (HMAC by accessToken)
  → enqueueInboundWebhook
  → webhookProcess worker
  → orders.ingest (risk score, fraud lookup, intent score)
  → Order + FraudPrediction created
  → enqueueAutoBook (if low risk) OR enqueueOrderConfirmationSms (auto-confirm)
  → automationSms worker → SSL Wireless/BulkSMSBD HTTP POST
  → Gateway delivers + POSTs /api/webhooks/sms-dlr
  → updateAutomationState("confirmed" | "delivery_failed")
  → If failed: escalate to requires_review + fire critical alert
```

### B. Customer reply → intent signal
```
Customer SMS reply ("YES <code>")
  → SMS gateway POST /api/webhooks/sms-inbound (HMAC)
  → match on order.automation.confirmationCode
  → record confirmationRepliedAt + confirmationReplyCode
  → enqueue riskRecompute (intent signal: reply received)
```

### C. Order risk scoring (synchronous)
```
orders.create / webhook ingest
  → server/risk.ts computeRisk()
    - delivery reliability (per-phone, per-address)
    - lane intelligence (courier × district)
    - area reliability (district)
    - fraud-network shared signals (hashes only)
    - customer value rollup
    - external delivery profile
  → apply FRAUD_WEIGHTS
  → classify low / med / high
  → decideAutomationAction()
```

### D. Public tracking
```
Customer visits /track/[code]
  → SSR fetchPublicTracking()
    - IP rate-limit 30/min
    - lookup Order by trackingNumber
    - mask address
    - load merchant branding (logo, primaryColor, supportPhone, supportEmail)
  → render server component with TrackingTimeline
```

### E. Courier shipment lifecycle
```
automationBook worker
  → selectBestCourier() reads CourierPerformance + CourierLane
  → adapterFor(courier).createShipment()
  → PendingAwb row + Order.status = "shipped"
…(courier delivers)…
Courier POST /api/webhooks/courier/<provider>/<merchantId> (HMAC)
  → idempotent on hash(tracking, status, ts)
  → upsert TrackingEvent
  → applyTrackingEvents() updates Order.details.status
  → CourierPerformance + CustomerReliability + AddressReliability counters update
  → Notification dispatched to merchant
```

## 10. What is genuinely well-architected

These are not vanity points — they will matter when you scale:

- **Idempotency at every webhook.** WebhookInbox unique index + per-provider
  externalId. Stripe events deduped by `providerEventId`. SMS DLR by status
  filter. Courier by `hash(tracking,status,ts)`.
- **Outbox / DLQ.** PendingJob model + `pendingJobReplay` worker means a Redis
  outage doesn't lose work. This is unusual for an early-stage BD SaaS.
- **Encrypted secrets at rest.** Courier API keys are AES-256-GCM enveloped
  with a 32-byte base64 `COURIER_ENC_KEY` enforced at boot
  (`apps/api/src/lib/crypto.ts`).
- **Explainable risk model.** `delivery-reliability.ts` exposes named signals
  (`customer_repeat_success`, `address_clean_history`, `courier_lane_strong`),
  not opaque scores. Merchants can audit *why*.
- **Cross-merchant fraud network with privacy.** `lib/fraud-network.ts`
  exchanges only `phoneHash`/`addressHash` — no raw PII.
- **Public-tracking page is server-rendered with branding.** Real merchant
  white-label, not a stripe of CSS.
- **Bangladesh-first address heuristics.** `lib/address-intelligence.ts` +
  `thana-lexicon.ts` + `gazetteer.ts` understand mosque/bazar/thana semantics.

## 11. What is architecturally fragile

- **No real observability backbone.** Per-feature observability files exist
  under `lib/observability/`, but there's no central structured logger,
  no distributed tracing, Sentry is optional. When something breaks at 2 AM
  you will be reading Railway logs by eye.
- **Voice subsystem is half-checked-in.** `lib/voice/` is on disk untracked.
  Per saved memory the BD-local IVR provider does not exist yet.
- **`@ecom/config` package directory exists but has no source files**
  (`packages/config/`). Either vestigial or a planned slot.
- **`admin-rbac.ts.new` and `audit.ts.new` shadow live files.** The `.new`
  RBAC file has a duplicate `throw new TRPCError(...)` near line 147 — a
  syntax error if it ever became the live file. Either merge or delete.
- **Many root-level audit `*.md` files** (50+). They drift, contradict each
  other, and are NOT a substitute for reading the code. This audit deliberately
  re-derived everything from source.

## 12. One-line architecture summary

> A correctly-sequenced Express + tRPC API with idempotent webhooks, a clean
> 19-worker BullMQ farm, 30 Mongoose models with race-safe indexes, a Next.js
> 14 App Router web with public tracking + Shopify embedded scaffold, an
> explainable BD-localised risk engine, encrypted courier credentials, and a
> partially-finished SMS + voice migration that the founder must finish or
> stub before the soft launch.
