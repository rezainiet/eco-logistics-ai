# Execution Flow Mapping

**Status:** discovery snapshot, 2026-05-08.
**Scope:** how a request, webhook, polling tick, or replay actually moves through the system at runtime. Code references use `path:line` where stable.

---

## 1. Commerce-platform webhook (Shopify / Woo / customApi)

```
POST /api/integrations/webhook/<provider>/<merchantId>
   │
   ├── webhookLimiter (rate limit middleware)
   ├── raw-body parser (mounted BEFORE express.json — index.ts:234)
   │
   ▼
server/webhooks/integrations.ts
   │  1. Look up Integration by (merchantId, provider).
   │  2. Verify signature using stored secret on the RAW body.
   │  3. Adapter.normalizeWebhookPayload(topic, payload) →
   │       NormalizedOrder | NormalizationSkip | null.
   │  4. ingest.enqueueInboundWebhook({...})
   │
   ▼
server/ingest.ts:enqueueInboundWebhook
   │  WebhookInbox.create({ status: "received", externalId, payload, payloadBytes, ... })
   │  → unique (merchantId, provider, externalId): E11000 ⇒ duplicate ⇒ return prior row.
   │
   ▼
   safeEnqueue("webhook-process", { inboxId })
   │  Path → BullMQ (3-attempt 50/200/500ms backoff)
   │  Path → on Redis fail: PendingJob row + merchant notification (deadLettered)
   │
   ▼ (response: 202 in <50ms)

…asynchronously…
workers/webhookProcess.ts (concurrency 8)
   │
   ▼
server/ingest.ts:replayWebhookInbox(inboxId)
   │  - skip if status === "succeeded"
   │  - skip if status === "needs_attention" && !manual
   │  - adapter.normalizeWebhookPayload(topic, inbox.payload)
   │       null            → mark "succeeded" with lastError "ignored on replay"
   │       NormalizationSkip → mark "needs_attention", fire merchant notification
   │       NormalizedOrder → continue
   │
   ▼
server/ingest.ts:ingestNormalizedOrder
   │  1. Normalize phone (E.164).
   │  2. Duplicate guard: Order.findOne by (merchantId, source.externalId).
   │  3. reserveQuota → check merchant plan cap.
   │  4. getMerchantValueRollup → adaptive p75 / avg COD.
   │  5. computeAddressQuality + extractThana (gated on ADDRESS_QUALITY_ENABLED).
   │  6. collectRiskHistory + computeRisk.
   │  7. Order.create({ fraud:{level,riskScore,signals,reasons,reviewStatus},
   │                    address:{quality}, source:{addressHash,externalId,…} }).
   │     E11000 race ⇒ refund quota, refetch winner, return duplicate.
   │  8. FraudPrediction.create (idempotent by orderId).  [void, best-effort]
   │  9. writeAudit "order.ingested".
   │ 10. Integration.updateOne (lastSyncAt, ordersImported++).
   │ 11. fireFraudAlert if risk.level === "high".
   │ 12. invalidate(`dashboard:<merchantId>`).
   │ 13. void resolveIdentityForOrder (back-stitches TrackingSession + TrackingEvent).
   │ 14. void scoreIntentForOrder (gated on INTENT_SCORING_ENABLED).
   │
   ▼
WebhookInbox.updateOne({ status: "succeeded", processedAt, resolvedOrderId })
   on failure: status:"failed", attempts++, nextRetryAt = now + backoff(attempts)
```

**Failure / retry flow** (background sweep, every 60s):

```
workers/webhookRetry.ts:sweepWebhookRetryQueue
   │  WebhookInbox.find({
   │    $or: [
   │      { status:"failed", nextRetryAt:{$lte:now}, attempts:{$lt:5} },
   │      { status:"received", receivedAt:{$lte: now - 5m} }   // orphan recovery
   │    ]
   │  })
   │
   ▼ per row:
   │  isCourierInboxProvider(provider) ? replayCourierInbox : replayWebhookInbox
   │
   ▼ at attempt 5:
   │  status:"failed", deadLetteredAt:now → merchant Notification (severity critical).
   │
   ▼ piggybacked: reapWebhookPayloads — NULLs `payload` on succeeded rows past payloadReapAt.
```

