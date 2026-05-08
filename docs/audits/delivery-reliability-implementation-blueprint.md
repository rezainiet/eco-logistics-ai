# Delivery Reliability — Implementation Blueprint

**Status:** architecture hardening only, 2026-05-08. **NO code changes** in this document.
**Companion docs:** [architecture-inventory](./architecture-inventory.md), [file-inventory](./file-inventory.md), [execution-flow](./execution-flow.md), [scoring-flow](./scoring-flow.md), [deep-scoring-audit](./deep-scoring-audit.md).
**Engineering posture:** additive-only; preserve replay integrity; preserve fraud semantics; graceful degradation always; every aggregate reconstructible; every write idempotent; every read tolerates missing data.

This blueprint is the single source of truth for HOW Delivery Reliability is intended to ship. Anything not here is out of scope.

---

## 1. Finalized architecture

### 1.1 Component inventory (final)

| # | Component                                | Type                | Lifecycle owner       | Surfaced to     |
|---|------------------------------------------|---------------------|-----------------------|-----------------|
| 1 | `CustomerReliability` collection         | aggregate counter   | `applyTrackingEvents` fan-out | classifier (read) + analytics |
| 2 | `AddressReliability` collection          | aggregate counter   | `applyTrackingEvents` fan-out | classifier (read) + analytics |
| 3 | `CourierThanaPerformance` collection     | aggregate counter (**v2**) | `applyTrackingEvents` fan-out | `selectBestCourier` (read) |
| 4 | `Order.deliveryReliability` subdoc       | observation snapshot (**v2**) | new fire-and-forget post-resolution | order list badge |
| 5 | `classifyDeliveryReliability(...)`       | pure function       | called from `orders.getOrder` | order detail drawer |
| 6 | `analytics.deliveryReliabilitySummary`   | tRPC read procedure | new                   | merchant analytics page |
| 7 | `analytics.topUnreliableLanes` (**v2**)  | tRPC read procedure | new                   | merchant analytics page |
| 8 | Observability instrumentation            | log + counters      | new                   | internal observability |
| 9 | `DeliveryReliabilityCheckpoint` collection (**v2**) | backfill ledger | offline backfill job | none (internal) |

### 1.2 `CustomerReliability` — exact shape

```
collection: customer_reliabilities
key:        (merchantId: ObjectId, phoneHash: String)

document:
  merchantId       ObjectId   ref Merchant, required
  phoneHash        String     sha256("p:" + canonicalPhone)[:32], required
  deliveredCount   Number     default 0, min 0
  rtoCount         Number     default 0, min 0
  cancelledCount   Number     default 0, min 0
  lastOutcomeAt    Date       updated on every fan-out
  firstOutcomeAt   Date       set on insert only
  // optional v1 fields — populated only when Order has them at write time
  lastOrderId      ObjectId   denormalized; latest contributing order
  lastDistrict     String     normalised; informational

  createdAt        Date       (timestamps)
  updatedAt        Date       (timestamps)

indexes:
  { merchantId: 1, phoneHash: 1 }                       // unique
  { merchantId: 1, lastOutcomeAt: -1 }                  // staleness sweep + dashboards
```

**Why phoneHash, not raw phone:** matches `FraudSignal`'s hash convention; keeps the new collection reuseable as a privacy-safe surface; the same `hashPhoneForNetwork` (`lib/fraud-network.ts:47`) produces the key. No PII leaks if the collection is ever exposed in logs.

**Why no decayed counters in storage:** `CourierPerformance` doesn't store decayed counters either. Storing raw totals + `lastOutcomeAt` keeps the writer pure `$inc`; decay is applied at read time inside `classifyDeliveryReliability` (the same way `risk.ts:decayWeight` does it for `phoneOrdersCount`).

**Why no reasonCounts (refused / no-answer breakdown):** v1 ships counters only. Reason taxonomy lives in `automation.rejectionReason` + `fraud.smsFeedback` and is fragmented (§3 of deep audit). Adding it would require unifying a writer set we've explicitly chosen not to touch in v1.

### 1.3 `AddressReliability` — exact shape

```
collection: address_reliabilities
key:        (merchantId: ObjectId, addressHash: String)

document:
  merchantId         ObjectId   ref Merchant, required
  addressHash        String     output of risk.ts:hashAddress(address, district), [:32], required
  deliveredCount     Number     default 0, min 0
  rtoCount           Number     default 0, min 0
  cancelledCount     Number     default 0, min 0
  // distinctPhoneHashes is BOUNDED — capped at FRAUD_SIGNAL_MAX_MERCHANTS-style ceiling
  distinctPhoneHashes  [String]  capped at 32; truncated via $slice on update
  lastOutcomeAt      Date
  firstOutcomeAt     Date
  lastDistrict       String     informational

  createdAt          Date
  updatedAt          Date

indexes:
  { merchantId: 1, addressHash: 1 }                     // unique
  { merchantId: 1, lastOutcomeAt: -1 }                  // staleness sweep
```

**Why distinctPhoneHashes here:** mirrors the existing `addressDistinctPhones` runtime computation in `risk.ts:collectRiskHistory:898`. Keeping a capped `$addToSet`-style array (max 32) makes the "this address has been used by N different buyers" signal an O(1) read. Cap is enforced via aggregation-pipeline `$slice` (same pattern as `FraudSignal.merchantIds`).

### 1.4 `CourierThanaPerformance` (v2 only — defined for forward-compat)

```
collection: courier_thana_performance      // v2; do not create in v1
key:        (merchantId, courier, thana)   // thana = "_GLOBAL_" sentinel for fallback

document:                                  // identical shape to CourierPerformance
  merchantId, courier, thana,
  deliveredCount, rtoCount, cancelledCount,
  totalDeliveryHours, lastOutcomeAt
  // no recentFailureCount / recentFailureWindowAt — that stays at the
  // (courier, district) granularity in CourierPerformance
indexes:
  { merchantId: 1, courier: 1, thana: 1 }   // unique
```

`CourierPerformance` is NOT modified. v2 adds this sibling collection and the `selectBestCourier` read layer prefers `CourierThanaPerformance` when thana is known and observations ≥ MIN_OBSERVATIONS, falling back to `CourierPerformance(district)` then `CourierPerformance(_GLOBAL_)` then cold-start. Out of scope for v1.

