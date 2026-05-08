# Fraud / Reliability / Operational Scoring — Critical Audit

**Date:** 2026-05-09
**Auditor:** Claude (claude-opus-4-7)
**Branch:** `claude/staging-deploy`
**Scope:** Audit only — no implementation. Inspect every fraud / risk /
reliability / operational scoring path. Determine operational
trustworthiness, false-positive risk, replay/idempotency safety,
merchant-explainability, and Bangladesh-COD market realism.

This audit treats the system as a candidate for **operational decision
support**, not as a customer-punishment machine. The standard applied
throughout: would a merchant trust this in their own business? Would a
junior agent in a Bangladesh COD call-center understand why a score
fired? Could a malformed webhook silently corrupt the merchant's view
of a buyer? Where the answer is "no", it is recorded.

---

## 1. Executive Summary

The platform runs **two distinct scoring stacks** today:

1. **Risk / Fraud (decision-feeding).** `apps/api/src/server/risk.ts`
   `computeRisk` → 0–100 deterministic score + hard-block list +
   logistic P(RTO) calibration. Wired into `ingestNormalizedOrder`,
   `riskRecompute` worker, and the manual `fraud.rescoreOrder` mutation.
   Drives the `pending_call` / `optional_review` queues and the
   "Risky/Verify/Safe" badge on the order surface.
2. **Delivery Reliability (observation-only).** `apps/api/src/lib/
   delivery-reliability.ts` `classifyDeliveryReliability` →
   signed-weight 0–100 baselined at 50 across customer / address /
   courier axes. Currently behind kill-switches
   (`DELIVERY_RELIABILITY_*_ENABLED`) — write default OFF, read default
   OFF. Properly observation-only by design.

A third layer — **the cross-merchant network** (`apps/api/src/lib/
fraud-network.ts`) — privacy-safely aggregates outcomes across
merchants and computes a `bonus` capped at +25. **It writes correctly,
but its read result is currently never consumed by `computeRisk`.**
The bonus is presented in the agent UI for context only.

### Headline findings (severity-ranked)

| # | Severity | Finding |
|---|----------|---------|
| 1 | 🔴 **Critical** | **Per-merchant adaptive weight overrides never apply.** `fraudWeightTuning` writes `signalWeightOverrides` keyed by snake_case signal keys (`high_cod`, `extreme_cod`, …). `computeRisk.effectiveWeight` looks up by camelCase `WEIGHTS` keys (`highCod`, `extremeCod`, …). The two key-spaces never collide → tuner output is a no-op for every merchant since launch. |
| 2 | 🔴 **Critical** | **Cross-merchant network bonus is never consumed.** `lookupNetworkRisk` is invoked only inside `fraud.getReviewOrder` for UI presentation. The `bonus` field is computed but never added to `riskScore` anywhere. The network is currently a privacy-safe data lake feeding only an info card. |
| 3 | 🟠 **High** | **`contributeOutcome` double-counts on status corrections.** A `delivered → rto` flip fires `contributeOutcome` twice with different outcomes; the FraudSignal row ends up with both `deliveredCount=1` AND `rtoCount=1` from a single physical order. No order-id de-dup. |
| 4 | 🟠 **High** | **Hard-block forces P(RTO) ≥ 0.95** even for purely structural reasons (e.g. malformed phone format). The merchant UI shows "95% chance of RTO" for what is actually a phone-validation rule. Misleads merchants about model confidence. |
| 5 | 🟠 **High** | **`extreme_cod + suspicious_district` is an unconditional hard-block**, where "suspicious" includes *missing district*. BD merchants regularly ingest orders with empty/un-normalized districts; pairing that with a high-value order auto-flags legitimate sales. |
| 6 | 🟠 **High** | **Velocity threshold defaults to 3 orders / 10 minutes with weight 75** (forces HIGH alone). A corporate or wholesale buyer placing three legitimate orders inside the window triggers auto-HIGH the same way fraud does. |
| 7 | 🟡 **Medium** | **`isFakeNamePattern` returns true for any name < 3 characters.** Two-character Bangla and short Romanizations exist. 25-weight penalty + any other yellow flag → HIGH. |
| 8 | 🟡 **Medium** | **First-resolved-order penalty is too eager.** `customer_low_success_rate` fires at `priorResolved >= 3` with success < 40% — e.g. one delivered + two unrelated cancellations triggers the penalty on the buyer's third order. |
| 9 | 🟡 **Medium** | **`fireFraudAlert` is not de-duplicated across rapid HIGH events for the same phone.** A buyer placing five flagged orders in quick succession pages the merchant five times. |
| 10 | 🟢 **Operational** | The Delivery Reliability layer is correctly architected as observation-only and properly gated. Replay-safety is enforced at the chokepoint, not the helpers. ✓ |

The system is **not** behaving as automated customer punishment — there
are no auto-cancellations and no merchant-invisible automatic actions
in the score path. But several *informational* surfaces (alerts, UI
copy, P(RTO)) overstate confidence in a way that erodes merchant trust
once they spot a false positive. The biggest correctness issues are
silent: nobody complains about a tuner that does nothing, and nobody
notices a network that never affects scores.

---

## 2. Current Scoring Architecture

### 2.1 Files (canonical)

