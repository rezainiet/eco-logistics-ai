# Scoring Flow Mapping

**Status:** discovery snapshot, 2026-05-08.
**Scope:** every scorer in the system — what it inputs, what it outputs, where it runs, and what consumes the output. No proposals.

The platform runs **five distinct scoring systems** plus an admin-side anomaly detector. They are deliberately decoupled — only `risk` feeds order workflow; `intent`, `addressQuality`, `operationalHint`, and `network` are visibility-only.

| # | Scorer                     | File                                    | Purity     | Output | Consumed by |
|---|----------------------------|-----------------------------------------|------------|--------|-------------|
| 1 | Risk (fraud)               | `apps/api/src/server/risk.ts`           | pure (DB I/O is a separate `collectRiskHistory` step) | `RiskResult { riskScore, level, signals, reviewStatus, pRto, customerTier, ... }` | order workflow, fraud review queue, fraud alerts, automation gating |
| 2 | Operational hint           | `apps/api/src/lib/operational-hints.ts` | pure       | `OperationalHint { code, severity, label, suggestedAction, observedAt? } | null` | order detail drawer (visibility only) |
| 3 | Courier intelligence       | `apps/api/src/lib/courier-intelligence.ts` | pure score; impure load | `SelectBestCourierResult { best, ranked[], reason }` | `automation-book` worker (chooses courier) |
| 4 | Intent                     | `apps/api/src/lib/intent.ts`            | pure score; impure load | `IntentResult { score, tier, signals, sessionsConsidered }` | order detail drawer + RTO Intelligence cards |
| 5 | Cross-merchant network     | `apps/api/src/lib/fraud-network.ts`     | impure read; impure write | `NetworkRiskAggregate { merchantCount, rtoRate, bonus, matchedOn, ... }` | fraud review side-panel, order detail (NetworkSignal pill); contributes to `risk` only via merchant-specific blocklists, not the bonus |
| – | Anomaly detector (admin)   | `apps/api/src/lib/anomaly.ts`           | impure     | `Alert[]` | admin observability dashboard, admin notifications |
| – | Address quality            | `apps/api/src/lib/address-intelligence.ts` | pure    | `AddressQuality { score, completeness, landmarks, hasNumber, scriptMix, missingHints }` | order detail drawer (visibility); RTO Intelligence cards |

---

## 1. Risk scoring — `computeRisk`

**Single pure function**: `apps/api/src/server/risk.ts:442 computeRisk(order, history, opts) → RiskResult`.

### Inputs
- `order`: `{ cod, customer:{name,phone,address?,district}, ip?, addressHash? }`.
- `history` (loaded by `collectRiskHistory` — separate fn so unit tests can pass synthetic data):
  - `phoneOrdersCount`, `phoneReturnedCount`, `phoneCancelledCount`, `phoneUnreachableCount`, `phoneVelocityCount`, `phoneDeliveredCount` (decayed counts, half-life 30 days configurable).
  - `phoneTotalRaw`, `phoneDeliveredRaw`, `phoneReturnedRaw`, `phoneCancelledRaw` (un-decayed — feed customer-tier classification).
  - `ipRecentCount`, `addressDistinctPhones`, `addressReturnedCount`.
- `opts` (per-merchant config):
  - `highCodBdt` / `extremeCodBdt` (explicit override) OR derive from merchant's `p75OrderValue` (1.5× / 3×) OR `avgOrderValue` (1.8× / 3.6×) OR platform defaults (4000 / 10000 BDT). Floors 1500 / 4000 protect new merchants.
  - `suspiciousDistricts`, `blockedPhones`, `blockedAddresses`, `velocityThreshold` (default 3, 0 disables).
  - `weightOverrides`: per-signal multipliers from the monthly tuner, clamped `[0, 3]`.
  - `baseRtoRate` (default 0.18) — anchors the P(RTO) logistic.
  - `weightsVersion` (carried into `RiskResult` for the feedback loop).

### Signal weights (`risk.ts:33`)