---

## 2. Courier webhook (Pathao / RedX / Steadfast)

```
POST /api/webhooks/courier/<provider>/<merchantId>
   │
   ├── raw-body parser
   │
   ▼
server/webhooks/courier.ts:handleCourierWebhook
   │  1. Validate merchantId path param (Types.ObjectId.isValid).
   │  2. Merchant.findById → load couriers[].
   │  3. Pick the matching courier config; refuse 401 if no apiSecret configured.
   │  4. cfg.verify(rawString, sigHeader, secret).
   │  5. cfg.parse(payload) → ParsedTrackingEvent | null.
   │  6. Order.findOne({merchantId, "logistics.trackingNumber": parsed.trackingCode}).
   │     - tenant defence-in-depth: refuse if order.merchantId !== url merchantId (403).
   │     - order missing: write a "drop" inbox row (succeeded, "order not found"), 200.
   │  7. WebhookInbox.create({status:"processing", externalId=hash(trackingCode|status|at)}).
   │     E11000 ⇒ duplicate (replayWithinWindow flag derived from prior processedAt).
   │  8. server/tracking.ts:applyTrackingEvents(order, normalizedStatus, [event],
   │       { source: "webhook", deliveredAt }).
   │  9. WebhookInbox.updateOne({status:"succeeded", processedAt:now}).
   │     on failure: status:"failed", attempts++, nextRetryAt = now+60s.
```

**Replay path** (`server/courier-replay.ts:replayCourierInbox`) is identical in shape to
`replayWebhookInbox` and is selected by `webhook-retry` via
`isCourierInboxProvider(provider)`.

---

## 3. `applyTrackingEvents` — the tracking chokepoint

`server/tracking.ts:77`. **The single writer for tracking timeline + order.status transitions** (called by both webhook and polling paths).

```
inputs:
  order (lean projection: _id, merchantId, order, logistics)
  normalizedStatus (8-state enum)
  events: [{ at?, providerStatus?, description?, location? }]
  options: { source: "webhook" | "poll", deliveredAt? }

flow:
  1. Build dedupeKey per event = sha1(providerStatus|description|location)[:24].
  2. Drop events whose dedupeKey is already in logistics.trackingEvents.
  3. nextStatus = STATUS_MAP[normalizedStatus] ?? prevStatus  (no-op when unmapped).
  4. Build $set:
       source==="webhook" → logistics.lastWebhookAt = now
       source==="poll"    → logistics.lastPolledAt  = now, pollError = null
       on delivered/rto   → stamp deliveredAt / returnedAt
  5. $push events with $slice: -MAX_TRACKING_EVENTS.
  6. Atomic guard: filter on { _id, "order.status": $in [active set ∪ prevStatus],
                                logistics.trackingEvents.dedupeKey: $nin newKeys }.
     — refuses to mutate when:
        a) order has moved to a status outside the active set, OR
        b) any new dedupeKey raced in between read and write.
  7. On terminal status flip (delivered / rto / cancelled):
        MerchantStats.updateOne { $inc: { [prev]:-1, [next]:+1 } }
        invalidate dashboard cache
        if rto: enqueueRescore (risk-recompute)
        FraudPrediction.updateOne { $set: { outcome, outcomeAt } }
        contributeOutcome (fraud-network) — phoneHash, addressHash
        recordCourierOutcome (courier-intelligence) — per (merchant, courier, district)
                                                       with derived deliveryHours.
  return { newEvents, statusTransition? }
```

