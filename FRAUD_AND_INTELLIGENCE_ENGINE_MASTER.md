# FRAUD AND INTELLIGENCE ENGINE MASTER

End-to-end map of the fraud + intelligence engine. Implementation truth grounded in:

- `apps/api/src/server/risk.ts` — `computeRisk` and the signal registry
- `apps/api/src/lib/fraud-network.ts` — cross-merchant aggregation
- `apps/api/src/lib/address-intelligence.ts` — Address Intelligence v1
- `apps/api/src/lib/intent.ts` — Intent Intelligence v1
- `apps/api/src/lib/anomaly.ts` — admin anomaly detection
- `apps/api/src/lib/courier-intelligence.ts` — courier selection engine
- `apps/api/src/lib/operational-hints.ts` — visibility-only hint classifier
- `apps/api/src/lib/rejectSnapshot.ts` — reject/restore snapshot helpers
- `apps/api/src/lib/thana-lexicon.ts` — Bangladesh thana lookup
- `apps/api/src/workers/{fraudWeightTuning,riskRecompute}.ts`

Every system below is labeled **IMPLEMENTED**, **OBSERVATION-ONLY**, or **PLANNED**. The
distinction is operational and matters for canonical documentation.

---

## 1. computeRisk — the scoring core

Status: **IMPLEMENTED**. Source: `server/risk.ts` (≈753 lines; the body of `computeRisk` runs lines 441-753).

`computeRisk(order, merchantConfig, history, networkSignal)` is a pure function. Inputs in / score out — no DB writes, no enqueue, no logging side-effects. The boundary is its caller (`ingestNormalizedOrder` writes `Order.fraud.*`).

### 1.1 Output shape
```
{
  riskScore:    0..100        // sum of fired-signal weights, capped
  level:        "low"|"medium"|"high"  // <40 / 40-69 / 70+
  reasons:      string[]      // human-readable
  signals:      [{ key, weight, detail }]   // explainable
  confidence:   0..100        // 100 - riskScore (merchant trust badge)
  confidenceLabel: "Safe"|"Verify"|"Risky"
  hardBlocked:  boolean       // any hard-block rule fired
  pRto:         0..1          // logistic calibration vs baseRtoRate
}
```

### 1.2 Scoring formula

1. Sum weights of all fired signals.
2. **Hard blocks** force ≥85 regardless of sum (`garbage_phone`, `blocked_phone`, `blocked_address`, certain combos).
3. Cap at 100.
4. Confidence = 100 − riskScore (merchant-facing inverse).
5. P(RTO) = logistic calibration anchored on `Merchant.fraudConfig.baseRtoRate` (default 18% — BD COD market floor). Score 50 maps to the merchant's base rate.

### 1.3 Customer tiers (bypass soft signals)
- **Gold**: ≥5 delivered AND >85% success rate → bypasses `velocity_breach`, `fake_name_pattern`, `duplicate_phone(_heavy)`.
- **Silver**: ≥3 delivered AND ≥70% success → no bypass; counted toward base only.
- **Standard / New**: all signals apply.

### 1.4 Merchant overrides
`opts.weightOverrides` (from `Merchant.fraudConfig.signalWeightOverrides`) is a `Map<key, multiplier>`. Multiplier is applied to the platform default; clamped `[0, 3]`. Written by the monthly `fraudWeightTuning` worker. Missing key keeps the platform default.

`Merchant.fraudConfig` also tunes:
- `highCodThreshold` / `extremeCodThreshold`: dynamic from merchant order p75 (1.5× / 3.0×) with floor.
- `velocityThreshold` / `velocityWindowMin`: phone burst detection.
- `historyHalfLifeDays` (default 30): exponential decay applied to history-based signals.
- `suspiciousDistricts[]`, `blockedPhones[]`, `blockedAddresses[]` (hashed): merchant blacklists.
- `baseRtoRate`: P(RTO) anchor; platform default 0.18.

---

## 2. Signals registry

Status: **IMPLEMENTED**. Each entry is a real branch in `risk.ts`. Decay column indicates whether the signal depends on order *history* and is dampened by the half-life.

