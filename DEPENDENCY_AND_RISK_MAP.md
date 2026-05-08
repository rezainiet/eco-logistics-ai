# DEPENDENCY AND RISK MAP

System dependency graph + risk classification of every operational
component. Risk levels: **CRITICAL / HIGH / MEDIUM / LOW**.

Risk classification is based on:
1. **Blast radius** if the component fails (one merchant vs. all merchants).
2. **Replay sensitivity** (does failure produce duplicate / lost / inconsistent state?).
3. **Recovery cost** (automatic vs. manual).
4. **Cardinality of writes** (is the component on the hot path?).

---

## 1. Top-level dependency graph

```
                       ┌──────────────────────────────────┐
                       │ apps/api  (single Node process)   │
                       │  Express + tRPC + 16 BullMQ workers│
                       └──────────┬───────────────────────┘
                                  │
        ┌─────────────────────────┼──────────────────────────────────┐
        │                         │                                  │
        ▼                         ▼                                  ▼
   ┌──────────┐             ┌──────────┐                   ┌─────────────────────┐
   │ MongoDB  │             │  Redis   │                   │ external providers  │
   │ (Atlas)  │             │ (BullMQ +│                   │  Stripe             │
   │          │             │  rate-   │                   │  Resend             │
   │  CRITICAL│             │  limit)  │                   │  SSL Wireless SMS   │
   └────┬─────┘             │  CRITICAL│                   │  Twilio             │
        │                   └─────┬────┘                   │  Pathao/RedX/       │
        │                         │                         │  Steadfast          │
        ▼                         ▼                         │  Sentry             │
   models in @ecom/db      QUEUE_NAMES + safeEnqueue        │  Shopify/Woo APIs   │
                            + 16 workers                     └─────────────────────┘
                                                                    │
                                                                    ▼
                                                               (some HIGH, some MEDIUM,
                                                                see § 4)
```

---

## 2. CRITICAL components

These are systems whose failure or misuse threatens correctness across the
entire platform. Most are write-once, foundational, and difficult to swap.

### 2.1 MongoDB (Atlas)
- **Why critical**: every Order, Merchant, Integration, Payment, AuditLog row.
- **Failure mode**: api boot fails (`connectDb` throws). `safeEnqueue` falls through to `ok: false` in catastrophic combinations. Read paths return 500.
- **Replay sensitivity**: Mongoose `findOneAndUpdate` is not idempotent on its own — every write path that needs idempotency goes through CAS via `version` (`Order`), unique partial indexes (`WebhookInbox`, `Order.source.externalId`, `Payment.providerEventId`), or upsert-with-`$setOnInsert`.
- **Mitigation**: autoIndex OFF in prod; `syncIndexes` runs at boot in background; index correctness gates the partial-unique idempotency guarantees.

### 2.2 Redis (BullMQ + per-merchant rate-limit + step-up tokens)
- **Why critical**: 16 workers depend on Redis; without it, automation, tracking sync, webhook processing, and billing lifecycle workers all stop.
- **Failure mode**: `assertRedisOrExit` fails at boot in prod. Mid-run flap → `safeEnqueue` retries (50/200/500ms); on persistent down → DLQ via `PendingJob`. From the merchant's perspective the work is *deferred*, not lost.
- **Replay sensitivity**: high — every job has an idempotency key (jobId). Without dedupe a Redis flap could produce duplicate auto-book attempts.
- **Mitigation**: in-process retry, DLQ to Mongo, `pendingJobReplay` sweeper.

### 2.3 `safeEnqueue` (`apps/api/src/lib/queue.ts`)
- **Why critical**: every queued write goes through it. The contract `{ ok: true | true,deadLettered | false }` is load-bearing for all callers.
- **Failure mode**: API contract violation would silently lose work. Mitigation is the test suite + the in-process counters that surface anomalies.
- **Replay sensitivity**: high — it owns the dead-letter ledger.
- **Mitigation**: discriminated union return type forces caller-side handling.

