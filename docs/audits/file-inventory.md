# File Inventory

**Status:** discovery snapshot, 2026-05-08.
**Format:** files grouped by the discovery question they answer. Line counts come from `wc -l`. Paths are repo-relative.

---

## A. Scoring & intelligence libraries

`apps/api/src/lib/`

| File                                | Lines | Purpose |
|-------------------------------------|------:|---------|
| `operational-hints.ts`              |   282 | Pure-function classifier: order state → operational hint (8 codes, 3 severities). NEVER writes, NEVER feeds risk. Test-friendly (input is structural, no Mongoose). |
| `courier-intelligence.ts`           |   425 | `recordCourierOutcome` (write) + `selectBestCourier` (read) + `recordCourierBookFailure`. Per-(merchant, courier, district) stats with `_GLOBAL_` aggregate fallback. Score = success×60 − rto×30 + speed×10 + preferredBonus − failurePenalty. |
| `intent.ts`                         |   462 | `computeIntentScore` (pure) + `scoreIntentForOrder` (DB I/O). 4 tiers: verified / implicit / unverified / no_data. Observation-only in v1; gated on `INTENT_SCORING_ENABLED`. |
| `fraud-network.ts`                  |   381 | Cross-merchant network: `lookupNetworkRisk` (read, returns aggregate + capped bonus) + `contributeOutcome` (write). Hashes only, never raw values. |
| `address-intelligence.ts`           |   216 | `computeAddressQuality` — pure; classifies address as complete/partial/incomplete with landmarks, hasNumber, scriptMix, missingHints. Gated on `ADDRESS_QUALITY_ENABLED`. |
| `anomaly.ts`                        |   313 | Admin observability: 4 short-vs-baseline detectors (payment_spike, webhook_failure_spike, automation_failure_spike, fraud_spike) → AuditLog `alert.fired` rows + admin notifications. |
| `automation.ts`                     |   ?   | Helpers for confirmation SMS / auto-book state machine (consumes `risk` output). |
| `admin-alerts.ts`                   |   ?   | `deliverAdminAlert` fan-out (in-app / email / SMS). |
| `merchantValueRollup.ts`            |   ?   | Cached p75/avg order value driving adaptive COD thresholds in `computeRisk`. |
| `district.ts`, `phone.ts`, `thana-lexicon.ts` |  ?  | Pure normalizers used across intelligence + ingestion. |

`apps/api/src/server/`

| File                                | Lines | Purpose |
|-------------------------------------|------:|---------|
| `risk.ts`                           |  1102 | `computeRisk` deterministic 0–100 scorer + `collectRiskHistory` / `collectRiskHistoryBatch` aggregates + `hashAddress` fingerprint + customer-tier classifier. **Authoritative risk engine.** |

`apps/api/src/server/services/intelligence/`

| File                              | Lines | Purpose |
|-----------------------------------|------:|---------|
| `intelligenceHandlers.ts`         |   379 | tRPC handler bodies for the 5 RTO Intelligence cards (intent dist, address quality dist, top thanas, campaign source outcomes, repeat visitor outcomes). |
| `sessionCorrelation.ts`           |   134 | `fetchOrdersAndSessions` two-stage join (no `$lookup`) for cards that need order+session correlation. |
| `intelligenceTypes.ts`            |   135 | Shared DTOs + `ProtectedHandlerCtx`. |
| `intelligenceBuckets.ts`          |    99 | `OutcomeBucket` shape + helpers (`addToBucket`, `finaliseBucket`). |
| `campaignClassification.ts`       |    80 | `categoriseCampaign(campaign) → CampaignCategory` (organic / paid_social / direct / unknown). |
| `outcomeMetrics.ts`               |    71 | Outcome-rate helpers. |
| `intelligenceSchemas.ts`          |    40 | Zod schemas for the procedure inputs. |

---

## B. Courier integrations

`apps/api/src/lib/couriers/`