| Concern | File | Role |
|---|---|---|
| Pure scoring | `apps/api/src/server/risk.ts` | `computeRisk`, `collectRiskHistory`, `collectRiskHistoryBatch`, `hashAddress`, `classifyCustomerTier`. Stateless, deterministic. |
| Ingest seam | `apps/api/src/server/ingest.ts` | Calls `computeRisk` at order create, persists `FraudPrediction`, fires alerts. |
| Per-order rescore worker | `apps/api/src/workers/riskRecompute.ts` | BullMQ consumer, optimistic-concurrency `updateOrderWithVersion`, fan-out fired by `order.rto`, `review.no_answer`, `review.rejected`. |
| Manual rescore | `apps/api/src/server/routers/fraud.ts` `rescoreOrder` | Single-order rescore, no version check (note: divergence from worker). |
| Adaptive weights | `apps/api/src/workers/fraudWeightTuning.ts` | Monthly cron, writes `Merchant.fraudConfig.signalWeightOverrides`. |
| Cross-merchant network | `apps/api/src/lib/fraud-network.ts` | `lookupNetworkRisk`, `contributeOutcome`. Hashed phone+address. |
| Reliability classifier (observation-only) | `apps/api/src/lib/delivery-reliability.ts` | Pure-function classifier. |
| Reliability writers | `apps/api/src/lib/delivery-reliability-writers.ts` | `recordCustomerOutcome`, `recordAddressOutcome`. Atomic upserts. |
| Anomaly detector | `apps/api/src/lib/anomaly.ts` | Hourly z-score-style baseline comparison; `fraud_spike` is a system-level alert, not a per-order signal. |
| Persistence | `packages/db/src/models/{fraudPrediction,fraudSignal,customerReliability,addressReliability}.ts` | TTL-bounded prediction ledger; capped, hashed network signal; per-merchant aggregates. |
| Merchant config | `packages/db/src/models/merchant.ts` `fraudConfigSchema` | Thresholds, blocklists, velocity, half-life, weight overrides, baseRtoRate, weightsVersion. |
| Read surfaces | `apps/web/src/app/dashboard/fraud-review/page.tsx` (queue), `getReviewOrder` (detail), `apps/web/src/app/admin/fraud/page.tsx` (admin observability). |

### 2.2 Flow (happy path)

```
Webhook  →  ingestNormalizedOrder
              ├─ collectRiskHistory  (5 queries: phone orders, address orders,
              │                        unreachable callogs, IP recent, velocity)
              ├─ computeRisk  (pure, weight-sum + hard-blocks + logistic P(RTO))
              ├─ Order.create  (fraud.* fields)
              ├─ FraudPrediction.create  (frozen weight snapshot for tuner)
              └─ fireFraudAlert if level==='high'

Tracking event  →  applyTrackingEvents
              └─ on terminal flip:
                   ├─ FraudPrediction.updateOne  (outcome, outcomeAt)
                   ├─ contributeOutcome  (cross-merchant network, hashed)
                   ├─ recordCourierOutcome  (per-(merchant, courier, district))
                   ├─ recordCustomerOutcome  (gated, observation-only)
                   ├─ recordAddressOutcome  (gated, observation-only)
                   └─ enqueueRescore on rto  (recompute open orders, same phone)

Monthly cron  →  fraudWeightTuningWorker
              ├─ FraudPrediction last 90d, ≥50 resolved
              ├─ per-key precision = rtoHits / hits  (cancelled excluded)
              ├─ multiplier = clamp(sqrt(precision/baseRate), 0.5, 1.5)
              └─ Merchant.update  (signalWeightOverrides, baseRtoRate, weightsVersion)
```

### 2.3 Gates and kill-switches

| Env var | Default | Effect |
|---|---|---|
| `FRAUD_NETWORK_ENABLED` | `1` | Master switch for both lookup and contribute. |
| `FRAUD_NETWORK_DECAY_DAYS` | `180` | Stale-cutoff for read; contribution still bumps `lastSeenAt`. |
| `FRAUD_NETWORK_WARMING_FLOOR` | `50` | While total signals < floor, network bonus is halved (warming-up damper). |
| `ADDRESS_QUALITY_ENABLED` | `1` | Stamps `address.quality` and `customer.thana` on order create. Observation-only. |
| `INTENT_SCORING_ENABLED` | `1` | Enables intent post-stitching. Observation-only. |
| `DELIVERY_RELIABILITY_WRITE_ENABLED` | `0` | Gates `recordCustomerOutcome` / `recordAddressOutcome` fan-out. |
| `DELIVERY_RELIABILITY_READ_ENABLED` | `0` | Gates orders.getOrder reliability surface. |
| `DELIVERY_RELIABILITY_ANALYTICS_ENABLED` | `0` | Gates analytics tRPC surface. |

---

## 3. Signal Inventory

### 3.1 Risk signals (`computeRisk`)

| Signal key (emitted) | `WEIGHTS` key | Weight | Trigger | Notes |
|---|---|---:|---|---|
| `garbage_phone` | `garbagePhone` | 30 | Phone fails BD canonical pattern OR all-same-digit OR < 7 digits OR > 15 digits. | **Hard-block.** False-positives on 11-digit foreign numbers that "look BD". |
| `blocked_phone` | `blockedPhone` | 100 | Merchant blocklist hit on normalized phone. | **Hard-block.** Exact match. |
| `blocked_address` | `blockedAddress` | 100 | Merchant blocklist hit on `addressHash`. | **Hard-block.** Brittle to typos because hash is exact. |
| `extreme_cod` | `extremeCod` | 40 | `cod >= extremeCod` (dynamic from merchant p75 × 3, floor ৳4000). | Combined with `suspicious_district` becomes a hard-block. |
| `high_cod` | `highCod` | 18 | `cod >= highCod` (dynamic, p75 × 1.5, floor ৳1500). | |
| `duplicate_phone` | `duplicatePhone` | 10 | Decayed phone-orders count ≥ 3. | Bypassed for Gold tier. |
| `duplicate_phone_heavy` | `duplicatePhoneHeavy` | 25 | Decayed phone-orders count ≥ 6. | Bypassed for Gold. |
| `prior_returns` | `priorReturns` | 22 | Decayed return count > 0. | Fires on a single decayed prior return — too sensitive when paired with `low_success_rate`. |
| `prior_cancelled` | `priorCancelled` | 14 | Decayed cancelled count ≥ 2. | |
| `low_success_rate` | derived | 14 or 22 | `priorResolved ≥ 3` AND success < 40%. | Tiny-sample false positive risk. |
| `suspicious_district` | `suspiciousDistrict` | 16 | District blank or in {`unknown`, `n/a`, `na`, `test`} ∪ merchant list. | Missing district + extreme COD = hard-block. |
| `fake_name_pattern` | `fakeNamePattern` | 25 | Length<3, placeholder list, regex set, vowelless ≥4. | Bypassed for Gold. Aggressive on short Bangla names. |
| `unreachable_history` | `unreachableHistory` | 20 | Decayed unanswered-call count ≥ 2. | |
| `ip_velocity` | `ipVelocity` | 16 | ≥5 orders from same IP in 10 min. | Fragile on shared NAT pools (BD mobile carriers). |
| `velocity_breach` | `velocityBreach` | 75 | ≥`velocityThreshold` (default 3) orders from same phone in window. | **Single-signal HIGH.** Bypassed for Gold. |
| `duplicate_address` | `duplicateAddress` | 22 (or /2) | ≥3 distinct phones at the same `addressHash`, OR a prior RTO at the address. | |