### 1.5 `Order.deliveryReliability` subdoc (v2 only)

```
deliveryReliability:
  score              Number 0..100
  tier               String enum [verified, implicit, unverified, no_data]
  signals            [{ key, weight, detail }]   // pure shape; same as IntentSignal
  samplesConsidered  { customer: Number, address: Number, courier: Number }
  computedAt         Date
```

Optional in v1. v1 simply runs `classifyDeliveryReliability` on every `getOrder` and returns the result inline (analogous to `operationalHint`). v2 stamps the subdoc fire-and-forget at terminal flip so the order LIST page can render the badge without N classifier calls per page.

### 1.6 `classifyDeliveryReliability` — pure-function contract

Mirrors the contracts of `classifyOperationalHint` and `computeIntentScore` — same purity rules, same explainability rules, same "no automation/fraud feedback" rule.

```
inputs:
  customerStats?:  { deliveredCount, rtoCount, cancelledCount,
                     lastOutcomeAt, firstOutcomeAt }
  addressStats?:   same shape + distinctPhoneCount, addressReturnedCount
  courierStats?:   {                                           // existing
                     successRate, rtoRate, avgDeliveryHours,
                     observations, coldStart, stale,
                     matchedOn  // district | global | cold_start
                   }
  thana?:          string
  addressQuality?: { completeness, score, missingHints[] }
  networkAggregate?: NetworkRiskAggregate                      // existing
  now?:            Date     // injectable for tests

outputs:
  { score:    Number 0..100,
    tier:     "verified" | "implicit" | "unverified" | "no_data",
    signals:  [{ key, weight, detail }],
    samplesConsidered: { customer, address, courier },
    computedAt: Date
  }

contract:
  - PURE — no DB I/O, no clock except `now`, no env reads
  - returns tier="no_data" when ALL of {customerStats, addressStats, courierStats}
    are absent OR every observation count is below MIN_OBSERVATIONS_FOR_SIGNAL
  - signals carry an operator-readable `detail` string, surfaced verbatim
  - score ∈ [0,100]; never feeds computeRisk; never enqueues a job;
    never writes to Mongo
```

**Stable signal keys (v1):**

```
customer_repeat_success     buyer has prior delivered orders for this merchant
customer_repeat_rto         buyer has prior RTOs for this merchant
customer_low_success_rate   priorResolved≥3 AND deliveredRate<0.4
address_clean_history       prior delivered at same address, no RTO
address_repeat_rto          prior RTO at same address
address_multi_buyer         distinctPhoneCount ≥ 3
courier_lane_strong         district matchedOn AND successRate ≥ 0.85 AND obs ≥ 30
courier_lane_weak           district matchedOn AND rtoRate ≥ 0.20
courier_lane_unknown        cold_start OR stale
network_warning             network rtoRate ≥ 0.5 AND merchantCount ≥ 2 (visibility-only)
address_quality_warning     completeness === "incomplete"
```

**Tier thresholds (v1, mirroring intent.ts):**
- `verified ≥ 70`
- `implicit ≥ 40`
- `unverified < 40`
- `no_data` when nothing tippable contributes

### 1.7 Read-time integration (v1)

`orders.getOrder` (`server/routers/orders.ts:1636` neighborhood) gains:

1. After loading `order`, derive `phoneHash`, `addressHash`, `district`, `thana`, `courier`.
2. Fan out three reads in parallel:
   - `CustomerReliability.findOne({merchantId, phoneHash})`
   - `AddressReliability.findOne({merchantId, addressHash})`
   - existing per-courier read (already issued for `selectBestCourier` paths) OR a fresh `CourierPerformance` lookup
3. Reuse the existing `lookupNetworkRisk(...)` already called in `routers/orders.ts:234`.
4. Reuse `Order.address.quality` already on the doc.
5. Call `classifyDeliveryReliability(...)` and merge the result into the response next to `operationalHint`.

Cost: 2 small `_id`-equivalent lookups + 1 small lookup; total p95 < 5ms. The `getOrder` payload already does ~6 reads.

### 1.8 Failure semantics (v1)

| Layer | Failure | Behavior |
|---|---|---|
| Aggregate write (chokepoint fan-out) | Mongo throws | logged via existing `console.error` pattern; order/status write unaffected; eventual consistency restored on next outcome |
| Aggregate read in `classifyDeliveryReliability` path | DB error | classifier called with `undefined` stats → returns `tier: "no_data"`; NO 500 to merchant |
| Pure function throws | Programmer error | caller catches; returns null; absent panel in UI |
| Feature flag off | n/a | classifier short-circuits; no aggregate reads issued |

### 1.9 Lifecycle ownership

| Concern | Owner |
|---|---|
| Writing to aggregates | `applyTrackingEvents` only (v1). `recordCustomerOutcome` + `recordAddressOutcome` helpers in a new `lib/delivery-reliability.ts`. |
| Reading aggregates | `classifyDeliveryReliability` callers only |
| Pure-function evolution | `lib/delivery-reliability.ts` (new file) |
| Backfill | offline job; v2 only; never touches the chokepoint |
| Tier copy / UI | `apps/web/src/components/orders/delivery-reliability-panel.tsx` (new) |
| Feature flag | `env.DELIVERY_RELIABILITY_READ_ENABLED` (boolean) and `env.DELIVERY_RELIABILITY_WRITE_ENABLED` (boolean) |

### 1.10 Retention strategy

- `CustomerReliability` / `AddressReliability` rows are **append-and-update**, no TTL. Total document count bound = `unique merchant×phoneHash` and `unique merchant×addressHash`. Realistic upper bound: O(merchant active customer count). No retention pressure for v1.
- Sweepable on demand: any row with `lastOutcomeAt > 365d` ago can be archived later. Out of scope for v1.

### 1.11 Migration requirements