| File                       | Lines | Purpose |
|----------------------------|------:|---------|
| `index.ts`                 |    65 | Adapter registry (`pathao`, `steadfast`, `redx`); decrypts merchant secrets via `crypto.ts`. |
| `types.ts`                 |   126 | `CourierAdapter` contract + 8-state `NormalizedTrackingStatus` enum + `CourierError` taxonomy. |
| `pathao.ts`                |   527 | Pathao adapter: `validateCredentials` / `createAWB` / `getTracking` / `priceQuote` + `parsePathaoWebhook` + `verifyPathaoWebhookSignature`. |
| `redx.ts`                  |   429 | RedX adapter (same shape). |
| `steadfast.ts`             |   396 | Steadfast adapter (same shape). |
| `circuit-breaker.ts`       |   331 | Per-(courier, merchant) circuit breaker shared by adapters. |
| `http.ts`                  |   191 | HTTP client wrapper (timeouts, retry, error mapping). |
| `webhook-registration.ts`  |   128 | Outbound webhook registration helper (used by integration setup). |

`apps/api/src/server/webhooks/courier.ts` (371 lines) is the inbound router. `apps/api/src/server/courier-replay.ts` (192) is the replay path. `apps/api/src/lib/observability/courier-webhook.ts` is the metrics emitter.

Tests: `apps/api/tests/courier.*.test.ts` (5 files: webhook, retry, circuit-breaker, observability, pathao-redx) plus `tests/courier-intelligence*.test.ts`.

---

## C. Workers / queue system

`apps/api/src/workers/`

All 16 wrappers register a queue defined in `apps/api/src/lib/queue.ts:QUEUE_NAMES`. The wired list (verified against `apps/api/src/index.ts:157–195`):

| Worker file                | Queue name              | Schedule | Concurrency | Role |
|----------------------------|-------------------------|----------|-------------|------|
| `trackingSync.ts`          | `tracking-sync`         | every `TRACKING_SYNC_INTERVAL_MIN` | 1 | Polling fallback for courier tracking. |
| `riskRecompute.ts`         | `risk-recompute`        | consumer-only | 2 | Fan-out rescore on RTO / no-answer / rejected. |
| `webhookRetry.ts`          | `webhook-retry`         | every 60s | 1 | Sweeps failed/orphaned `WebhookInbox` rows + reaps payloads. |
| `webhookProcess.ts`        | `webhook-process`       | event-driven | 8 | First-delivery webhook ingestion (sub-second). |
| `fraudWeightTuning.ts`     | `fraud-weight-tuning`   | scheduled | default | Monthly per-signal weight tuner from `FraudPrediction` outcomes. |
| `commerceImport.ts`        | `commerce-import`       | consumer-only | default | CSV / bulk upload import. |
| `automationBook.ts`        | `automation-book`       | consumer-only | default | Auto-book courier (uses `selectBestCourier`). |
| `automationSms.ts`         | `automation-sms`        | consumer-only | default | Confirmation SMS dispatch. |
| `automationStale.ts`       | `automation-stale`      | scheduled | default | Sweeper for stuck `automation.state`. |
| `automationWatchdog.ts`    | `automation-watchdog`   | scheduled | default | Sweeper for over-attempt automation. |
| `cartRecovery.ts`          | `cart-recovery`         | scheduled | default | Cart abandonment recovery messaging. |
| `trialReminder.ts`         | `trial-reminder`        | scheduled | default | Trial-end reminder email/SMS. |
| `subscriptionGrace.ts`     | `subscription-grace`    | scheduled | default | Subscription past-due grace handling. |
| `awbReconcile.ts`          | `awb-reconcile`         | every 60s | 1 | Reconciles stuck `PendingAwb` rows (90s stale threshold, 5 attempts → abandoned). |
| `orderSync.worker.ts`      | `order-sync`            | every 5 min | 1 | Polling fallback for upstream order ingest (Shopify, Woo). |
| `pendingJobReplay.ts`      | `pending-job-replay`    | every 30s | 1 | Drains `PendingJob` rows back onto BullMQ (DLQ replay sweeper). |

`apps/api/src/lib/queue.ts` (574 lines) — queue infrastructure: `safeEnqueue` (3-attempt Redis backoff → Mongo `PendingJob` dead-letter → merchant notification), per-merchant token bucket fairness, in-process counters (`failures`, `retryRecovered`, `deadLettered`, `replayed`, `exhausted`).

---

## D. Webhook ingestion pipelines

`apps/api/src/server/webhooks/`