`STATUS_MAP` is intentionally partial: `picked_up`/`in_transit`/`out_for_delivery → in_transit`,
`delivered → delivered`, `rto/failed → rto`. `pending` and `unknown` do not move status.

---

## 4. Polling fallback — tracking sync

`workers/trackingSync.ts:registerTrackingSyncWorker` + `scheduleTrackingSync`.

```
every TRACKING_SYNC_INTERVAL_MIN min (BullMQ repeatable):
   │
   ▼
processBatch:
   pickOrdersToSync(batchSize, maxAgeMs)
      Order.find({
        order.status ∈ {shipped, in_transit},
        logistics.trackingNumber: exists,
        // overdue poll
        $or: [no lastPolledAt, lastPolledAt < pollCutoff],
        // …AND no recent webhook
        $and: [{ $or: [no lastWebhookAt, lastWebhookAt < (now - 30 min)] }]
      }).sort({ lastPolledAt: 1 }).limit(batchSize)
   │
   ▼  CONCURRENCY = 4 (in-job fan-out)
syncOrderTracking(order)
   │  1. resolve adapter (skip "no_adapter").
   │  2. load merchant.couriers[name] (skip "no_courier_config").
   │  3. adapter.getTracking(trackingNumber) → TrackingInfo | throws.
   │     on throw: stamp logistics.pollError + bump pollErrorCount.
   │  4. applyTrackingEvents(order, info.normalizedStatus, info.events,
   │                          {source:"poll", deliveredAt: info.deliveredAt})
```

The `lastWebhookAt < now - 30min` filter (`WEBHOOK_FRESH_MS`) avoids redundant courier API calls when the webhook path is already current.

---

## 5. Polling fallback — order sync (commerce platforms)

`workers/orderSync.worker.ts:runOrderSyncOnce`.

```
every 5 min (BullMQ repeatable):
   │
   ▼
For each Integration { status:"connected", provider ∈ {shopify, woocommerce} }:
   │  - skip if integration.pausedAt set (soft pause).
   │  - decrypt credentials.
   │  - adapter.fetchSampleOrders(creds, 50, lastSyncedAt) → { ok, rawDeliveries[], sample[] }
   │       on adapter throw OR ok:false:
   │         Integration.update { errorCount++, lastSyncStatus:"error", lastError },
   │         leave lastSyncedAt UNCHANGED → next tick re-fetches.
   │
   ▼ per delivery:
   │  enqueueInboundWebhook({ provider, externalId, topic, payload, payloadBytes })
   │     → SAME inbox path as webhook traffic.
   │     E11000 ⇒ duplicate (webhook beat us) ⇒ no enqueue.
   │  on fresh row:
   │     safeEnqueue("webhook-process", { inboxId })   [merchant context attached]
   │
   ▼
   Integration.update {
     lastSyncStatus: "ok", errorCount:0, lastError:null,
     lastImportAt: now (only when enqueued|duplicates>0),
     lastSyncedAt: max(observed placedAt) (only when it strictly moves the watermark)
   }
```

**Why this is replay-safe.** Polled orders go through the same `WebhookInbox` that webhooks use; dedup is enforced by `(merchantId, provider, externalId)`. Adapter failures leave the cursor untouched, so transient blips self-heal next tick. Inbox-stamp failures don't bump the cursor past the unstamped row.

---

## 6. Storefront SDK collector

`server/tracking/collector.ts` (mounted at `/api/track`).