| Change | Migration kind | Required for v1 |
|---|---|---|
| New `customer_reliabilities` collection + 2 indexes | additive index build | yes |
| New `address_reliabilities` collection + 2 indexes | additive index build | yes |
| New env flags `DELIVERY_RELIABILITY_READ_ENABLED`, `DELIVERY_RELIABILITY_WRITE_ENABLED` | env-only | yes |
| `CourierThanaPerformance` collection + indexes | additive index build | **no — v2** |
| `Order.deliveryReliability` subdoc field | additive Mongoose schema; no migration | **no — v2** |
| Backfill of pre-existing terminal orders | offline job | **no — v2 (or never)** |

### 1.12 Consistency guarantees

- **Within-row:** counter math is `$inc` only; under MongoDB's per-document atomicity, no torn reads.
- **Cross-row:** counters across `CustomerReliability` + `AddressReliability` + `CourierPerformance` reflect different keys, never expected to sum to anything cross-collection. There IS NO invariant of the form "sum of CustomerReliability.delivered for merchant M = MerchantStats.delivered for M" — distinct customers can buy multiple times so the customer-axis sum equals total delivered orders, the address-axis sum can DIFFER (multiple orders to one address). This is by design and must be documented to anyone drawing dashboards.
- **Eventual:** chokepoint side-effects are best-effort. A write failure means a single missing increment, never a corruption — at worst, the buyer's reliability tier shows as one outcome behind for a while.

---

## 2. Implementation sequencing

Phases are ordered for **lowest-risk additivity**. Each phase compiles and ships independently. Each is gated behind a feature flag where the gate adds value.

### 2.1 Phase ordering (10 phases)

```
S1  Pure function `classifyDeliveryReliability(...)` + unit tests
S2  Schema models: CustomerReliability + AddressReliability + indexes
S3  Writer helpers `recordCustomerOutcome` + `recordAddressOutcome` (NOT yet wired)
S4  Wire writer helpers into applyTrackingEvents fan-out, GATED by
    DELIVERY_RELIABILITY_WRITE_ENABLED (default false in prod)
S5  Observability instrumentation (logs, counters, drift sentinel)
S6  Read-time integration in orders.getOrder, GATED by
    DELIVERY_RELIABILITY_READ_ENABLED (default false; opt-in per-merchant via flag)
S7  Analytics tRPC procedure `deliveryReliabilitySummary` (admin-flag-gated)
S8  UI surface: per-order tier badge + signals on tracking-timeline-drawer
S9  Cohort enable: turn write flag on in production for all merchants;
    (read flag remains opt-in to avoid mass UI changes)
S10 Cohort enable: turn read flag on globally; remove flag scaffolding in v1.5

(v2 adds Phase B-1 backfill, Phase B-2 Order.deliveryReliability subdoc,
 Phase B-3 CourierThanaPerformance.)
```

### 2.2 Per-phase rationale

| Phase | Why this order is safest | Blast radius | Rollback complexity | Replay sensitivity | Validation requirements | Feature flag needed? |
|---|---|---|---|---|---|---|
| **S1** | Pure function with no I/O is the unit-test baseline; future phases all depend on its shape | nil — code is dead until called | revert one file | n/a | unit-test matrix per signal, edge cases (no_data, gold-tier, all-cold-start, all-hits) | no |
| **S2** | Schemas + indexes added with NO writers ⇒ no behavior change; index build is fast on empty collections | nil — empty collections | drop the two collections | n/a | confirm collections exist + indexes built; no writes yet | no |
| **S3** | Writer helpers are unit-testable in isolation against an in-memory MongoDB; no production wiring | nil — code is dead until called from S4 | revert one file | tested standalone | unit tests covering insert+upsert paths, distinctPhoneHashes cap, $inc semantics | no |
| **S4** | Wiring into the chokepoint comes AFTER helpers proven; gated behind a flag default-off so production stays unchanged on deploy | none under flag-off; bounded ($inc per terminal flip, never > N writes/sec) on flag-on | flip flag off; no aggregate cleanup needed (counters reflect partial truth, classifier handles via lastOutcomeAt staleness) | High — must respect chokepoint guard. Tested via `pending-job-replay` scenarios + `webhook-retry` orphan recovery | replay-storm test in dev: replay 1000× same WebhookInbox row, assert counters identical to single-run | yes — `DELIVERY_RELIABILITY_WRITE_ENABLED` |
| **S5** | Observability shipped BEFORE any meaningful traffic so the first writes are observed | nil — log volume bounded | revert | n/a | structured-log shape match against `intent.scored` schema | no |
| **S6** | Reads gated independently of writes — lets writes warm up before reads expose tiers to merchants | nil under flag-off; small read fanout (3 lookups) under flag-on | flip flag off | no replay risk on read | p95 latency check on `getOrder` with classifier active | yes — `DELIVERY_RELIABILITY_READ_ENABLED` |
| **S7** | Analytics procedure read-only; admin-flag-gated so internal users dogfood first | nil under flag-off | flip flag off | none | benchmark on largest test merchant | yes — admin flag |
| **S8** | UI surface is the LAST step — shipping markup before backend is dead pixels; shipping backend before UI is observable internally first | nil — UI tied to flag | revert UI commit | none | manual smoke + Playwright if available | shares S6 flag |
| **S9** | After 7+ days of write-flag-on dogfood, enable for all merchants. Aggregate counters fill in real time | bounded ($inc fan-out grows linearly with terminal-flip rate) | flip flag off; counters keep their latest values (not corruption, just frozen) | tracked via S5 | drift check (§4.3) green for 7d | yes |
| **S10** | After 14+ days of write-flag-on globally, enable read-flag globally. Merchants see the panel | merchant-visible UX change | flip read flag off | none | dashboard p95 latency green; no spike in `delivery_reliability.classified` errors | yes |

### 2.3 Feature flag matrix (v1)

| Flag                                  | Default | Controls                                                       |
|---------------------------------------|---------|----------------------------------------------------------------|
| `DELIVERY_RELIABILITY_WRITE_ENABLED`  | `false` | the two `record*Outcome` calls inside `applyTrackingEvents`    |
| `DELIVERY_RELIABILITY_READ_ENABLED`        | `false` | the read-side classifier call inside `orders.getOrder`         |
| `DELIVERY_RELIABILITY_ANALYTICS_ENABLED` | `false` | the new `deliveryReliabilitySummary` tRPC procedure (admin)   |

