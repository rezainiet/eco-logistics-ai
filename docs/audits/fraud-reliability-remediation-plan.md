# Fraud / Reliability — Remediation Execution Plan

**Date:** 2026-05-09
**Author:** Claude (claude-opus-4-7)
**Branch:** `claude/staging-deploy`
**Pairs with:** `docs/audits/fraud-reliability-system-critical-audit.md`
(2026-05-09)

This document is **planning only**. No code changes. Its purpose is to
sequence the audit findings into a defensible execution order that
preserves replay safety, idempotency, additive architecture, observability
integrity, and merchant trust — and to make eight specific design
decisions that the audit deliberately deferred.

The product direction is fixed: **ConfirmX remains operational decision
support — explainable, merchant-trust-first, Bangladesh-realistic.** This
plan is gated on that direction and will not propose anything that
reshapes the system into automated punishment, black-box AI, or hidden
scoring.

---

## 1. Executive Remediation Strategy

The audit surfaced 14 findings across critical / high / medium severity.
Three are **silent correctness bugs** invisible to merchants today; five
are **false-positive amplifiers** the merchant DOES feel; the rest are
trust / explainability / observability issues.

The strategy is conservative and additive:

1. **Fix what is silently wrong before changing anything merchants
   notice.** P0 work is invisible to merchants (tuner key-space,
   contribute dedup, manual rescore concurrency, alert dedup, network
   counter honesty). No behavior changes; tests change.
2. **Reduce false positives behind a shadow-mode flag.** P1 work
   measurably narrows what the engine flags. Each change ships in
   shadow mode for ≥ 7 days — would-fire counters logged, no
   merchant-visible effect — before enforcement.
3. **Decide policy questions explicitly.** Network consumption,
   missing-district handling, velocity redesign, terminology — each
   gets a short product memo (or this document, where stated below)
   before any code lands. We do not refactor without a decision.
4. **Preserve every existing replay / idempotency contract.** The
   tracking chokepoint is the dedup gate; nothing outside it gains
   write authority. The reconciler is the drift repair; nothing
   else mutates aggregates retroactively.
5. **Treat observability as a load-bearing surface.** Counters that
   currently overstate (e.g. `estimatedPreventedRto`) are corrected
   in P0, not silently retired. Merchants and operators must be able
   to verify that what we say is happening, is happening.

The plan ships across **three releases** corresponding to P0 / P1 / P2,
each behind a feature gate, each with rollback. Total wall-clock
estimate: 3–5 weeks of focused engineering, dominated by shadow-mode
soak time, not by code volume.

---

## 2. Severity Classification (P0 / P1 / P2)

Each finding is classified across **eight dimensions** so dependencies
are explicit. `H/M/L` = High / Medium / Low.