```
POST /api/track/collect
   │
   ▼ Layer F — concurrency cap (tryAcquireCollectorSlot) — 503 on saturation.
   ▼ Parse JSON, basic shape validation.
   ▼ resolveMerchantFromKey(trackingKey) — LRU(5000, 5m); 401 unknown.
   ▼ Layer C — verifyHmac(rawBody, sig, secret, strict).
   ▼ Layer B — validateBatch(events, now); reject malformed shape (400).
   ▼ Layer E — claimSessionOwnership(sid, merchantId); 409 cross-merchant.
   ▼ Per-session inflation cap (5000 events; cache + DB recheck).
   ▼ Layer A — checkRateLimits (IP / key / merchant / per-session); 429.
   ▼ Layer D — checkIdenticalPayloads (silent drop) + checkSpike (flag).
   ▼ Build TrackingEvent docs (PII clamped, properties size-capped 8KB).
   ▼ TrackingEvent.insertMany({ ordered: false }) — E11000 on clientEventId is the
        idempotency happy path.
   ▼ TrackingSession.updateOne (upsert) — bump pageViews/productViews/... counts,
        $max lastSeenAt, set converted/abandonedCart, set repeatVisitor.
   ▼ TrackingSession second updateOne — pipeline $set durationMs from lastSeen − firstSeen.
   ▼ on identifyPhone || email && session known:
        stitchExistingOrder → resolveIdentityForOrder
              → updates TrackingSession.resolvedOrderId
              → rewrites stored phones to canonical.
   ▼ recordAccepted(merchantId, count); 200.
```

---

## 7. Risk recompute fan-out

Triggered from:
- `applyTrackingEvents` on terminal `rto` flip → `enqueueRescore({trigger:"order.rto"})`.
- Fraud review actions (`fraud.markRejected`, `fraud.markNoAnswer`) — see `routers/fraud.ts`.

```
workers/riskRecompute.ts:processRescoreJob({ merchantId, phone, trigger, triggerOrderId? })
   │
   ▼
   Order.find({ merchantId, "customer.phone": phone,
                 "order.status": ∈ NON_TERMINAL_STATUSES,
                 _id ≠ triggerOrderId })
   │
   ▼ per order:
   │  collectRiskHistory(...) + computeRisk(...) (per-merchant fraudConfig)
   │  optimistic-CC write via updateOrderWithVersion (skip on version conflict)
   │  audit "risk.recomputed"
   │  if level transitions to HIGH → fireFraudAlert("fraud.rescored_high")
   │
   ▼ enqueue dedupe: jobId = `${merchantId}:${phone}:${trigger}:${10s-bucket}`.
```

`enqueueRescore` falls back to **synchronous** processing in dev/test when Redis is unavailable, so signal reliability doesn't degrade in non-prod environments.

---

## 8. AWB booking + reconciliation

```
workers/automationBook.ts:processAutoBook (consumer-only)
   │  selectBestCourier({ merchantId, district, candidates, preferredCourier })
   │      → chooses based on per-(merchant, courier, district) outcome stats
   │        with fallback to merchant `_GLOBAL_` aggregate, recent-failure penalty,
   │        cold-start neutral score.
   │  PendingAwb.create({ status:"pending", attempt, idempotencyKey, ... })
   │  adapter.createAWB(...)  (Idempotency-Key forwarded upstream)
   │  on success → Order.updateOne { logistics.trackingNumber, awbCreatedAt, ... },
   │                PendingAwb.updateOne { status:"succeeded", trackingNumber }.
   │  on adapter failure → recordCourierBookFailure + bump retry/abandon path.
```

`workers/awbReconcile.ts` sweeps `PendingAwb` rows stuck in `pending` for >90s every 60s. Per row:

| Order state                            | Action |
|----------------------------------------|--------|
| Order missing                          | mark `orphaned`, audit. |
| Order has trackingNumber               | mark `succeeded` (some other path beat us); release `bookingInFlight` lock. |
| No tracking yet, attempts < 5          | bump `reconcileAttempts`, retry next sweep. |
| No tracking yet, attempts == 5         | mark `abandoned` (release lock so merchant can re-attempt with fresh idempotencyKey). |

---

## 9. Dead-letter replay

`safeEnqueue` failure path → `PendingJob.create({status:"pending", nextAttemptAt})`.