| Signal               | Default weight | Notes |
|----------------------|---------------:|-------|
| `extreme_cod`        |  40 | order.cod ≥ extremeCodThreshold |
| `high_cod`           |  18 | order.cod ≥ highCodThreshold |
| `duplicate_phone`    |  10 | decayed prior orders ≥ 3 |
| `duplicate_phone_heavy` | 25 | decayed prior orders ≥ 6 |
| `prior_returns`      |  22 | decayed prior RTO > 0 |
| `prior_cancelled`    |  14 | decayed prior cancelled ≥ 2 |
| `low_success_rate`   | 14 or 22 | resolved ≥ 3 AND deliveredRate < 0.4 |
| `suspicious_district`|  16 | district missing or in blocklist |
| `fake_name_pattern`  |  25 | regex placeholder / keyboard-walk / vowelless / Bangla placeholder |
| `unreachable_history`|  20 | call-log unreachable count ≥ 2 |
| `ip_velocity`        |  16 | ≥ 5 orders from same IP in 10 min |
| `velocity_breach`    |  75 | per-phone velocity ≥ threshold (single-signal HIGH) |
| `garbage_phone`      |  30 | structurally invalid or all-same-digit |
| `duplicate_address`  |  22 | ≥ 3 distinct phones on same address; halved if just `addressReturnedCount > 0` |
| `blocked_phone`      | 100 | merchant blocklist hit (HARD BLOCK) |
| `blocked_address`    | 100 | merchant blocklist hit (HARD BLOCK) |

### Hard-block rules (force HIGH regardless of weight sum)
- `garbage_phone`
- `blocked_phone`
- `blocked_address`
- `extreme_cod_in_suspicious_district` (combo)

When hard-blocked: `riskScore = max(score, 85)`, `pRto ≥ 0.95`.

### Customer tier (soft-signal bypass)
`classifyCustomerTier(history)`:
- `gold`: ≥5 delivered AND deliveredRate > 0.85 → bypasses `velocity_breach`, `fake_name_pattern`, `duplicate_phone(_heavy)`.
- `silver`: ≥3 delivered AND ≥0.7 success — informational only.
- `standard`, `new`: no bypass.

