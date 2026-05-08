# Deep Scoring & Operational Intelligence Audit

**Status:** read-only audit, 2026-05-08. NO implementation, NO changes proposed beyond an additive recommendation in §7–§8.
**Companion docs:** [architecture-inventory](./architecture-inventory.md), [file-inventory](./file-inventory.md), [execution-flow](./execution-flow.md), [scoring-flow](./scoring-flow.md).
**Engineering posture:** runtime truth over assumption, replay integrity sacred, additive-only architecture, observation-only intelligence remains observation-only.

---

## 1. Deep scoring architecture analysis

### 1.1 `computeRisk` — exact contract (`apps/api/src/server/risk.ts:442`)

**Signature:** `computeRisk(order: RiskInputOrder, history: RiskHistory, opts: RiskOptions = {}) → RiskResult`

**Pure** — no DB I/O, no clock reads beyond a timestamp, no env. The DB-touching half lives in `collectRiskHistory(...)`.

#### 1.1.1 Inputs

`RiskInputOrder`:
- `cod: number`
- `customer: { name, phone, address?, district }`
- `ip?: string`
- `addressHash?: string | null` (token-sorted sha256[:32], `risk.ts:160 hashAddress`)

`RiskHistory` (decay-weighted, default 30-day half-life):
- `phoneOrdersCount`, `phoneReturnedCount`, `phoneCancelledCount`, `phoneUnreachableCount` — decayed.
- `phoneVelocityCount` — RAW count inside the velocity window (default 10 min).
- `ipRecentCount` — RAW count inside `IP_VELOCITY_WINDOW_MS` (10 min).
- `addressDistinctPhones`, `addressReturnedCount` — distinct-phone set size + decayed RTO count at the same `addressHash`.
- `phoneDeliveredCount?` — decayed delivered count (optional; enables low-success-rate signal).
- `phoneTotalRaw?`, `phoneDeliveredRaw?`, `phoneReturnedRaw?`, `phoneCancelledRaw?` — un-decayed counters used by the customer-tier classifier.

`RiskOptions` (per-merchant `Merchant.fraudConfig`):
- `highCodBdt` / `extremeCodBdt` (explicit override).
- `suspiciousDistricts: string[]`, `blockedPhones: string[]`, `blockedAddresses: string[]`.
- `velocityThreshold: number` (default 3, 0 disables, negative also disables).
- `p75OrderValue`, `avgOrderValue` — feed adaptive COD thresholds.
- `weightOverrides: Record<key, multiplier>` — clamped `[0, 3]`, written by the monthly tuner.
- `baseRtoRate: number` — anchors the P(RTO) logistic.
- `weightsVersion: string` — frozen into `RiskResult`.

#### 1.1.2 Weighting system (`risk.ts:33–60`)

| Signal key             | Weight | Type   | Source signal |
|------------------------|-------:|--------|---------------|
| `extreme_cod`          |     40 | soft   | `cod ≥ extremeCod` |
| `high_cod`             |     18 | soft   | `cod ≥ highCod` (mutually exclusive with extreme) |
| `duplicate_phone`      |     10 | soft   | decayed prior orders ≥ 3 |
| `duplicate_phone_heavy`|     25 | soft   | decayed prior orders ≥ 6 |
| `prior_returns`        |     22 | soft   | decayed RTO > 0 |
| `prior_cancelled`      |     14 | soft   | decayed cancelled ≥ 2 |
| `low_success_rate`     | 14 / 22 | soft  | priorResolved ≥ 3 AND deliveredRate < 0.4 (heavy at < 0.2) |
| `suspicious_district`  |     16 | soft   | district missing OR in blocklist |
| `fake_name_pattern`    |     25 | soft   | regex/keyboard-walk/vowelless/Bangla placeholders |
| `unreachable_history`  |     20 | soft   | decayed unreachable CallLog count ≥ 2 |
| `ip_velocity`          |     16 | soft   | `ipRecentCount ≥ 5` (10 min window) |
| `velocity_breach`      |     75 | soft   | per-phone velocity ≥ threshold (single-signal HIGH) |
| `garbage_phone`        |     30 | **HARD** | structural BD-format check or all-same-digit |
| `duplicate_address`    | 22 / 11 | soft  | `≥ 3` distinct phones OR `addressReturnedCount > 0` (halved) |
| `blocked_phone`        |    100 | **HARD** | merchant blocklist hit |
| `blocked_address`      |    100 | **HARD** | merchant blocklist hit |

Plus a non-weighted **combo hard-block**: `extreme_cod_in_suspicious_district` forces HIGH but does not add weight (it sits on top of the existing extreme-COD weight).

`weightFor(key)` applies per-merchant override multipliers (clamped `[0, 3]`, rounded to int).

#### 1.1.3 Adaptive thresholds (`risk.ts:resolveDynamicThresholds`)

Precedence: explicit override → derived from merchant `p75OrderValue` (×1.5 high, ×3.0 extreme) → derived from `avgOrderValue` (×1.8 / ×3.6) → platform defaults `4000 / 10000 BDT`. Floors `1500 / 4000` clamp the dynamic path so a brand-new merchant with three ৳200 orders doesn't end up with absurd thresholds. The `source` field (`merchant_p75 / merchant_avg / merchant_override / platform_default`) is surfaced in the agent UI for transparency.

`getMerchantValueRollup(merchantId)` is cached 10 min and aggregates the merchant's last 90 days of resolved orders to produce p75 / avg.

#### 1.1.4 Customer-tier bypass

`classifyCustomerTier(history)`:
- `gold` ≥5 delivered AND deliveredRate > 0.85 → bypasses **soft** signals `velocity_breach`, `fake_name_pattern`, `duplicate_phone`, `duplicate_phone_heavy`.
- `silver` ≥3 delivered AND deliveredRate ≥ 0.7 → informational only.
- `standard`, `new` → no bypass.

**Hard blocks always fire.** A stolen-account scenario should not be laundered through a high-trust phone.

#### 1.1.5 Score → level → P(RTO)

```
raw = sum(signal.weight)              (clamped to [0, 100])
hardBlocked → score = max(score, 85)
level = score ≤ 39 ? "low" : score ≤ 69 ? "medium" : "high"
confidence = 100 − score
pRto = logistic((score − 50)/18 + logit(baseRate))   // anchor at base rate at score=50
hardBlocked → pRto = max(pRto, 0.95)
```

`reviewStatus = pending_call (high) | optional_review (medium) | not_required (low)` — never overwrites existing `verified` / `rejected`.

#### 1.1.6 Call sites (single source of truth: `risk.ts:computeRisk`)

| Site                                        | Trigger |
|---------------------------------------------|---------|
| `server/ingest.ts:157` (`ingestNormalizedOrder`) | every fresh order from any source |
| `server/routers/orders.ts:218`              | dashboard create-order preview/commit |
| `server/routers/orders.ts:2119`             | bulk-upload preview |
| `server/routers/fraud.ts:561`               | recompute on fraud-config change |
| `workers/riskRecompute.ts:129`              | rescore fan-out (RTO / no-answer / rejected) |
| `scripts/{verifyFraudFlow, auditCsvAndBulk}` | one-shot CLIs |

### 1.2 `collectRiskHistory` — DB lookup contract

`risk.ts:788`. Single fan-out, five concurrent reads:

1. **Phone history** (`Order.find {merchantId, customer.phone, createdAt ≥ now-365d, _id ≠ excludeOrderId}`) projection `{order.status, createdAt}`. Decay weight `2^(-ageDays/halfLife)` accumulated into `phoneOrdersCount`, plus per-status decayed AND raw counters. Half-life clamps near-zero ages to 1.0 to avoid floating-point arithmetic missing the `≥ 3` threshold under back-to-back orders.
2. **Address history** (`{merchantId, source.addressHash}`) → `{customer.phone, order.status, createdAt}`. Builds `distinctPhones: Set<string>` (excluding the current phone) AND decayed `addressReturnedCount` from RTO rows.
3. **CallLog unreachable** (`{merchantId, customerPhone, answered: false, timestamp}`) → decayed `phoneUnreachableCount`.
4. **IP velocity** (`Order.countDocuments {merchantId, source.ip, createdAt ≥ now-10min}`).
5. **Phone velocity** (`Order.countDocuments {merchantId, customer.phone, createdAt ≥ velocitySince}`).

`collectRiskHistoryBatch(...)` is the bulk-upload variant — two aggregations cover N keys instead of 5N reads.