The two write/read flags are **independent on purpose** — writes can warm without exposing partial UI; reads can be turned off in incident response without losing data accumulation.

### 2.4 Why NO feature flag for the schema additions

Schemas + indexes are additive; they do not change behavior until writers exist. Adding a flag here would mean dynamic index creation, which is worse than a static schema migration. The two collections + their indexes ship in S2 unconditionally.

---

## 3. Backfill strategy

### 3.1 v1 explicitly ships WITHOUT backfill

**v1 starts collecting from the moment `DELIVERY_RELIABILITY_WRITE_ENABLED=true` lands.** Pre-existing terminal orders are NOT retroactively counted. Reasoning:

- `CustomerReliability` / `AddressReliability` are advisory aggregates feeding an observation-only classifier. A merchant whose buyer has 5 historical RTOs that aren't yet counted simply sees `tier: "no_data"` until the next terminal outcome lands — same UX as the `Order.intent.no_data` surface used today.
- Skipping backfill removes the entire class of "live writes vs backfill writes overlap" risks (§3.4–3.6 below).
- Per the audit, every metric is already runtime-computable from `Order` for analytics surfaces. The aggregates are an OPTIMIZATION, not a truth source. Live ramp-up is acceptable.
- The fraud-tuner already operates on a 90-day rolling window without retroactive backfill of older predictions; this matches existing posture.

If a merchant or stakeholder demands backfilled history, v2 ships the design below.

### 3.2 Backfill design (v2 — described, not implemented)

#### 3.2.1 Source of truth

`Order` collection. Specifically: orders with `order.status ∈ {delivered, rto, cancelled}` AND `updatedAt ≤ T` for some cutoff `T` chosen BEFORE the job starts.

Backfill **must NOT replay events** through `applyTrackingEvents` and **must NOT call `recordCourierOutcome`**. Both would either re-fire the existing chokepoint side-effects (double-count `MerchantStats`, re-stamp `FraudPrediction.outcome`, re-contribute to `FraudSignal`, re-increment `CourierPerformance`) or fail the chokepoint's status guard. Backfill writes **directly** to the new aggregate collections via dedicated helpers.

#### 3.2.2 Strategy

**Snapshot-cutoff pattern**, not event replay:

```
At t=T (cutoff fixed BEFORE backfill begins):
  for each (merchantId, phoneHash) bucket:
     compute absolute counters via Order.aggregate over orders with
     terminalAt ≤ T
  bulkWrite UPSERT to customer_reliabilities with $set {counters} and
     $setOnInsert {firstOutcomeAt}, $max {lastOutcomeAt}
     (NOT $inc — $set is idempotent on re-run)

  same for (merchantId, addressHash) → address_reliabilities

Live writes from chokepoint fire-and-forget AFTER T:
  use $inc as normal — orders written into the chokepoint after T
  have terminalAt > T so they DON'T overlap the backfilled set
```

**The aggregate row carries TWO independent contributions:** backfill's `$set` of pre-T totals, then live `$inc` of post-T deltas. Sum is implicit (all in the same field). Provided no order is counted in both (T-boundary check), no double-count is possible.

Boundary precision:
- `T` is a Date stored on the merchant doc as `deliveryReliabilityBackfillCutoff`.
- The aggregate-pipeline `$match` stage uses `terminalAt ≤ T`. We define `terminalAt` deterministically as `coalesce(logistics.deliveredAt, logistics.returnedAt, /* cancelled-at proxy */ updatedAt)`.
- The chokepoint, on a terminal flip, uses `now` as the outcome instant (already passed-through to `lastOutcomeAt`). After T, `now > T` always.
- The narrow risk: a backfill batch is in flight while a live order's terminal flip happens for the same `(merchantId, phoneHash)` key.
  - The chokepoint write does `$inc` ⇒ +1 on existing fields; backfill subsequently does `$set` ⇒ overwrites with backfill total ⇒ **the live increment is lost**.
  - **Mitigation:** backfill uses a per-key two-phase compose:
    1. Phase 1: count `Order` aggregate where `terminalAt ≤ T` into a STAGING field `backfillCounts: { delivered, rto, cancelled }` with `$set`.
    2. Phase 2: at job end, atomic merge — `findOneAndUpdate` per row with a pipeline:
       ```
       $set:
         deliveredCount: { $add: [ "$backfillCounts.delivered", "$liveCounts.delivered" ] }
         rtoCount:       { $add: [ "$backfillCounts.rto",       "$liveCounts.rto" ] }
         cancelledCount: { $add: [ "$backfillCounts.cancelled", "$liveCounts.cancelled" ] }
       $unset: backfillCounts
       ```
    3. The live writer must, throughout backfill, write into `liveCounts.*` (NOT the canonical fields). This requires a writer-mode flag (`DELIVERY_RELIABILITY_BACKFILL_IN_PROGRESS`) toggled during the backfill window.

- This is the price of correctness under live-coexistence. v2 may instead opt for the simpler **snapshot-during-quiet-window** approach (run backfill at low traffic, accept narrow data loss).

#### 3.2.3 Dedupe + idempotency

- Per-row idempotency: backfill writes are `$set` of absolute values from a deterministic aggregate. Re-running with the same `T` produces byte-identical writes.
- Per-job idempotency: `DeliveryReliabilityCheckpoint` collection records `(jobId, T, completedKeys)`. Resume picks up at `completedKeys` count. A re-run after completion is a no-op (same writes).
- Per-key idempotency: the unique `(merchantId, phoneHash)` index makes the upsert exactly one row.

#### 3.2.4 Chunking

`Order.aggregate` per-merchant + per-key is too granular. Approach:

```
1. distinct merchantIds with terminal orders ≤ T → list M
2. for each merchant in M (cursor):
     for each axis (customer, address):
        Order.aggregate $match {merchantId, terminalAt ≤ T, status ∈ terminal}
                        $group _id: phoneHash | addressHash, counters
        bulkWrite the result into customer_reliabilities | address_reliabilities
        record progress in DeliveryReliabilityCheckpoint
3. on completion: flip flag; merge backfillCounts + liveCounts (§3.2.2 phase 2)
```