### 3.2 Reliability signals (`classifyDeliveryReliability`)

Signed weights summed onto baseline 50. Tier cutoffs at 70 (verified)
and 40 (implicit). Properly observation-only.

`customer_repeat_success`, `customer_repeat_rto`, `customer_low_success_rate`,
`address_clean_history`, `address_repeat_rto`, `address_multi_buyer`,
`courier_lane_strong`, `courier_lane_weak`, `courier_lane_unknown`,
`network_warning`, `address_quality_warning`, `no_history_data`.

### 3.3 Network signals (`lookupNetworkRisk`)

Three drivers, each clamped, summed and clamped at `NETWORK_BONUS_CAP = 25`:

- `rtoRate × 25` (capped at 20) when rate ≥ 0.5 AND merchantCount ≥ 2.
- `+8` flat when rtoCount ≥ 3 (regardless of rate).
- `min(5, cancelledCount)`.
- Halved while `signalCount < FRAUD_NETWORK_WARMING_FLOOR`.

**Currently unconsumed by `computeRisk`** — see §4 finding 1.

### 3.4 Anomaly system signals (`runAnomalyDetection`)

`payment_spike`, `webhook_failure_spike`, `automation_failure_spike`,
`fraud_spike`. Hourly z-score-shaped detection, dedup-key per-hour.
Operationally healthy. Not per-order; for admin observability only.

---

## 4. Critical Correctness Risks

### 4.1 🔴 Adaptive weight overrides never apply (key-space mismatch)

**File:** `apps/api/src/workers/fraudWeightTuning.ts:115` writes overrides
keyed by the **snake_case signal key** that lives on `FraudPrediction.signals[].key`:

```ts
const fired = new Set((row.signals ?? []).map((s) => s.key));
for (const key of fired) {  // key === "high_cod", "extreme_cod", …
  ...
  overrides[key] = multiplier;
}
```

`apps/api/src/server/risk.ts:410` reads them with the **camelCase
`WEIGHTS` key**:

```ts
const lookup = overrides instanceof Map
  ? overrides.get(key as string)        // key === "highCod"
  : (overrides as Record<string, number>)[key as string];
```

Result: every lookup returns `undefined`, the function falls back to
`baseline`, and **no merchant has ever consumed a tuned weight since
the worker shipped**. The `weightsVersion` stamp on each prediction
correctly tracks "tuner-2025-12", "tuner-2026-01", …, but the
multipliers behind those versions were silently dead.

This also means the tuner's per-merchant base RTO rewrite (which IS
read correctly via `fraudConfig.baseRtoRate`) is the only thing that
has had an effect — but it's a single calibration anchor, not a per-
signal correction.

### 4.2 🔴 Cross-merchant network bonus is unconsumed

**File:** `apps/api/src/lib/fraud-network.ts:118` exports
`lookupNetworkRisk` returning a `bonus` field. Grepping the call sites:

- `apps/api/src/server/routers/fraud.ts:202` — invoked **only** from
  `getReviewOrder` for the agent UI's network panel. Bonus is not added
  back to any score.
- No call site exists in `risk.ts`, `ingest.ts`, `riskRecompute.ts`, or
  `tracking.ts`.

`contributeOutcome` is correctly wired and the data lake builds. The
read side is functionally a privacy-safe info widget. Either the
integration was never finished or the policy decision to keep it
informational only is undocumented.

The `recordNetworkOutcome({ outcome: "lookup_hit_applied", ..., estimatedPrevented: bonus >= 10 })`
metric is therefore **false** — the bonus is "applied" only into the
agent's eyes, never into a decision.

### 4.3 🟠 Manual `rescoreOrder` mutation lacks optimistic concurrency

`apps/api/src/server/routers/fraud.ts:581` writes via
`Order.updateOne({ _id, merchantId }, ...)` with no `version` filter.
The worker path (`riskRecompute.ts:159`) correctly uses
`updateOrderWithVersion`. Two agents racing the manual rescore button
during a webhook-triggered worker rescore can clobber each other's
fraud state. Low-frequency in practice; would still violate the
"never silently undo merchant intent" rule.

### 4.4 🟠 `signals.signals` schema drift between writers

`Order.fraud.signals` is written variously as
- ingest: `{ key, weight, detail? }`
- worker rescore: same
- `FraudPrediction.signals`: `{ key, weight }` only — `detail` stripped.

The tuner reads `FraudPrediction.signals` and is therefore unaffected,
but the inconsistency means any future tuner that wants to read
`detail` for richer features will silently miss it for predictions
created via ingest.