```
workers/pendingJobReplay.ts:sweepPendingJobs (every 30s)
   │  Atomic claim per row: findOneAndUpdate({status:"pending", nextAttemptAt:$lte:now},
   │                                         {$set:{nextAttemptAt: now+60s}}).
   │
   ▼ getQueue(row.queueName).add(row.jobName, row.data, row.jobOpts)
   │   on success: PendingJob.deleteOne; bump replayed counter; log.
   │
   ▼ on throw:
        attempts++, lastError, status:"pending" with backoff [1m,5m,15m,1h,4h]
        OR status:"exhausted" once attempts ≥ MAX_REPLAY_ATTEMPTS (critical merchant alert).
```

---

## 10. Anomaly detection (admin observability)

`lib/anomaly.ts:runAnomalyDetection` — invoked from `routers/adminObservability.ts` (or a scheduled hook). Four detectors compare the last hour against the preceding 23h:

- `payment_spike` — Manual `Payment` documents.
- `webhook_failure_spike` — `WebhookInbox` rows in `failed`.
- `automation_failure_spike` — `AuditLog` actions `automation.auto_book_failed` / `confirmation_sms_failed` / `watchdog_exhausted`.
- `fraud_spike` — `Order` docs with `fraud.level === "high"`.

Per-detector dedupe via `AuditLog` row keyed `dedupeKey = "<kind>:<hourBucket>"`. Side-effect: lazy import of `admin-alerts.deliverAdminAlert` (in-app / email / SMS), wrapped so delivery failure never reaches back into the detector loop.

---

## 11. Boot, registration, and shutdown

```
apps/api/src/index.ts:main
   ↦ env validation
   ↦ connectDb()
   ↦ assertRedisOrExit() + initQueues()
   ↦ register every worker (16, list in apps/api/CLAUDE.md "Currently wired")
   ↦ schedule every repeatable
   ↦ ensureRepeatableSweep (pending-job-replay)
   ↦ Express middleware: helmet, cors,
     RAW-BODY ROUTERS BEFORE express.json:
        /api/webhooks/courier
        /api/webhooks/sms-inbound
        /api/webhooks/sms-dlr
        /api/integrations/webhook
        /api/webhooks/shopify/gdpr
     express.json({ limit: "1mb" })
     /health, /auth, /admin
     /api/webhooks/stripe (raw inside)
     /api/webhooks/twilio
     /api/integrations  (Shopify OAuth, NOT raw)
     /api/track (collector — own raw parser)
     tRPC at /trpc
   ↦ server.listen(env.API_PORT)

shutdown(SIGINT|SIGTERM)
   ↦ server.close (await)
   ↦ shutdownQueues
   ↦ disconnectDb
   ↦ process.exit(0)
   25s watchdog (.unref()) bounds drain to Railway's 30s window.
```

---

## 12. Observed invariants the runtime depends on

1. **Inbox is the source of truth for replay.** Every webhook (commerce + courier) writes a `WebhookInbox` row before any side-effect. Idempotency comes from the unique `(merchantId, provider, externalId)`.
2. **Polling and webhook share the same destinations.** `applyTrackingEvents` for tracking; `enqueueInboundWebhook` for new orders. Duplicates are impossible by index.
3. **`safeEnqueue` never throws.** Either the job lands on Redis, or it lands in `PendingJob`. The only `ok:false` outcome requires both Redis and Mongo to be down.
4. **Tenant boundary is the URL path, not the payload.** Every webhook handler scopes to the merchantId in the route. `replayCourierInbox` re-checks tenant on every replay.
5. **Optimistic concurrency on Order.** `version` field + `updateOrderWithVersion` everywhere a write could race a manual review action. Risk recompute SKIPS on version conflict rather than clobber merchant intent.
6. **Observation-only intelligence.** `intent`, `addressQuality`, `operationalHint` never feed `computeRisk`. Cross-merchant `lookupNetworkRisk` returns a capped bonus and never raw merchant identities.