| File                       | Lines | Purpose |
|----------------------------|------:|---------|
| `courier.ts`               |   371 | Inbound courier webhooks (Pathao / RedX / Steadfast). HMAC-verified on raw body. Writes `WebhookInbox` then calls `applyTrackingEvents` synchronously. |
| `integrations.ts`          |   773 | Inbound commerce platform webhooks (Shopify, Woo, customApi). HMAC / shared-secret per provider. Writes `WebhookInbox` then enqueues `webhook-process`. Hosts the Shopify OAuth router too. |
| `stripe.ts`                |   832 | Stripe billing webhooks. Mounted after `express.json` (uses raw body internally). |
| `shopify-gdpr.ts`          |   323 | Shopify mandatory GDPR webhooks (customer/redact, shop/redact, customer/data_request). |
| `sms-inbound.ts`           |   292 | SMS inbound (replies to confirmation prompts). |
| `sms-dlr.ts`               |   269 | SMS delivery receipt. Updates `Order.automation.confirmationDeliveryStatus`. |
| `twilio.ts`                |    69 | Twilio voice/SMS callback. |

`apps/api/src/server/ingest.ts` (1070 lines) — **central ingestion module:**
- `ingestNormalizedOrder` — Order.create + risk + identity stitching + intent score + audit + invalidation.
- `enqueueInboundWebhook` — ack-fast: stamps `WebhookInbox` and returns.
- `processWebhookOnce` — synchronous variant for tests / dashboard imports.
- `replayWebhookInbox` — replays a stamped row through ingestion (used by both retry sweep and "Replay" button).
- `resolveIdentityForOrder` — stitches existing `TrackingSession` + `TrackingEvent` rows on phone/email match within 30-day lookback.
- `WEBHOOK_RETRY_MAX_ATTEMPTS = 5`, `RETRY_BACKOFF_MS = [1m, 5m, 15m, 30m, 1h]`.

`apps/api/src/lib/integrations/`

| File                | Lines | Purpose |
|---------------------|------:|---------|
| `shopify.ts`        |   663 | Shopify adapter: OAuth, fetch sample orders, webhook normalization. |
| `woocommerce.ts`    |   476 | WooCommerce adapter (REST + JWT/basic auth). |
| `types.ts`          |   178 | `IntegrationAdapter` contract + `NormalizedOrder` + `NormalizationSkip` envelope. |
| `customApi.ts`      |   131 | Custom API adapter (push-only). |
| `safe-fetch.ts`     |    91 | SSRF-safe HTTP wrapper (DNS resolution, IP block-list). |
| `health.ts`         |    65 | Integration health probe. |
| `index.ts`          |    27 | Adapter registry. |

---

## E. Polling fallback systems

| Path | Role |
|------|------|
| `apps/api/src/workers/trackingSync.ts` | Repeats every `TRACKING_SYNC_INTERVAL_MIN`. Calls `pickOrdersToSync` → `syncOrderTracking` per order. Concurrency 4 inside a job. Skips orders with `lastWebhookAt` within 30 min (`WEBHOOK_FRESH_MS`). |
| `apps/api/src/server/tracking.ts:pickOrdersToSync` | Selects active shipments (`shipped` / `in_transit`) with a tracking number and overdue `lastPolledAt`, sorted oldest first. |
| `apps/api/src/server/tracking.ts:syncOrderTracking` | Calls courier adapter `getTracking()`. On error, stamps `logistics.pollError` and bumps `pollErrorCount` — never throws. |
| `apps/api/src/workers/orderSync.worker.ts` | Repeats every 5 min. For each connected `shopify`/`woocommerce` integration, calls `adapter.fetchSampleOrders(creds, 50, lastSyncedAt)` and pushes each delivery through `enqueueInboundWebhook` so polled orders pass through the SAME inbox + dedup as webhooks. Cursor (`lastSyncedAt`) is only advanced when an observed `placedAt` moves the watermark; transient adapter failures leave the cursor untouched. |

---

## F. Status normalization logic

