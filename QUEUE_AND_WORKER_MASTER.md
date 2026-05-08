# QUEUE AND WORKER MASTER

Per-queue / per-worker operational reference grounded in `apps/api/src/lib/queue.ts`
and every file under `apps/api/src/workers/`. Worker wiring at boot is verified
against `apps/api/src/index.ts`.

This is the operational truth. If a worker file exists in `src/workers/` but is
not registered in `index.ts`, **it is dead in production no matter how many
tests cover it** (`apps/api/CLAUDE.md` § Worker registration).

---

## 1. Queue inventory

`QUEUE_NAMES` (verbatim from `lib/queue.ts:11-30`):

| Symbol                 | Redis queue name      | Cadence       | Wired in index.ts |
| ---------------------- | --------------------- | ------------- | ----------------- |
| `tracking`             | `tracking-sync`       | repeatable    | yes               |
| `risk`                 | `risk-recompute`      | event-driven  | yes               |
| `fraudWeightTuning`    | `fraud-weight-tuning` | monthly cron  | yes               |
| `webhookProcess`       | `webhook-process`     | event-driven  | yes               |
| `webhookRetry`         | `webhook-retry`       | repeatable 1m | yes               |
| `commerceImport`       | `commerce-import`     | event-driven  | yes               |
| `cartRecovery`         | `cart-recovery`       | repeatable 5m | yes               |
| `trialReminder`        | `trial-reminder`      | repeatable 6h | yes               |
| `subscriptionGrace`    | `subscription-grace`  | repeatable 1h | yes               |
| `automationBook`       | `automation-book`     | event-driven  | yes               |
| `automationWatchdog`   | `automation-watchdog` | repeatable    | yes               |
| `automationSms`        | `automation-sms`      | event-driven  | yes               |
| `automationStale`      | `automation-stale`    | repeatable 1h | yes               |
| `awbReconcile`         | `awb-reconcile`       | repeatable 60s| yes               |
| `orderSync`            | `order-sync`          | repeatable 5m | yes (since 26-05-07) |
| `pendingJobReplay`     | `pending-job-replay`  | repeatable 30s| yes               |

Default job options (all queues, `lib/queue.ts:34-39`):
```
attempts: 3
backoff: { type: "exponential", delay: 5_000 }
removeOnComplete: { count: 1_000, age: 24 * 3600 }
removeOnFail:    { count: 5_000, age: 7 * 24 * 3600 }
```

Per-worker `concurrency` defaults to `4` (`registerWorker` opts). Schedulers / sweep workers override to `1` so multi-instance cooperation stays single-stream.

Queue-wait-time observability (`registerWorker`): when `(processedOn - timestamp) >= 5_000ms`, a structured warn `{evt: "queue.wait_time", queue, jobId, jobName, waitMs, attemptsMade}` fires. Anything over 5s on a transactional queue is a backlog signal worth alerting on.

---

## 2. `safeEnqueue` — the canonical enqueue path

Source: `lib/queue.ts:326-388`. The contract:

1. **Per-merchant token bucket** — fairness across tenants. When `merchantId` is set and `enforceMerchantQuota !== false`, consume tokens from `lib/merchantRateLimit.ts` `consumeMerchantTokens`. On bucket exhaustion the job is **deferred** (BullMQ `delay`, capped at 30s) — never silently dropped. Failure to consume tokens *fails open* on Redis outage so a bad infra day doesn't make a healthy queue worse.
2. **Up to 3 in-process Redis retries**: 50ms → 200ms → 500ms backoff. Most "Redis hiccup" transients clear inside ~750ms.
3. **Dead-letter to Mongo** — `PendingJob.create({...})` if Redis still rejecting. Counter `_counters.deadLettered` bumps; merchant gets a `queue.enqueue_failed` notification (severity `critical`, dedupe key `queue_enqueue_failed:{queue}:{merchantId}:dead_lettered:{hourBucket}`).
4. **Hard fail** — only if Mongo *also* refuses the write. Returns `{ ok: false, error: "redis+mongo unavailable: ..." }`. This is the only path that genuinely loses work.

Discriminated union return type (verbatim, `queue.ts:285-288`):
```
SafeEnqueueResult =
  | { ok: true; jobId?: string; recovered?: boolean }
  | { ok: true; deadLettered: true; pendingJobId: string }
  | { ok: false; error: string; originalError?: string }
```