### 2.4 `ingestNormalizedOrder` (`apps/api/src/server/ingest.ts`)
- **Why critical**: every Order is created here. A bug here is a duplicate-on-replay or quota-double-charge bug across all merchants.
- **Failure mode**: a fixable past pain point — quota refund didn't apply on race; phone-required produced silent null. Both fixed.
- **Mitigation**: race-safe insert with E11000 catch, `clientRequestId` partial-unique, `WebhookInbox` defense-in-depth.

### 2.5 Order CAS (`apps/api/src/lib/orderConcurrency.ts`)
- **Why critical**: every Order mutation must use `version` CAS. Bypassing it is a stale-overwrite bug class (booking lock vs fraud worker, restore vs riskRecompute).
- **Failure mode**: stale-overwrite produces wrong `automation.state` or `logistics.bookingInFlight`. Hard to debug post-hoc.
- **Mitigation**: explicit field (not Mongoose `__v` which is silently ignored by `findOneAndUpdate`), documented contract.

### 2.6 Audit log tamper chain (`apps/api/src/lib/audit.ts` + `models/auditLog.ts`)
- **Why critical**: SOC-2-style trustworthiness. Compliance, forensics, governance.
- **Failure mode**: a row inserted out of order or a row missing breaks the chain at the row *after* the gap.
- **Mitigation**: pre-save hook blocks every mutation type; `selfHash + prevHash` SHA-256 chain; verifier walks rows in order.

### 2.7 `lib/crypto.ts` AES-256-GCM (`v1:iv:tag:ct`)
- **Why critical**: courier credentials at rest. A leak is merchant-facing and vendor-facing breach.
- **Failure mode**: `COURIER_ENC_KEY` rotation without a multi-key reader = mass-decrypt failure on existing rows.
- **Mitigation**: env validation rejects boot if key is not exactly 32 bytes base64; constant-time compare in places that need it.

### 2.8 `WebhookInbox` permanent dedupe
- **Why critical**: idempotency floor for every push integration. Without it, a Shopify rate-limited replay storm produces duplicate Orders.
- **Failure mode**: index loss (e.g. failed migration) → duplicates re-flow.
- **Mitigation**: `(merchantId, provider, externalId)` unique. Defense in depth: `Order.source.externalId` partial-unique. Both must be present.

---

## 3. HIGH risk components

### 3.1 `automationBook` worker
- Books real shipments via real courier APIs. Wrong attempt counter or stale lock → duplicate AWB or no AWB.
- Mitigations: `bookingInFlight` lock + CAS, `PendingAwb` ledger row written *before* upstream call, `idempotencyKey` sent as upstream header, `awbReconcile` 60s sweep recovers stale locks.

### 3.2 `webhookProcess` worker
- Single failure path for inbound order ingest. Concurrency 8 — burst absorption matters.
- Mitigations: `attempts: 1` (no auto-retry); retry policy lives in `webhookRetry` sweep, which respects the inbox row's `attempts` counter and exponential `nextRetryAt`.

### 3.3 `webhookRetry` sweep + payload reap
- Owns retry policy AND payload reaping. A bug here either fails to retry (lost orders) or grows the collection unboundedly (cost).
- Mitigations: `attempts < MAX` cap; `nextRetryAt` exponential backoff; payload reap batch cap of 500/sweep; partial index on `(payloadReapAt) status:succeeded, payloadReaped:false`.

### 3.4 `Stripe webhook` → subscription state machine
- Merchant access depends on `subscription.status`. A bug here can suspend a paying merchant or activate a non-paying one.
- Mitigations: `Payment.providerEventId` and `invoiceId` partial-unique; `gracePeriodEndsAt` cleared on `invoice.payment_succeeded`; `subscriptionGrace` worker is the only writer to `suspended` state.