Per-merchant chunking caps the in-flight aggregation memory and lets the job parallelise per-merchant when a queue worker fans out. Chunking is per-merchant primarily because the planner picks the (`merchantId, customer.phone`)-prefixed indexes naturally.

#### 3.2.5 Resume strategy

`DeliveryReliabilityCheckpoint` has `(jobId, merchantId, axis, status: pending|done, processedAt)`. The job iterates `pending` rows; on completion of a (merchant, axis) pair, marks it `done`. Crash + restart resumes at the first `pending` row — no re-aggregation of completed rows.

#### 3.2.6 Verification

After completion (and BEFORE flipping the merge flag in §3.2.2 phase 2):

```
For a sample of 50 merchants:
  expected = Order.aggregate over the merchant's terminal orders ≤ T
  actual   = customer_reliabilities counters for the merchant
  assert per-(merchantId, phoneHash) counter equality
```

If any merchant fails the equality check, abort the merge and surface the discrepancy. This is the single human-attended gate in the v2 backfill.

#### 3.2.7 Corruption detection

Continuous post-merge invariant check (also part of normal observability §4.3):

```
weekly: sample 100 random (merchantId, phoneHash) keys
  recompute counters from Order
  compare to customer_reliabilities row
  alert on drift > 1 per counter (allowing for terminal-flip race window)
```

#### 3.2.8 Live-write coexistence

The dual-counter pattern in §3.2.2 is the only pattern that preserves correctness without taking the merchant offline. If correctness during backfill is not negotiable, accept downtime instead.

#### 3.2.9 What backfill MUST NEVER do

- ❌ Call `applyTrackingEvents`. It would re-fire all four existing fan-outs.
- ❌ Call `recordCourierOutcome`, `contributeOutcome`, or any chokepoint side-effect.
- ❌ Mutate `MerchantStats` (already correct).
- ❌ Mutate `FraudPrediction` or `FraudSignal` (already correct).
- ❌ Run without a feature flag.
- ❌ Run without a checkpoint collection.
- ❌ Run without the post-merge verification step.

---

## 4. Observability & safety

### 4.1 Logs (structured, single-line JSON, matching `intent.scored` shape)

```
evt: delivery_reliability.aggregated
fields:
  merchantId   ObjectId hex
  axis         "customer" | "address" | "courier_thana"
  outcome      "delivered" | "rto" | "cancelled"
  keyHash      first 12 chars of phoneHash | addressHash | "courier:thana"
  hasFirstOutcome boolean (insert vs update)
  totalMs      number
  source       "chokepoint" | "backfill"
emitted on:    every successful aggregate write

evt: delivery_reliability.classified
fields:
  merchantId
  orderId
  tier         enum
  score        0..100
  signalCount  number
  samples      { customer, address, courier }   // observation counts
  totalMs      number
emitted on:    every getOrder call when DELIVERY_RELIABILITY_READ_ENABLED

evt: delivery_reliability.write_failed
fields:
  merchantId
  axis
  error        truncated message
emitted on:    aggregate write throws (analogous to existing
               `[fraud-network] contribute failed` log)
```

### 4.2 Counters (in-process, exposed via existing `/admin/system` snapshot)

| Counter | Description |
|---|---|
| `customerReliability.writes`     | total successful customer-axis writes |
| `addressReliability.writes`      | total successful address-axis writes |
| `customerReliability.failures`   | aggregate write throws |
| `addressReliability.failures`    | aggregate write throws |
| `deliveryReliability.classifyCalls` | classifier invocations |
| `deliveryReliability.classifyNoData` | classifier returned `tier: "no_data"` |

Reuse the `apps/api/src/lib/queue.ts` counter pattern (per-process Maps) so the admin observability page (`adminObservability.ts`) picks them up without a new query.

### 4.3 Drift detection (passive — runs as a slow scheduled job)

A new repeatable job in the `automation-watchdog`-cadence range (every 6h or daily):

```
Sample 100 (merchantId, phoneHash) keys at random:
  expected = Order.countDocuments by status within last 365d for that key
  actual   = customer_reliabilities row counters
  delta    = abs(expected - actual)

Alert if delta > 2 OR if (delta / max(expected, 1)) > 0.05

Same for (merchantId, addressHash) sample.
```

Tolerance of 2 + 5% absorbs the narrow race window where a chokepoint write happens between Order.find and the aggregate read. Persistent drift > tolerance is a defect signal.

Wired into `lib/anomaly.ts` as a 5th detector, surfaced via `runAnomalyDetection`'s existing fan-out.

### 4.4 Replay anomaly detection

Per-row `lastOutcomeAt` is a sentinel — if a write attempt sees `lastOutcomeAt` jumping backward, the chokepoint guard either failed OR a backfill ran out-of-order. Log:

```
evt: delivery_reliability.anomalous_lastOutcome
fields:
  merchantId
  axis
  keyHash
  prior_lastOutcomeAt
  attempted_lastOutcomeAt
```

Implementable as a `findOneAndUpdate` with a `$max: { lastOutcomeAt: now }` clause: the value never moves backward. Add a debug log when `now < lastOutcomeAt`.

### 4.5 Double-count detection

Strongest invariant: for any `(merchantId, phoneHash)`, total delivered + rto + cancelled ≤ count of `Order` matching that key. Any > is corruption. The drift detector (§4.3) enforces this.

### 4.6 Aggregation-lag monitoring

`now − lastOutcomeAt` for the most-recently-written row, per merchant. P95 should track terminal-transition rate. Massive lag = chokepoint stopped firing the side-effect.

### 4.7 Rollout monitoring

During S9 / S10 rollout:

| Metric | Acceptable | Action if violated |
|---|---|---|
| `getOrder` p95 latency increase | < +10ms | flip read flag off; investigate per-merchant index hit rate |
| `delivery_reliability.write_failed` rate | < 0.1% of writes | investigate; common cause = Mongo capacity; rollback flag if degrading |
| `delivery_reliability.classifyNoData` | warns at > 30% post-rollout > 14d | surface; may indicate phoneHash drift |

### 4.8 Audit log

NO new audit events for the aggregate writes — they are per-order best-effort and would dwarf the audit collection. `applyTrackingEvents` already writes the `order.delivered` / `order.rto` audit. Backfill emits a single `delivery_reliability.backfill_completed` audit entry per merchant.