### 1.3 `FraudPrediction` lifecycle (`packages/db/src/models/fraudPrediction.ts`)

**Append-once snapshot** + **terminal-outcome stamp**.

```
Order ingest                  → FraudPrediction.create({
  server/ingest.ts:303              riskScore, pRto, levelPredicted, customerTier,
                                    signals[{key,weight}], weightsVersion,
                                    scoredAt, expiresAt = now + 400d
                                  })
                                  • idempotent via unique `orderId` (a re-score later
                                    overwrites cleanly via updateOne)

Terminal status flip          → FraudPrediction.updateOne(
  server/tracking.ts:196          { orderId },
                                  { $set: { outcome, outcomeAt: now } }
                                )
                                  • only fires from applyTrackingEvents
                                  • `delivered` / `rto` / `cancelled` are the only
                                    enum values; `out_for_delivery` / `failed`
                                    don't stamp here

TTL                           → 400 days (FRAUD_PREDICTION_TTL_DAYS), giving the
                                tuner a 12-month window + 1 month grace
```

**Important asymmetry:** terminal cancel transitions that happen OUTSIDE `applyTrackingEvents` (fraud-reject, automation-stale auto-expire, SMS-inbound NO reply, manual cancel via routers) **do not stamp `FraudPrediction.outcome`**. See §3.3.

### 1.4 `FraudSignal` lifecycle (`packages/db/src/models/fraudSignal.ts`, `lib/fraud-network.ts`)

**Cross-merchant aggregate.** One document per `(phoneHash, addressHash)` — either side may be `_none_`.

```
Terminal status flip          → contributeOutcome({merchantId, phoneHash, addressHash, outcome})
  server/tracking.ts:220          • aggregation-pipeline upsert with $ifNull-guards on
                                    every counter (defaults don't apply to pipeline updates)
                                  • $setUnion + $slice -64 for the merchantIds set
                                  • lastSeenAt = now, firstSeenAt only on insert
                                  • only fires from applyTrackingEvents
                                  • `delivered` / `rto` / `cancelled` enums

Risk scoring read             → lookupNetworkRisk({phoneHash, addressHash, merchantId})
  server/routers/orders.ts:234    • 3-filter cascade: phone+address → phone-only → address-only
  server/routers/fraud.ts:202     • filtered to FraudSignal(...) where lastSeenAt ≥ now-decayDays
                                  • suppressed if merchantCount<2 OR observations<2
                                  • bonus = clamp(25,
                                      rate≥0.5 + ≥2 merchants ? min(20, rate×25) : 0
                                    + rtoCount≥3                ? +8                : 0
                                    + min(5, cancelledCount)
                                    )
                                  • halved during warming-up window
                                  • returns aggregate only — never the merchantIds list
```

**The `lookupNetworkRisk` bonus is currently NOT additively folded into `computeRisk`'s signal sum.** It's read and surfaced in the dashboard via `NetworkSignalPill`, but the bonus value isn't added to `riskScore`. This means the network is observation-only too in v1 — confirmed by reading both call sites in `routers/orders.ts:234` and `routers/fraud.ts:202`: the result is forwarded to the UI but never re-injected into a `computeRisk` opts.

### 1.5 Risk recompute flow (`workers/riskRecompute.ts`)

Triggers (`enqueueRescore`):
- `applyTrackingEvents` on `rto` terminal flip → `trigger: "order.rto"`.
- `fraud.markRejected` mutation → `trigger: "review.rejected"`.
- `fraud.markNoAnswer` mutation → `trigger: "review.no_answer"`.