| # | Finding (audit ref) | Correctness | Replay/Idem. | Merchant-Trust | False-Pos. | Rollout | Observ. | Architect. | Op-Urgency | **Bucket** |
|---|---|---|---|---|---|---|---|---|---|---|
| F1 | Tuner key-space mismatch (§4.1) | **H** | L | M | L | L | M | L | **H** | **P0** |
| F2 | Network bonus unconsumed (§4.2) | **H** | L | M | L | M | **H** | M | M | **P0** |
| F3 | `contributeOutcome` double-count on flips (§5.1) | **H** | **H** | L | L | L | M | L | M | **P0** |
| F4 | Manual `rescoreOrder` lacks OCC (§4.3) | M | M | L | L | L | L | L | L | **P0** |
| F5 | `pRto ≥ 0.95` pinned on policy-only blocks (§4 #4 / §7.3) | M | L | **H** | L | L | M | L | M | **P0** |
| F6 | `fireFraudAlert` no per-(merchant, phone) dedup (§7.1) | L | L | **H** | L | L | M | L | **H** | **P0** |
| F7 | "Missing district" hard-block COMBO (§6.2) | L | L | **H** | **H** | M | L | M | **H** | **P1** |
| F8 | `velocity_breach` single-signal HIGH at default 3/10min (§6.1, §10.3) | L | L | M | **H** | M | L | L | M | **P1** |
| F9 | `low_success_rate` over 3-order sample (§6.4) | L | L | M | **H** | L | L | L | L | **P1** |
| F10 | `garbage_phone` "looks BD" branch foreign hits (§6.5) | L | L | M | M | L | L | L | L | **P1** |
| F11 | `isFakeNamePattern` length<3 too aggressive (§6.3) | L | L | L | M | L | L | L | L | **P1** |
| F12 | New-merchant uncertainty not surfaced (§7.2) | L | L | **H** | L | L | L | M | L | **P2** |
| F13 | `dynamicThresholds.source` not visible in UI (§8.3) | L | L | M | L | L | M | L | L | **P2** |
| F14 | Tuner has no precision/recall validation (§11.4) | M | L | L | M | M | M | M | L | **P2** |

**P0 = silent correctness or trust-erosion that must land before P1.**
**P1 = false-positive containment behind shadow-mode gates.**
**P2 = trust + explainability + governance maturity.**

---

## 3. Recommended Remediation Order

Execution order, with dependencies explicit:

### Release 1 — P0 (correctness, no merchant-visible behavior change)

1. **F1 — Tuner key-space fix.**
   *Recommended approach (§5.1 below):* canonicalize on the snake_case
   key namespace (the durable persistence shape that already exists in
   400 days of `FraudPrediction.signals[].key` history). Teach
   `effectiveWeight` to look up by the emitted signal key, not the
   `WEIGHTS` JS-property name. Add a regression test that a
   tuner-emitted override actually changes a `computeRisk` result.
   *Blocked by:* nothing.
   *Blocks:* F14 (tuner validation has no value if multipliers don't apply).

2. **F3 — Contribute / reliability writer dedup on status corrections.**
   *Recommended approach (§5.3):* gate `contributeOutcome` and the
   reliability writers on `FraudPrediction.outcome` being
   *unset-or-equal-to* the new outcome. A `delivered → rto`
   correction updates `FraudPrediction.outcome` but does NOT re-emit
   network / reliability writes. The reconciler remains the drift
   repair.
   *Blocked by:* nothing.
   *Blocks:* F2 (any decision to consume network bonus must rest on
   an honest signal lake).

3. **F4 — Manual `rescoreOrder` optimistic concurrency.**
   *Approach:* mirror the worker — `updateOrderWithVersion` with the
   loaded `version` field. Refuse stale-version writes and surface a
   409-style error; agents retry by reloading.
   *Blocked by:* nothing.

4. **F5 — Decouple policy-block confidence from `pRto`.**
   *Recommended approach (§5.4):* add `policyBlock?: { reason: string }`
   to `RiskResult`. Hard-block triggers (garbage / blocked phone /
   blocked address) populate `policyBlock` and DO NOT inflate `pRto`.
   `riskScore` floor at 85 is preserved (queue ranking unchanged).
   The merchant UI gains a "policy match" treatment distinct from
   probabilistic confidence.
   *Blocked by:* nothing.
   *Blocks:* P2 terminology rework (F12).

5. **F6 — `fireFraudAlert` dedup at (merchantId, phone, hour).**
   *Recommended approach (§5.7):* mirror the existing anomaly
   `alertDedupeKey` shape — one Notification per
   `(merchantId, phone, hour-bucket)` regardless of how many HIGH
   orders land. Existing dedupeKey on Notification table makes this
   a 5-line change.
   *Blocked by:* nothing.

6. **F2 decision (network consumption).**
   *Recommended decision (§5.2):* **advisory only — do NOT consume
   into score.** Surface to agents as labeled "cross-merchant context:
   +X toward Verify" with the underlying counts. Rename
   `estimatedPreventedRto` to `advisoryFlagsApplied`. Do NOT add
   `bonus` to `riskScore` anywhere. Preserves privacy posture, ends
   the silent half-integration, avoids the "punished by strangers"
   failure mode.
   *Blocked by:* F3 (contribute dedup must be correct first).

### Release 2 — P1 (false-positive containment, shadow-mode rollout)

7. **F7 — Move "missing district" out of the hard-block COMBO.**
   *Recommended approach (§5.5):* split into two paths.
   `suspicious_district` (named district matching the suspicious set)
   keeps current weight. Empty / un-normalized district emits a new
   `data_quality_warning` signal at weight 0 (informational). The
   `extreme_cod_in_suspicious_district` hard-block COMBO requires a
   *named* suspicious district, not a missing one.
   *Shadow-mode:* log "would-have-blocked" vs. actual for ≥ 7 days
   per merchant before enforcement.

8. **F8 — Velocity redesign.**
   *Recommended approach (§5.6):*
   - Lower `velocityBreach` weight from 75 to **60**, taking it out of
     single-signal-HIGH territory. A second signal is then required.
   - Bypass for `customerTier ∈ {silver, gold}` (already done), AND
     bypass when `phoneTotalRaw >= 5` even at standard tier (saved
     buyer exemption).
   - Allow a per-merchant `velocityChannelExemption` list — channels
     like `bulk_upload` / `dashboard` skip velocity entirely; `webhook`
     keeps it.
   *Shadow-mode:* same 7-day window.

9. **F9 — `low_success_rate` minimum sample.**
   Raise from `priorResolved >= 3` to `priorResolved >= 5`. Three is
   below sample-size meaning for a 40% threshold.

10. **F10 — `garbage_phone` foreign-number disambiguation.**
    Tighten the "looks BD" branch: require `digits.startsWith("880")`
    OR `(digits.length === 11 && digits.startsWith("01"))`. Drop the
    pure `length === 11` heuristic that catches 11-digit foreign
    numbers.

11. **F11 — `isFakeNamePattern` length floor.**
    Lower the absolute-length cutoff from `< 3` to `< 2`. Apply the
    vowelless check only to Latin-only single tokens (already gated).
    Two-character Bangla names pass.

### Release 3 — P2 (trust + governance maturity)

12. **F12 — Surface `customerTier === "new"` as uncertainty.**
    Merchant UI shows "uncertain — not enough buyer history yet" with
    visually de-emphasized score. Underlying score unchanged; only
    presentation.

13. **F13 — Display `dynamicThresholds.source`.**
    Order-detail surface gains a "Threshold: ৳4,500 (from your average
    order value)" line. Settings page gains a "thresholds in effect"
    panel.

14. **F14 — Tuner backtest + auto-rollback.**
    Tuner cycle N's overrides backtested on held-out predictions
    (e.g. last 14 days of resolved). Refuse to write multipliers that
    degrade per-signal precision below a floor. Log every decision.
    Raise per-merchant minimum sample from 50 to 200 to match the
    "statistical floor" comment in `merchant.ts:96`.

### Release 4 — P3 (deferred, decision-pending)

Merchant-language terminology adjustment (`P(RTO) = X%` → ordinal
labels) is deferred until calibration measurement (F14) ships and
runs for 30 days. Without measurement, ordinal language is a
downgrade of capability, not a calibration improvement.

---

## 4. Replay-Safety Considerations

The system's replay-safety contract is **the single most precious
property** of this codebase. Any remediation step must preserve:

- The tracking chokepoint (`applyTrackingEvents`) is the **only** writer
  authorized to fire downstream fan-out (FraudPrediction outcome,
  contributeOutcome, recordCourierOutcome, recordCustomer/AddressOutcome).
- Writers themselves do not dedupe — they trust the chokepoint.
- The chokepoint guards via `$nin newKeys` + status guard +
  `nextStatus !== prevStatus`.
- The reconciler is the only mechanism that retroactively touches
  aggregates, and only to repair drift between Order and aggregates.

**F3 (contribute dedup) requires the most care.** The recommended
approach (gate on `FraudPrediction.outcome` state) keeps the chokepoint
contract intact:

- The chokepoint still fires the fan-out exactly once per real
  terminal transition. ✓
- Each writer's first action is a `FraudPrediction.findOne({orderId})`
  to read the existing `outcome`. If `outcome === undefined`, write
  the new outcome AND emit downstream signals. If
  `outcome === newOutcome`, no-op silently (idempotent re-fire). If
  `outcome !== newOutcome` (correction), update `FraudPrediction.outcome`
  ONLY — do NOT re-emit downstream signals. The reconciler is then
  responsible for whatever drift this leaves.
- This is the **minimal-deviation** fix. It does NOT introduce new
  cross-collection coordination, does NOT introduce transactions, does
  NOT change the chokepoint contract, does NOT add new dedup state.

Alternatives we **reject**:

- ❌ Dedup at each writer with its own per-orderId log — adds N new
  pieces of dedup state to keep correct.
- ❌ Decrementing on correction (e.g. `delivered → rto`: subtract 1
  from `deliveredCount`, add 1 to `rtoCount`). The compensation logic
  is not commutative with concurrent updates and risks negative
  counters under contention.
- ❌ Treating corrections as "fresh" outcomes (status quo). Continues
  to over-count.

**F4 (manual rescore OCC)** is a strict refinement — adds a guard,
removes none.

**F1 (tuner key-space)** has zero replay implications — the tuner
writes per-merchant config; readers consume on the next score event.
The fix only changes what `effectiveWeight` returns from a static
lookup.

**F2 (network advisory)** has zero replay implications — we are
*removing* a non-existent integration, not adding one.

**Net replay risk of P0 work: low.** Each finding either preserves the
chokepoint contract or operates entirely outside it.

---

## 5. Specific Decisions Required (the 8 from the brief)

### 5.1 Adaptive tuner key-space fix — DECIDE: snake_case canonicalization

The two key-spaces in conflict are:

- **snake_case** — `FraudPrediction.signals[].key` ("high_cod",
  "extreme_cod", …). Persisted with 400-day TTL. Surfaced in the
  merchant UI. Stable across releases.
- **camelCase** — `WEIGHTS` JS-property names ("highCod", …). A
  language-level convenience, never persisted, never user-facing.

**Decision: canonicalize on snake_case.** The persisted format is
the durable contract. Adapting `effectiveWeight` to lookup by the
emitted signal key is a 5-line change. The alternatives — rewriting
historical FraudPrediction docs, or rewriting the `WEIGHTS` object —
both touch more surface and risk more.

Implementation note: `risk.ts` should expose a stable mapping
`SIGNAL_KEYS_BY_WEIGHT_KEY` (or vice-versa) and use it everywhere.
A regression test must assert that a tuner-emitted override (e.g.
`{"high_cod": 1.2}`) actually multiplies the high_cod weight when
the signal fires.

### 5.2 Cross-merchant network bonus — DECIDE: advisory, do not consume into score

The audit (§4.2) showed `lookupNetworkRisk.bonus` is computed but never
fed into `riskScore`. Three options:

| Option | Effect |
|---|---|
| **A. Consume into score** | Adds up to +25 from cross-merchant data into a merchant's view of their buyer. Privacy-safe (hashed) but introduces "punished by strangers" failure mode without an appeal/override mechanism. |
| **B. Advisory** | Surface to agents as labeled context. No score effect. Preserves the privacy posture, the data lake, and the trust posture. |
| **C. Remove** | Tear out the contribution + lookup paths. Loses the data lake's future option value. |

**Decision: B — advisory only.** Consume the bonus into the agent UI
as `network_advisory: { bonus, merchantCount, rtoRate, deliveredCount,
rtoCount, matchedOn }`. Display copy: "Cross-merchant context:
2 other merchants saw 3 returns from this customer." Do NOT add
`bonus` to `riskScore`. Rename observability counter
`estimatedPreventedRto` → `advisoryFlagsApplied` to stop overstating.
Document the choice in the network module header.

This decision is **revisitable** only after:
1. A merchant-side appeal mechanism exists.
2. The signal lake's per-merchant-contribution skew is measured (one
   dominant merchant must not be able to define another's risk).
3. Calibration measurement (F14) is shipping.

### 5.3 Outcome dedup strategy — DECIDE: gate downstream emit on FraudPrediction.outcome

**Decision:** see §4 above. `FraudPrediction.outcome` is the
single-source-of-truth for "have we already emitted downstream signals
for this order's terminal outcome?" State machine:

- `undefined` → emit downstream + set outcome (first terminal).
- `=== newOutcome` → no-op (replay).
- `!== newOutcome` → update outcome only, do NOT re-emit.

The reconciler retains responsibility for repairing aggregate drift
when corrections leave the network/reliability lakes ahead of (or
behind) the Order ground truth. Add a `correctionCount` field to
FraudPrediction so we can observe how often corrections happen
without reading audit logs.

### 5.4 Policy-block vs probabilistic-confidence separation — DECIDE: split the result type

**Decision:** add to `RiskResult`:

```ts
policyBlock?: {
  cause: "garbage_phone" | "blocked_phone" | "blocked_address" |
         "extreme_cod_in_suspicious_district";
  detail: string;
};
```

When `policyBlock` is set:
- `riskScore` floor at 85 preserved (queue ranking unchanged).
- `pRto` is **NOT** clamped to ≥ 0.95. It remains whatever the
  weight-sum logistic produces, often genuinely lower for a
  policy-blocked order with otherwise clean signals.
- `confidenceLabel` becomes `"Policy"` (new) instead of `"Risky"`
  for the policy-block case.
- Merchant UI shows a distinct policy chip + reason: "Phone is on
  your blocklist" — unambiguously merchant-policy, not platform-risk.

`hardBlocked: boolean` stays for queue compatibility but becomes
derived from `policyBlock !== undefined`.

This is the structural fix that lets P2 terminology work (§5.8) be
honest without breaking compatibility.

### 5.5 Missing-district handling — DECIDE: data_quality channel

**Decision:** introduce a new signal class.

```
suspicious_district  — district present AND in named-suspicious set.
                       Same weight, same hard-block COMBO eligibility.
data_quality_warning — district missing/empty. Weight 0. Informational.
                       NOT eligible for any hard-block COMBO.
```

`extreme_cod_in_suspicious_district` requires `suspicious_district`
specifically — never `data_quality_warning`. Empty district contributes
no risk score, surfaces in merchant UI as "Address looks incomplete —
please confirm with the customer", linked to the existing
`address.quality` infrastructure (which is already populated by
`computeAddressQuality`).

Side benefit: the `address_quality_warning` signal in the Delivery
Reliability layer (`delivery-reliability.ts:454`) becomes the natural
merge target for this — both express the same operational concern.

### 5.6 Velocity signal redesign — DECIDE: weight reduction + saved-buyer bypass + channel exemption

**Decision (§3 Release 2 #8):**

- Weight 75 → **60** (medium-band; needs another signal to HIGH).
- Existing Gold/Silver bypass preserved.
- New: `phoneTotalRaw >= 5` saved-buyer bypass (regardless of tier).
- New: per-merchant `velocityChannelExemption: ("bulk_upload" |
  "dashboard" | "api")[]` defaulting to `["bulk_upload"]`. Webhook
  channel keeps velocity always (most fraud arrives via webhooks
  on Shopify spam).
- Per-merchant kill remains via `velocityThreshold = -1`.

The B2B/wholesale story now has three escape hatches: tier, raw count,
or merchant-explicit channel exemption. The CSV legitimate-orders
story is fully covered by `bulk_upload` exemption (which also already
skips real-time velocity in the batch helper today — making the
exemption explicit aligns code with reality).

### 5.7 Fraud-alert dedup architecture — DECIDE: per-(merchant, phone, hour) Notification dedupeKey

**Decision:** the `Notification` collection already supports
`dedupeKey`. `fireFraudAlert` should compose:

```
dedupeKey = `fraud-high:${merchantId}:${phone}:${hourBucket}`
```

`hourBucket = Math.floor(Date.now() / (60*60*1000))`. Mirror the
anomaly detector's hour-snap. Five flagged orders for the same buyer
in 12 minutes = one alert. The alert body itself can mention "5
orders" via a `$inc` of a counter field on the Notification, but
delivery happens once.

Edge case: a merchant who *wants* per-order alerts (e.g. a careful
ops desk) can opt out via merchant config. Default is dedup-on.

### 5.8 Merchant-facing terminology — DECIDE: keep ordinal in P0/P1, defer cardinal change to post-calibration

**Decision:** ship the `policyBlock` separation (F5) and the
`customerTier === "new"` uncertainty surfacing (F12) in P0/P2. Do
NOT change "P(RTO) = X%" to ordinal language until F14 (tuner
backtest + calibration measurement) is running for 30 days.

Rationale: today's P(RTO) is a logistic, not measured calibration.
Replacing it with "Verify recommended" is more honest *if* we leave
the cardinal number out — but operators have learned to read the
percentage as ranking signal. Removing it without a replacement
ranking signal is a UX downgrade. The right sequence is: measure
calibration → if it's actually within tolerance, keep the cardinal
with a confidence band; if not, replace it with ordinal language and
explain why.

In the interim, merchant UI gains a tooltip on the P(RTO) line:
"Calibration in progress — treat as relative ranking, not absolute
probability."

---

## 6. Bangladesh-Operational Considerations

Every P1 change must defend the BD-realistic posture stated in the
product direction. Concretely:

- **F7 (missing district)** is the most BD-load-bearing fix. Empty
  / un-normalized districts are the single largest data-quality
  source in the merchant base; treating them as fraud trains agents
  to over-reject and erodes merchant trust at exactly the
  storefronts where it matters most (small merchants, Bangla-only
  storefronts, partial-data integrations).
- **F11 (fake-name length<3)** disproportionately hits Bangla
  storefronts where two-character names exist.
- **F8 (velocity)** disproportionately hits CG-NAT-served buyers and
  B2B merchants.
- **F10 (garbage_phone)** ensures we don't over-reject legitimate
  foreign numbers (NRBs, business buyers, expats), which is a
  realistic BD merchant scenario.

We should explicitly **not** make signal thresholds stricter as part
of this remediation. The audit found over-firing, not under-firing.

Decay half-life adjustments for seasonal patterns (Eid clusters,
end-of-month bursts, audit §9.4) are **out of scope** for this
remediation and should be a separate decision after F14 calibration
measurement reveals whether the 30-day default is producing observable
drift.

---

## 7. False-Positive Reduction Strategy

Ordering matters for FP work. We do **not** ship multiple FP changes
in parallel — too easy to lose causality on the metric.

### Shadow-mode pattern (mandatory for every P1 change)

For ≥ 7 days per merchant before enforcement:

1. New logic computes `would_fire` independently of current logic.
2. Both fire/don't-fire decisions logged to a structured log line:
   `{ change: "F7-missing-district", current: "blocked", proposed: "allowed", merchantId, riskScore_current, riskScore_proposed, …}`.
3. Ops dashboards aggregate `agreement_rate`, `loosened_rate`,
   `tightened_rate` (always 0 expected for FP work) per merchant.
4. Enforcement flips the gate; logs continue for ≥ 30 days post-
   enforcement to catch slow regressions.

Per-merchant rollout: staff merchants → 5% canary → 25% → 100%.
Standard rollout-safety pattern, mirrors the existing
`DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS` allowlist.

### Per-finding FP measurement target

| Finding | Hypothesized FP-rate-reduction baseline | Measurement |
|---|---|---|
| F7 | -40% on extreme_cod orders with missing district | Agents' verify-rate on those orders pre-vs-post. |
| F8 | -30% on velocity-only HIGH orders for repeat buyers | `(verify_rate - reject_rate)` on velocity-only HIGH. |
| F9 | -25% on `low_success_rate`-fired orders | Verify-rate on first-trigger orders. |
| F10 | Foreign-number garbage_phone counts → ~0 | Counter over time. |
| F11 | Zero false-positives on 2-character Bangla names | Manual review sample. |

We treat shadow-mode signal as advisory until ≥ 100 events accumulate
per merchant per change.

### What the FP-reduction strategy will NOT do

- It will not introduce ML / learned classifiers as a "smarter" filter
  on top of the deterministic engine. Black-box atop white-box loses
  the explainability moat.
- It will not add new auto-dismissal logic ("if low_success_rate but
  network is clean, suppress"). We narrow the firing condition,
  not introduce silent dismissal.
- It will not silently raise weight thresholds across the board.
  Surgical per-signal narrowing only.

---

## 8. Observability-Preservation Strategy

Today's observability surfaces:

- `recordNetworkOutcome` (`fraud-network.ts`)
- `recordReliabilityOutcome` (`delivery-reliability.ts`)
- `runAnomalyDetection` (`anomaly.ts`)
- BullMQ + DLQ replay sweeper (operational)

Every remediation change ADDS to observability; never SUBTRACTS.

### Required additions per release

- **Release 1 (P0):**
  - F1: emit `tuner.override_applied { merchantId, signalKey, multiplier, baseline, effective }` on every score where an override fires. Lets ops verify the fix immediately.
  - F2: rename `estimatedPreventedRto` → `advisoryFlagsApplied`. Counter unchanged in shape; meaning matches reality.
  - F3: emit `outcome.dedup_skipped { orderId, existingOutcome, attemptedOutcome }` when contribute is short-circuited. Lets ops measure correction frequency without reading audit logs.
  - F5: emit `policy_block { merchantId, cause }` separate from existing high-risk emit.
  - F6: emit `fraud_alert.deduped { merchantId, phoneHash, hourBucket }` so we can see how many alerts the new dedup is suppressing.

- **Release 2 (P1):**
  - F7–F11: each emits a `would_fire_change` line in shadow-mode (see §7).

- **Release 3 (P2):**
  - F12, F13: instrumentation in `fraud-review` page (client-side analytics) on tooltip-hover and tier-uncertainty-shown.
  - F14: tuner backtest results emitted as structured logs per merchant per cycle.

### What we MUST NOT do to observability

- ❌ Remove existing counters even when they're wrong. Rename + redefine, or add alongside, never silently drop.
- ❌ Change log line shapes for existing `evt:` keys without a deprecation cycle (downstream alert rules and dashboards key on shape).
- ❌ Move counters from in-process to Mongo "for permanence" — the per-process snapshot is intentional and matches courier-webhook observability.

The end state: ops can read `adminFraudNetworkRouter.getStats` and
trust every number — including, for the first time, the reasoning
counters (F1, F3) and the corrected `advisoryFlagsApplied` (F2).

---

## 9. Recommended Scoring Philosophy Adjustments

Rather than redesigning, we **codify** the philosophy that the audit
found the architecture already implicitly follows:

1. **Policy ≠ Prediction.** `policyBlock` (merchant-curated rules,
   structural validity) is structurally separated from `pRto`
   (predictive estimate). Already present in the architecture's
   intent (`hardBlocked: true`); we are making it explicit (§5.4).

2. **Calibration is a contract.** P(RTO) percentages remain in the
   merchant UI for now, with a "calibration in progress" tooltip
   (§5.8). Removed only after F14 measurement reveals what's true.
   This is honest: today's number is a logistic mapping of a weight
   sum; we should not pretend otherwise.

3. **Cross-merchant data is evidence, not verdict.** Decision §5.2
   makes this concrete: network is advisory, never adds to score
   without per-merchant override + appeal mechanism + skew metrics.

4. **Behavioral signals require combinations; policy signals stand
   alone.** Codified in F8 (velocity weight 75 → 60). The only
   single-signal HIGH triggers are policy ones (blocked phone /
   address, garbage phone), and those get the `policyBlock` framing
   so the merchant knows.

5. **Data quality is its own channel.** F7 introduces
   `data_quality_warning` (weight 0) so a missing district is no
   longer entangled with fraud signaling.

6. **Adaptive systems require validation.** F14 codifies the rule
   that the tuner is opt-in for merchants until backtest is green,
   and self-rolls-back on degradation.

7. **Idempotency is the non-negotiable property.** F3's dedup
   strategy (§5.3) chooses the option that preserves the chokepoint
   contract over the option that compensates after the fact, even
   though compensation would yield more-accurate aggregate counts.
   We choose preservation over precision.

These adjustments are **descriptive, not redirective.** The
architecture already implies them; the remediation makes them
explicit and self-enforcing.

---

## 10. Recommended Automation Boundaries

Reaffirmed and made explicit:

| Action | Automated? | Notes |
|---|---|---|
| Cancel an order based on score | **NO** | Hard-blocks force review, never cancel. |
| Mark an order as fraud-rejected | **NO** | Always merchant or agent action. |
| Block a phone / address platform-wide | **NO** | Blocklists are per-merchant, merchant-curated. |
| Contribute outcome to cross-merchant network | YES | After §5.3 dedup. |
| Recompute open orders' scores on signal change | YES | Already via `enqueueRescore`. |
| Apply tuned weight multipliers | YES | After §5.1 fix + §5.8 backtest gate. |
| Send merchant alerts on HIGH | YES | After §5.7 dedup. |
| Auto-route to call queue (`pending_call`) | YES | Existing behavior, unchanged. |
| Stamp `data_quality_warning` | YES | After §5.5, observation-only. |
| Rewrite past `FraudPrediction.outcome` on correction | YES | Already correct (idempotent `$set`). |
| Decrement past aggregate counts on correction | **NO** | Drift repair is the reconciler's job, not the writer's. |

The list is short on purpose. Every "YES" already exists or is a
strict refinement. No new automation classes are introduced by this
remediation.

---

## 11. Rollout Strategy Recommendations

### Per-release gating

| Release | Flag | Default | Allowlist |
|---|---|---|---|
| R1 (P0) | none — corrections only | enabled on merge | n/a |
| R2 (P1) | `FRAUD_FP_REDUCTION_*` per finding | shadow mode (off) | staff → 5% → 25% → 100% |
| R3 (P2) | `FRAUD_TUNER_BACKTEST_ENABLED`, UI flags via existing pattern | shadow → opt-in → on | staff → all |

R1 ships behind code review only — no flag — because each fix is
either invisible (F1, F4) or strictly reduces unintended behavior
(F3, F5, F6) or is a counter rename (F2). A bug in any P0 ships fast
to revert without touching merchants.

R2 ships behind explicit per-finding flags. Shadow-mode for ≥ 7 days
per merchant cohort. Promotion criteria: agreement_rate stable,
no merchant-reported false-positive *increases*, no new HIGH-rate
spike on the affected merchants.

R3 ships UI changes behind component flags so they can be reverted
without a redeploy.

### Cohort sequencing

1. **Staff merchants** (any internal test merchants on the
   `DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS` allowlist or its analog).
   Catches obvious regressions in 24h.
2. **5% canary** — randomly selected stable merchants with ≥ 30 days
   of resolved orders. Measures FP-rate change at production scale.
3. **25%** — broader cohort to cover BD-market diversity (Bangla-
   storefront mix, vertical mix, ticket-size mix).
4. **100%** — only after each cohort meets promotion criteria.

### Rollback playbook (per release)

- R1: revert PR, redeploy. No data migration needed for any P0 fix
  except F2 (counter rename) — the old `estimatedPreventedRto`
  reading from the snapshot remains zero-valued.
- R2: per-finding flag flip to OFF re-enables current behavior
  immediately. No data migration needed.
- R3: UI flags flip to OFF. Underlying score data unchanged.

### Pre-launch verification gates

Each release gate requires:

1. ✅ All existing tests pass.
2. ✅ New regression tests for the specific finding.
3. ✅ Shadow-mode soak completed (R2/R3 only).
4. ✅ Observability counters confirm expected behavior delta.
5. ✅ Manual review with a sample of pre-merge / post-merge scoring
   diffs for ≥ 10 merchants.

---

## 12. "Do NOT Implement" List for the Remediation

These are temptations to actively avoid during execution. They
either re-open settled audit decisions, or expand scope beyond
remediation.

1. **Do NOT introduce ML / learned models** as part of this
   remediation. The audit philosophy (and decision §5.2) is that
   explainability is the moat.
2. **Do NOT consume `lookupNetworkRisk.bonus` into `riskScore`.**
   Decision §5.2 is explicit. Revisitable, but not in this work.
3. **Do NOT rewrite `WEIGHTS` keys to snake_case**. Decision §5.1 is
   to canonicalize at the lookup boundary, not in the code style.
4. **Do NOT decrement aggregate counts on outcome corrections.**
   Decision §5.3. Compensation logic is non-commutative under
   contention.
5. **Do NOT migrate `FraudPrediction.signals[]` to add `detail`.**
   Tuner doesn't need it; the migration cost outweighs the future
   option value at this stage.
6. **Do NOT remove existing observability counters** even when they
   overstate. Rename + redefine (F2). Downstream dashboards key on
   shape.
7. **Do NOT replace `pRto` with ordinal language yet.** Decision
   §5.8. Premature without F14 calibration measurement.
8. **Do NOT extend the hard-block COMBO** during P1 work. F7
   removes one COMBO trigger; resist the urge to add new ones until
   the FP rate of the existing COMBO is measured post-fix.
9. **Do NOT allow the tuner to run with the snake_case fix until F14
   backtest gate is built.** Tuner write authority is paused until
   we can falsify a regression.
10. **Do NOT introduce new auto-decision paths.** §10 list is closed
    for this remediation. New automation requires a separate product
    decision.
11. **Do NOT raise any signal weight as part of FP reduction.** §7.
    Surgical narrowing only.
12. **Do NOT change the chokepoint contract.** F3 dedup gates at the
    writer's read of `FraudPrediction`, not at the chokepoint. The
    chokepoint stays simple.
13. **Do NOT add merchant-facing copy claims** ("we use AI", "machine
    learning") that contradict the explainability stance. The
    deterministic engine is the brand.
14. **Do NOT reorder the P-buckets** without surfacing the dependency
    graph to product. F2 depends on F3; F14 depends on F1. Skipping
    a bucket under deadline pressure produces silent regressions.

---

## 13. Final Architectural Recommendation

**Execute this plan as written, in order, behind the gates described.**

The architecture is correct. The remediation:

- Closes 14 audit findings.
- Introduces zero new automation classes.
- Preserves every replay / idempotency / additive contract.
- Preserves every existing observability surface.
- Aligns merchant-facing language with what the math actually
  supports (after F14, with calibration; before F14, with
  honest disclosure).
- Costs ≈ 3–5 weeks of engineering, dominated by shadow-mode soak
  time, not code volume.

The deepest finding (F1, the silently-broken tuner) is the
**single most important fix**. It is invisible to merchants today,
and any future "we tune your weights monthly" claim depends on it
being correct. It must land before F14 (tuner validation) becomes
meaningful.

The most consequential design decision (§5.2, network advisory) is
the single best opportunity to articulate the product philosophy
clearly: ConfirmX uses cross-merchant data to *inform* an agent's
review, never to *decide* against a buyer the merchant has never
seen.

The remediation respects the audit's caution that ConfirmX should
be "operational decision support, not automated customer punishment"
— and the work it sequences makes that distinction explicit in the
code, the data, and the merchant UI.

**The plan does not propose a redesign.** It proposes the smallest
set of additive changes that bring the merchant-visible behavior
and the merchant-language layer into alignment with the
architecture's existing intent.

Recommended next step: review §5 (the eight specific decisions) with
the team, confirm or revise each in writing, then begin Release 1
(P0) implementation.

---

*End of remediation plan. No code has been changed. No behavior has
been modified. Recommended next action: explicit team sign-off on
§5 decisions, then proceed to Release 1.*