Hard-block signals always fire (a stolen-account scenario shouldn't be laundered through a high-trust phone).

### Levels and downstream
- `low ≤ 39 ≤ medium ≤ 69 < high` (`RISK_TIERS`).
- `reviewStatus = pending_call (high) | optional_review (medium) | not_required (low)` — never overwritten if existing status ∈ `{verified, rejected}`.
- `pRto` = logistic over score anchored at merchant base rate; `pRtoPct` rounded to 1 decimal.
- `confidenceLabel = Safe | Verify | Risky` (mirror of risk level for the order card UI).

### Where `computeRisk` is called

| Site                                                  | Trigger                                |
|-------------------------------------------------------|----------------------------------------|
| `server/ingest.ts:157` (in `ingestNormalizedOrder`)   | every fresh order (webhook / poll / CSV / dashboard) |
| `server/routers/orders.ts:218`                        | dashboard "create order" preview / commit |
| `server/routers/orders.ts:2119`                       | bulk-upload preview |
| `server/routers/fraud.ts:561`                         | recompute on fraud config change |
| `workers/riskRecompute.ts:129`                        | rescore fan-out on RTO / no-answer / rejected |
| `scripts/verifyFraudFlow.ts`, `scripts/auditCsvAndBulk.ts` | one-shot CLIs |

### Persistence / feedback
- Order document carries `fraud.{detected, riskScore, level, reasons, signals, reviewStatus, scoredAt}`.
- `FraudPrediction` row persists per-order snapshot for the monthly tuner.
- Terminal status flip stamps `FraudPrediction.outcome` (delivered / rto / cancelled).
- `fraud-weight-tuning` worker (monthly) reads `FraudPrediction` outcomes → derives per-signal multipliers → writes `Merchant.fraudConfig.signalWeightOverrides` + bumps `weightsVersion`.

---

## 2. Operational hint — `classifyOperationalHint`

**Pure function** at `apps/api/src/lib/operational-hints.ts:122`. Visibility-only — never writes, never feeds risk, never enqueues a job.

### Input shape
Structural (not Mongoose) so the test surface stays light:
- `status`, `addressCompleteness`, `fraudReviewStatus`, `automationState`, `confirmationDeliveryStatus`, `confirmationSentAt`, `shippedAt`, `lastTrackingActivityAt`, `trackingEvents[]`, `now`.

### Eight stable codes (priority order — first match wins)
1. `address_clarification_needed` (warning) — `addressCompleteness === "incomplete"` AND status pre-dispatch.
2. `confirmation_sms_undelivered` (warning) — automation pending_confirmation AND DLR failed AND past 30 min grace.
3. `customer_unreachable_pending_call` (warning) — `fraudReviewStatus === "no_answer"`.
4. `awaiting_customer_confirmation` (info) — `automationState === "pending_confirmation"`.
5. `delivery_failed_attempt` (critical) — latest event `normalizedStatus === "failed"` AND status not delivered.
6. `delivery_attempt_in_progress` (info) / `stuck_in_transit` (warning) — depending on age of latest `out_for_delivery` event vs `STALE_OUT_FOR_DELIVERY_MS = 24h`.
7. `stuck_in_transit` (warning) — `(in_transit|shipped) AND lastTrackingActivityAt > 4d`.
8. `stuck_pending_pickup` (warning) — `(confirmed|packed) AND !shippedAt AND confirmationSentAt > 36h`.

Returns `null` for healthy orders; the UI hides the panel.

### Call sites
- `server/routers/orders.ts:1636` (`getOrder`) — only writer of the field on the wire.
- `apps/web/src/components/orders/operational-hint-panel.tsx` — UI.
- `apps/web/src/components/orders/tracking-timeline-drawer.tsx:179` — mounts the panel.

---

## 3. Courier intelligence — `selectBestCourier` / `recordCourierOutcome` / `recordCourierBookFailure`

`apps/api/src/lib/courier-intelligence.ts`.

### Storage
`CourierPerformance` collection with key `(merchantId, courier, district)`. Each merchant also has a `_GLOBAL_` aggregate per courier (`COURIER_PERF_GLOBAL_DISTRICT`).
Per-row counters: `deliveredCount`, `rtoCount`, `cancelledCount`, `totalDeliveryHours`, `lastOutcomeAt`, `recentFailureCount`, `recentFailureWindowAt`.

### Score formula (`scoreCourierCandidate`, `risk.ts`-style)
Weights: success +60, rto −30, speed +10, preferred-courier +5.

```
completed = delivered + rto + cancelled
if completed < 10  OR  lastOutcomeAt > 180 days ago
   → cold_start: score = NEUTRAL_SCORE(50) + preferredBonus − failurePenalty
else:
   successRate    = delivered / completed
   rtoRate        = rto / completed
   avgHours       = totalDeliveryHours / delivered  (if delivered>0)
   speedScore     = clamp(0, 1.5,  24h_baseline / avgHours)  (24h → 1.0)
   score          = 60·successRate − 30·rtoRate + (speedScore/1.5)·10 + preferredBonus − failurePenalty
   clamp(0, 100)
```

Recent-failure penalty applies to ANY tier, capped at 20 (`FAILURE_PENALTY_PER_HIT = 4`, `FAILURE_PENALTY_CAP = 20`). Window is rolling 1h via `recentFailureWindowAt` reset; expired window → penalty 0.

### Selection (`selectBestCourier`)
1. Single round-trip: `CourierPerformance.find({merchantId, courier∈candidates, district∈[district, _GLOBAL_]})`.
2. Per candidate: prefer the per-district row when its `completed ≥ 10`; otherwise the merchant `_GLOBAL_` aggregate; otherwise `cold_start`.
3. Score each candidate; sort descending.
4. Return `{ best, ranked[], reason }` where `reason` is operator-readable ("success 92% / rto 4% over 230 orders (district)" or "cold start — neutral score + preferred courier (pathao)").

### Where it's invoked
- **Read side:** `workers/automationBook.ts:199` chooses the courier when the merchant uses auto-book without a hard pin.
- **Write side (outcome):** `server/tracking.ts:254` on every terminal status flip in `applyTrackingEvents` — derives `deliveryHours` from `shippedAt → deliveredAt` (fallback `createdAt → now`) for `delivered`.
- **Write side (booking failure):** `workers/automationBook.ts:296` after every adapter failure.

---

## 4. Intent intelligence — `computeIntentScore`

`apps/api/src/lib/intent.ts:204`. **Pure function over a list of `SessionInput`s.** Side-effecting helper `scoreIntentForOrder` reads `TrackingSession`s and stamps `Order.intent`.

### Score components (max 100)
- **Commitment** (max 40): repeat_visitor (+12), deep_engagement (+8), long_dwell (+10), funnel_completion (+10).
- **Engagement quality** (max 30): organic_landing (+15 organic search, +10 direct), multi_session_converter (+15 if ≥2 sessions across ≥1 day). Paid social earns nothing.
- **Confirmation quality** (max 30, optional re-score input): confirmation_delivered (+5), confirmation_replied (+20), fast_confirmation (+5 if reply within 1h).

### Tiers
- `verified ≥ 70`, `implicit ≥ 40`, `unverified < 40`, `no_data` (no sessions at all).

### Storage
`Order.intent.{score, tier, signals[], sessionsConsidered, computedAt}`. Bumps `Order.version` for compatibility with `updateOrderWithVersion`.

### Where invoked
- `server/ingest.ts:384` — fire-and-forget after `resolveIdentityForOrder`. Gated on `INTENT_SCORING_ENABLED` env flag.
- (No call site feeds the result back into `computeRisk` in v1 — explicitly observation-only per the file header.)

### Where surfaced
- `apps/web/src/components/orders/intelligence-panels.tsx:IntentPanel` (consumed via `orders.getOrder`).
- `apps/web/src/components/intelligence/rto-intelligence-section.tsx` "Intent tier distribution" card via `analytics.intentDistribution` → `intelligenceHandlers.intentDistributionHandler`.

---

## 5. Cross-merchant network — `lookupNetworkRisk` / `contributeOutcome`

`apps/api/src/lib/fraud-network.ts`.

### Fingerprints (privacy-safe)
- `hashPhoneForNetwork(normalizedPhone) = sha256("p:" + phone)[:32]`.
- `addressHash` from `risk.ts:hashAddress` is reused (token-sorted sha256[:32]).
- `_none_` sentinel when both are missing.

### Read (`lookupNetworkRisk`)
Returns `EMPTY` when:
- both hashes are missing.
- only one merchant has contributed (or only the caller).
- `(delivered + rto + cancelled) < 2`.

Otherwise returns aggregated `merchantCount`, `deliveredCount`, `rtoCount`, `cancelledCount`, `rtoRate`, `firstSeenAt`, `lastSeenAt`, and a recommended `bonus` (capped at `NETWORK_BONUS_CAP = 25`). The merchant id list is NEVER surfaced.

### Write (`contributeOutcome`)
Atomic upsert on `FraudSignal` keyed by `(phoneHash | addressHash | _none_)`. Bumps the right counter (delivered / rto / cancelled), records the contributing merchant id (capped at `FRAUD_SIGNAL_MAX_MERCHANTS`).

### Where invoked
- **Read:** `server/routers/fraud.ts:202`, `server/routers/orders.ts:234`.
- **Write:** `server/tracking.ts:220` on every terminal status flip in `applyTrackingEvents`.

### Where surfaced
- `apps/web/src/components/fraud/network-signal.tsx` (NetworkSignalPill, NetworkSignalCard).

---

## 6. Address quality — `computeAddressQuality`

`apps/api/src/lib/address-intelligence.ts`.

Pure function gated on `ADDRESS_QUALITY_ENABLED`. Output `AddressQuality { score, completeness:"complete"|"partial"|"incomplete", landmarks[], hasNumber, tokenCount, scriptMix:"latin"|"bangla"|"mixed", missingHints[] }`. Stored at `Order.address.quality` on ingest (`server/ingest.ts:178`).

Surfaced via `intelligence-panels.tsx:AddressQualityPanel` and `rto-intelligence-section.tsx` "Address quality distribution" card.

---

## 7. Anomaly detection (admin)

`apps/api/src/lib/anomaly.ts:runAnomalyDetection`. Four detectors, each compares **last hour** against the **preceding 23h baseline**:

| Detector                       | Source                                  | Floor / Multiplier |
|--------------------------------|-----------------------------------------|--------------------|
| `payment_spike`                | `Payment` (provider:"manual")           | 10 / 3×            |
| `webhook_failure_spike`        | `WebhookInbox` status:"failed"          | 5 / 4×             |
| `automation_failure_spike`     | `AuditLog` action ∈ {auto_book_failed, confirmation_sms_failed, watchdog_exhausted} | 10 / 3× |
| `fraud_spike`                  | `Order` fraud.level:"high"              | 10 / 2.5×          |

Per-detector dedupe via an `AuditLog` row keyed `dedupeKey = "<kind>:<hourBucket>"` — refuses to re-fire within the hour. On fire: writes `alert.fired` audit row, fans out via `admin-alerts.deliverAdminAlert` (lazy import; delivery failure never propagates).

---

## 8. Combined order-create scoring flow (the canonical pipeline)

When a fresh order lands (webhook / poll / dashboard / CSV), this is the actual sequence inside `ingestNormalizedOrder`:

```
1. Phone E.164 normalize (lib/phone.ts).
2. Duplicate guard (Order.findOne by externalId).
3. reserveQuota (plan cap).
4. getMerchantValueRollup → adaptive p75 / avg COD.
5. computeAddressQuality + extractThana   [gated ADDRESS_QUALITY_ENABLED]
6. collectRiskHistory(merchantId, phone, ip, addressHash) — single round-trip:
      Order.find phone history (decayed)
      Order.find address history (decayed + distinct phones)
      CallLog.find unreachable history (decayed)
      Order.countDocuments IP velocity
      Order.countDocuments phone velocity
7. computeRisk(order, history, riskOpts) — pure.
8. Order.create({fraud, address.quality, source.addressHash, source.externalId, ...})
9. void FraudPrediction.create — feedback loop.
10. void writeAudit "order.ingested".
11. fireFraudAlert if level === "high".
12. invalidate dashboard cache.
13. void resolveIdentityForOrder — stitch back-sessions to TrackingSession.
14. void scoreIntentForOrder       — gated INTENT_SCORING_ENABLED, observation-only.
        ↳ TrackingSession.find (resolved to this order)
        ↳ computeIntentScore (pure)
        ↳ Order.updateOne { $set: { intent }, $inc: { version } }
```

When that order later hits a terminal status (`delivered` / `rto` / `cancelled`) via `applyTrackingEvents`:

```
+ MerchantStats counters updated.
+ Dashboard cache invalidated.
+ if rto: enqueueRescore({trigger:"order.rto"}) → rescore every other open
                                                  order on the same phone.
+ FraudPrediction.outcome stamped (feedback loop for the monthly tuner).
+ fraud-network contributeOutcome (cross-merchant aggregate; hashes only).
+ courier-intelligence recordCourierOutcome (per-(merchant, courier, district)
                                              with derived deliveryHours).
```

Operational hint is computed **on read** (no persistence), so it always reflects current state.

---

## 9. What feeds what — strict dependency graph

```
Order create / ingest
  └── computeRisk (pure)             ← collectRiskHistory ← Order, CallLog
        └── Order.fraud.*
        └── FraudPrediction
        └── fraud alerts / review queue / automation gating

Order.intent  ← scoreIntentForOrder ← computeIntentScore (pure)
                                       ← TrackingSession[]
  (observation-only — does NOT feed computeRisk)

Order.address.quality ← computeAddressQuality (pure)
  (observation-only)

Order.operationalHint ← classifyOperationalHint (pure, computed on read)
  (visibility-only — does NOT feed computeRisk or automation)

Courier outcome (delivered/rto/cancelled) at applyTrackingEvents
  ├── FraudPrediction.outcome    (feedback to fraud-weight-tuning worker)
  ├── FraudSignal counters       (fraud-network — cross-merchant)
  ├── CourierPerformance counters (courier-intelligence — selection)
  └── if rto: enqueueRescore → workers/riskRecompute → re-runs computeRisk
                                                       on every open order
                                                       for the same phone

automation-book worker
  └── selectBestCourier (courier-intelligence) ← CourierPerformance.

admin observability
  └── runAnomalyDetection (anomaly.ts) ← Payment / WebhookInbox / AuditLog / Order
        └── AuditLog "alert.fired" + admin-alerts dispatch
```

---

## 10. Observed contracts (load-bearing)

1. **Risk weights are explainable.** Every `RiskSignal` carries `key`, `weight`, and a human-readable `detail`. Hard-block causes are tracked separately (`hardBlockCauses[]`) so the agent UI can surface "auto-flagged because X".
2. **Customer-tier bypass is soft-only.** Gold-tier never bypasses hard blocks (garbage_phone, blocked_phone, blocked_address). This is what keeps a stolen-account scenario from laundering through a trusted phone.
3. **Adaptive thresholds float on merchant data.** A high-ticket merchant doesn't trip `high_cod` on every order; a low-ticket merchant does flag a 5× outlier. Floors clamp the dynamic path.
4. **Decay half-life keeps history fresh.** Default 30-day half-life on every history aggregate. Configurable per-merchant via `fraudConfig.historyHalfLifeDays`.
5. **Outcome is the feedback signal.** `FraudPrediction.outcome` (set on terminal flip) is what `fraud-weight-tuning` reads to derive per-signal multipliers. The signed monthly delta is clamped to `[0, 3]` so tuner regression can't cascade.
6. **Network bonus is bounded.** `NETWORK_BONUS_CAP = 25`. A single noisy fingerprint cannot dominate merchant-local features.
7. **Courier-intelligence cold-start is benign.** A new courier scores `NEUTRAL_SCORE(50) + preferredBonus − failurePenalty` so it doesn't sweep proven couriers off the top by virtue of having no data.
8. **Intent stays observation-only.** v1 deliberately does NOT feed `computeRisk` (`intent.ts:17`). Wiring it in is roadmap Phase 7 per file commentary.
9. **Operational hint runs on every getOrder.** Computed-on-read keeps it always-current; cost is negligible (pure function over an in-memory order doc).