### 4.5 🟢 Hard-block score floor is correctly enforced

`riskScore = Math.max(riskScore, 85)` when `hardBlocked` ensures a hard
block always classifies HIGH and ranks above any computed-medium order
in the queue sort. ✓

---

## 5. Replay / Idempotency Risks

### 5.1 🟠 `contributeOutcome` double-counts on status corrections

A buyer order that flows `pending → delivered → rto` (delivery later
corrected) fires `contributeOutcome` twice: once at the
`pending → delivered` flip and once at the `delivered → rto` flip.
The `(phoneHash, addressHash)` row ends up with `deliveredCount = 1`
AND `rtoCount = 1` for a single physical order.

`apps/api/src/server/tracking.ts:206` only checks `nextStatus !== prevStatus`;
the chokepoint correctly prevents re-entry on equal-status events but
NOT on flip-flops. Same issue applies to `recordCustomerOutcome` and
`recordAddressOutcome` — both helpers explicitly document "the helper
does NOT dedupe by orderId".

`FraudPrediction.outcome` is safer: `$set` overwrites cleanly on a
later flip, so the tuner sees the final outcome only. But the network
signal lake and reliability aggregates accumulate ghost outcomes on
every correction.

The reconciler (`delivery-reliability-reconciliation.ts`) repairs
drift between Order and aggregates but does not retroactively decrement
network signals.

### 5.2 🟠 `enqueueRescore` jobId bucket may collapse legitimate fan-outs

`riskRecompute.ts:263`:

```ts
jobId: `${data.merchantId}:${data.phone}:${data.trigger}:${Math.floor(Date.now() / 10_000)}`
```

A 10s bucket. Two webhooks landing 11s apart → two jobs → fine. Two
landing 9s apart → collapse. Generally safe; flagged only because the
bucket is undocumented in the worker contract.

### 5.3 🟠 Sync fallback when Redis is down processes inline

`enqueueRescore` falls back to **synchronous** `processRescoreJob` when
the queue throws. In a Redis outage during a busy hour, every
RTO-triggered rescore now blocks the request thread of whichever
caller fired it (e.g. the tracking webhook). Tail latency cliff.

### 5.4 🟢 Webhook ingestion idempotency is sound

The unique partial index on `(merchantId, source.externalId)` plus the
`E11000` catch in `ingestNormalizedOrder` covers the dedup race.
`WebhookInbox` provides the per-event ledger. ✓

### 5.5 🟢 Tracking chokepoint (`applyTrackingEvents`) is replay-safe

`$nin newKeys` + status guard + `nextStatus !== prevStatus` is a sound
3-of-3 guard against double-fire of the terminal block. The
delivery-reliability fan-out trusts this gate, which is the right
contract.

---

## 6. False-Positive Risks

### 6.1 🟠 `velocity_breach` is too sensitive for legitimate B2B / wholesale buyers

Threshold default 3 / 10 min, weight 75 = forces HIGH on a single
trigger. A wholesale buyer placing one order per stockkeeper for three
SKUs in five minutes auto-trips. Same shape as fraud, opposite
intent. No "group order" detection.

### 6.2 🟠 `extreme_cod_in_suspicious_district` hard-blocks legitimate sales

`reasons.push("Very high COD into a suspicious district — auto-flagged for review")`
fires on `extremeCodHit && (district === "" || district in defaults)`.
The default suspicious set includes only `unknown`, `n/a`, `na`, `test`
— but `!district` (empty string) ALSO trips the suspicious branch.
Many BD storefronts ingest orders without a normalized district; the
ingest path will pass the raw `customer.district` through. Result:
"high-value order with no district" → review-required, regardless of
whether the address itself is well-formed.

### 6.3 🟡 `isFakeNamePattern` hits short legitimate names

`if (name.length < 3) return true;` will fire on legitimate two-character
Bangla names ("জয়", "মা") and short Latin names ("Bo", "Ed", "Al",
"Ai"). 25-weight signal, plus any other yellow flag = HIGH.

### 6.4 🟡 `low_success_rate` over a 3-order sample is too eager

`priorResolved >= 3 && successRate < 0.4` fires after a single
delivered + two unrelated cancellations (which may have been merchant-
side stockouts, not buyer-side rejects). The buyer's third order pays
the penalty for sequencing they didn't cause. Tuning would help —
except tuning doesn't apply (§4.1).

### 6.5 🟡 `garbage_phone` on 11-digit non-BD numbers

`looksBD = digits.startsWith("880") || digits.startsWith("0") || digits.length === 11`.
An Indian "9123456789" or a Pakistani "0301..." that happens to be
11 digits and starts with `0` enters the `looksBD` branch and fails
the canonical regex → HARD BLOCK. The comment says "foreign numbers
are left alone" but the branch contradicts that.

### 6.6 🟡 `ip_velocity` on shared mobile NAT pools

5 orders / 10 min from the same IP. BD mobile carriers (GP, Robi,
Banglalink) do CG-NAT — thousands of users behind one egress IP. A
moderately popular merchant on a Friday evening will trip this on
real customers. Weight 16 alone won't HIGH but combines with anything
else.

### 6.7 🟡 `duplicate_address` on token-sorted hash

`hashAddress` lowercases, strips punctuation, sorts tokens. Two
physically distinct addresses that happen to share tokens
("House 1, Road 2, Dhaka" ≡ "House 2, Road 1, Dhaka") collide. Then
`addressDistinctPhones >= 3` over-fires across genuinely distinct
households on similar streets.

---

## 7. Operational-Trust Risks

### 7.1 🟠 `fireFraudAlert` is not deduplicated across HIGH events

A buyer placing 5 flagged orders within an hour pages the merchant 5
times. No per-(merchantId, phone) cooldown. Alert fatigue.