### 3.5 `computeRisk` core engine
- Mistake here over-blocks legit orders or under-blocks RTO. Affects merchant revenue + RTO rate.
- Mitigations: pure function, deterministic, fully unit-testable, weights are merchant-tunable, kill switches (`FRAUD_NETWORK_ENABLED`) without redeploy.

### 3.6 `restoreOrder` (preActionSnapshot reversal)
- Merchant trust depends on this working. A failed restore leaves an order in a half-state.
- Mitigations: CAS via `version`, `preActionSnapshot` cleared atomically with restore, fallback to legacy `preReject*` fields for older rows.

### 3.7 Courier credentials encryption + decryption
- Vendor-facing breach is merchant-trust-killing.
- Mitigations: AES-256-GCM, never returned in plaintext to the client, `lib/crypto.ts` is the only decrypt site.

### 3.8 Admin step-up token system
- Mistakenly long TTL or missing scope check = ungated destructive admin action.
- Mitigations: 5-min TTL, single-use (`consumedAt`), permission scope pinned at mint time, audit log on every mint AND consumption.

### 3.9 Bulk upload anti-replay
- A double-uploaded CSV could create thousands of duplicate orders.
- Mitigations: `(merchantId, externalBatchId)` unique. Re-submission collides on insert.

### 3.10 Public tracking page
- Public surface; PII leak risk. Branded but must not expose internal fields.
- Mitigations: server-rendered with explicit selection of fields; no internal IDs or fraud signals exposed.

### 3.11 `Order.source.externalId` partial-unique
- Last-line defense if `WebhookInbox` row deleted manually. Without it, a manual cleanup ops mistake → duplicates.
- Mitigations: index sync at boot; verified against schema.

### 3.12 `Merchant.subscription.status` field
- Single field gating every `merchantProcedure`. A wrong cache TTL here can deny paying merchants or admit non-paying ones.
- Mitigations: cached but TTL conservative; webhook flips invalidate; `lib/cache.ts` exposes a per-merchant cache key.

---

## 4. MEDIUM risk components

### 4.1 `trackingSync` worker
- If silent for hours, fraud rescore on RTO doesn't fan out — but courier webhooks (when they arrive) catch up.
- Mitigations: cadence env-tunable; courier webhooks redundant.

### 4.2 `orderSync` polling fallback
- Was the canonical "silent revenue hole" failure mode before being wired (2026-05-07).
- Mitigations: now wired; cursor stays unchanged on adapter error so next tick re-fetches.

### 4.3 `cartRecovery` worker
- Failure produces missed RecoveryTask creation. Merchant impact is opportunity cost (no RTO produced).
- Mitigations: re-run is idempotent; `$setOnInsert` preserves agent state.

### 4.4 `automationStale` worker
- 24h/72h escalation. If silent, customers stay in pending_confirmation until merchant manually triages.
- Mitigations: notification + dashboard surface visibility.

### 4.5 `subscriptionGrace` worker
- If silent, a past_due merchant retains access past grace. Revenue impact, not data integrity.
- Mitigations: indexed sweep is cheap; partial index ensures only candidate rows scanned.

### 4.6 `trialReminder` worker
- One-shot email. Failure = no email; merchant still gets surprised on trial end.
- Mitigations: `notificationsSent.trialEndingAt` marker prevents double-fire if multi-instance; email failure swallowed.

### 4.7 `awbReconcile` worker
- If silent, orders with stale `bookingInFlight` lock can't be re-booked.
- Mitigations: 60s cron; `MAX_ATTEMPTED_COURIERS=3` caps bounce.

### 4.8 `fraudWeightTuning` worker
- Monthly cadence. Failure = stale weights for a month; not a correctness issue.
- Mitigations: `MIN_SAMPLE_SIZE=50`, `MIN_SIGNAL_HITS=10`, multiplier clamped `[0.5, 1.5]`, `sqrt` smoothing.