In-process counters per queue: `failures`, `retryRecovered`, `deadLettered`, `replayed`, `exhausted`. Snapshot via `snapshotEnqueueCounters()` — surfaced on `/admin/system`.

---

## 3. Workers — operational reference

Listed in the order they boot in `apps/api/src/index.ts`.

### 3.1 trackingSync — `apps/api/src/workers/trackingSync.ts`

- Queue: `QUEUE_NAMES.tracking`
- Exports: `registerTrackingSyncWorker()`, `scheduleTrackingSync()`
- Cadence: every `env.TRACKING_SYNC_INTERVAL_MIN` minutes (default 60; `0` disables; clamped 0-1440)
- Concurrency: 1 at sweep level; internal `Promise.all` with chunked concurrency to respect courier rate limits
- Trigger: scheduled repeatable `tracking-sync:repeat`

What it does
- Picks active shipments needing polling — Order rows with `logistics.trackingNumber` set, `lastPolledAt` stale, status `shipped | in_transit`. Indexed by `(order.status, logistics.lastPolledAt)` partial.
- Calls courier adapter for each candidate (in chunks). Pushes new normalized events into `Order.logistics.trackingEvents` with `$push: { $each: [...], $slice: -MAX_TRACKING_EVENTS }`. Stamps `lastPolledAt`, `pollErrorCount`, `pollError`.
- On RTO / cancelled outcome: calls `enqueueRescore({ merchantId, phone, orderId, trigger: "tracking_outcome" })` → fan-out riskRecompute.

DB: Order (read+write logistics, status, fraud); Merchant (read couriers via cache).
Queues: `risk` (rescore).
External: courier adapters (Pathao, RedX, Steadfast).
Failure semantics: per-order errors logged; sweep continues. `pollErrorCount` increments; `pollError` truncated 500 chars.

### 3.2 riskRecompute — `apps/api/src/workers/riskRecompute.ts`

- Queue: `QUEUE_NAMES.risk`
- Exports: `registerRiskRecomputeWorker()`, `enqueueRescore(data)` helper
- Trigger: `enqueueRescore` from `trackingSync`, fraud router actions, manual triggers
- Concurrency: 2

What it does
- Loads Order(s) for `(merchantId, phone)` cohort — every still-open order with the same phone, since outcome history changes their priors.
- Calls `computeRisk` (`server/risk.ts`) with merchant config + history.
- Updates `fraud.riskScore`, `fraud.level`, `fraud.reasons`, `fraud.signals`, `fraud.scoredAt`. **Never overrides terminal review** (`verified | rejected`).
- Fires `fraud.rescored_high` notification on first elevation to HIGH.

Idempotency: jobId encodes `{merchantId}:{phone}:{trigger}:{10sBucket}` so bursts collapse within a 10-second window.
Concurrency safety: CAS via `Order.version`. On conflict, skip (a merchant action may have moved fraud state) and trust the next rescore trigger.
Failure semantics: best-effort; in dev without Redis falls back to sync execution.

### 3.3 webhookRetry — `apps/api/src/workers/webhookRetry.ts`

- Queue: `QUEUE_NAMES.webhookRetry`
- Exports: `registerWebhookRetryWorker()`, `scheduleWebhookRetry(intervalMs)`
- Cadence: every 60s (default; configurable)
- Concurrency: 1
- Trigger: scheduled repeatable `webhook-retry:sweep`

What it does
- Scans `WebhookInbox` rows with `status=failed` AND `nextRetryAt <= now` AND `attempts < MAX`.
- Also scans `status=received` orphans older than 5 minutes (a healthy `webhookProcess` should drain those; 5 min is a generous cutoff).
- Invokes `replayWebhookInbox(row)` per row.
- Piggyback **payload reap**: in the same sweep, NULLs `payload` and `payloadBytes` on rows where `status=succeeded AND payloadReaped=false AND payloadReapAt <= now`. Batched 500/sweep.

Verbatim from the worker:
> *"We deliberately do NOT throw on failed so BullMQ's own retry doesn't fight the sweep — row already carries canonical attempts counter + backoff schedule."*