### 7.2 🟠 New-merchant orders compute against platform defaults with full UI confidence

A merchant with zero history sees "P(RTO) = 38%" on the third order of
their day, with the same emphasis as a merchant who's tuned for six
months. Nothing in the UI flags "this score is uncertain because we
don't know your buyer base yet." `customerTier === "new"` is computed
but not surfaced.

### 7.3 🟠 P(RTO) is uncalibrated and presented as a probability

`scoreToProbability(score, baseRate)` is a logistic with `scale = 18`
anchored on the merchant's base rate at score 50. That is a
reasonable shape, but it has never been validated against actual RTO
outcomes, and the merchant UI says
> "P(RTO) = 23%"
without disclosing the anchor or the model class. It is a plausibility
function dressed up as a probability.

### 7.4 🟠 Hard-block reasons are mixed with weight-sum reasons

The merchant UI iterates `fraud.reasons[]` with no distinction between
"this signal forced HIGH on its own" and "this signal contributed
points". The agent cannot easily tell why a particular order is HIGH
without expanding the technical-signals `<details>` block.

### 7.5 🟢 No automated customer-side punishment

Hard-block forces *review*, not *cancel*. There is no auto-cancel,
auto-blacklist, or auto-block path triggered by score. The merchant
or agent always makes the terminal decision. ✓

### 7.6 🟢 Quota-aware review actions

`markVerified` and `markRejected` reserve quota up-front, refund on
conflict — quota usage stays consistent with intent. ✓

---

## 8. Merchant Explainability Findings

### 8.1 ✓ Reasons-first display in the agent surface