Behavior:
1. Find all open orders for `(merchantId, customer.phone)` in `NON_TERMINAL_STATUSES`, excluding the trigger order.
2. Per order: `collectRiskHistory` + `computeRisk` (per-merchant fraudConfig).
3. **Optimistic-CC write** via `updateOrderWithVersion({_id, version})`. If `version` mismatches → SKIP (don't clobber a manual-restore or in-flight review action).
4. Audit `risk.recomputed`. If transition to HIGH from non-HIGH AND review wasn't terminal → `fireFraudAlert("fraud.rescored_high")`.
5. Dedupe enqueue: `jobId = "${merchantId}:${phone}:${trigger}:${10s-bucket}"` collapses bursts.
6. Sync fallback when Redis is unavailable (dev/test) — signal reliability never degrades.

### 1.6 Risk persistence flow (where `Order.fraud.*` actually lives)

| Writer                                    | Action                                                                      |
|-------------------------------------------|-----------------------------------------------------------------------------|
| `server/ingest.ts:222 (Order.create)`     | initial `fraud.{detected, riskScore, level, reasons, signals, reviewStatus, scoredAt}` |
| `workers/riskRecompute.ts:159`            | recompute on RTO / review actions; CAS-protected by `version` |
| `server/routers/fraud.ts` (markVerified / markRejected / markNoAnswer) | review-state mutations + review queue movement |
| `server/routers/orders.ts` rejectOrder + bulk variants | reject snapshot + cancellation |
| `lib/rejectSnapshot.ts`                   | `restoreOrder` re-applies the pre-reject snapshot atomically |

`Order.version` is bumped on every CAS-write; `updateOrderWithVersion` is the one helper. **Ordinary `updateOne`s that don't go through this helper bypass CC** — only the call sites above are CC-aware.

### 1.7 Terminal outcome propagation (where the feedback loop lives)

`applyTrackingEvents` on terminal flip (`delivered` / `rto` / `cancelled`) — **but only the courier-driven flip, not the cancel paths**:

```
applyTrackingEvents (server/tracking.ts:174)
   │
   ├── MerchantStats.updateOne $inc {[prev]:-1, [next]:+1}
   ├── invalidate(`dashboard:${merchantId}`)
   │
   ├── if rto:
   │     enqueueRescore({trigger:"order.rto"})
   │
   └── if delivered | rto | cancelled (terminal):
         FraudPrediction.updateOne {outcome, outcomeAt}        // §1.3
         contributeOutcome (FraudSignal cross-merchant)         // §1.4
         if order.logistics.courier && district:
             recordCourierOutcome (CourierPerformance)          // §2
                deliveryHours = clamp(0.1,
                    delivered ? (deliveredAt − shippedAt) / 1h : undefined)
                fallback shippedAt → createdAt → now
```

### 1.8 Existing operational signals already inside the risk engine

The risk engine ALREADY reads delivery-outcome history — `phoneReturnedCount`, `phoneCancelledCount`, `phoneDeliveredRaw` (raw and decayed) all derive from `Order.order.status` terminal states. These power:
- `prior_returns` signal
- `prior_cancelled` signal
- `low_success_rate` signal
- customer-tier classification (gold/silver/standard/new)

So **buyer-side delivery reliability is already feeding `computeRisk`**, just framed as "fraud signal" rather than "delivery reliability". This is load-bearing for §6.

### 1.9 Signals intentionally excluded from `computeRisk`

Per file-level comments (`intent.ts:17`, `operational-hints.ts:10`, `address-intelligence.ts` header):
- `Order.intent.*` — observation-only in v1; explicit roadmap Phase 7 to wire in.
- `Order.address.quality.*` — observation-only.
- `operationalHint` — visibility-only, computed on read.
- `lookupNetworkRisk.bonus` — surfaced to UI but NOT additively combined with `riskScore` (§1.4).
- Confirmation-quality signals (`confirmation_delivered`, `confirmation_replied`, `fast_confirmation`) — wired into `computeIntentScore` but intent itself isn't fed back.
- Per-courier delivery reliability — the merchant's average courier RTO rate is collected in `CourierPerformance` and `getCourierPerformance`, but never read by `computeRisk`. Today the merchant's RTO history is used at the **buyer (phone)** granularity, not at the **lane (courier×district)** granularity.

### 1.10 Where delivery outcomes already influence scoring vs. don't

| Aspect                                | Influences `computeRisk`? | Source path |
|---------------------------------------|:-:|---|
| Buyer's prior RTO count (decayed)     | ✅ | `phoneReturnedCount` → `prior_returns` |
| Buyer's prior delivered rate          | ✅ | `phoneDeliveredRaw / priorResolved` → `low_success_rate` |
| Buyer's cancellation count            | ✅ | `phoneCancelledCount` → `prior_cancelled` |
| Address has prior RTO                 | ✅ | `addressReturnedCount` → `duplicate_address (halved)` |
| Cross-merchant network RTO            | ❌ (read but not added) | `lookupNetworkRisk` |
| Courier's RTO rate (this merchant)    | ❌ | `CourierPerformance` |
| Courier×district lane reliability     | ❌ | `CourierPerformance` |
| Address-quality completeness          | ❌ | `Order.address.quality` |
| Buyer engagement (intent)             | ❌ | `Order.intent` |
| Confirmation SMS delivered/replied    | ❌ | `Order.automation.confirmation*` |
| Thana-level reliability               | ❌ | `Order.customer.thana` (no aggregate yet) |

### 1.11 Where operational reliability semantics naturally fit

Two distinct shapes already live in the codebase:

1. **Order-level visibility** — pure-function classifiers run on read (`classifyOperationalHint` from `getOrder`, `IntentPanel` / `AddressQualityPanel` from stamped subdocs). Cheap, no persistence, always current. This is the right shape for "this specific order needs attention because X".
2. **Aggregate intelligence** — per-(merchant, courier, district) counters in `CourierPerformance`; per-(phoneHash, addressHash) counters in `FraudSignal`; per-merchant rollup in `MerchantStats`. This is the right shape for "across all my orders, this lane is unreliable".

A delivery-reliability score for an INDIVIDUAL order requires both: aggregates fed from terminal outcomes + a pure-function combiner that joins them at read or ingest time.

---

## 2. Courier intelligence analysis

### 2.1 `CourierPerformance` model

Fields (`packages/db/src/models/courierPerformance.ts`):
- Key: `(merchantId, courier, district)` — unique compound index. `district` ≡ `_GLOBAL_` for the merchant-wide aggregate.
- Counters: `deliveredCount`, `rtoCount`, `cancelledCount`, `totalDeliveryHours` (sum, divided by `deliveredCount` for avg).
- Window: `recentFailureCount`, `recentFailureWindowAt` — booking-failure circuit breaker.
- `lastOutcomeAt` — staleness anchor (180 days).
- Secondary index: `(merchantId, courier, lastOutcomeAt:-1)` — supports staleness scans.

### 2.2 `recordCourierOutcome` (write)

Called only from **`applyTrackingEvents`** (`server/tracking.ts:254`).

```
inputs: { merchantId, courier, district, outcome, deliveryHours? }

steps:
  1. lower-case + trim courier; normalizeDistrict(district).
  2. abort if courier or district is empty (defensive).
  3. counterField = "deliveredCount" | "rtoCount" | "cancelledCount" (lookup).
  4. inc = { [counterField]: 1, totalDeliveryHours?: deliveryHours }
  5. for districtKey ∈ [district, "_GLOBAL_"]:
       upsert { merchantId, courier, district: districtKey } with $inc + $set lastOutcomeAt
       wrap in try/catch; never throws back to caller.
```

**Replay safety:**
- Counters are pure `$inc`s. A re-fired `applyTrackingEvents` call would double-count.
- Protection: `applyTrackingEvents` only runs the outcome side-effects when `nextStatus !== prevStatus` (§3.1). The status guard + dedupe guard on the Order update means a duplicate webhook either matches `dedupeKey` and short-circuits, or fails the status guard and writes nothing. **The write is gated by a successful status transition.**
- A **manual restore** that flips a `delivered` order back to `confirmed` and lets the courier re-deliver IS a vector for double-counting today — see §5.3.

### 2.3 `selectBestCourier` (read)

Single round-trip read of every candidate row + each merchant's `_GLOBAL_` row. Per candidate:
- If district row has `completed ≥ MIN_OBSERVATIONS(10)` → use district stats, `matchedOn = "district"`.
- Else if global row exists → use global, `matchedOn = "global"`.
- Else `matchedOn = "cold_start"` with neutral score.

`scoreCourierCandidate(stats, opts)`:
```
completed = delivered + rto + cancelled
recent failure penalty (cap 20):
  count × FAILURE_PENALTY_PER_HIT(4), capped, with rolling 1h window
  expired window → 0
stale = lastOutcomeAt > 180 days ago

if completed < 10  OR  stale:
  score = NEUTRAL_SCORE(50) + preferredBonus(5 if matched) − failurePenalty
else:
  successRate = delivered / completed
  rtoRate     = rto      / completed
  avgHours    = totalDeliveryHours / delivered    (when delivered>0)
  speedScore  = clamp(0, 1.5, 24h_baseline / avgHours)
  score = 60·successRate − 30·rtoRate + (speedScore/1.5)·10 + preferredBonus − failurePenalty
  clamp(0, 100)
```

`reason` is operator-readable: `"success 92% / rto 4% over 230 orders (district)"` or `"cold start — neutral score + preferred courier (pathao)"`.

Single read site: `workers/automationBook.ts:199` — the auto-book worker uses this when no per-order `pinnedCourier` is set.

### 2.4 `recordCourierBookFailure` (write — circuit breaker)

`workers/automationBook.ts:296` calls this on every adapter `createAWB` failure. Two updates:
1. If `recentFailureWindowAt < now − 1h` → reset count + window stamp.
2. Atomic `$inc { recentFailureCount: 1 }` with `$setOnInsert` + `$set recentFailureWindowAt`.

Both for the per-district row AND the merchant `_GLOBAL_` row.

### 2.5 `deliveryHours` derivation (`server/tracking.ts:243`)

For `delivered` outcomes:
- Prefer `shippedAt → deliveredAt` (true transit time).
- Fall back to `shippedAt → now` (deliveredAt missing).
- Fall back to `createdAt → now` (no shipped stamp at all — usually legacy data or auto-imports).
- Floor at 0.1h to keep `$inc` healthy under synthetic seeds.

### 2.6 District normalization

`normalizeDistrict(district)` (`apps/api/src/lib/district.ts`) is applied at BOTH the write (`recordCourierOutcome`) and read (`selectBestCourier`) seams. Without this, `"Dhaka" / "dhaka" / "DHAKA"` would be three separate buckets. Confirmed by the file-level comment at `recordCourierOutcome`: this was a previous bug, fixed by anchoring normalization at both sides.

### 2.7 Aggregation logic — what already exists vs gaps

| Capability                          | Already aggregated? | Where |
|-------------------------------------|:-:|---|
| Per-(merchant, courier, district) outcome counters | ✅ | `CourierPerformance` |
| Per-merchant courier global aggregate | ✅ | `_GLOBAL_` district row |
| Average delivery hours              | ✅ | `totalDeliveryHours / deliveredCount` |
| Recent booking-failure circuit      | ✅ | `recentFailureCount` 1h window |
| Per-(merchant, courier) RTO over time | ⚠️ | only ad-hoc via `Order.aggregate` in `analytics.getCourierPerformance`; not a counter |
| Per-(merchant, district) reliability (any courier) | ❌ | not aggregated; computable from Order |
| Per-(merchant, thana) reliability   | ❌ | indexed (`{merchantId, customer.thana, createdAt:-1}`) but not aggregated; analytics card computes ad-hoc |
| Per-courier×thana reliability       | ❌ | not aggregated; would need new shape |
| Per-customer (phone) success rate   | ⚠️ | computed at scoring time inside `collectRiskHistory`; not pre-aggregated |
| Per-address success rate            | ⚠️ | computed at scoring time inside `collectRiskHistory`; not pre-aggregated |

### 2.8 Existing operational intelligence quality — verdict

The courier intelligence layer is already production-grade for its declared scope (auto-book selection):
- Replay-safe (gated by status-transition chokepoint).
- Idempotent under re-poll (dedupe key fixes the duplicate-write class).
- Cold-start handling is benign (neutral 50, not 0).
- Stale-data guard (180-day cutoff) keeps a moribund courier from being preserved as "good".
- Recent-failure circuit lets a courier self-downrank within 1h on real-time failures.
- Per-district + global fallback handles low-volume gracefully.

**It is NOT sufficient for** the broader RTO-prevention scope:
- It is **per-courier**, not per-(courier×thana). Thana data exists on `Order.customer.thana` and has a partial index (`order.ts:604`) but no `CourierPerformance`-style counter keys on it.
- It does not surface a **buyer-level delivery reliability score** — `collectRiskHistory` computes one at scoring time but doesn't persist it.
- It does not surface an **address-level reliability score** beyond the boolean `addressDistinctPhones / addressReturnedCount` signals used inside `computeRisk`.
- It does not export a **merchant operational quality score** — `MerchantStats` carries the raw counters but no derived "operational quality" rollup (which would feed an admin-side cohort comparison).

---

## 3. Terminal status outcome flow

### 3.1 The applyTrackingEvents chokepoint (`server/tracking.ts:77`)

For each event batch, with `source: "webhook" | "poll"`:

```
1. Build new dedupeKey set from events (sha1(providerStatus|description|location)[:24]).
2. Skip events whose dedupeKey already exists in logistics.trackingEvents.
3. nextStatus = STATUS_MAP[normalizedStatus] ?? prevStatus.
4. Build $set:
     source==="webhook"  → set logistics.lastWebhookAt
     source==="poll"     → set logistics.lastPolledAt, clear pollError + count
     normalizedStatus==="delivered" + no deliveredAt → set deliveredAt, actualDelivery
     normalizedStatus==="rto"       + no returnedAt  → set returnedAt
     nextStatus !== prevStatus → set order.status
5. Build $push for new events with $slice: -MAX_TRACKING_EVENTS(100).
6. Atomic guard:
     filter: { _id, "order.status": $in [active set ∪ prevStatus],
               "logistics.trackingEvents.dedupeKey": $nin newKeys }
     refuses to mutate when:
        a) order has moved out of the active set (a fresher status won)
        b) any new dedupeKey already raced in
7. Run Order.updateOne(filter, update).
8. effectivelyAppended = persisted ? newEvents.length : 0.
9. If status transitioned (and persisted):
     A. MerchantStats.$inc { [prev]:-1, [next]:+1 }, set updatedAt.
     B. invalidate(`dashboard:${merchantId}`).
     C. if next === "rto":
          enqueueRescore({trigger:"order.rto", phone, triggerOrderId}).
     D. if next ∈ {delivered, rto, cancelled}:
          FraudPrediction.updateOne {outcome, outcomeAt}.
          contributeOutcome (FraudSignal cross-merchant; phoneHash, addressHash).
          if order.logistics.courier && district:
              recordCourierOutcome (CourierPerformance).
```

**This is the canonical chokepoint for COURIER-DRIVEN terminal outcomes.** It is the only writer of `delivered` and `rto` order statuses; both come exclusively from courier signals (webhook or poll).

### 3.2 Other writers of `Order.order.status` (verified by grep)

| Writer                                                    | Target status | Goes through `applyTrackingEvents`? |
|-----------------------------------------------------------|---------------|:-:|
| `Order.create` (`ingest.ts:222`)                          | `pending`     | n/a (initial — post-save hook bumps MerchantStats) |
| `applyTrackingEvents`                                     | `in_transit`/`delivered`/`rto` | ✅ self |
| `routers/fraud.ts:380` (markRejected)                     | `cancelled`   | ❌ (manual MerchantStats $inc; rescore enqueued) |
| `routers/orders.ts:2006, 2548, 2715, 3020` (cancel / bulk reject) | `cancelled` | ❌ (manual MerchantStats $inc) |
| `routers/orders.ts:668` (book success)                    | `shipped`     | n/a (non-terminal) |
| `workers/automationStale.ts:93` (auto-expire)             | `cancelled`   | ❌ (no MerchantStats $inc — see §3.3) |
| `webhooks/sms-inbound.ts:266` (customer NO reply)         | `cancelled`   | ❌ (no MerchantStats $inc — see §3.3) |
| `lib/rejectSnapshot.ts:73` (restoreOrder)                 | restores prev | ❌ (manual flip back) |

### 3.3 Side-effect coverage gap on cancel paths

`applyTrackingEvents` is the only writer that fans out to:
- `FraudPrediction.outcome` (the fraud-tuner feedback loop).
- `contributeOutcome` (cross-merchant `FraudSignal`).
- `recordCourierOutcome` (`CourierPerformance`) — though for non-courier-driven cancels this is correct: a pre-shipping cancel has no courier yet.

**Cancellations from non-courier paths therefore:**
- ✅ Bump `MerchantStats` correctly (each writer does it manually OR via fraud reject).
- ✅ Trigger a rescore where appropriate (`fraud.markRejected`).
- ❌ Do NOT stamp `FraudPrediction.outcome = "cancelled"` (the fraud tuner thinks these orders are still in-flight).
- ❌ Do NOT contribute to `FraudSignal` cross-merchant aggregate.

For the fraud tuner this is partially benign (it explicitly excludes `cancelled` from the precision math, `fraudWeightTuning.ts:103`), but the network signal genuinely loses the cancel signal from these paths.

### 3.4 Workers triggered by terminal transition (per status)

| Status         | Worker triggered                         | Via |
|----------------|------------------------------------------|-----|
| `delivered`    | (none directly; analytics + dashboard cache invalidation only) | inline |
| `rto`          | `risk-recompute` (rescore every open order on the phone) | `enqueueRescore` |
| `cancelled` (courier-driven) | (none triggered; analytics only)  | inline |
| `cancelled` (fraud reject) | `risk-recompute` (rescore peers)     | `enqueueRescore` from `markRejected` |
| `cancelled` (auto-expire / SMS NO) | (none — see §3.3)              | n/a |
| `in_transit`   | (none)                                   | inline |
| `out_for_delivery` | (none — non-status-changing event in STATUS_MAP) | inline |
| `failed` (event, not status) | (none — appears on timeline; `STATUS_MAP[failed] = rto` triggers RTO branch when order's overall status flips) | inline |

### 3.5 Models touched per terminal flip (`applyTrackingEvents` chokepoint)

| Model | Operation | Condition |
|-------|-----------|-----------|
| `Order` | `updateOne` $set status + $push event | always |
| `MerchantStats` | `updateOne` $inc {[prev]:-1, [next]:+1} | nextStatus !== prevStatus |
| `FraudPrediction` | `updateOne` $set {outcome, outcomeAt} | terminal |
| `FraudSignal` | aggregation-pipeline upsert (counter + merchantIds) | terminal AND ≥1 hash |
| `CourierPerformance` | upsert per-district + per-`_GLOBAL_` $inc | terminal AND order has courier+district |
| Cache (Redis) | `invalidate("dashboard:${merchantId}")` | nextStatus changed |
| Queue (BullMQ) | `enqueueRescore` | next === "rto" |

### 3.6 The single safest chokepoint for future delivery-reliability aggregation

**`applyTrackingEvents` (`server/tracking.ts:77`).**

Reasoning (load-bearing):
- It is THE single writer of `delivered` and `rto` status. No other code path lands those.
- Its status guard + dedupe guard + `Order.version` make every side-effect run **at most once per actual transition**, even under webhook re-delivery, polling overlap, and replay sweeps.
- It already enriches with `district`, `courier`, `phoneHash`, `addressHash`, and `deliveryHours`.
- Adding ONE more best-effort `void aggregateDeliveryReliability(...)` next to the existing four side-effects (lines ~196, ~220, ~254) is the minimum-blast-radius extension.
- Failures inside additional best-effort fans-out cannot affect the order/status write — the existing pattern wraps every aggregate write in `void X(...).catch(console.error)`.

For non-courier `cancelled` flips, a parallel chokepoint exists but it is currently **scattered across many writers** (§3.2). If delivery reliability needs the cancel signal, there should be a single `recordOrderCancelled(...)` helper called from each of those writers — but the data those writers carry is sufficient (no courier means courier-axis metrics shouldn't update, only buyer / address axes).

---

## 4. Replay & idempotency risk analysis

### 4.1 Replay-sensitive aggregation points

| Aggregation site                              | Failure mode under replay                       | Mitigation in code |
|-----------------------------------------------|--------------------------------------------------|--------------------|
| `MerchantStats.$inc` in `applyTrackingEvents` | Double-count on duplicate replay                 | Status-guard filter — only fires when `nextStatus !== prevStatus`, AND the Order updateOne's filter includes the prevStatus check so a re-applied delivered→delivered does nothing. |
| `MerchantStats.$inc` in fraud reject / cancel routers | Double-count on retry                    | Each fires inside the protected mutation; review-status filter `{$in: [pending_call, no_answer]}` blocks a second decrement. |
| `FraudPrediction.updateOne {outcome}`         | $set is idempotent by definition                 | Safe under any number of replays. |
| `contributeOutcome` (FraudSignal $inc)        | Double-increment on duplicate replay             | Same status-transition gating as MerchantStats; the fan-out only fires after a successful status flip in `applyTrackingEvents`. |
| `recordCourierOutcome` (CourierPerformance $inc) | Double-increment on duplicate replay         | Same gating. |
| `recordCourierBookFailure` (CourierPerformance $inc) | Double-increment on retry                | `automation-book` worker re-enqueues a NEW job with a different `jobId` for the next courier — same job's failure path runs once per attempt; the worker's own retry semantics don't double-fire because the standard `attempts:1` is set on auto-book jobs. |
| `Order.create` race                           | E11000 ⇒ refund-quota + return duplicate         | `ingest.ts:266`. |
| `WebhookInbox.create` race                    | E11000 ⇒ duplicate flag                           | `ingest.ts:464`, `webhooks/courier.ts:255`. |
| `Order.fraud.*` re-write on rescore            | Stale write clobbers manual review                | `updateOrderWithVersion` CAS — skip on version mismatch. |
| `Order.intent` re-write                        | Concurrent re-stamp                               | $set under `version:$inc`; intent is single-writer (the fire-and-forget). |

### 4.2 Non-idempotent risks (where replay would actually corrupt)

1. **Manual status mutation outside `applyTrackingEvents` then a courier event lands.** If a merchant manually flips a `delivered` order back to `confirmed` (no such UI today, but `restoreOrder` exists for cancel→pending), and then a courier webhook re-delivers, `applyTrackingEvents` would fire all four side-effects AGAIN. Net result: `MerchantStats` over-incremented, `FraudPrediction.outcome` stamped twice (idempotent), `FraudSignal` over-incremented, `CourierPerformance` over-incremented. **This is the single class of replay risk the existing chokepoint does NOT defend against.** The `restoreOrder` path in `lib/rejectSnapshot.ts` only handles `cancelled → previous` — it does not roll back terminal `delivered`/`rto`.
2. **`automationStale` auto-cancel firing twice.** Defended by CAS on `(automation.state, version)` (`automationStale.ts:84`). Replay-safe.
3. **`fraud.markRejected` retry under network failure.** Defended by `{fraud.reviewStatus: $in [pending_call, no_answer]}` filter — second call sees `rejected` and 409s.
4. **`bookSingleShipment` retry duplicating a courier AWB.** Defended by:
   - `Order.logistics.bookingInFlight` exclusive lock acquired via `findOneAndUpdate` guarded on `bookingInFlight !== true`.
   - `PendingAwb` ledger row with idempotency key `(orderId, attempt)`.
   - `awb-reconcile` worker breaks stale locks after 90s.
   - `Idempotency-Key` header forwarded to upstream couriers (Stripe-style).

### 4.3 Dangerous recompute paths

| Path                                | Risk                                              | Defence |
|-------------------------------------|---------------------------------------------------|---------|
| `riskRecompute` writing to terminal-review orders | Could overwrite `verified` / `rejected` | `TERMINAL_REVIEW.has(currentReview)` keeps `nextReview = currentReview`. |
| `riskRecompute` writing during a manual `restoreOrder` | Could clobber the restored snapshot | `updateOrderWithVersion` skip on version mismatch. |
| `fraudWeightTuning` reading mid-rollover | Mid-month boundary could produce skewed precision | LOOKBACK_DAYS=90; tuner runs monthly; cron-anchored. Not a replay risk, but a temporal one. |
| `getMerchantValueRollup` cache poisoning | Could feed stale p75 into adaptive thresholds | 10-minute TTL. A stale p75 just means the order is scored against a slightly outdated threshold — bounded and self-healing. |

### 4.4 Race-condition risks already mitigated

- **Two webhooks for the same order arriving in parallel:** `WebhookInbox` unique `(merchantId, provider, externalId)` — second loses with E11000 → duplicate flag.
- **Webhook + poll racing:** dedupe key on `logistics.trackingEvents.dedupeKey` → second is a no-op append; `applyTrackingEvents` filter `{trackingEvents.dedupeKey: $nin newKeys}` makes the late writer write nothing.
- **Two workers grabbing the same `PendingJob`:** atomic `findOneAndUpdate({status:"pending", nextAttemptAt:$lte:now}, {$set:{nextAttemptAt:now+60s}})` — sibling sees future deadline.
- **Order.create race:** unique partial index `(merchantId, source.externalId)` — second loser catches E11000, refunds quota.
- **Fraud reject racing with restore:** version CAS (`Order.version`) — both `markRejected` and `restoreOrder` go through `updateOrderWithVersion`.

### 4.5 Replay safety of each function called by replay sweep

| Function                          | Inputs that change between original + replay | Idempotent? |
|-----------------------------------|----------------------------------------------|:-:|
| `replayWebhookInbox`              | `inbox.attempts` increments; `nextRetryAt` rolls forward | ✅ overall — `ingestNormalizedOrder` deduplicates against `Order.source.externalId`; if the order already lives, returns `duplicate: true`. |
| `replayCourierInbox`              | Same                                         | ✅ — `applyTrackingEvents` dedupes via content-hash; no duplicate timeline events. |
| `applyTrackingEvents`             | `now` (timestamps), but content-hash dedupe is content-only | ✅ — see §3.1. |
| `recordCourierOutcome`            | `now`, `deliveryHours` — but only fires once per status flip | ✅ when called via `applyTrackingEvents`. ⚠️ if called directly by hypothetical other writer. |
| `contributeOutcome`               | Same                                         | ✅ when called via `applyTrackingEvents`. |
| `riskRecompute.processRescoreJob` | `enqueueRescore` jobId dedupes 10s buckets   | ✅ — version CAS on every write. |
| `pendingJobReplay.sweepPendingJobs` | `attempts++` on every claim                | ✅ — atomic claim with forward `nextAttemptAt`. |

### 4.6 Historical aggregation corruption risks

| Risk                                                 | Today's exposure |
|------------------------------------------------------|------------------|
| MerchantStats double-count on replay                 | Defended (§4.1). |
| MerchantStats drift if a writer forgets the $inc     | Possible (§3.3 cancel paths all do remember; this is fragile by convention, not enforced). |
| CourierPerformance double-count on `delivered → confirmed → re-delivered` round-trip | Possible if such a round-trip is ever introduced; today no UI exposes it. |
| FraudSignal cross-tenant leakage                     | Defended by privacy posture: only hashes persisted, only aggregate counts surfaced, merchant ids list capped + hidden. |
| Phone normalisation drift                            | E.164 normalize at ingest seam (`ingest.ts:85`); `phoneLookupVariants` covers legacy variants on lookup. Risk: if the storefront SDK records a non-canonical phone before the order ingests, the `TrackingEvent.phone` rewrite at identity-resolution time backfills it. |
| Address fingerprint collision                        | Token-sorted SHA-256 truncated to 32 chars; realistic collision only on identical token sets — by design. |

---

## 5. Historical intelligence capability matrix

For each candidate metric: **(A)** can it be computed TODAY with no schema change? **(B)** what are the source collections? **(C)** what is the data-completeness confidence? **(D)** what are the normalization gaps? **(E)** what are the replay risks if we wired it as a runtime aggregate?

### 5.1 Customer (phone) delivery success rate
- **A: ✅ Yes, today.** Already computed at scoring time in `collectRiskHistory` (`risk.ts:868–893`) — `phoneDeliveredRaw / (phoneDeliveredRaw + phoneReturnedRaw + phoneCancelledRaw)`.
- **B:** `Order` only.
- **C:** High. `Order.order.status` is the canonical truth and the chokepoint enforcement makes it consistent.
- **D:** Phone normalisation requires `phoneLookupVariants` to find legacy non-canonical rows. Already handled in `resolveIdentityForOrder`.
- **E:** Pre-aggregating into a per-merchant `(phone)` counter would inherit the same chokepoint semantics as `CourierPerformance`. Replay-safe IF gated by `applyTrackingEvents` AND the cancel paths.

### 5.2 Customer RTO rate
- **A: ✅** Same as 5.1 — `phoneReturnedRaw / priorResolved`.
- Same B / C / D / E as 5.1.

### 5.3 Customer cancellation patterns
- **A: ✅** `phoneCancelledRaw` available; can also distinguish reason via `automation.rejectionReason`, `fraud.reviewStatus = rejected`, `fraud.smsFeedback`.
- **D:** Cancellation reason is FRAGMENTED across `automation.rejectionReason`, `fraud.reviewNotes`, plus the writer pattern (§3.2). No unified `Order.cancelReason` field. Would need to enumerate the writer set.
- **E:** Same as 5.1.

### 5.4 Address reliability scoring
- **A: ✅** `addressHash` + same outcome lookup. Already used by `duplicate_address` signal — `addressDistinctPhones` and decayed `addressReturnedCount`.
- **B:** `Order.source.addressHash` (indexed: `{merchantId, source.addressHash, createdAt:-1}` partial).
- **C:** High where `addressHash` is set. Legacy orders before Address Intelligence v1 may lack `addressHash`; defensive recompute happens in `tracking.ts:215` (`hashAddress` from raw on terminal flip if missing).
- **D:** Two distinct concepts coexist: (a) `source.addressHash` (used for de-dup signal) and (b) `address.quality.completeness` (used for hint surface). They can coexist; both exist on every fresh order.
- **E:** Pre-aggregating into a per-`addressHash` counter would mirror `FraudSignal`. Replay-safe under same chokepoint gating.

### 5.5 Courier-region performance
- **A: ✅ Already aggregated** in `CourierPerformance` (per-district + global).
- **B:** `CourierPerformance`.
- **C:** High for active couriers; cold-start handling explicit.
- **D:** District is normalised via `normalizeDistrict`. Thana axis NOT yet aggregated.
- **E:** Existing system; documented replay-safe (§2.2).

### 5.6 District-level reliability (any courier)
- **A: ✅ Computable** via `Order.aggregate` keyed on `{merchantId, customer.district, order.status}` over a window. Today done ad-hoc in `analytics.getRTOMetrics:296` and the `topThanas` handler.
- **B:** `Order` (uses partial index `{merchantId, "customer.thana"|"customer.district", createdAt:-1}`).
- **C:** High.
- **D:** Thana extraction is best-effort (`extractThana`); coverage grows over time. Until coverage is universal, thana-keyed aggregates have a `null-thana` bucket.
- **E:** Runtime computation is replay-safe by virtue of being read-time aggregation. Pre-aggregating into a counter would inherit chokepoint semantics.

### 5.7 Merchant operational quality
- **A: ✅** `MerchantStats.{totalOrders, delivered, rto, cancelled, ...}` carries the raw counters. A "quality score" composed of (deliveredRate, rtoRate, avgTransitDays, webhook-failure-rate, automation-failure-rate) can be computed read-time.
- **B:** `MerchantStats` + `WebhookInbox` (failures) + `AuditLog` (`automation.*` failure actions) — same datasources used by `runAnomalyDetection`.
- **C:** Authoritative for counters. Anomaly detector already uses these.
- **D:** None.
- **E:** Read-time computation has zero replay risk.

### 5.8 Repeat delivery behavior
- **A: ✅** `phoneOrdersCount` (decayed), `phoneTotalRaw` (un-decayed), `TrackingSession.repeatVisitor`, plus `Order.intent.signals` keys (`repeat_visitor`, `multi_session_converter`).
- **B:** `Order` + `TrackingSession`.
- **C:** High for active SDK installs; `no_data` for non-SDK merchants is the explicit `intent.tier`.
- **D:** Cross-channel buyer identity is phone+email; `resolveIdentityForOrder` stitches both. SDK coverage is what drives the `no_data` rate.
- **E:** Read-time only (intent is observation-only); no replay risk.

### 5.9 Delivery success probability
- **A: ⚠️ Partially.** `pRto` (P(RTO)) is already computed by `computeRisk`. Its complement (`1 − pRto`) is the closest thing to "delivery success probability" the system has. But it's framed as a fraud probability anchored to merchant base RTO rate, not a delivery-reliability probability that joins (buyer × address × courier × district).
- **B:** `Order.fraud.riskScore` + `FraudPrediction.pRto` (snapshot).
- **C:** Available on every order from the fraud-v2 era forward; legacy orders have no `pRto`.
- **D:** The model conflates fraud risk with delivery risk. They overlap heavily but aren't identical — a high-COD-but-genuine buyer in a slow-rural-thana has high RTO probability for COURIER reasons, not fraud reasons. The current single-score model can't distinguish.
- **E:** Read-time recomputation; no replay risk.

### 5.10 Unreachable customer frequency
- **A: ✅** `CallLog` model carries `(answered: false, customerPhone, timestamp)`. `phoneUnreachableCount` is decayed in `collectRiskHistory`.
- **B:** `CallLog`.
- **C:** Coverage equal to call-center usage. Sparse for merchants who don't run a call center.
- **D:** Phone normalisation must match (E.164 canonical). Handled at write-time inside the call-center surface.
- **E:** Read-time aggregation; no replay risk.

### Capability summary

| Metric                          | Computable today | Aggregated today | Source                           |
|---------------------------------|:-:|:-:|---|
| Customer delivery success rate  | ✅ | (runtime in collectRiskHistory) | Order |
| Customer RTO rate               | ✅ | (runtime)                       | Order |
| Customer cancellation patterns  | ✅ | (runtime)                       | Order |
| Address reliability scoring     | ✅ | (runtime; partial signal)        | Order |
| Courier-region performance      | ✅ | ✅ (CourierPerformance)         | CourierPerformance |
| District-level reliability      | ✅ | (runtime; analytics ad-hoc)      | Order |
| Merchant operational quality    | ✅ | ✅ (MerchantStats)              | MerchantStats |
| Repeat delivery behavior        | ✅ | ✅ (Order.intent + TrackingSession) | Order, TrackingSession |
| Delivery success probability    | ⚠️ | (proxy via 1 − pRto)             | Order, FraudPrediction |
| Unreachable customer frequency  | ✅ | (runtime)                        | CallLog |

**Headline finding:** every metric on the user's audit list is either already aggregated or computable from existing collections **without a schema change**. The gap is not data — it's *unification at a single-score abstraction*.

---

## 6. Reusable intelligence inventory

### 6.1 Models that are reusable as-is

| Model            | Primary key                                  | Suitable for           | Re-use rules |
|------------------|----------------------------------------------|------------------------|--------------|
| `Order`          | `_id` + per-merchant `orderNumber` unique    | every read-time aggregation | use the existing partial indexes; never bypass `version` CAS on writes |
| `CourierPerformance` | `(merchantId, courier, district)`         | per-(courier, district) reliability | reuse the chokepoint, do NOT add a parallel writer |
| `FraudSignal`    | `(phoneHash, addressHash)`                   | cross-merchant phone/address reliability | observation-only at read; bonus capped at `NETWORK_BONUS_CAP` |
| `FraudPrediction`| `orderId`                                    | per-prediction outcome feedback | append at scoring time; updates only stamp outcome |
| `MerchantStats`  | `merchantId`                                 | merchant-level operational quality | ALL writers must pair with $inc — convention, not enforced |
| `TrackingSession`| `(merchantId, sessionId)` + `resolvedOrderId`| buyer-engagement correlation | resolved-order linkage is the join key |
| `CallLog`        | `(merchantId, customerPhone, timestamp)`     | unreachable-frequency aggregation | already used in `collectRiskHistory` |
| `WebhookInbox`   | `(merchantId, provider, externalId)`         | replay durability — NOT for analytics | reads here are for operational health, not analytics |
| `RecoveryTask`   | `_id` per task                               | cart-recovery queue (NOT delivery recovery) | distinct domain |

### 6.2 Pure functions reusable as building blocks

| Function                                  | File                              | Reuse role |
|-------------------------------------------|-----------------------------------|------------|
| `hashAddress(address, district)`          | `server/risk.ts:160`              | canonical address fingerprint |
| `hashPhoneForNetwork(phone)`              | `lib/fraud-network.ts:47`         | canonical phone hash for cross-merchant |
| `normalizeDistrict(district)`             | `lib/district.ts`                 | district key normalisation |
| `extractThana(address, district)`         | `lib/thana-lexicon.ts`            | thana extraction (best-effort) |
| `computeAddressQuality(address, district)`| `lib/address-intelligence.ts`     | address completeness/landmarks |
| `classifyCustomerTier(history)`           | `server/risk.ts:374`              | gold/silver/standard/new tiering |
| `scoreCourierCandidate(stats, opts)`      | `lib/courier-intelligence.ts:95`  | courier scoring formula |
| `classifyOperationalHint(input)`          | `lib/operational-hints.ts:122`    | per-order hint classification |
| `computeIntentScore(sessions)`            | `lib/intent.ts:204`               | buyer commitment score |
| `decayWeight(ageDays, halfLifeDays)`      | `server/risk.ts:760`              | exponential decay weighting |
| `phoneLookupVariants(phone)`              | `lib/phone.ts`                    | legacy phone variant fan-out |

### 6.3 Operational chokepoints reusable as extension points

| Chokepoint                                | File                              | Reuse role |
|-------------------------------------------|-----------------------------------|------------|
| `applyTrackingEvents`                     | `server/tracking.ts:77`           | the courier-driven terminal-outcome chokepoint |
| `ingestNormalizedOrder`                   | `server/ingest.ts:74`             | the create-order chokepoint |
| `safeEnqueue`                             | `lib/queue.ts:326`                | the durable-enqueue chokepoint |
| `updateOrderWithVersion`                  | `lib/orderConcurrency.ts`         | optimistic-CC write helper |
| `enqueueRescore`                          | `workers/riskRecompute.ts:252`    | risk recompute fan-out |
| `replayWebhookInbox`                      | `server/ingest.ts:711`            | commerce webhook replay |
| `replayCourierInbox`                      | `server/courier-replay.ts:24`     | courier webhook replay |

### 6.4 What is already operational intelligence — but underutilized

1. **`Order.fraud.pRto`** — a calibrated probability of RTO that already exists on every fresh order. The dashboard surfaces `riskScore` (0–100) but not `pRto%` directly to merchants, even though `pRto` is the more user-friendly framing.
2. **`Order.intent.tier` + signals** — fully computed and persisted on every SDK-tracked order, but read by exactly two surfaces (the order detail drawer and the analytics card). It does not feed any decision.
3. **`Order.address.quality`** — same. Computed on every order, surfaced on the drawer + analytics, but not summarised into "this merchant has X% complete addresses" anywhere except as an analytics card.
4. **`CourierPerformance.totalDeliveryHours`** — the `avgDeliveryHours` it computes is part of the auto-book scoring but never surfaced to the merchant. A "Pathao delivers 3.2× faster than RedX in your district" UI hint costs nothing more than a read.
5. **`logistics.lastWebhookAt` vs `lastPolledAt`** — the polling worker uses these to skip recently-pushed orders, but the same comparison would surface "this courier's webhook is healthy" / "this courier's webhook is broken, we're polling fallback" to merchants.
6. **`automation.confirmationDeliveryStatus`** — DLR data is captured per-order. An aggregate of "Y% of confirmation SMS reach the buyer" per merchant is computable today but not surfaced.
7. **`logistics.pollErrorCount`** — increments on every failed poll. A merchant whose courier credentials are silently broken can see degraded tracking; a "credentials likely expired" hint is computable from N consecutive non-zero poll errors.
8. **`FraudSignal.merchantCount`** — surfaced in the `NetworkSignalCard` but not aggregated to "your merchant has contributed N RTO signals to the network". A merchant-level network contribution stat exists in counts but is invisible.
9. **`Order.calls[]` (per-order calls subdoc)** — distinct from `CallLog`; un-rolled-up. A "this buyer has been called 3 times" hint is computable from the order itself.

---

## 7. Safest extension-point recommendations

### 7.1 What should NEVER be refactored

1. `applyTrackingEvents` internals. The status guard, dedupe guard, and atomic Order.updateOne filter are load-bearing for replay correctness across webhook + poll + replay paths. **Add side-effects beside the existing fan-out, never inside the filter.**
2. `WebhookInbox` schema and indexes. The unique `(merchantId, provider, externalId)` is the entire idempotency contract.
3. `safeEnqueue` discriminated union. Callers depend on the precise `ok: true | recovered | deadLettered | ok: false` shape.
4. `computeRisk` weight set + tier bypass rules. Per-merchant tuner already adapts via multipliers; the static base set is the explainability anchor.
5. `Order.version` CAS contract. Every mutating write uses `updateOrderWithVersion`; bypassing is a bug.
6. `FraudSignal` privacy posture (hashes only, capped merchant set, aggregate-only reads).
7. The pure-function vs side-effecting split (`computeRisk` vs `collectRiskHistory`; `computeIntentScore` vs `scoreIntentForOrder`; `classifyOperationalHint`). This separation is what makes the test surface tractable.

### 7.2 Lowest-risk extension surfaces (in increasing risk order)

| Extension surface | Risk | Why |
|-------------------|------|-----|
| **Add a new tRPC analytics procedure** (read-only) that joins Order + CourierPerformance + CallLog at read time | minimal | no schema change, no writer, replay-irrelevant |
| **Add a new pure-function classifier** (e.g. `classifyDeliveryReliability(orderInput) → DeliveryReliabilityResult`) called from `getOrder` like `classifyOperationalHint` | minimal | observation-only, no persistence |
| **Add a new observation-only subdoc to `Order`** (e.g. `Order.deliveryReliability`) populated fire-and-forget at ingest like `Order.intent` | low | additive subdoc; absent on legacy rows; no read path can crash on missing |
| **Add a new aggregate collection** (e.g. `CustomerReliability(merchantId, phoneHash)`) written from `applyTrackingEvents` | low–medium | mirrors CourierPerformance; protected by the chokepoint; needs the cancel-path coverage decision |
| **Add a new signal to `computeRisk`** | medium | adds a weight; affects every tier classification; needs explainability copy + tuner support |
| **Wire `lookupNetworkRisk.bonus` into `riskScore`** | medium | already gated by warming-up; would need ramp-up monitoring |
| **Re-key `CourierPerformance` by `(merchant, courier, thana)`** | high | breaks every existing read; bigger blast radius than starting a sibling collection |
| **Modify `applyTrackingEvents` filter logic** | high | replay correctness regression class |

---

## 8. Additive delivery-reliability architecture recommendation

**Question the user posed:** delivery reliability — separate intelligence layer / part of operationalHint / part of fraud / separate collection / precomputed / runtime / hybrid?

**Recommendation: hybrid — observation-only subdoc + sibling per-(merchant, key) aggregates + pure-function classifier on read. Never inside `computeRisk`. Never sharing the `CourierPerformance` collection.**

### 8.1 The shape

Three layers, all additive, none touching the existing risk/automation/replay paths:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Layer C — Per-order pure-function classifier (READ-ONLY)             │
│   classifyDeliveryReliability({                                       │
│     courierStats, customerStats, addressStats, thana, addressQuality, │
│     networkAggregate                                                  │
│   }) → { score, tier, signals[] }                                     │
│                                                                        │
│   Called from `getOrder` like `classifyOperationalHint`. NEVER feeds   │
│   computeRisk. Visibility-only on the order detail drawer.             │
└──────────────────────────────────────────────────────────────────────┘
                                ▲
                                │ reads
                                │
┌──────────────────────────────────────────────────────────────────────┐
│ Layer B — Sibling aggregate collections (existing chokepoint)         │
│   CustomerReliability(merchantId, phoneHash)                          │
│      mirrors CourierPerformance shape: delivered/rto/cancelled/       │
│      lastOutcomeAt; lookups via hashPhoneForNetwork                    │
│                                                                        │
│   AddressReliability(merchantId, addressHash)                         │
│      same shape; lookups via existing addressHash                      │
│                                                                        │
│   (Optional) CourierThanaPerformance(merchantId, courier, thana)      │
│      same shape as CourierPerformance but keyed on thana               │
│                                                                        │
│   Writers: ALL go through applyTrackingEvents fan-out, beside the     │
│   existing 4 best-effort writes (FraudPrediction, FraudSignal,         │
│   CourierPerformance, MerchantStats). Wrapped in void/.catch — a       │
│   failure can never affect the order/status write.                     │
└──────────────────────────────────────────────────────────────────────┘
                                ▲
                                │ writes (best-effort)
                                │
┌──────────────────────────────────────────────────────────────────────┐
│ Layer A — Existing terminal-outcome chokepoint                        │
│   applyTrackingEvents ← webhook | poll | replay                       │
│   already enforces idempotency, dedupe, status guard, version CAS    │
└──────────────────────────────────────────────────────────────────────┘

Optional Layer D — observation-only subdoc on Order:
   Order.deliveryReliability = {
     score, tier, signals, computedAt, sessionsConsidered? (n/a here)
   }
   Stamped fire-and-forget AFTER ingest, like Order.intent.
   Lets the order list show a tier badge without re-running the
   classifier on every row.
```

### 8.2 Why hybrid (and not the alternatives)

- **Not inside `operationalHint`.** That layer is per-order *acute* attention triage ("delivery failed", "stuck"). Reliability is per-order *predictive context* ("this order has a 70% historical success likelihood across these axes"). Conflating them muddies both panels.
- **Not part of `fraud`.** `computeRisk` is fraud detection — buyer/order-shape risk. Delivery reliability is courier/lane reliability — operational risk. They overlap in inputs (phoneReturnedCount, addressReturnedCount) but the OUTPUT is different. Folding into `fraud` would make a slow-rural-thana order indistinguishable from a stolen-card order.
- **Not a separate top-level collection** for the order-level result. That'd be a 1:1 sidetable with `Order` — a subdoc is cheaper and joins for free in `getOrder`.
- **Not runtime-only.** Aggregating per-customer and per-address from `Order` at read time would require a heavy `Order.aggregate` per `getOrder` call. The CourierPerformance pattern (pre-aggregated counters fed from the chokepoint) is proven; mirroring it for customer/address is the same cost profile.
- **Not precomputed-only.** The combiner — joining (customer × address × courier × thana × address-quality × network) — is order-specific and only runs on the small set of orders the merchant is actually viewing. Pure function on read is cheaper than maintaining a 5-axis cube.

### 8.3 Constraints this design respects

1. **Replay safety preserved.** Every aggregate write goes through the existing chokepoint and inherits its guards. No new replay-sensitive aggregation point is created.
2. **Idempotency preserved.** Counters fire on the same `(prevStatus → nextStatus)` transition gate that already protects `MerchantStats` / `CourierPerformance` / `FraudSignal`.
3. **`computeRisk` untouched.** Delivery reliability is observation-only; the score never feeds `riskScore`. `pRto` continues to be the fraud probability.
4. **Tenant isolation preserved.** All new aggregates are merchant-scoped. The optional cross-merchant axis stays inside `FraudSignal`, which already has the privacy posture in place.
5. **Explainability preserved.** Each signal in `DeliveryReliabilityResult` carries a `detail` string the merchant can read verbatim — same contract as `IntentSignal`, `OperationalHint.suggestedAction`, `RiskSignal.detail`.
6. **Observability preserved.** A `delivery_reliability_aggregated` audit / log line (matching `intent.scored` and `address.scored`) gives a tier-mix and latency drift signal for monitoring.

### 8.4 What stays observational-only vs merchant-facing vs internal

| Layer                        | Audience       | Surface |
|------------------------------|----------------|---------|
| Per-order classifier         | Merchant       | Order detail drawer (tier badge + signals) |
| Per-customer aggregate       | Merchant       | (optional) customer profile drawer surfacing repeat-buyer history |
| Per-address aggregate        | Merchant       | (optional) hint inside operational-hint panel ("this address has prior RTO") |
| Per-(courier, thana) aggregate | Internal first | improves `selectBestCourier` selection in a follow-up; not surfaced until validated |
| Tier-mix / latency drift logs| Internal       | observability |
| Cross-merchant network bonus | Internal       | already capped + privacy-preserving; remains observation-only in v1 |

### 8.5 Free wins from existing data (no schema change required)

1. Surface `pRto%` next to `riskScore` in the order detail drawer — the field already exists.
2. Surface `avgDeliveryHours` from `CourierPerformance` ("Pathao delivers in ~2.6 days for your Dhaka orders") — already aggregated.
3. Aggregate `confirmationDeliveryStatus` per merchant ("Y% of your confirmation SMS reach the buyer") — already captured per-order.
4. Surface `logistics.pollErrorCount` ≥ N as a "courier credentials may be expired" hint — already incremented.
5. Aggregate `Order.intent.tier` over the merchant's last 30 days ("Z% of your buyers are 'verified intent'") — already counted by the existing `intentDistribution` card; extend to a sidebar KPI.
6. Surface `MerchantStats`-derived "operational quality" KPI on the dashboard — already counted; only the formula is missing.

### 8.6 Validation gates before moving from observation to influence

If a future milestone considers wiring delivery reliability INTO `computeRisk` (the way Phase 7 contemplates for `intent`):

1. ≥14 days of `Order.deliveryReliability` outcomes stamped on `FraudPrediction`.
2. Per-tier RTO precision computed (analogous to the fraud-tuner's per-signal precision math).
3. Tier-conditioned RTO precision shows monotonic separation across tiers (verified < implicit < unverified).
4. Per-merchant samples ≥ `MIN_SAMPLE_SIZE` (50, per fraud-weight-tuning).
5. Network warming-up posture (halve the contribution while the cohort is small).

These five gates are already the standard the fraud tuner enforces — no new validation infrastructure is needed.

---

## 9. Explicit answers to the user's analysis goals

| Question | Answer |
|---|---|
| What operational intelligence already exists but is underutilized? | `pRto%`, `Order.intent.*`, `Order.address.quality.*`, `CourierPerformance.totalDeliveryHours`, `logistics.lastWebhookAt`/`lastPolledAt` divergence, `automation.confirmationDeliveryStatus` rollup, `logistics.pollErrorCount`, `FraudSignal.merchantCount` from the merchant's own contributions, and `Order.calls[]` per-order call history (§6.4). |
| What is the safest existing chokepoint? | `applyTrackingEvents` for courier-driven terminal outcomes (§3.6). For non-courier cancels, the cancel paths are SCATTERED today (§3.2–3.3) — extending them needs a single helper. |
| What existing models should be reused? | `Order` (subdoc additions), `CourierPerformance` (read-only), `FraudPrediction` (outcome stamping), `FraudSignal` (read-only at lookup), `MerchantStats` (read-only), `TrackingSession` (resolved-order linkage), `CallLog` (unreachable counts). New aggregates should mirror the CourierPerformance shape, not reuse the CourierPerformance collection (§8.1). |
| What should NEVER be refactored? | §7.1: `applyTrackingEvents` internals, `WebhookInbox` schema, `safeEnqueue` discriminated union, `computeRisk` weights/bypasses, `Order.version` CAS contract, `FraudSignal` privacy posture, the pure-vs-impure split. |
| What intelligence should remain observational-only? | `Order.intent`, `Order.address.quality`, `operationalHint`, the proposed `Order.deliveryReliability`. None should feed `computeRisk` in v1. The `lookupNetworkRisk.bonus` is read-only today; if wired in later it must remain warming-up-aware and bonus-capped. |
| What should remain separate from fraud scoring? | Delivery reliability (§8.2). Lane / courier / thana reliability is operational, not fraud. The current single-score (`riskScore`/`pRto`) cannot distinguish a slow-rural-thana from a stolen-card. |
| What should be merchant-facing vs internal? | Merchant-facing: per-order reliability tier + signals, per-customer repeat-buyer summary, per-address prior-RTO hint, courier-speed surfaces. Internal: per-(courier, thana) aggregate, network contribution stats, tuner-style observability logs (§8.4). |
| What can be computed for free from existing data? | All ten capabilities in the matrix (§5) compute today without a schema change. Six of them are already pre-aggregated; the other four are pre-aggregated at scoring time inside `collectRiskHistory` and require either a runtime aggregation or a sibling counter to stand-alone (§8.5). |

---

## 10. Summary of risk decisions

1. The single safest chokepoint is `applyTrackingEvents`. Add side-effects beside the existing four; never inside the filter.
2. The single replay-corruption class today is `delivered/rto → manual rollback → re-delivered`. No UI exposes this path; if one is added, it must roll back the four side-effect aggregates atomically OR `applyTrackingEvents` must be made aware (additional flag) — neither change is in scope here.
3. Cancel paths (auto-expire, SMS NO, fraud reject, manual cancel) currently DON'T fan out to `FraudPrediction.outcome` / `FraudSignal`. The fraud tuner is unaffected (cancel is excluded from precision math); the cross-merchant network is partially under-fed.
4. The proposed Layer-B additive aggregates (CustomerReliability, AddressReliability) inherit replay-safety from the chokepoint they are wired through. They are NOT replay-safe if anyone calls them directly outside of that chokepoint — same caveat as `recordCourierOutcome` today.
5. `pRto` is already a probabilistic delivery-reliability proxy on every order. Surfacing it costs nothing.
6. `computeRisk` should remain the fraud scorer. A separate `classifyDeliveryReliability` is the operational scorer. They share inputs but produce different outputs and should never be conflated.

— end of deep audit —