---

## 5. Read-path design

### 5.1 Runtime joins (v1)

Per-`getOrder` request:

```
parallel fanout (after the existing order load):
  cust = CustomerReliability.findOne({merchantId, phoneHash}).lean()
  addr = AddressReliability.findOne({merchantId, addressHash}).lean()
  net  = lookupNetworkRisk({...})  // already issued in routers/orders.ts:234
  // courierStats already produced by the existing fraud/network logic
  // OR: CourierPerformance.findOne({merchantId, courier, district}).lean()

result = classifyDeliveryReliability({
  customerStats: cust,
  addressStats: addr,
  courierStats: courier,
  thana, addressQuality, networkAggregate: net,
  now: new Date()
})

response.deliveryReliability = result   // if DELIVERY_RELIABILITY_READ_ENABLED
```

Both reads use the unique index `(merchantId, phoneHash|addressHash)` ⇒ each is an exact-match O(log n) ⇒ < 1ms typical.

### 5.2 Cache strategy

**v1 ships without a cache.** The two reads are cheap. Adding caching (LRU per merchant) is a v2 optimization if metrics show p95 pressure.

When a cache is added, the dashboard cache invalidation already in place (`invalidate("dashboard:${merchantId}")` in `applyTrackingEvents`) is the right join key — it fires precisely when a counter changes.

### 5.3 Fallback behavior

| Condition | Response |
|---|---|
| `DELIVERY_RELIABILITY_READ_ENABLED = false` | `deliveryReliability: undefined` in payload; UI renders nothing (panel hidden) |
| Aggregate read throws | classifier sees `undefined`; returns `tier: "no_data"`; warn-log only |
| Both aggregates absent | `tier: "no_data"`; copy: "Not enough delivery history yet to score this order" |
| Stale (`lastOutcomeAt > 180d`) | classifier downweights to `cold_start`-equivalent (mirror CourierPerformance) |

### 5.4 Cold-start handling

Mirror `selectBestCourier`:

- Below `MIN_OBSERVATIONS_FOR_SIGNAL` (= 3 for axis observations): contribute a soft `*_unknown` signal, do NOT trip a tier transition.
- All axes below threshold: `tier: "no_data"`.

### 5.5 Missing-data behavior

Any of `phoneHash`, `addressHash`, `courier`, `district`, `thana` may be absent (legacy orders, cancelled-before-shipping, anonymous storefronts):

- `phoneHash` absent: skip `CustomerReliability` lookup; classifier handles `customerStats === undefined`.
- `addressHash` absent: same.
- `courier` / `district` absent: skip courier signal; classifier handles `courierStats === undefined`.
- All absent: `tier: "no_data"`.

### 5.6 Degraded-mode behavior

If MongoDB returns connection errors mid-read:

- The existing tRPC error path returns 5xx for the order load itself.
- The aggregate fan-out is wrapped in a `Promise.allSettled` so a transient Mongo blip on one of the 2-3 small reads does not 5xx the whole `getOrder`. Failed reads → `undefined` stats → `tier: "no_data"`.

### 5.7 Legacy orders

Orders pre-Phase-S9 without aggregate counters return `tier: "no_data"` until a NEW terminal flip on the same buyer/address lands. This is acceptable per §3.1.

### 5.8 Zero-downtime deployment

- S2 (schema) is online; index build on empty collections is instant.
- S4 wiring is gated; deploy lands code with flag off.
- S6 read integration is gated; ditto.
- All flag flips are env-var or per-merchant config; no redeploy required to roll back.

---

## 6. Failure-mode analysis

For each scenario: **risk** / **mitigation** / **recovery** / **observability signal**.

### 6.1 Duplicate webhook replay

- **Risk.** Same webhook arrives twice within minutes. Each replay re-enters `applyTrackingEvents`. If the new fan-out fires twice, counters double-count.
- **Mitigation.** The chokepoint's existing dedupe-by-content-hash + status guard means the SECOND call neither pushes a tracking event nor flips status. The terminal-transition fan-out is gated `if (nextStatus !== prevStatus)` (`tracking.ts:164`). Second call: `prev === next` ⇒ no fan-out ⇒ counters unchanged. **No new mitigation needed.**
- **Recovery.** None required.
- **Observability.** Existing `logistics.lastWebhookAt` and the dedup-key audit; `delivery_reliability.aggregated` log shows one entry per actual transition.

### 6.2 Rollback-and-re-deliver corruption

- **Risk.** A merchant manually flips a `delivered` order back to `confirmed`, then a courier re-delivers. `applyTrackingEvents` would fire the fan-out AGAIN (different prev → next transition); counters double-count.
- **Mitigation.** No UI exposes this path today. `restoreOrder` only handles `cancelled → preRejectStatus`, not `delivered → x`. **v1 does not add a defence; it inherits the existing exposure.** Documented as a known caveat.
- **Recovery.** Drift detector (§4.3) catches the over-count within a sweep window. Manual reconciliation: the per-key counter can be reset by re-running the §3.2.2 phase-2 merge on a single key.
- **Observability.** `delivery_reliability.anomalous_lastOutcome` if the second flip's `now` < first flip's `lastOutcomeAt` (would not happen for rollback-then-re-deliver — `now` increases monotonically). **The detector that DOES fire this is the §4.3 drift detector.**

### 6.3 Partial deploys

- **Risk.** Half the API replicas have new writer code, half don't. Traffic distributes unevenly; some terminal flips don't fan out.
- **Mitigation.** Counters are eventually consistent; missed increments are `tier: "no_data"` not corruption. Flag-driven rollout means new code is dormant until flag flip — and the flag flip is global (env var), so the entire fleet sees the change at once.
- **Recovery.** None — the next terminal flip on the same key fills in the missing observation.
- **Observability.** Lag metric (§4.6).

### 6.4 Aggregate write failures

- **Risk.** Mongo throws on the `$inc` upsert.
- **Mitigation.** All aggregate writers are `void X(...).catch(console.error)` — same pattern as `recordCourierOutcome` and `contributeOutcome` today. Order/status write is unaffected.
- **Recovery.** None — accept one missed outcome. Drift detector (§4.3) reconciles.
- **Observability.** `delivery_reliability.write_failed` log + counter.