DB: WebhookInbox (read+write); Order (via `replayWebhookInbox` → `ingestNormalizedOrder`).
Queues: none directly (`webhookProcess` is event-driven from the route).
Failure semantics: on `replay` failure, increments `attempts`, computes next backoff, sets `status=failed` + `nextRetryAt`. Once `attempts` hits cap, sets `deadLetteredAt` and `status=needs_attention` if order-shaped.

### 3.4 webhookProcess — `apps/api/src/workers/webhookProcess.ts`

- Queue: `QUEUE_NAMES.webhookProcess`
- Exports: `registerWebhookProcessWorker()` (event-driven; no schedule)
- Concurrency: 8
- Trigger: enqueued by `/api/integrations/webhook/{provider}` on inbox-row stamp; also by `orderSync` worker per synced order

What it does
- Calls `replayWebhookInbox(inboxId)` for sub-second processing (vs. the bounded sweep).
- WebhookInbox unique key prevents double-ingest if both webhookProcess and webhookRetry pick the same row.

Verbatim:
> *"We deliberately do NOT throw on failed so BullMQ's own retry doesn't fight the sweep — row already carries canonical attempts counter + backoff schedule."*

`attempts: 1` — retry policy is owned by the `webhookRetry` sweep.

### 3.5 fraudWeightTuning — `apps/api/src/workers/fraudWeightTuning.ts`

- Queue: `QUEUE_NAMES.fraudWeightTuning`
- Exports: `registerFraudWeightTuningWorker()`, `scheduleFraudWeightTuning(cron)`
- Cadence: monthly, cron `15 3 1 * *` (1st of month at 03:15 UTC)
- Concurrency: 1

What it does (per merchant)
- Pulls 90 days of `FraudPrediction` rows where `outcome` is set.
- Floor: `MIN_SAMPLE_SIZE = 50` resolved predictions; merchants below floor are skipped.
- Computes base RTO rate `rtoCount / resolvedNonCancelled` (cancelled excluded).
- For every signal key with `MIN_SIGNAL_HITS = 10` observations:
  - precision = `rtoHits / hits`
  - lift     = `precision / baseRtoRate`
  - multiplier = `sqrt(lift)` (smoothing), clamped to `[0.5, 1.5]`
- Persists to `Merchant.fraudConfig`:
  - `signalWeightOverrides`: `Map<key, multiplier>`
  - `baseRtoRate`: calibrated anchor (replaces platform 0.18 default)
  - `weightsVersion`: `tuned-YYYY-MM`
  - `lastTunedAt`

Verbatim on cadence:
> *"Why monthly: signal stability > reactivity. Weekly overfits to seasonal blips. Quarterly too lagging. Why per-merchant: a beauty merchant's extreme COD looks nothing like electronics."*

### 3.6 commerceImport — `apps/api/src/workers/commerceImport.ts`

- Queue: `QUEUE_NAMES.commerceImport`
- Exports: `registerCommerceImportWorker()`, helper `enqueueCommerceImport`
- Concurrency: 2
- Trigger: `integrations.importOrders` mutation (creates `ImportJob` row, enqueues)
- BullMQ attempts: 1 (no auto-retry; failures need a manual re-click)

What it does
- Reads `Integration` (credentials), calls adapter `fetchSampleOrders` (Shopify / WooCommerce / custom_api). Per order, calls `ingestNormalizedOrder`.
- Streams progress to `ImportJob.{processedRows, importedRows, duplicateRows, failedRows}` every 5 rows or on the final row.
- Partial success (some imported + duplicates + failed) marked as `succeeded`.
- Verbatim: *"Resumable behavior intentionally NOT modeled — adapters only support fetch most recent N, so retried job restarts from scratch."*

### 3.7 automationBook — `apps/api/src/workers/automationBook.ts`

- Queue: `QUEUE_NAMES.automationBook`
- Exports: `registerAutomationBookWorker()` (event-driven)
- Concurrency: 4
- Trigger: `enqueueAutoBook` from order-create flow when automation engine decides to auto-book