### 4.9 `riskRecompute` worker
- If silent, terminal-outcome events don't fan out fraud rescore on phone cohort. Fresh orders for the same phone don't reflect new history.
- Mitigations: ingest itself runs `computeRisk`; rescore is corrective, not creating.

### 4.10 SSL Wireless SMS provider
- Outage = pending_confirmation orders don't get prompted. Customer trust impact.
- Mitigations: `automationSms` BullMQ retries (5 attempts, 15s exponential); `confirmationDeliveryStatus` DLR feedback; manual call surface in UI.

### 4.11 Twilio
- Voice calls fail if Twilio unavailable; manual `callCenter.logManual` mitigates.

### 4.12 Resend (transactional email)
- Trial reminder, password reset, subscription notices. Failure = no email; flows still complete.

### 4.13 Cross-merchant fraud network warm-up
- Until `FRAUD_NETWORK_WARMING_FLOOR=50` reached, bonuses halved; weak signal in early days. Not a correctness risk.

### 4.14 Identity-resolution stitch (TrackingSession ↔ Order)
- If matching is missed, `Order.intent` lacks data → tier `no_data`. Observation-only impact.

### 4.15 Per-merchant token bucket (`lib/merchantRateLimit.ts`)
- Fails open on Redis outage. Could let one merchant burst — but Redis being down already triggers DLQ.

---

## 5. LOW risk components

### 5.1 Public marketing pages (`apps/web/src/app/(marketing)/*`)
- Static. Failure = downtime of marketing surface; no ops impact.

### 5.2 `MerchantStats`
- Denormalized cache. Drift = wrong dashboard counters; can be re-derived.

### 5.3 `Notification` rows (in-app inbox)
- Best-effort fan-out. Missed notification ≠ business state corruption.

### 5.4 `TrackingEvent` raw stream
- Append-only; volume is manageable; bounded PII; idempotent via `clientEventId`.

### 5.5 SaaS-level `BrandingConfig`
- Single row, infrequent writes; fallback to `DEFAULT_BRANDING` if missing.

### 5.6 `MerchantFeedback`
- Triage queue. Stale = ops backlog, not customer impact.

### 5.7 `e2e-stack.mjs` and `backup-mongo.sh`
- Dev / ops scripts. Not on hot path.

### 5.8 `/health` endpoint
- Healthcheck. Failure = Railway restart; new boot self-heals.

---

## 6. Tightly coupled pairs (pairs that fail together if one drifts)