### 6.5 Mongo transaction failure

- **Risk.** Aggregate writes are SEPARATE upserts, NOT in a transaction with the order write. A partial failure leaves order updated but counters not.
- **Mitigation.** This is the explicit best-effort posture. Already accepted by `recordCourierOutcome` / `contributeOutcome` / `FraudPrediction.outcome`. Same rules apply.
- **Recovery.** Drift detector.
- **Observability.** Lag metric + write-failure log.

### 6.6 Queue replay storms

- **Risk.** `pending-job-replay` worker drains 1000 dead-lettered webhook-process jobs in one tick. Each replays a `WebhookInbox` row. Each could trigger a fan-out.
- **Mitigation.** Each replay enters `replayWebhookInbox` which re-enters `ingestNormalizedOrder` for ORDER-CREATE replays (idempotent via `Order.findOne` dedup) OR `applyTrackingEvents` for COURIER-WEBHOOK replays (idempotent via dedupe key + status guard). In neither case does the chokepoint re-fire the fan-out for an already-resolved transition.
- **Recovery.** None.
- **Observability.** `delivery_reliability.aggregated` rate matches terminal-transition rate, not replay rate.

### 6.7 Stale reads

- **Risk.** Classifier reads counters that are seconds-old; a recent terminal flip hasn't propagated.
- **Mitigation.** Eventually consistent by design. The order detail drawer caches client-side via React Query; a manual refresh exposes the latest.
- **Recovery.** None.
- **Observability.** None — accepted UX.

### 6.8 Migration interruption

- **Risk.** Backfill (v2) crashes mid-run; aggregates are partially populated.
- **Mitigation.** The §3.2.5 checkpoint design resumes at `pending` rows. The §3.2.2 dual-counter design (`backfillCounts.*` + `liveCounts.*`) means partial backfill never produces wrong totals — the merge in phase 2 is gated by job completion.
- **Recovery.** Resume the job.
- **Observability.** `DeliveryReliabilityCheckpoint.status` per row.

### 6.9 Index build impact

- **Risk.** Adding indexes on a new collection — fast. Adding indexes on `Order` — slow on large datasets.
- **Mitigation.** v1 only creates indexes on the new (empty) collections. No `Order` index changes. v2 thana-aware additions would need rolling background index builds (`{ background: true }` on Mongoose; `db.collection.createIndex(..., {background:true})` directly).
- **Recovery.** Drop and recreate.
- **Observability.** Mongo's `currentOp()` index-build progress.

### 6.10 Cache inconsistency

- **Risk.** v2 introduces a per-merchant LRU cache; cache is populated, then a terminal flip changes the underlying counter, but cache TTL hasn't expired.
- **Mitigation.** The existing `invalidate("dashboard:${merchantId}")` already runs from `applyTrackingEvents`. v2 cache piggybacks on the same invalidation.
- **Recovery.** Cache TTL of 60s.
- **Observability.** Cache hit/miss rate.

### 6.11 Race conditions

- **Risk A.** Two terminal flips on different orders for the same buyer arrive in parallel. Both `$inc` the same `CustomerReliability` row.
- **Mitigation.** `$inc` is atomic per-document in Mongo. Both increments land. Correct.
- **Risk B.** A terminal flip and a `findOne` happen in parallel. The `findOne` reads pre-increment, the classifier returns slightly stale tier.
- **Mitigation.** Eventual consistency is the contract.
- **Risk C.** Two writers race a `$setOnInsert`. Both think they're inserting.
- **Mitigation.** Unique index ⇒ one wins ⇒ second's `$setOnInsert` no-ops, `$inc` proceeds. Standard upsert race semantics.

### 6.12 Concurrent terminal transitions

- **Risk.** Two webhooks for the same order, with different `normalizedStatus`, arrive within a few ms.
- **Mitigation.** Existing chokepoint atomic guard (`tracking.ts:150–161`) — second writer either fails the status guard (different `prevStatus`) or its content-hash dedup. Only one wins.
- **Recovery.** None.
- **Observability.** `_metrics` snapshot at `tracking-guard`.

---

## 7. Validation checklist

To declare v1 production-ready, ALL must pass:

```
[ ] S1 unit tests cover: no_data, gold-tier, cold-start, all-hits,
    partial-axis, signal-precedence, paid-social-equivalent
[ ] S2 indexes confirmed via getIndexes() in staging
[ ] S3 writer tests cover: insert path, $inc path, distinctPhoneHashes
    cap, parallel-write idempotency, never-throws contract
[ ] S4 chokepoint integration test: terminal flip with flag-off → no
    aggregate writes; flag-on → exactly one write per axis per terminal
    transition
[ ] S4 replay-storm test: 1000× webhook replay → counter delta ≤ 1
[ ] S5 logs land in production log shipper (smoke deploy)
[ ] S6 getOrder p95 latency unchanged ±10ms with read flag off
[ ] S6 getOrder p95 latency rise <10ms with read flag on
[ ] S6 fallback test: drop one of CustomerReliability / AddressReliability
    docs → response still 200, tier="no_data"
[ ] S7 admin analytics surface returns within 200ms on the largest test
    merchant
[ ] S8 UI panel renders in all 4 tiers + no_data
[ ] S9 production: write flag on, drift detector green for 7d
[ ] S10 production: read flag on, no spike in classifier errors over 7d
[ ] Observability: drift detector reports baseline drift < tolerance
[ ] Observability: lag metric tracks terminal-transition rate
```

---

## 8. Deployment sequencing

```
Day 0  Land S1 + S2 (pure function + collections + indexes)
       Both are dead until S4 lands. Safe in any order.

Day 0+ Land S3 (writer helpers, not yet wired)
       Safe — code is dead.

Day 1  Land S4 (chokepoint wiring), flag DEFAULT FALSE.
       Verify production: no aggregate writes occur.

Day 1+ Land S5 (observability) + S6 (read integration), both flags FALSE.
       Verify production: no behavior change.

Day 2  Internal-flag-on for STAGING merchants.
       Run for 48h. Watch drift detector + lag metric.

Day 4  Production write flag ON globally.
       Run for 7d. Drift detector must remain green.

Day 11 Production read flag ON for INTERNAL/dogfood merchants.
       Run for 3d.

Day 14 Production read flag ON globally.
       UI panel becomes visible to all merchants.

Day 30 v1 complete. Begin v2 design (backfill, subdoc, thana axis).
```