`fraud-review/page.tsx:476` shows full English sentences ("Same phone
used in 5 previous orders") above the technical signal list. Operators
without internal taxonomy training can decide. ✓

### 8.2 🟠 Weights are shown as `+X` deltas

The `<details>` panel surfaces `+25`, `+18`, etc. but the score is
itself capped at 100, decayed, and goes through a logistic — the
arithmetic the merchant sees doesn't add up. A merchant who tries to
audit the score will conclude the math is wrong. It's not, but the
presentation suggests linear additivity.

### 8.3 🟠 No visibility into which thresholds are in effect

`dynamicThresholds.source` is computed (`merchant_p75`, `merchant_avg`,
`platform_default`, `merchant_override`) and stamped on the result —
but no UI surface shows it. A merchant cannot easily answer "why is
my high-COD threshold ৳4500 today?"

### 8.4 🟠 No "what would lower the score" guidance

The merchant sees a 78 score with three reasons. None of the reasons
are actionable from their side ("the customer's phone has 5 prior
orders" — what is the merchant supposed to do?). Reasons are framed
as findings, not levers.

### 8.5 🟡 `confidenceLabel` is good

Plain "Safe / Verify / Risky" tied to thresholds is the right language
for non-technical merchants. ✓

### 8.6 🟡 Network panel is informational with no scoring impact (matches §4.2)

The agent UI's network card shows merchantCount, deliveredCount,
rtoCount, rtoRate. No claim of scoring effect — but the field is also
not labeled as "context only", so an agent may infer it influenced
the score. It did not.

---

## 9. Bangladesh-Market Realism Findings

### 9.1 🟢 Bangla-script awareness is good

`PLACEHOLDER_NAMES` includes "নাম", "ক্রেতা", "গ্রাহক". `FAKE_NAME_REGEXES`
includes the Bangla Unicode block in the digits-only check.
`hashAddress` regex preserves Bangla code points (`ঀ-৿`).

### 9.2 🟠 Phone validation hits 015-prefix legacy numbers correctly but is brittle

`/^(8801[3-9]\d{8}|01[3-9]\d{8})$/` covers GP/Robi/Banglalink/Teletalk
+ Skitto. Doesn't accept the rare 014/015/017 fixed-line / virtual
numbering schemes some merchants encounter. Conservative tradeoff;
acknowledge it.

### 9.3 🟠 District signal is a coarse proxy for delivery zone

Districts in BD ingestion data are highly inconsistent: "Dhaka",
"ঢাকা", "Dhanmondi" (an area, not a district), "Mirpur-10" (a
sub-area). Treating empty district as "suspicious" (and hard-blocking
on extreme COD) punishes the merchant for noisy upstream data. The
proper signal is *thana / area* — `extractThana` exists but is
observation-only.

### 9.4 🟠 30-day default decay half-life is short for seasonal patterns

BD COD is seasonal: Eid clusters, end-of-month payday clusters,
campaign-driven bursts. With a 30-day half-life, a buyer who placed
4 successful orders in Eid-ul-Fitr and returns 32 days later looks
like a new customer (4 orders × 0.5 ≈ 2 weighted; below the
`DUP_PHONE_WARN` threshold of 3). The Gold-tier bypass uses raw
counts (`phoneDeliveredRaw`), so the seasonal-buyer story works
*there* — but every other signal that uses decayed counts forgets
the buyer.

### 9.5 🟢 Address tokenization handles common BD address noise

The lowercase + punctuation strip + token sort + Bangla preservation
is appropriate for the heterogeneous address format. The collision
risk in §6.7 is the cost.

### 9.6 🟠 COD floors (৳1500 high / ৳4000 extreme) reflect mid-market only

A boutique apparel merchant with average ticket ৳800 will have
*every* order trip "high COD" if the dynamic floor doesn't kick in.
A consumer-electronics merchant with average ticket ৳15000 will
have nothing trip extreme_cod even on a ৳50000 order until the p75
adapts. The dynamic-threshold mechanism is the right design; the
adaptation latency (needs `MerchantStats.p75OrderValue`) means the
first month is platform-default for everybody.

### 9.7 🟢 Cross-merchant privacy posture is sound

Hashed phone (32 chars of SHA-256), hashed address, capped
merchantIds, no raw fields on the global surface. ✓

---

## 10. Automation Danger Findings

### 10.1 🟢 No auto-cancel or auto-decision in the score path

The HIGH path is queue-only; merchant or agent is always the
terminal decider. ✓

### 10.2 🟠 Rescore worker can fan-out to many open orders on a single trigger

A single confirmed `review.rejected` enqueues a rescore for every
non-terminal order from the same phone. If the buyer has 12 open
orders (e.g. courier delays piling up), the worker rescores 12,
potentially elevates several to HIGH, and fires 12 alerts. Combined
with §7.1 (no alert dedup), this is an alert storm.

### 10.3 🟠 `velocity_breach` weight 75 = single-signal HIGH

A merchant who unintentionally configures `velocityThreshold = 1` (or
relies on default 3) and runs a CSV bulk-upload of 10 legitimate
orders for one buyer will see all 10 auto-HIGH. There is no
"this is a CSV import" exemption in the velocity check.

### 10.4 🟢 Bulk-upload path uses `collectRiskHistoryBatch`

The batch helper does not compute `phoneVelocityCount` or
`ipRecentCount`, so CSV imports skip those signals entirely. ✓
(Though §10.3 still applies to API + dashboard creation.)

---

## 11. Observability / Runtime Findings

### 11.1 🟢 `recordNetworkOutcome` covers the network surface

Lookup outcomes (`hit_applied`, `hit_suppressed`, `miss`, `disabled`,
`stale`, `warming_up`) and contribute outcomes (`recorded`, `disabled`,
`skipped`, `failed`) all log + counter. Snapshot exposed via
`adminFraudNetworkRouter.getStats`. ✓

### 11.2 🟢 `recordReliabilityOutcome` instruments the reliability path

`event: customer_updated | address_updated | aggregate_skipped | invalid_transition | write_failed` — mature observability for an
observation-only layer. ✓

### 11.3 🟠 No per-merchant scoring observability

Counters track network and reliability outcomes globally, but there
is no per-merchant "scoring health" dashboard: HIGH rate, hard-block
rate, false-positive rate (verified after pending_call), tuner status,
weights version in effect.

### 11.4 🟠 Tuner output has no validation pass

The tuner writes overrides on a 50-prediction floor with a
10-precision-hit per-key floor. There is no "did this tuner cycle
make precision worse?" backstop — even if the key-space bug (§4.1)
were fixed, a regression in the tuner could push merchants into a
worse weight set with no auto-rollback.

### 11.5 🟠 `recordNetworkOutcome` claims `estimatedPrevented` based on `bonus >= 10`

Given §4.2, this metric is structurally untrue: the bonus has no
prevention effect because no decision consumes it. Counter is
operationally misleading.

### 11.6 🟢 Anomaly detection is wired and dedup-keyed

`runAnomalyDetection` covers payment / webhook / automation / fraud
spike, with per-hour dedup. `fraud_spike` fires when high-risk orders
> 2.5× their daily baseline. Operationally healthy. ✓

---

## 12. Queue / Replay Safety Findings

### 12.1 🟢 Risk recompute uses optimistic concurrency

`updateOrderWithVersion` correctly skips on stale-version writes and
logs the conflict for ops follow-up. ✓

### 12.2 🟢 BullMQ wiring is verified per CLAUDE.md

`registerRiskRecomputeWorker` and `registerFraudWeightTuningWorker`
appear in `src/index.ts`. ✓

### 12.3 🟠 Sync fallback when Redis is degraded (see §5.3)

Tail latency cliff during Redis outage. Acceptable for cold-start; not
acceptable under load.

### 12.4 🟠 `markRejected` triggers rescore but does not block on completion

The mutation returns `{ id, reviewStatus, orderStatus, codSaved }`
immediately after `enqueueRescore`. Agents who reject and immediately
look at related orders may still see stale scores. Acceptable UX —
flagged for awareness only.

### 12.5 🟢 FraudPrediction outcome update is order-id-keyed and idempotent

Unique index on `orderId` + `$set` semantics tolerate replays. ✓

---

## 13. Scalability Findings

### 13.1 🟠 `collectRiskHistory` is 5 queries per scoring run

For high-throughput merchants (100s of orders/min from Shopify), this
is 500+ queries/min on Order alone, mostly served by the
`merchantId + customer.phone` index path. Acceptable today; will need
revisiting at 10× volume. Consider per-merchant + per-phone caching
with explicit invalidation on order status flips.

### 13.2 🟠 Aggregate write amplification on terminal flip

Each terminal flip writes:
- `Order.updateOne` (status + timestamps)
- `MerchantStats.updateOne`
- `FraudPrediction.updateOne` (outcome)
- `FraudSignal.updateOne` (cross-merchant network)
- `CourierPerformance.updateOne` (lane)
- `CustomerReliability.updateOne` (gated)
- `AddressReliability.updateOne` (gated)
- (cache invalidation)

At the courier-webhook chokepoint, that's 7 writes per terminal
event. Acceptable today; a single Redis or Mongo blip during peak
becomes 7× more painful.

### 13.3 🟢 FraudSignal lookup path is cheap

Unique compound index on `(phoneHash, addressHash)` + single-axis
indexes; `estimatedDocumentCount` for warming-up is O(1). ✓

### 13.4 🟢 FraudPrediction TTL prevents unbounded growth

400-day TTL + outcome-based partial indexes for the tuner. ✓

### 13.5 🟢 Bulk upload avoids per-order velocity / IP queries

`collectRiskHistoryBatch` is two aggregations regardless of CSV size.
Right shape for that path. ✓

---

## 14. Recommended Scoring Philosophy

The product direction stated in the brief — "operational decision
support, not automated customer punishment" — already matches how the
**hard architecture** is laid out:

- No auto-cancel.
- Manual review is the terminal step.
- Scoring is deterministic and reproducible.
- The reliability layer is observation-only by design.
- Cross-merchant data is aggregated privacy-safely.

What does NOT match the philosophy is the **soft language and
confidence claims**:

- P(RTO) presented as a probability when it is a logistic of a weight
  sum (§7.3).
- Hard-block consequences pinned to 95% pRto regardless of cause (§4
  finding 4).
- "Risky" badge applied uniformly to brand-new merchants without
  uncertainty disclosure (§7.2).
- Tuned-weights story sold to merchants while the tuner is silently
  inert (§4.1).

The recommended philosophy:

1. **Calibration is a contract.** If we show P(RTO) = X%, the empirical
   RTO rate among orders with P(RTO) = X% should be approximately X%.
   Until that's measured per merchant, present scores as ordinal
   (Risky / Verify / Safe) rather than cardinal probabilities.
2. **Explainability beats accuracy.** A simpler signal a merchant
   trusts and can audit is operationally more valuable than a tuned
   signal they can't reason about. Keep the per-signal weight delta
   visible only when it's faithful to the math (it isn't right now —
   logistic + cap + hard-block are not linear).
3. **Hard-blocks are merchant policy, not platform risk.** Garbage
   phone, blocked phone, blocked address are policy. Frame them as
   "your block-list / data-quality rule fired", not as "high risk
   detected". Don't apply the `pRto >= 0.95` halo to them.
4. **Adaptive systems require validation.** A weight tuner that
   doesn't measure precision/recall against held-out data is a
   confidence theatre — and as §4.1 shows, can be silently broken
   for an extended period without anyone noticing.
5. **Cross-merchant signals are evidence, not verdict.** The +25
   bonus shape is conservative and good. Surface the data
   transparently to agents (already done) but do not let it influence
   the score until a falsification mechanism (merchant override,
   appeal flow) exists.
6. **Bangladesh-COD operations need data-quality channels separate
   from fraud channels.** "Missing district" is a data quality issue.
   Routing it through the fraud system trains operators to treat it
   as suspicious, which is the wrong instinct.

---

## 15. "Do NOT do" Recommendations

Concrete things to **avoid** in the upcoming redesign phase:

1. **Do NOT auto-cancel orders based on score, ever.** Even on hard-
   blocks — keep the merchant or agent as the decider.
2. **Do NOT layer ML / black-box scoring on top of the existing
   deterministic engine.** The current explainability is the moat;
   don't trade it for a small precision gain.
3. **Do NOT increase any single weight to single-signal-HIGH** unless
   the trigger is a *policy* signal (blocked_phone, blocked_address,
   garbage_phone). Behavioral signals should require combinations.
4. **Do NOT remove the `customerTier` Gold-bypass mechanism** when
   refactoring; it is the only thing that protects high-value repeat
   buyers from accumulating false positives.
5. **Do NOT extend `extreme_cod_in_suspicious_district` to additional
   combos** until missing-district is moved out of the suspicious set.
6. **Do NOT fire merchant alerts without per-(merchant, phone) dedup
   keys**. Alert fatigue is a worse failure mode than missing one.
7. **Do NOT consume the cross-merchant network bonus into `computeRisk`
   without a falsification path** (merchant-side override / appeal /
   transparency). Otherwise we regress to the "punished by other
   merchants' history" failure mode.
8. **Do NOT count cancellations identically with RTOs in the network
   signal.** Cancellation is often merchant-side (out of stock); RTO
   is buyer-side. Already correct in the tuner; not in the network
   bonus formula (which adds `min(5, cancelledCount)` directly).
9. **Do NOT lower the `MIN_OBSERVATIONS_FOR_SIGNAL` floor below 3** in
   the reliability classifier without re-running the false-positive
   analysis. Three is already aggressive in the BD COD seasonal
   pattern.
10. **Do NOT rely on tuned weights without writing precision/recall
    monitoring** for the weights themselves. A silent tuner regression
    must be impossible to ignore.
11. **Do NOT ship merchant-language strings that imply probability**
    ("we predict 73% of these will return") until calibration is
    measured and disclosed.
12. **Do NOT build new scoring writers without idempotency by orderId**
    if they live outside the `applyTrackingEvents` chokepoint.
    `contributeOutcome` and the reliability writers exist within that
    gate; new code outside it MUST dedupe.
13. **Do NOT add hard-block triggers without a corresponding
    "appeal / override" surface in the merchant UI.** Hard-blocks
    are a policy lever; merchants must own the policy.
14. **Do NOT expand the `suspiciousDistricts` defaults.** Move
    "missing district" out, keep the others minimal, let merchants
    grow their own list from real RTO patterns.

---

## 16. Recommended Implementation Priority Order

**This audit recommends the following order; the priorities below are
sequenced to fix correctness gaps before behavioral changes.**

### P0 — Correctness, no behavior change

1. **Fix the snake_case ↔ camelCase mismatch in adaptive weights**
   (§4.1). Either rewrite the tuner to emit camelCase keys, or
   teach `effectiveWeight` to normalize lookups, or canonicalize
   the signal-key namespace once. Add a regression test that a
   tuner-emitted override actually changes a `computeRisk` result.
2. **De-duplicate `contributeOutcome` and reliability writers by
   orderId** for status-correction events (§5.1). Either guard at
   the chokepoint with a "previous terminal" delta, or stamp the
   prediction row with the contributed outcome and refuse to
   re-contribute on flip.
3. **Add optimistic concurrency to the manual `rescoreOrder`
   mutation** (§4.3) to match the worker.
4. **Stop pinning `pRto >= 0.95` on policy-only hard-blocks** (§4
   finding 4 / §7.3). A blocked phone is policy, not predicted RTO.
5. **De-dup `fireFraudAlert` per (merchantId, phone, hour)** (§7.1).

### P1 — False-positive containment

6. **Remove "missing district" from the auto-hard-block COMBO**
   (§6.2). Surface it as a data-quality warning, not a fraud reason.
7. **Raise `velocity_breach` from a 75 single-signal HIGH to
   "60 + requires another signal"** (§6.1, §10.3) OR introduce a
   "wholesale buyer" / "saved-customer" exemption.
8. **Lower the `low_success_rate` minimum sample to ≥ 5 resolved
   orders** (§6.4) — three is too few for a 40% threshold to mean
   anything.
9. **Disambiguate `garbage_phone`'s "looks BD" branch** (§6.5) so
   foreign 11-digit numbers don't enter the canonical-required path.
10. **Raise `isFakeNamePattern`'s minimum length to 2** and only
    apply the heuristic to Latin tokens (§6.3).

### P2 — Trust + explainability

11. **Surface `customerTier === "new"` in the merchant UI** as
    "uncertain — not enough buyer history yet" (§7.2). Down-weight
    the visual confidence accordingly.
12. **Display `dynamicThresholds.source`** on the order detail and
    a settings page (§8.3).
13. **Visually separate hard-block reasons from accumulated reasons**
    (§7.4). Different icon, different copy ("policy match" vs.
    "behavioral signal").
14. **Stop claiming "Y RTOs prevented" in network observability**
    while the bonus is unconsumed (§4.2 / §11.5). Either consume it
    properly (§16 P3) or rename the counter.

### P3 — Cross-merchant network integration

15. **Decide explicitly: consume `lookupNetworkRisk.bonus` in
    `computeRisk` or remove the contribution path.** If consume,
    add: per-merchant override, agent-visible "network influenced
    this score by +X", appeal flow, falsification metrics. If
    remove, mark the network as observation-only and update copy.

### P4 — Tuner credibility

16. **Add precision/recall monitoring on the tuner output** (§11.4).
    Tuner cycle N's overrides must be backtested against held-out
    predictions before write. Auto-rollback on degradation.
17. **Raise the per-merchant minimum sample size for tuning
    multipliers from 50 to 200** to match the disclosed
    "statistical floor" comment in `merchant.ts:96`.

### P5 — Operational tooling

18. **Add a per-merchant scoring health dashboard** (HIGH rate,
    review-rejection rate vs. verify rate, hard-block rate by
    cause, weights version in effect, last tuner run, model
    calibration line).
19. **Move `extractThana`-derived signal into the reliability
    layer** as the proper proxy for delivery-zone risk (replacing
    the brittle district hack).

---

## 17. Final Architectural Recommendation

The overall architecture is **sound and aligned with the stated
product direction**: deterministic, replay-safe, additive,
observation-friendly, privacy-respecting cross-merchant data, no
auto-customer-punishment. The bones are right.

What is NOT right today:

- **A silently broken adaptive layer.** The per-merchant tuner has
  been writing keyed-wrong overrides since launch. Every merchant
  has been on platform defaults regardless of the
  `tuner-2026-04` / `tuner-2026-03` / … `weightsVersion` stamps on
  their fraud config. **This must be the first thing fixed**, with
  a regression test, before any further "tune" work is done.

- **A cross-merchant network that is harvested but not used.** The
  privacy posture is excellent; the integration is half-finished.
  The choice — consume it as a scored input, or restate it as an
  agent-only context lake — must be made explicitly. The current
  in-between is the worst of both worlds: data accumulates with no
  decision consequence, and observability claims a benefit that
  doesn't exist.

- **Hard-blocks that confuse policy with prediction.** A blocked
  phone is the merchant's policy, not the platform's risk model.
  Pinning P(RTO) ≥ 0.95 on a policy match conflates the two and
  trains merchants to mistrust the calibration when they
  inevitably notice it.

- **A merchant-language layer that overstates confidence.** "P(RTO)
  = 38%" is presented as a number we can defend; we cannot defend
  it without calibration measurement. Until then, ordinal
  classification (Safe / Verify / Risky) is the honest surface.

- **Bangladesh-COD-realism gaps that punish the merchant for
  upstream data quality.** Empty district, address-token collisions,
  CG-NAT IP velocity, B2B/wholesale buyers tripping velocity_breach,
  short Bangla names hitting fake-name regex. These are operational
  realities of the market the platform serves, and the engine
  should treat them as data-quality / context signals, not
  fraud signals.

### The recommendation

**Do not redesign the scoring engine.** The engine's shape is right.
Instead:

1. Run **P0 (correctness fixes) immediately.** None of them change
   merchant-visible behavior; they fix things that are quietly
   broken right now.
2. Run **P1 (false-positive containment) next**, gated behind a
   per-merchant flag with a 7-day shadow-mode where the new logic's
   would-fire vs. would-not-fire delta is logged but not enforced.
3. Resolve **P3 (network integration decision) explicitly** in a
   short product memo. Any answer (consume, remove, document as
   observation-only) is better than the current ambiguous state.
4. Treat **P4 (tuner credibility)** as a prerequisite for ever
   marketing "adaptive" or "self-tuning" externally. Until the
   tuner has a backtest, it is opt-in for staff merchants only.
5. Build **P5 observability** as the long-term operational moat.
   Per-merchant scoring health dashboards are how this becomes a
   product the merchant trusts in their daily workflow rather than a
   rule engine they tolerate.

The system should keep behaving like operational decision support.
After the P0/P1 work it will have the *language* and *math integrity*
to actually deserve that framing — today, in subtle ways, it
overstates what it knows.

---

*End of audit. No code has been changed. No behavior has been
modified. Recommended next step: review and prioritize §16 with the
team before any implementation begins.*