What it does
- Loads Order; verifies still in `pending | confirmed | packed` (anything else is a no-op success).
- Selects courier via `courier-intelligence.ts` `selectBestCourier`. Honours `automation.pinnedCourier` for the FIRST attempt (skips intelligence).
- **`bookSingleShipment`**:
  - Acquires the booking lock atomically: `findOneAndUpdate` guarded on `bookingInFlight !== true` AND `version` CAS.
  - Stamps `PendingAwb` row BEFORE upstream call. `idempotencyKey = sha256(orderId + ":" + attempt)`.
  - Calls courier adapter `createAWB(...)` with the idempotency key as upstream header.
  - On success: `Order.logistics.{trackingNumber, courier, shippedAt, bookingInFlight=false}`, `automation.{selectedCourier, bookedByAutomation=true}`, `PendingAwb.status=succeeded`.
  - On failure: `bookingInFlight=false`, `PendingAwb.status=failed`, `recordCourierBookFailure` (rolling 1h window for circuit breaker), and **enqueue fallback** with next-best courier (jobId encodes attempt counter; `MAX_ATTEMPTED_COURIERS=3`).
- On all couriers exhausted: critical merchant notification (`automation.watchdog_exhausted`).

CAS filter on `version` prevents stale overwrites when a concurrent restore moves the order back.

### 3.8 automationSms — `apps/api/src/workers/automationSms.ts`

- Queue: `QUEUE_NAMES.automationSms`
- Exports: `registerAutomationSmsWorker()` (event-driven)
- Concurrency: 4
- BullMQ attempts: 5; backoff 15s exponential
- jobId: `auto-sms:{orderId}` — dedupes
- Trigger: `enqueueOrderConfirmationSms` from order-create when state=`pending_confirmation`

What it does
- Calls `sendOrderConfirmationSms` (SSL Wireless). On state guard mismatch (order moved to `confirmed | rejected`), silently skips so a chatty restoring merchant doesn't get a duplicate prompt.
- Stamps `Order.automation.{confirmationSentAt, confirmationChannel}` on success.
- Provider failure throws to trigger BullMQ retry.

Verbatim:
> *"Reliable outbound for pending_confirmation prompt SMS. If SMS gateway was down at order create, SMS now gets BullMQ-grade retries."*

### 3.9 automationStale — `apps/api/src/workers/automationStale.ts`

- Queue: `QUEUE_NAMES.automationStale`
- Exports: `registerAutomationStaleWorker()`, `scheduleAutomationStaleSweep()`
- Cadence: every 1h (default)
- Concurrency: 1

What it does
- Two-stage escalation on orders stuck in `automation.state = pending_confirmation`:
  - **24h stale**: notify merchant + escalate `fraud.reviewStatus=pending_call`.
  - **72h stale**: auto-cancel: `order.status=cancelled`, `automation.state=rejected`, `fraud.smsFeedback=no_reply`.
- Updates use CAS via `Order.version`. If merchant confirmed/rejected/restored between scan and write, update misses cleanly.
- Dedup keys: `automation_stale:{orderOid}` (notify), `automation_expired:{orderOid}` (expire).

### 3.10 automationWatchdog — `apps/api/src/workers/automationWatchdog.ts`

- Queue: `QUEUE_NAMES.automationWatchdog`
- Exports: `registerAutomationWatchdogWorker()`, `scheduleAutomationWatchdog()`
- Cadence: scheduled
- Concurrency: 1

What it does (best-effort): sweeps for orders where `automation.state=auto_confirmed` AND `autoBookEnabled=true` but no booking happened (e.g. `automationBook` enqueue failed catastrophically AND dead-letter never replayed). Re-enqueues `automationBook` with `enforceMerchantQuota=false` so the watchdog isn't billable to one merchant's bucket.

### 3.11 cartRecovery — `apps/api/src/workers/cartRecovery.ts`

- Queue: `QUEUE_NAMES.cartRecovery`
- Exports: `registerCartRecoveryWorker()`, `scheduleCartRecovery()`
- Cadence: every 5m (default; `0` disables)
- Concurrency: 1