| File | Role |
|------|------|
| `apps/api/src/lib/couriers/types.ts:NormalizedTrackingStatus` | 8-state enum: `pending` / `picked_up` / `in_transit` / `out_for_delivery` / `delivered` / `failed` / `rto` / `unknown`. |
| `apps/api/src/lib/couriers/{pathao,redx,steadfast}.ts` | Each adapter's `getTracking()` and `parse*Webhook()` map provider-specific status strings into `NormalizedTrackingStatus`. |
| `apps/api/src/server/tracking.ts:STATUS_MAP` | Maps `NormalizedTrackingStatus` → `Order.order.status`. Only terminal transitions (`delivered` / `rto`) and `picked_up` / `in_transit` / `out_for_delivery` move order status; the rest stay timeline-only. |
| `apps/api/src/server/tracking.ts:applyTrackingEvents` | **The single chokepoint that writes tracking timeline + status.** Content-hash dedupe (`dedupeKeyFor` on providerStatus + description + location), atomic status guard (refuses to mutate when order moved out of active set), `$slice: -MAX_TRACKING_EVENTS` to bound document size. Used by both webhooks and the polling worker. |

---

## G. Replay & recovery systems

| File | Role |
|------|------|
| `packages/db/src/models/webhookInbox.ts` | **Canonical durability ledger.** Unique `(merchantId, provider, externalId)`. State machine `received → processing → succeeded` / `failed` / `needs_attention` / `dead_lettered`. Carries `attempts`, `nextRetryAt`, `lastError`, `payload` + `payloadReapAt` for post-success eviction. |
| `packages/db/src/models/pendingJob.ts` | Dead-letter store for `safeEnqueue`. Statuses `pending` / `exhausted`. |
| `packages/db/src/models/pendingAwb.ts` | Ledger for in-flight courier bookings. Statuses `pending` / `succeeded` / `abandoned` / `orphaned`. |
| `apps/api/src/server/ingest.ts:replayWebhookInbox` | Replays commerce-platform inbox row. Used by `webhook-process` (first delivery), `webhook-retry` (sweep), and the dashboard "Replay" button. Backoff `[1m, 5m, 15m, 30m, 1h]`, dead-letter at attempt 5 with merchant notification. |
| `apps/api/src/server/courier-replay.ts:replayCourierInbox` | Same shape, but for steadfast/pathao/redx. Re-validates tenant on every replay; refuses to mutate cross-merchant. |
| `apps/api/src/workers/webhookRetry.ts` | Sweeps failed inbox rows whose `nextRetryAt` has elapsed AND orphaned `received` rows (>5 min old). Routes to `replayWebhookInbox` or `replayCourierInbox` based on provider. Also reaps payloads on succeeded rows past `payloadReapAt`. |
| `apps/api/src/workers/webhookProcess.ts` | Event-driven worker. Concurrency 8. First-delivery latency target sub-second under burst. Does NOT throw on failure (so BullMQ's own retry doesn't fight the inbox-row retry schedule). |
| `apps/api/src/workers/pendingJobReplay.ts` | DLQ replay sweep every 30s. Atomic claim via `findOneAndUpdate` + forward `nextAttemptAt`. Backoff `[1m, 5m, 15m, 1h, 4h]`, exhausted at `MAX_REPLAY_ATTEMPTS` with critical merchant alert. |
| `apps/api/src/workers/awbReconcile.ts` | Sweeps `PendingAwb` rows stuck in `pending` for >90s. 5-attempt budget; abandons after exhaustion (releases `bookingInFlight` lock so merchant can re-attempt with a fresh idempotency key). |
| `apps/api/src/lib/queue.ts:safeEnqueue` | 3-retry Redis attempt → Mongo `PendingJob` dead-letter → merchant notification. NEVER throws; returns a discriminated `SafeEnqueueResult` (`ok: true` / `recovered` / `deadLettered` / `ok: false` only when both Redis AND Mongo are down). |
| `apps/api/src/lib/rejectSnapshot.ts` | Snapshot/restore helper for fraud-rejected orders (so a manual "restore" undoes a rejection cleanly). |

---

## H. Operational hint generation

| File | Role |
|------|------|
| `apps/api/src/lib/operational-hints.ts` | `classifyOperationalHint(input)` pure function; 8 stable codes (address_clarification_needed, customer_unreachable_pending_call, delivery_failed_attempt, delivery_attempt_in_progress, stuck_in_transit, stuck_pending_pickup, awaiting_customer_confirmation, confirmation_sms_undelivered). Priority rules; first match wins. Returns `null` for healthy orders. |
| `apps/api/src/server/routers/orders.ts:1636` | Single call site: `getOrder` invokes `classifyOperationalHint` before returning to the dashboard. |
| `apps/web/src/components/orders/operational-hint-panel.tsx` | UI component. Maps severity → icon + colour. |
| `apps/web/src/components/orders/tracking-timeline-drawer.tsx:179` | Mounts `<OperationalHintPanel>` inside the order detail drawer. |
| `apps/api/tests/operational-hints.test.ts` | Behavioural test for the classifier. |