| Signal key                  | Default weight | Source line | Meaning                                                         | Decay | Tier bypass     | Cross-merchant |
| --------------------------- | -------------- | ----------- | --------------------------------------------------------------- | ----- | --------------- | -------------- |
| `garbage_phone`             | 30 (hard)      | risk.ts:466 | All-same-digit, wrong format                                    | no    |                 | per-merchant   |
| `blocked_phone`             | 100 (hard)     | risk.ts:480 | On merchant blocklist                                           | no    |                 | per-merchant   |
| `blocked_address`           | 100 (hard)     | risk.ts:494 | On merchant blocklist (hashed match)                            | no    |                 | per-merchant   |
| `extreme_cod`               | 40             | risk.ts:509 | COD ≥ merchant's extreme threshold                              | no    |                 | per-merchant   |
| `high_cod`                  | 18             | risk.ts:517 | COD ≥ merchant's high threshold                                 | no    |                 | per-merchant   |
| `duplicate_phone_heavy`     | 25             | risk.ts:529 | ≥6 decayed prior orders from this phone                         | yes   | gold            | per-merchant   |
| `duplicate_phone`           | 10             | risk.ts:539 | ≥3 decayed prior orders from this phone                         | yes   | gold            | per-merchant   |
| `prior_returns`             | 22             | risk.ts:553 | Decayed RTO count > 0                                           | yes   |                 | per-merchant   |
| `prior_cancelled`           | 14             | risk.ts:565 | Decayed cancellation count ≥2                                   | yes   |                 | per-merchant   |
| `low_success_rate`          | 20–22          | risk.ts:588 | <40% success rate when ≥3 resolved orders                       | yes   |                 | per-merchant   |
| `suspicious_district`       | 16             | risk.ts:608 | District empty / in `["unknown","n/a","na","test"]` / merchant list | no |                 | per-merchant   |
| `fake_name_pattern`         | 25             | risk.ts:622 | Placeholder / keyboard walk / vowelless / Bangla placeholder regex | no | gold            | per-merchant   |
| `unreachable_history`       | 20             | risk.ts:644 | ≥2 decayed prior unreachable call attempts                      | yes   |                 | per-merchant   |
| `ip_velocity`               | 16             | risk.ts:656 | ≥5 orders from same IP in 10-min window                         | no    |                 | per-merchant   |
| `velocity_breach`           | 75             | risk.ts:671 | ≥N orders from phone in velocity window (merchant-tunable)      | no    | gold            | per-merchant   |
| `duplicate_address`         | 22 / 11        | risk.ts:687 | ≥3 distinct phones on address OR prior RTO at this address       | yes   |                 | per-merchant   |
| network bonus               | up to +25      | fraud-network.ts | Cross-merchant signal — see § 3                                | yes (decay window) |       | **cross-merchant** |

Decayed signals use `weight(age) = weight × 2^(−age_days / historyHalfLifeDays)`. History window: 365 days lookback.

---

## 3. Cross-merchant fraud network — `lib/fraud-network.ts`

Status: **IMPLEMENTED**. Privacy-preserving cross-tenant aggregation.

### 3.1 Storage
- Model: `FraudSignal`
- Key: `(phoneHash, addressHash)` unique. Either may be `_none_` sentinel.
- Counters: `deliveredCount`, `rtoCount`, `cancelledCount`. `merchantIds[]` capped at 64 distinct contributors via schema-level validator. `firstSeenAt`, `lastSeenAt`.

### 3.2 Lookup (`lookupNetworkRisk(phoneHash, addressHash)`)
- Returns `EMPTY` (no bonus) when:
  - `env.FRAUD_NETWORK_ENABLED === false` (master kill switch), OR
  - signal not found, OR
  - `lastSeenAt < now - FRAUD_NETWORK_DECAY_DAYS` (default 180 days), OR
  - merchantCount ≤ 1 (single-merchant signal — pattern-of-one isolation).
- Bonus formula (capped at `NETWORK_BONUS_CAP = 25`):
  1. RTO-rate bonus: `max(0, min(20, rtoRate × 25))` when `rtoRate >= 0.5` AND merchantCount ≥ 2.
  2. Absolute RTO bonus: `+8` if `rtoCount >= 3`.
  3. Cancelled bonus: `+1` per cancellation, capped `+5`.
- **Warming-up damper**: if total network signal count < `FRAUD_NETWORK_WARMING_FLOOR` (default 50), bonuses are halved. Prevents single sketchy fingerprint dominating early rollout.
- Returns counts only — never the merchant identity list.