What it does
- Scans `TrackingSession` with `abandonedCart=true AND converted=false AND (phone OR email)`.
- Window: `30min` minimum age (so we don't notify before an active session ends) up to `7 days` recovery window.
- Upserts `RecoveryTask` keyed `(merchantId, sessionId)` with `$setOnInsert` so re-runs never overwrite agent state.
- Emits one `recovery.cart_pending` Notification per merchant per day-bucket (dedupeKey).

### 3.12 trialReminder — `apps/api/src/workers/trialReminder.ts`

- Queue: `QUEUE_NAMES.trialReminder`
- Exports: `registerTrialReminderWorker()`, `scheduleTrialReminder()`
- Cadence: every 6h (default)
- Concurrency: 1

What it does
- Targets merchants on `trial` status with `trialEndsAt` within `env.TRIAL_WARNING_DAYS` (default 3).
- Atomic claim: `findOneAndUpdate` with mismatch guard on `notificationsSent.trialEndingAt` — only one worker fires per trial cycle.
- Sends `buildTrialEndingEmail` (Resend). Email failure is swallowed; the marker is still set so we don't re-fire.

Verbatim:
> *"Multi-instance safe — findOneAndUpdate guards ensure only one worker fires even if two pick same merchant same tick."*

### 3.13 subscriptionGrace — `apps/api/src/workers/subscriptionGrace.ts`

- Queue: `QUEUE_NAMES.subscriptionGrace`
- Exports: `registerSubscriptionGraceWorker()`, `scheduleSubscriptionGrace()`
- Cadence: every 1h (default; `0` disables)
- Concurrency: 1

What it does
- Targets merchants on `subscription.status=past_due` AND `gracePeriodEndsAt <= now`.
- Atomically flips `status=suspended`, sends `buildSubscriptionSuspendedEmail`. Re-runs are no-ops once suspended.
- Recovery is orthogonal: `webhooks/stripe.ts invoice.payment_succeeded` flips back to `active` and clears `gracePeriodEndsAt`.

Indexed by `(subscription.status, subscription.gracePeriodEndsAt)` partial — only rows that have a deadline are scanned.

### 3.14 awbReconcile — `apps/api/src/workers/awbReconcile.ts`

- Queue: `QUEUE_NAMES.awbReconcile`
- Exports: `registerAwbReconcileWorker()`, `scheduleAwbReconcile()`
- Cadence: every 60s (default; `0` disables)
- Concurrency: 1

What it does
- Sweeps `PendingAwb.status=pending` rows with `requestedAt < now - 90s` (stale-lock threshold).
- Three outcomes:
  1. Order has `logistics.trackingNumber` — courier already booked but our success path was interrupted. Mark `PendingAwb.status=succeeded`. Catchup ledger.
  2. No tracking, `reconcileAttempts < 5` — increment, leave `pending` for next sweep.
  3. No tracking, attempts exhausted — `status=abandoned`, release `Order.logistics.bookingInFlight=false` so the next booking attempt can acquire the lock.
- Orphaned orders (deleted) marked `status=orphaned` separately.

Verbatim:
> *"Conservative — only flips ledger states verifiable from our DB; never assumes whether courier created AWB."*

### 3.15 orderSync — `apps/api/src/workers/orderSync.worker.ts`

- Queue: `QUEUE_NAMES.orderSync`
- Exports: `registerOrderSyncWorker()`, `scheduleOrderSync(intervalMs)`
- Cadence: every 5 minutes (`DEFAULT_INTERVAL_MS`; configurable; `0` disables)
- Concurrency: 1
- Wired 2026-05-07 — fixed a long-standing "silent revenue hole" where webhook delivery breaks on uninstall+reinstall, scope drop, or platform outage.

What it does
- For each connected `Integration` (Shopify / WooCommerce only — `custom_api` and `csv` skipped), calls adapter `fetchSampleOrders(since: lastSyncedAt)`.
- Per order: `enqueueInboundWebhook` → `webhookProcess` → `ingestNormalizedOrder`. Same dedupe key path as live webhooks (WebhookInbox `(merchantId, provider, externalId)` unique).
- Anchors cursor on `newestPlacedAt`. Empty batches keep `lastSyncedAt` unchanged so the next tick re-fetches the same window if upstream is stable.
- On adapter failure: leave cursor unchanged, log, retry next tick. Never advances cursor past unfetched orders.

Verbatim from `index.ts`:
> *"Polling fallback for upstream order ingest. Absence of this worker is the canonical 'silent revenue hole' failure mode; it was previously declared but not wired."*

### 3.16 pendingJobReplay — `apps/api/src/workers/pendingJobReplay.ts`

- Queue: `QUEUE_NAMES.pendingJobReplay`
- Exports: `startPendingJobReplayWorker()`, `ensureRepeatableSweep()`
- Cadence: every 30s (default; configurable)
- Concurrency: 1
- Source of work: rows written by `safeEnqueue` when Redis was unavailable

What it does
- Atomically claims `PendingJob` row: `findOneAndUpdate({status:"pending", nextAttemptAt:{$lte:now}}, {$set:{nextAttemptAt:now+1d}, $inc:{attempts:1}})`. Forward-bumps so a sibling sweeper sees a future deadline.
- Calls `getQueue(queueName).add(jobName, data, opts)`.
- On success: `__bumpReplayed(queueName)`, delete the row, log `queue.dead_letter_replayed`.
- On failure: leave `status=pending`, schedule next attempt with exponential backoff `[1m, 5m, 15m, 1h, 4h]` (per `attempts`).
- After `MAX_REPLAY_ATTEMPTS = 5` total failures: `status=exhausted`, `__bumpExhausted(queueName)`, fire critical alert. Push `nextAttemptAt` 365 days into the future to prevent tight-loop scanning.

Verbatim:
> *"Multi-instance safe — each row claimed via findOneAndUpdate + forward-bumped nextAttemptAt so sibling sweeper sees future deadline."*

---

## 4. Cross-cutting operational guarantees

| Guarantee                            | How it's enforced                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| **At-least-once delivery**           | BullMQ `attempts: 3` + `safeEnqueue` retry + `PendingJob` dead-letter + replay sweeper      |
| **Idempotent re-execution**          | per-worker: jobId dedup; per-row: WebhookInbox unique key; per-Order: source.externalId    |
| **Ordering not assumed**             | every consumer is idempotent and CAS-safe                                                  |
| **Exactly-once writes**              | `Order.create` runs in a Mongoose transaction; post-save stats hook reuses the session     |
| **Optimistic concurrency**           | `Order.version` CAS via `lib/orderConcurrency.ts`                                          |
| **Per-merchant fairness**            | token bucket in `lib/merchantRateLimit.ts`; `safeEnqueue` defers on bucket exhaustion       |
| **Multi-instance schedule de-dup**   | BullMQ keys repeats by hash of `(name, repeat opts)`                                       |
| **Graceful shutdown**                | `index.ts` 4-step sequence with 25s watchdog; `worker.close()` lets current job finish      |
| **Backlog observability**            | `queue.wait_time` warn fires when active-pickup latency ≥ 5s                                |
| **Dead-letter observability**        | `_counters.{failures, retryRecovered, deadLettered, replayed, exhausted}` per queue         |

---

## 5. Replay matrix

| Failure scenario                          | Recovery path                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Redis blip < 750ms                        | `safeEnqueue` in-process retry; `recovered: true`. Counter `retryRecovered` bumps.            |
| Redis down for minutes                    | `safeEnqueue` dead-letters to `PendingJob`; `pendingJobReplay` drains when Redis returns.    |
| Redis + Mongo both down                   | `safeEnqueue` returns `{ ok: false }`. The single path that loses work.                       |
| Worker crash mid-job                      | BullMQ requeues per `attempts`; worker.close() lets the job finish before disposing.         |
| Webhook delivered twice                   | `WebhookInbox(merchantId, provider, externalId)` unique → second insert collides → ignored.   |
| Order `createOrder` re-submitted (double-click) | `Order.source.clientRequestId` partial-unique → second insert collides; first row returned. |
| Booking attempt crashes after upstream call | `PendingAwb` ledger row retains `pending`. `awbReconcile` reconciles based on whether `Order.logistics.trackingNumber` was written. |
| Webhook delivery silently breaks          | `orderSync` polling fallback re-discovers since the last cursor.                              |
| Stripe webhook delivered twice            | `Payment.providerEventId` / `invoiceId` partial-unique → second insert ignored.               |
| Tracking poll misses an event             | Next poll (interval) catches it; events idempotent via `dedupeKey`.                           |
| Merchant rejects then restores            | `preActionSnapshot` reverses fraud + automation + order.status atomically.                    |

---

## 6. What lives in `lib/queueState.ts`

Read-only helpers consumed by `adminObservability` to render `/admin/system`:

- BullMQ counts per queue (waiting / active / completed / failed / delayed / paused)
- Latest dead-letter rows
- Repeatable schedules currently registered
- `snapshotEnqueueCounters()` from `lib/queue.ts`

This is read-only; mutating the queue from the admin UI requires step-up.