| Pair                                                | Coupling                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Order.source.externalId` index ↔ `WebhookInbox` index | Both must exist for full webhook idempotency defense-in-depth                       |
| `lib/queue.ts QUEUE_NAMES` ↔ every worker file      | Workers reference symbols, not strings; rename of one without the other = dead code |
| `Order.version` ↔ `lib/orderConcurrency.ts`         | Manual writes that bypass orderConcurrency lose CAS guarantees                      |
| `seedBranding` ↔ admin Branding Panel               | Admin writes need the singleton row; first-writer race avoided by boot seed         |
| `Merchant.fraudConfig.signalWeightOverrides` ↔ `fraudWeightTuning`  | Tuner is the only writer; manual tweak collides on next sweep      |
| `Merchant.subscription.gracePeriodEndsAt` ↔ `subscriptionGrace`     | Stripe webhook is the only writer; sweeper is the only reader-then-writer |
| `automationBook` ↔ `awbReconcile`                   | Reconciler unwinds locks the booker forgot to release                              |
| `safeEnqueue` ↔ `pendingJobReplay`                  | DLQ is meaningful only because the sweeper drains it                               |
| `WebhookInbox.payloadReapAt` ↔ `webhookRetry` reap pass | Reap is piggy-backed on the retry sweep; removing one strands the other          |
| `Order.preActionSnapshot` ↔ `restoreOrder`          | Snapshot is the entire restore contract                                            |

Refactoring any of the left side without the right side is the failure-mode signal.

---

## 7. Scaling bottlenecks (real, with thresholds)

| Bottleneck                                          | Floor today                          | What hurts first                              |
| --------------------------------------------------- | ------------------------------------ | --------------------------------------------- |
| Single api Node process for all 16 workers + HTTP   | RAM + CPU on one box                 | trackingSync + automationBook compete for cycles |
| `Order.logistics.trackingEvents` slice ceiling 100  | per-order doc size                   | already capped; multi-bounce shipments lose history beyond 100 events |
| `WebhookInbox` payload (5–50 KB Shopify orders)     | collection size                      | `payloadReap` sweep at 90d; row persists for dedupe |
| `FraudPrediction` retention 400d                    | TTL index                            | tuning worker scan time as merchants grow      |
| `TrackingEvent` raw stream                          | volume scales with storefront traffic| not yet a problem; would benefit from a separate cluster eventually |
| Per-merchant token bucket (Redis-keyed)             | bucket capacity tunable per queue    | bursty large merchants pay; misconfiguration could over-throttle |
| Stripe price ID env vars                            | 4 tiers fixed                        | new tier requires deploy + STRIPE_PRICE_<tier> env |

---

## 8. Replay-sensitive subsystems

These are systems whose semantics depend on idempotent re-execution. Mistakes here cause duplicates or losses.

| Subsystem            | Idempotency basis                                          | Replay risk if removed              |
| -------------------- | ---------------------------------------------------------- | ----------------------------------- |
| Webhook ingest       | `WebhookInbox` unique + `Order.source.externalId` unique   | duplicate Orders                    |
| Dashboard order create | `Order.source.clientRequestId` unique                    | double-click duplicates             |
| Bulk CSV             | `BulkUploadBatch.externalBatchId` unique                   | accidental re-upload duplicates     |
| Stripe webhook       | `Payment.providerEventId` + `invoiceId` unique             | double subscription activation      |
| Booking attempt      | `PendingAwb (orderId, attempt)` + upstream idempotencyKey  | duplicate AWB                       |
| Tracking events      | `dedupeKey = hash(at + providerStatus)`                    | duplicate tracking timeline entries  |
| Tracking SDK batch   | `(merchantId, sessionId, clientEventId)` unique            | duplicate behavioral events         |
| Cart recovery upsert | `(merchantId, sessionId)` unique + `$setOnInsert`          | overwrite of agent state            |
| Job enqueue          | per-worker jobId conventions                               | double auto-book / double SMS       |
| Trial reminder       | `notificationsSent.trialEndingAt` mismatch guard           | double email                        |

Every entry above is wired. None is theoretical.

---

## 9. Operational fragility (real, named)

| Fragility                                            | Signal                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| Worker file in `src/workers/` not registered in `index.ts` | dead code in prod (per `apps/api/CLAUDE.md`)                       |
| Mongoose `__v` reliance for CAS                      | silently ignored by `findOneAndUpdate` — use `Order.version` instead   |
| `Mixed` payload on `_id:false` sub-schemas           | strict-mode silently drops on dot-notation $set; use top-level field   |
| Env-flag + redeploy coupling                         | kill switches (`FRAUD_NETWORK_ENABLED`, `ADDRESS_QUALITY_ENABLED`, `INTENT_SCORING_ENABLED`) live in env to enable instant rollback |
| Phone-required floor                                 | regression here silently drops orders; manual replay surface mitigates  |
| Quota refund correctness                             | parameter alignment fix means refunds round-trip on race failure       |
| `payloadReaped` flag                                 | stable signal that payload was cleared — without flag, reaped rows could re-trigger reap |

---

## 10. Multi-instance correctness checklist

| Requirement                                          | How it's met                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| Repeatable jobs deduped across boots                 | BullMQ keys repeat by hash of `(name, repeat opts)` — `ensureRepeatableSweep` is idempotent |
| Sweep workers single-stream                          | `concurrency: 1` on every sweeper                                     |
| `pendingJobReplay` claim safe                        | `findOneAndUpdate` + forward-bumped `nextAttemptAt`                   |
| `trialReminder` one-shot                             | `findOneAndUpdate` mismatch guard on `notificationsSent.trialEndingAt` |
| `subscriptionGrace` flip safe                        | atomic update with `status: past_due AND gracePeriodEndsAt <= now`     |
| `automationStale` 24h/72h                            | CAS via `Order.version`                                                |
| `automationBook` lock                                | `bookingInFlight !== true` + version CAS                              |
| `awbReconcile` row claim                             | per-row update with status guard                                       |

---

## 11. Risk classification table

| Component                                       | Risk      | Notes                                                                 |
| ----------------------------------------------- | --------- | --------------------------------------------------------------------- |
| MongoDB                                         | CRITICAL  | data plane                                                            |
| Redis (BullMQ + rate-limit)                     | CRITICAL  | control plane                                                         |
| `safeEnqueue` contract                          | CRITICAL  | dead-letter floor                                                     |
| `ingestNormalizedOrder`                         | CRITICAL  | every Order goes through                                              |
| `Order.version` CAS                             | CRITICAL  | stale-overwrite prevention                                            |
| `AuditLog` tamper chain                         | CRITICAL  | compliance                                                            |
| AES-256-GCM courier encryption                  | CRITICAL  | secrets                                                               |
| `WebhookInbox` dedupe                           | CRITICAL  | idempotency floor                                                     |
| `automationBook`                                | HIGH      | real shipments via real APIs                                          |
| `webhookProcess` / `webhookRetry`               | HIGH      | inbound ingest path                                                   |
| Stripe state machine                            | HIGH      | merchant access gate                                                  |
| `computeRisk`                                   | HIGH      | merchant revenue + RTO                                                |
| `restoreOrder`                                  | HIGH      | merchant trust                                                        |
| Admin step-up                                   | HIGH      | destructive action gate                                               |
| Bulk upload anti-replay                         | HIGH      | duplicate prevention                                                  |
| Public tracking page                            | HIGH      | PII surface                                                           |
| `Order.source.externalId` partial-unique        | HIGH      | webhook defense-in-depth                                              |
| `Merchant.subscription.status`                  | HIGH      | subscription gate                                                     |
| `trackingSync`                                  | MEDIUM    | redundant with courier webhooks                                       |
| `orderSync` polling                             | MEDIUM    | now wired; was canonical silent failure mode                          |
| `cartRecovery`                                  | MEDIUM    | opportunity cost                                                      |
| `automationStale`                               | MEDIUM    | manual triage fallback                                                |
| `subscriptionGrace`                             | MEDIUM    | revenue impact                                                        |
| `trialReminder`                                 | MEDIUM    | one-shot email                                                        |
| `awbReconcile`                                  | MEDIUM    | unblocks stuck bookings                                               |
| `fraudWeightTuning`                             | MEDIUM    | monthly; failure = stale weights                                       |
| `riskRecompute`                                 | MEDIUM    | corrective                                                            |
| SSL Wireless / Twilio / Resend                  | MEDIUM    | external; degraded UX, not data corruption                            |
| Marketing pages                                  | LOW       | static                                                                |
| `MerchantStats`                                 | LOW       | re-derivable                                                          |
| `Notification` fan-out                          | LOW       | best-effort                                                           |
| `TrackingEvent` raw stream                      | LOW       | append-only, idempotent                                                |
| `BrandingConfig` singleton                      | LOW       | fallback to defaults                                                  |
| `MerchantFeedback`                              | LOW       | triage queue                                                          |
| Dev / ops scripts                                | LOW       | non-runtime                                                           |
| `/health`                                       | LOW       | restart-driven                                                        |

---

## 12. Reading guide

For any debugging or design discussion: start at the CRITICAL section and ask
"is the property held?". If yes, drop to HIGH and so on. The risk is encoded
not by *novelty of bug* but by *blast radius if missing*.