---

## 9. Operational runbook

### 9.1 "I see a wrong reliability tier on an order"

1. Check `delivery_reliability.classified` log for that orderId — confirm `samples` and `tier`.
2. Confirm `Order.intent`, `Order.address.quality`, `Order.fraud` are present.
3. Check `CustomerReliability.findOne({merchantId, phoneHash})` — does it exist? Counters?
4. If counters look wrong vs `Order.aggregate({customer.phone})`: drift. Fall through to §9.3.

### 9.2 "I want to disable Delivery Reliability for one merchant"

Read flag is global env. v1 does NOT support per-merchant disable. Workaround: rollback the read flag globally, re-evaluate. v2 may add a per-merchant feature-config row.

### 9.3 "Drift detector fired"

1. Pull the (merchantId, key) the alert names.
2. Recompute Order-side aggregate.
3. Diff counters.
4. If `actual > expected`: replay corruption — investigate the rollback case (§6.2). Reset the row counters from the recompute.
5. If `actual < expected`: missed write — investigate `delivery_reliability.write_failed` log. No corruption; next outcome will narrow the gap.

### 9.4 "Aggregate write failure rate elevated"

1. Check Mongo capacity / connection pool.
2. Verify the unique index is intact (`db.customer_reliabilities.getIndexes()`).
3. If index dropped: rebuild background.
4. If pool saturated: not specific to delivery reliability — investigate root cause; the failure is symptomatic.

### 9.5 "Production rollback steps"

```
Read flag rollback:    set DELIVERY_RELIABILITY_READ_ENABLED=false → redeploy
                       (or hot-reload if env-driven). UI panel disappears
                       within seconds. NO data loss; aggregates keep
                       accumulating.

Write flag rollback:   set DELIVERY_RELIABILITY_WRITE_ENABLED=false →
                       redeploy. Aggregates STOP advancing. Existing
                       aggregates remain valid. Re-enabling later resumes
                       writes; backfill is required if the gap matters.

Schema rollback:       drop customer_reliabilities and address_reliabilities
                       collections. Idempotent. Re-creating restores the
                       "starts from now" v1 posture.
```

### 9.6 "Backfill (v2) failed mid-run"

1. Inspect `DeliveryReliabilityCheckpoint` for `pending` rows.
2. Resume by re-running the same `jobId`.
3. If resumed run still fails on the same row: investigate the underlying Order aggregation; abort merge phase 2.
4. NEVER manually merge `backfillCounts` into the canonical fields without verification (§3.2.6).

---

## 10. Recommended v1 scope (final)

**In v1:**

1. `lib/delivery-reliability.ts` — pure function `classifyDeliveryReliability(...)` + writer helpers `recordCustomerOutcome` / `recordAddressOutcome`.
2. `packages/db/src/models/customerReliability.ts` + `addressReliability.ts`.
3. Two helpers wired into `applyTrackingEvents` fan-out, gated by `DELIVERY_RELIABILITY_WRITE_ENABLED`.
4. `orders.getOrder` adds `deliveryReliability` to the response, gated by `DELIVERY_RELIABILITY_READ_ENABLED`.
5. New analytics tRPC procedure: `analytics.deliveryReliabilitySummary` (read-only, admin-flag-gated).
6. UI panel `<DeliveryReliabilityPanel>` mounted in `tracking-timeline-drawer.tsx` next to `<OperationalHintPanel>`.
7. Observability: 4 structured-log events, 6 in-process counters, drift detector wired into `runAnomalyDetection`.
8. Three feature flags as specified.
9. Validation checklist gated.

**v1 is observation-only:** it does NOT feed `computeRisk`, does NOT modify `selectBestCourier`, does NOT change automation behavior.

## 11. Recommended v2 scope (deferred)

1. `Order.deliveryReliability` subdoc populated fire-and-forget post-resolution; lets the order LIST page render the badge cheaply.
2. `CourierThanaPerformance` collection + `selectBestCourier` thana-aware preference.
3. Backfill (per §3.2 design) — gated, checkpointed, dual-counter merge.
4. Per-merchant read flag (config-row, not env).
5. Cache layer with `invalidate("dashboard:${merchantId}")` integration.
6. Per-customer / per-address dashboard surfaces (drill-down from the analytics summary).
7. Cancel-path coverage helper: a single `recordOrderCancelled(...)` called from the 7+ writers in §3.2 of the deep audit, contributing to `FraudSignal` + `FraudPrediction.outcome` for cancels (separate effort; benefits more than just delivery reliability).

## 12. Things explicitly OUT OF SCOPE

These are NOT planned, NOT implied, and NOT a hidden goal:

- ❌ Folding any new score into `computeRisk`.
- ❌ Wiring `lookupNetworkRisk.bonus` into `riskScore`.
- ❌ Modifying any chokepoint's filter logic, status guard, or dedupe key.
- ❌ Changing the `Order.version` CAS contract.
- ❌ Replacing or merging `CourierPerformance` and `CustomerReliability` (different keys, different domains).
- ❌ Replacing `operationalHint` (per-order acute attention triage stays separate from per-order predictive context).
- ❌ Replacing `intent` (buyer engagement signal stays separate from delivery reliability).
- ❌ Any ML, LLM, or black-box scoring. Every signal carries a `detail` string the merchant reads verbatim.
- ❌ Any automation (auto-cancel, auto-flag) driven by the new tier.
- ❌ Any merchant-facing text labelled "fraud" — this surface is "delivery reliability" only.
- ❌ Backfill in v1.
- ❌ Per-merchant read flag in v1.
- ❌ Caching in v1.
- ❌ Thana axis in v1.
- ❌ Cancel-path side-effect coverage in v1 (separate, larger effort).
- ❌ Modifying NetworkBonus / FraudSignal weights.
- ❌ Changing existing tRPC routers' input/output shapes (purely additive fields on `getOrder`).

— end of blueprint —