### 3.3 Contribution (`contributeOutcome(phoneHash, addressHash, outcome)`)
- Atomic aggregation-pipeline upsert.
- Outcome `delivered | rto | cancelled` increments the matching counter.
- `merchantIds` updated (capped at 64; once full, future contributors update counts but aren't added).
- `firstSeenAt` only on insert; `lastSeenAt` always touched.
- Triggered from `trackingSync` when an order lands a terminal status, AND from manual reject/no-answer paths via `rejectSnapshot.ts` helpers.

### 3.4 Privacy boundary (verbatim from `fraudSignal.ts`)
> *"Privacy posture: raw phone numbers and addresses are NEVER persisted in this collection… Tenant isolation: this collection is global by design — that's the point. The privacy boundary is enforced at write time (only hashes persist) and at read time."*

Hashes are SHA-256, 32 chars. Generated by `lib/crypto.ts` `hashPhone` and `hashAddress`. Phone is normalized to E.164 first; address is canonicalized (lowercased, whitespace-collapsed, common synonyms folded) before hashing.

### 3.5 Observability
Per-lookup and per-contribute, structured logs go through `lib/observability/fraud-network.ts`. Admin Fraud Network dashboard (`/admin/fraud`) reads aggregate stats: total signals, recent contributions, top merchants by RTO contribution count.

---

## 4. Address Intelligence v1 — `lib/address-intelligence.ts`

Status: **IMPLEMENTED**, **OBSERVATION-ONLY**. Verbatim from the file:
> *"No ML, no LLM, no opaque model — every contribution is a fixed integer with a human-readable rationale."*

### 4.1 `computeAddressQuality(address, district)` → `{score, completeness, missingHints, scriptMix, tokenCount, hasNumber, landmarks}`

Scoring (baseline 50):

Positive:
- tokenCount ≥5 (+10), ≥8 (+5)
- has number (+10)
- has landmark (+10), ≥2 landmarks (+5)
- district present (+5)

Penalties:
- mixed script (Bangla + Latin in same line) (−5)
- <15 chars (−20)
- <3 tokens (−25)
- no anchor — neither landmark nor number (−10)

Clamp 0–100.

Completeness tier:
- **Complete**: score ≥70 AND tokenCount ≥5 AND (has number OR landmarks)
- **Partial**: score ≥40
- **Incomplete**: score <40

Missing hints (UI-stable codes): `no_anchor`, `no_landmark`, `no_number`, `too_short`, `too_few_tokens`, `mixed_script`.

### 4.2 Landmarks
Categories: road, house, block, worship, education, market, health, intersection, transport, authority. Both Latin and Bangla aliases. Detection: token-level match + substring fallback for Bangla glyphs without whitespace. Bangla glyph matches always accepted; Latin aliases require ≥4 chars (avoid false positives on "st", "rd").

### 4.3 Status
- Stamped synchronously inline at ingest by `ingestNormalizedOrder` step 5.
- **Read by**: dashboard UI (order detail), admin analytics cohorts.
- **Not read by**: `computeRisk`, automation, courier selection. Observation-only.
- Kill switch: `ADDRESS_QUALITY_ENABLED=0` skips both this and thana extraction at ingest. Existing values on already-stamped orders remain visible (we only stop minting new ones).

### 4.4 Thana extraction — `lib/thana-lexicon.ts`
Best-effort: `extractThana(address, district)` returns a thana name only when the lexicon disambiguates a single match. Multi-match (same thana name across districts) returns null — never guessed.
> *"The lexicon below is a v1 SEED, not a complete enumeration. Coverage is deliberately weighted toward the BD divisions where merchants on Cordon concentrate today… Adding a thana is a code change — keeps it under code review."*

Status: v1 seed; **medium-term** thana-aware courier-performance scoring is documented in `FUTURE_EVOLUTION_GUIDE.md`.

---

## 5. Intent Intelligence v1 — `lib/intent.ts`

Status: **IMPLEMENTED**, **OBSERVATION-ONLY**. Verbatim:
> *"v1 does NOT feed the risk score; we observe against `FraudPrediction.outcome` for ≥14 days before wiring into `computeRisk` (covered in roadmap Phase 7)."*

### 5.1 `computeIntentScore(sessions, confirmation?)` → `{score 0..100, tier, signals}`

Tiers:
- **Verified**: ≥70
- **Implicit**: 40–69
- **Unverified**: <40
- **No data**: empty `sessions`

### 5.2 Score composition (max 100)

1. **Commitment** (max 40):
   - Repeat visitor OR multi-session: +12
   - 3+ product views OR ≥50% scroll depth: +8
   - 60+ seconds dwell: +10
   - Checkout completion ratio ≥0.5: +10
2. **Engagement quality** (max 30):
   - Organic / direct landing (no paid social): +10–15
   - Multi-session converter (2+ sessions, ≥1-day span): +15
3. **Confirmation quality** (max 30, optional):
   - SMS DLR delivered: +5
   - Buyer replied to confirmation: +20
   - Reply within 1h: +5

### 5.3 Signal keys
`no_session_data`, `repeat_visitor`, `deep_engagement`, `long_dwell`, `funnel_completion`, `organic_landing`, `multi_session_converter`, `confirmation_delivered`, `confirmation_replied`, `fast_confirmation`.

### 5.4 Wiring at ingest
`scoreIntentForOrder(orderId)` runs fire-and-forget after identity resolution stitches `TrackingSession.resolvedOrderId`. Reads sessions; computes intent; writes `Order.intent.{score, tier, signals[], sessionsConsidered, computedAt}`.

Kill switch: `INTENT_SCORING_ENABLED=0`.

---

## 6. Operational hints — `lib/operational-hints.ts`

Status: **IMPLEMENTED**, **VISIBILITY-ONLY**. Verbatim:
> *"This module never writes to the database, never enqueues a job, never modifies fraud/risk/automation state, never feeds `computeRisk`."*
> *"NDR engagement automation is out of scope for this milestone."*

### 6.1 `classifyOperationalHint(order)` → `OperationalHint | null`

Hint codes:
1. `address_clarification_needed` — incomplete address + still pre-dispatch.
2. `customer_unreachable_pending_call` — `fraud.reviewStatus === "no_answer"`.
3. `delivery_failed_attempt` — latest tracking event is `failed`.
4. `delivery_attempt_in_progress` — out-for-delivery within last 24h.
5. `stuck_in_transit` — out-for-delivery >24h ago, OR in_transit/shipped + no tracking event >4 days.
6. `stuck_pending_pickup` — confirmed/packed, no shipment, >36h since confirmation.
7. `awaiting_customer_confirmation` — `automation.state === "pending_confirmation"`.
8. `confirmation_sms_undelivered` — pending_confirmation + DLR failed + >30min.

Severity: `info | warning | critical`. Each hint includes a one-line action recommendation for the merchant.

### 6.2 Time thresholds (verbatim from `operational-hints.ts:97-107`)
- Stuck pending pickup: 36 hours
- Stuck in transit: 4 days
- Stale OFD: 24 hours
- Confirmation SMS grace: 30 minutes

### 6.3 Consumption
Dashboard UI surfaces hints in the order detail drawer. There is **no** auto-dispatch, no agent escalation, no auto-reschedule. Status: **PLANNED** for the NDR engine roadmap; current state is observation-only.

---

## 7. Reject snapshot / restore — `lib/rejectSnapshot.ts`

Status: **IMPLEMENTED**.

### 7.1 Snapshot at reject
`buildPreActionSnapshot(order, action="reject")` strips metadata fields (`decidedBy`, `decidedAt`, `reason`, `rejectedAt`, `preRejectState`) from `automation` subdoc and returns:
```
PreActionSnapshot {
  takenAt: Date;
  action: "reject";
  order:      { status }
  automation: { state, subdoc: { ...filtered fields } }
  fraud:      { reviewStatus, level }
}
```

Written to `Order.preActionSnapshot` (Mixed). Stored top-level (not nested) due to a known Mongoose strict-mode quirk that drops `Mixed` payloads on `_id: false` sub-schemas.

### 7.2 Restore
`restoreOrder(orderId, requesterId)`:
- Reads `preActionSnapshot`.
- Atomically reverts:
  - `order.status` → snapshot's prior status
  - `automation.*` → prior state + subdoc fields
  - `fraud.reviewStatus` → prior review status
  - `fraud.level` → prior level
- Clears `preActionSnapshot` so a re-reject + re-restore round-trips cleanly.
- CAS via `Order.version`.
- Emits AuditLog action `order.restored`.

Legacy rows (rejected before this PR) lack `preActionSnapshot`; restore falls back to the older split fields (`automation.preRejectState`, `order.preRejectStatus`, `fraud.preRejectReviewStatus`, `fraud.preRejectLevel`).

---

## 8. Courier Intelligence — `lib/courier-intelligence.ts`

Status: **IMPLEMENTED**.

### 8.1 Two-layer design
1. **Write**: `recordCourierOutcome(merchantId, courier, district, outcome, deliveryHours?)`. Increments `CourierPerformance` per-district AND merchant's `_GLOBAL_` aggregate atomically. Bumps `lastOutcomeAt`. Resets recent-failure window if older than 1h.
2. **Read**: `selectBestCourier(merchantId, district, candidates, preferredCourier?)` → `{best, ranked: [{courier, score, breakdown}]}`.

### 8.2 Scoring (per candidate)
- Success rate: `(delivered / completed) × 60`
- RTO penalty: `(rto / completed) × 30`
- Speed: `(min(1.5, 24h / avgDeliveryHours) / 1.5) × 10`
- Preferred bonus: +5 if matches merchant's `automationConfig.autoBookCourier`
- Recent-failure penalty: `−min(20, recentFailureCount × 4)`
- Cold-start (sample size < `MIN_OBSERVATIONS = 10` OR `lastOutcomeAt` > `STALE_OUTCOME_DAYS = 180`): neutral 50 + preferred bonus − failure penalty.

### 8.3 District + global fallback
Selection prefers per-district scores when ≥10 observations. Falls back to merchant's `_GLOBAL_` aggregate. Prevents RTO-rich district lookalikes from dominating courier ranking when a merchant just expanded into a new district.

### 8.4 Circuit breaker (recent-failure)
`recordCourierBookFailure(...)`:
- Rolling 1-hour window per `CourierPerformance` row.
- Window resets if older than 1h.
- Penalty `min(20, count × 4)` applied to the score → temporarily de-ranks a flapping courier without removing them entirely.

### 8.5 Caller
`automationBook` worker. The fallback chain consumes the `ranked` list in order, capped at `MAX_ATTEMPTED_COURIERS = 3`.

---

## 9. Weight tuning — `workers/fraudWeightTuning.ts`

Status: **IMPLEMENTED**. Cron `15 3 1 * *` (1st of month, 03:15 UTC).

### 9.1 Inputs
- 90 days of `FraudPrediction` rows where `outcome` is set.
- Floor: `MIN_SAMPLE_SIZE = 50` resolved predictions per merchant. Below floor → skipped.

### 9.2 Per-signal computation
For each signal key with `MIN_SIGNAL_HITS = 10` observations:
- `precision = rtoHits / hits`
- `lift = precision / merchantBaseRtoRate`
- `multiplier = sqrt(lift)`, clamped `[0.5, 1.5]`

`sqrt` smoothing dampens whiplash. Clamps protect against extreme moves on small samples.

### 9.3 Outputs (per merchant)
Persisted to `Merchant.fraudConfig`:
- `signalWeightOverrides`: `Map<signalKey, multiplier>`
- `baseRtoRate`: `rtoCount / resolvedNonCancelled` (cancelled excluded)
- `weightsVersion`: `tuned-YYYY-MM`
- `lastTunedAt`

### 9.4 Why monthly (verbatim)
> *"Why monthly: signal stability > reactivity. Weekly overfits to seasonal blips. Quarterly too lagging. Why per-merchant: a beauty merchant's extreme COD looks nothing like electronics."*

---

## 10. Anomaly detection — `lib/anomaly.ts`

Status: **IMPLEMENTED**. Admin observability surface.

### 10.1 Detectors
1. `detectPaymentSpike()` — manual payments: ≥10 in last hour, 3× baseline.
2. `detectWebhookFailureSpike()` — failed webhooks: ≥5 in last hour, 4× baseline.
3. `detectAutomationFailureSpike()` — automation failures: ≥10 in last hour, 3× baseline.
4. `detectFraudSpike()` — HIGH-risk orders: ≥10 in last hour, 2.5× baseline.

### 10.2 Comparison
- Short window: 1h.
- Reference window: previous 23h (24h − 1h).
- Trigger: `shortRate ≥ baselineRate × multiplier`, OR `baseline=0 AND shortCount ≥ floor`.

### 10.3 Dedupe
`alertDedupeKey(kind)` hour-grain. Same anomaly doesn't refire within the window.

### 10.4 Fan-out
`AuditLog.action = alert.fired` (subjectType `system`, severity per detector). Then `deliverAdminAlert()` fans out to admins per their `adminAlertPrefs` (in-app always; email + SMS per severity).

---

## 11. riskRecompute — `workers/riskRecompute.ts`

Triggers re-scoring of all *still-open* orders sharing a `(merchantId, phone)` after an outcome event (RTO/cancelled/manual review).

- jobId encodes `{merchantId}:{phone}:{trigger}:{10sBucket}` — bursts collapse.
- Loads each open Order, runs `computeRisk` with current merchant config + history.
- Updates `fraud.{riskScore, level, reasons, signals, scoredAt}`.
- **Never overrides terminal review** (`verified | rejected`).
- Fires `fraud.rescored_high` notification on first elevation to HIGH.
- CAS via `Order.version`. Conflict → skip; the next rescore trigger covers it.

In dev without Redis, falls back to synchronous execution so workflows still test end-to-end.

---

## 12. Map of what is IMPLEMENTED vs OBSERVATION-ONLY vs PLANNED

| Component                              | Status                | Reads from                                      | Writes to                                   |
| -------------------------------------- | --------------------- | ----------------------------------------------- | ------------------------------------------- |
| computeRisk                            | IMPLEMENTED           | merchant config, order history, network         | (caller writes Order.fraud)                  |
| signal registry (15 keys)              | IMPLEMENTED           | as above                                        | (caller)                                     |
| FraudSignal cross-merchant network     | IMPLEMENTED           | hashes                                          | hashes (env-gated)                           |
| Address Intelligence v1                | IMPLEMENTED + OBS-ONLY| address string                                  | Order.address.quality                        |
| Thana extraction                       | IMPLEMENTED (v1 seed) | address + district                              | Order.customer.thana                         |
| Intent Intelligence v1                 | IMPLEMENTED + OBS-ONLY| TrackingSession (resolvedOrderId)               | Order.intent                                 |
| Operational hints                      | IMPLEMENTED + VIS-ONLY| Order state                                     | (none — pure UI)                             |
| Reject snapshot / restore              | IMPLEMENTED           | Order                                            | Order.preActionSnapshot                      |
| Courier intelligence                   | IMPLEMENTED           | CourierPerformance                               | (caller via recordCourierOutcome)            |
| Weight tuning                          | IMPLEMENTED           | FraudPrediction outcomes                         | Merchant.fraudConfig                         |
| Anomaly detection                      | IMPLEMENTED           | Mongo time-windows                               | AuditLog + deliverAdminAlert                 |
| Intent → risk wiring                   | **PLANNED**           | (Phase 7)                                        |                                              |
| NDR engagement automation              | **PLANNED**           |                                                  |                                              |
| Thana-aware courier scoring            | **PLANNED** (medium-term) | thana + per-thana CourierPerformance           |                                              |
| Full BD thana lexicon coverage          | **PLANNED**           |                                                  |                                              |
| RTO Engine v2 (full prevention loop)   | **PLANNED**           | (per RTO_ENGINE_EXECUTION_ROADMAP.md)            |                                              |

---

## 13. Operational guarantees of the engine

- **Explainability**: every signal carries `(key, weight, detail)`. The merchant UI surfaces these verbatim. There is no opaque ML.
- **Determinism**: `computeRisk`, `computeIntentScore`, `computeAddressQuality`, `classifyOperationalHint` are pure functions. Same inputs → same outputs.
- **Reversibility**: `preActionSnapshot` lets the merchant un-reject without losing fraud state.
- **Bounded blast radius**: `FRAUD_NETWORK_ENABLED=0` disables both lookup AND contribution without redeploy. `ADDRESS_QUALITY_ENABLED=0`, `INTENT_SCORING_ENABLED=0` likewise.
- **Adaptive but stable**: weights adjust monthly per merchant; the `[0.5, 1.5]` clamp + `sqrt` smoothing prevent runaway moves.
- **Privacy**: cross-merchant network operates on SHA-256 hashes; merchant counts rounded; merchant identities never returned.
- **Conservatism**: weights sum to >>100 so a single moderate signal rarely flips to HIGH; a HIGH score requires *combinations* of signals.
- **Gold-tier protection**: high-success customers bypass soft signals so a loyal repeat buyer doesn't get falsely flagged on velocity.

---

## 14. Pointers in code

- `apps/api/src/server/risk.ts:441-753` — `computeRisk` body
- `apps/api/src/server/risk.ts:33-60` — signal key constants + default weights
- `apps/api/src/lib/fraud-network.ts:270-284` — bonus formula
- `apps/api/src/lib/address-intelligence.ts:140-216` — `computeAddressQuality`
- `apps/api/src/lib/intent.ts:204-366` — `computeIntentScore`
- `apps/api/src/lib/operational-hints.ts:122-262` — `classifyOperationalHint`
- `apps/api/src/lib/courier-intelligence.ts:95-412` — selection + circuit breaker
- `apps/api/src/workers/fraudWeightTuning.ts:62-152` — per-merchant tuning
- `apps/api/src/lib/anomaly.ts:84-313` — detectors
- `apps/api/src/lib/rejectSnapshot.ts:24-83` — snapshot + restore helpers