---

## I. Dashboard surfaces (scoring/intelligence)

| Surface | tRPC consumed | Components |
|---------|---------------|------------|
| `app/dashboard/page.tsx` | `analytics.getDashboard`, `analytics.getOrdersLast7Days`, `fraud.getReviewStats` | `KpiBar`, dashboard tiles. |
| `app/dashboard/analytics/page.tsx` | `analytics.getDashboard`, `analytics.getOrdersLast7Days`, `analytics.getBestTimeToCall` | Mounts `<RtoIntelligenceSection />` (4 cards). |
| `app/dashboard/analytics/behavior/page.tsx` | (TBD; not inspected) | Behavior-engagement metrics. |
| `app/dashboard/analytics/couriers/page.tsx` | `analytics.getCourierPerformance` | Courier performance table. |
| `app/dashboard/orders/page.tsx` | `orders.list`, `orders.listCouriers` | Orders table + tracking drawer. |
| `app/dashboard/orders/.../tracking-timeline-drawer.tsx` | `orders.getOrder` (returns `operationalHint`, `intent`, `addressQuality`) | Mounts `<OperationalHintPanel>` + `<IntentPanel>` + `<AddressQualityPanel>`. |
| `app/dashboard/fraud-review/page.tsx` | `fraud.listPendingReviews`, `fraud.getReviewOrder`, `fraud.getReviewStats`, `fraud.markVerified` / `markRejected` / `markNoAnswer` | Manual review queue. |
| `app/dashboard/recovery/page.tsx` | `recovery.list`, `recovery.counts`, `recovery.update`, `recovery.getEntitlements` | RTO recovery tasks. |
| `app/dashboard/call-customer/page.tsx` | (TBD; not inspected) | Call-customer agent surface. |
| `components/intelligence/rto-intelligence-section.tsx` | `analytics.intentDistribution`, `addressQualityDistribution`, `topThanas`, `campaignSourceOutcomes` | 4-card RTO Intelligence v1 surface. |
| `components/orders/intelligence-panels.tsx` | (consumes `order.intent`, `order.addressQuality` via getOrder) | `IntentPanel`, `AddressQualityPanel`. |
| `components/fraud/network-signal.tsx` | (consumes the network risk lookup result via fraud / orders router) | `NetworkSignalPill`, `NetworkSignalCard`. |
| `components/analytics/fraud-section.tsx` | `fraud.getReviewStats` | Fraud snapshot card. |
| `components/analytics/call-center-section.tsx`, `call-heatmap.tsx`, `orders-bar-chart.tsx` | various analytics queries | Charts. |
| `components/dashboard/kpi-bar.tsx` | `analytics.getDashboard` | KPI bar. |
| `components/sidebar/Sidebar.tsx`, `components/shell/notifications-drawer.tsx`, `components/onboarding/activation-moments.tsx`, `components/billing/trial-savings-banner.tsx` | `fraud.getReviewStats` | Fraud-pending badge / activation hint / trial saved-revenue banner. |

---

## J. Files NOT covered here

These exist in the repo but are out of scope for this audit (and were not used as input):

- `apps/api/src/scripts/` — one-shot CLIs (seed, listMerchants, verifyFraudFlow, auditCsvAndBulk, …).
- `apps/api/tests/` — vitest suites; counted but not analyzed.
- `apps/web/e2e/` — Playwright (referenced in `apps/web/CLAUDE.md`; not inspected).
- `apps/web/src/lib/` non-trpc (formatters, friendly-errors, i18n, status-badges).
- `apps/web/src/app/(marketing)/` — landing surface.
- Pre-existing top-level audit MDs (`MONOREPO_SAAS_MASTER_AUDIT.md`, `RTO_PREVENTION_STRATEGY_MASTERPLAN.md`, etc.) — read-only artefacts, not load-bearing for runtime.
