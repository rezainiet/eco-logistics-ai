# Reconciliation Window Race — Investigation Report

**Branch:** `claude/staging-deploy`
**Generated:** 2026-05-08
**Scope:** root-cause investigation into the 9 hardening-test failures
documented in `s10-finalization-verification-report.md §3`. **No code
changes** were made during this investigation.
**Companion docs:**
- `final-delivery-reliability-status-report.md` — pre-merge audit
- `s10-finalization-verification-report.md` — finalization patch verification
- `delivery-reliability-implementation-blueprint.md` §3.2.2 — phase-2 merge semantics
- `deep-scoring-audit.md` §6.2 — chokepoint stale-snapshot caveat

---

## 0. TL;DR

The 9 hardening-test failures stem from a **deterministic ~microsecond clock-skew race between two distinct `new Date()` calls inside `applyTrackingEvents`**: one stamps `Order.logistics.deliveredAt`, the other stamps the aggregate's `firstOutcomeAt`. Because the helper's `new Date()` runs strictly **after** the chokepoint's, `firstOutcomeAt > deliveredAt` for the first ever flip per `(merchant, key)` aggregate. The reconciler's strict `<` window filter then excludes that single Order from the recomputed expected count.

**The race is bounded, deterministic, self-bounded, and operationally invisible:**

- **Bounded at exactly 1 per `(merchant, key)` aggregate, forever.** Cannot accumulate further from this race.
- **Within `DRIFT_TOLERANCE=2` by design** — repair refuses to mutate.
- **Aggregate counter remains correct (truth-of-record).** Reconciler is biased by 1; aggregate is not.
- **`drift_detected` counter stays at 0** in healthy production paths because per-key drift is always ≤ tolerance.

**Recommendation: PATCH WRITE ORDERING (one-line, deterministic fix) with PATCH TESTS ONLY as the conservative fallback.** The race itself is architecturally acceptable; the recommended fix simply propagates the chokepoint's `new Date()` into the helper's `now` parameter so the two timestamps are equal by construction. No reconciler-window change. No `DRIFT_TOLERANCE` change. No `STATUS_MAP` / replay-guard change.

The race **cannot realistically exceed `DRIFT_TOLERANCE` under production concurrency** (analysis in §5). No production-risk STOP-immediately condition was found.

---

## 1. Failing assertions (precise inventory)

| # | File:line | Assertion | Expected | Observed | Race contribution |
|---|---|---|---|---|---|
| 1 | `delivery-reliability-hardening.test.ts:201` | `entry.expected.delivered` | 3 | 2 | -1 |
| 2 | `delivery-reliability-hardening.test.ts:220` | `result.entries[0]?.driftMagnitude > DRIFT_TOLERANCE` | true | 8 (true via tampering) — passes the inequality but the upstream `expected.delivered` is 9 not 10, which propagates to subsequent asserts in the same describe-block | -1 |
| 3 | `delivery-reliability-hardening.test.ts:283` | `result.entries[0]?.expected.delivered` | 2 | 1 | -1 |
| 4 | `delivery-reliability-hardening.test.ts:417` (`proposed.deliveredCount`) | 10 | 9 | -1 | |
| 5 | `delivery-reliability-hardening.test.ts:505` (`after.deliveredCount` after apply) | 10 | 9 | -1 | |
| 6 | `delivery-reliability-hardening.test.ts:553` (address axis after apply) | 10 | 9 | -1 | |
| 7 | `delivery-reliability-hardening.test.ts:578` (`result.action.kind`) | `"failed"` | `"noop"` (because reconciler's expected=9 lands the proposed within tolerance of the spy-mocked write, masking the failure) | -1 | |
| 8 | `delivery-reliability-hardening.test.ts:649` (`slice.capped`) | 2 | varies — relies on three drifted keys exceeding tolerance, but each picks up the -1 race | -1 per key | |
| 9 | `delivery-reliability-hardening.test.ts:672` (`after.deliveredCount` after slice apply) | 10 | 9 | -1 | |

Every failure is the same -1 off-by-one, surfacing in different assertion shapes.

---

## 2. Root-cause timeline diagram

The race lives entirely inside `apps/api/src/server/tracking.ts:applyTrackingEvents`. Two `new Date()` calls happen in two different code paths against two different documents.

```
                     ┌───────────────────────────────────────────────────────────┐
                     │  applyTrackingEvents — ONE in-process invocation          │
                     └───────────────────────────────────────────────────────────┘

T₁ │ ▼ chokepoint:  set["logistics.deliveredAt"] = options.deliveredAt ?? new Date();
   │                (tracking.ts:125)
   │
   │   [synchronous JS continues — building filter, $set, $push]
   │
T₂ │ ▼ chokepoint:  await Order.updateOne(filter, { $set: { ..., deliveredAt: T₁ }, $push: ... })
   │                Mongo applies $set with deliveredAt = T₁ (the value from step 1).
   │                Resolves at T₂ > T₁.
   │
   │   [synchronous JS continues — FraudPrediction stamp, Order.findById,
   │    contributeOutcome, recordCourierOutcome — all "void X(...).catch(...)"]
   │
T₃ │ ▼ chokepoint:  void recordCustomerOutcome({
   │                  merchantId,
   │                  phoneHash,
   │                  outcome,
   │                  district,
   │                  orderId,
   │                  // NOTE: no `now` field — see tracking.ts:307–313
   │                })
   │
T₄ │ ▼ helper:     const now = normalizeNow(input.now);
   │                (delivery-reliability-writers.ts:142)
   │                input.now is undefined → returns new Date() at T₄.
   │                T₄ > T₃ > T₂ > T₁ — strict ordering by JS event-loop semantics.
   │
T₅ │ ▼ helper:     await CustomerReliability.updateOne(filter, {
   │                  $setOnInsert: { ..., firstOutcomeAt: T₄ },  ◄── this is what lands
   │                  $max: { lastOutcomeAt: T₄ },
   │                  $inc: { deliveredCount: 1 },
   │                }, { upsert: true });
   │                On INSERT: row.firstOutcomeAt = T₄.
   │                Resolves at T₅.

POST-WRITE INVARIANT (for the FIRST flip on any `(merchant, key)`):
   Order.logistics.deliveredAt = T₁
   CustomerReliability.firstOutcomeAt = T₄
   T₄ > T₁  (strictly)
```

### Reconciler window filter

```
  // delivery-reliability-reconciliation.ts:353-354
  if (terminalMs > now.getTime()) continue;
  if (terminalMs < unionWindowStart.getTime()) continue;   ◄── strict <

  // delivery-reliability-reconciliation.ts:378
  if (obs.terminalMs < windowStart.getTime()) continue;     ◄── strict <
```

`unionWindowStart` = `min(firstOutcomeAt across selected aggregates)` = T₄ (for a fresh single-key aggregate). The first iteration's Order has `terminalMs = T₁ < T₄` — **excluded**.

Second iteration onward: `Order_n.deliveredAt = T₁_n > T₄ = firstOutcomeAt` (because helper of iteration 1 has long since landed by the time iteration 2's chokepoint runs `set["logistics.deliveredAt"] = new Date()`). So they pass the filter — **included**.

---

## 3. Why the tests fail at 9 vs 10

```
For a tight loop:  for (let i = 0; i < 10; i++) await seedDeliveredOrder(merchantId);

Iteration 1: Order₁.deliveredAt = T₁₁     │ Helper INSERT: firstOutcomeAt = T₄₁
Iteration 2: Order₂.deliveredAt = T₁₂     │ Helper UPSERT: $max(lastOutcomeAt, T₄₂)
                                          │ firstOutcomeAt UNCHANGED — $setOnInsert was a no-op
Iteration 3: Order₃.deliveredAt = T₁₃     │ ...
...
Iteration 10: Order₁₀.deliveredAt = T₁,₁₀ │ ...

Mongo state after the loop:
  Aggregate row:  deliveredCount = 10, firstOutcomeAt = T₄₁
  Order rows:     deliveredAt ∈ {T₁₁, T₁₂, T₁₃, ..., T₁,₁₀}
  Where:          T₁₁ < T₄₁ < T₁₂ < T₄₂ < T₁₃ < ... < T₁,₁₀

Reconciler:
  windowStart = T₄₁
  Pass:  T₁₁ < T₄₁ → DROP
         T₁₂ ≥ T₄₁ → KEEP
         T₁₃ ≥ T₄₁ → KEEP
         ...
         T₁,₁₀ ≥ T₄₁ → KEEP
  Expected.delivered = 9
  Aggregate.delivered = 10
  drift = 9 - 10 = -1
  driftMagnitude = 1
```

The hardening tests assert `expected.delivered === 10`. This **was always going to be 9** under the current chokepoint write ordering. The tests were written assuming the chokepoint and the helper share a clock.

---

## 4. Drift bounding analysis

### 4.1 Per-key drift is bounded at 1, permanently

For every `(merchant, key)` aggregate row, **exactly one** Order observation falls below `firstOutcomeAt` — the one whose terminal flip created the row. All subsequent terminal flips on the same key happen with `Order.deliveredAt > firstOutcomeAt` because the helper's `new Date()` for iteration 1 has long since resolved by the time iteration 2's chokepoint is constructing its `$set`.

After 1, 100, or 100,000 subsequent flips, the per-key drift remains exactly **−1**. Magnitude = 1. Bounded.

### 4.2 Drift cannot accumulate from this race

There is no mechanism by which a second observation could fall below `firstOutcomeAt`:

- `firstOutcomeAt` is set ONCE via `$setOnInsert` (Mongo guarantees: applies only on the upsert that creates the document). Subsequent calls do NOT re-stamp it.
- Subsequent `Order.deliveredAt` values are computed in JS at iterations strictly later in event-loop time than iteration 1's helper completion.

Therefore: **drift contribution from THIS race is exactly 1, forever.**

### 4.3 Combined with the §6.2 caveat

The deep-audit §6.2 caveat: under stale in-memory `lean` snapshots, two callers can both pass the `nextStatus !== prevStatus` gate using the stale `prev`, and both fire the fan-out for the same Order. Each over-fire adds +1 to the aggregate; the reconciler still counts the Order once. Net effect on a single-key drift:

```
  drift_total = -1 (clock-skew race for first ever flip)
              + (k - 1) (§6.2 over-fires, where k is the number of helper invocations
                         for orders mapping to this key — k=1 = no over-fire)
```

| §6.2 over-fires `k` | aggregate.delivered | expected.delivered | drift | magnitude | within tolerance? |
|---|---|---|---|---|---|
| 0 (first flip) | 1 | 0 | -1 | 1 | ✅ |
| 0 (subsequent flips) | N | N-1 | -1 | 1 | ✅ |
| 1 (single §6.2 incident) | N+1 | N-1 | -2 | 2 | ✅ at-tolerance |
| 2 §6.2 incidents | N+2 | N-1 | -3 | 3 | ❌ exceeds |
| ≥3 §6.2 incidents | … | … | ≥-4 | ≥4 | ❌ exceeds |

The clock-skew race **alone** never breaches tolerance. Combined with §6.2:

- **k=1 (one §6.2 incident on the key):** still within tolerance — no defect surfaced.
- **k=2:** exceeds tolerance by exactly 1 — `driftMagnitude=3`, repair would fire. But k=2 (two stale-snapshot races on the SAME buyer) is a sustained webhook re-fetch regression, not a normal operating condition. The runbook §4 explicitly tells operators to investigate `invalidTransition` spikes.

**Operationally, the clock-skew race contributes 1 to the §6.2 budget. It does not, on its own, cause drift to exceed tolerance.**

### 4.4 Aggregate counter remains the truth-of-record

Critically: the **aggregate counter is correct** in all paths:

- Each successful chokepoint terminal flip increments the aggregate exactly once via `$inc`.
- The aggregate IS the source-of-record for in-merchant delivery reliability (per blueprint §3.2.2).
- The reconciler's `expected` is a **windowed view** of `Order` — useful as a sanity check, but not the authority.
- The −1 drift is a reconciler artefact, not an aggregate defect. The aggregate has counted every flip correctly.

---

## 5. Production-risk assessment

### 5.1 Replay-safety implications

| Property | Status | Reasoning |
|---|---|---|
| Chokepoint guards (G2/G6/G8) untouched | ✅ | Race lives entirely in clock semantics, not in guard logic. |
| Per-flip at-most-once aggregate increment | ✅ | The race excludes Order #1 from the reconciler's recompute; it does NOT cause a missed `$inc` on the aggregate. The aggregate counted it. |
| Idempotent replay (5× identical event → 1 increment) | ✅ | Verified by `tracking-reliability-integration.test.ts:262`. Race irrelevant — the helper is gated by G6/G8, not by clocks. |
| Concurrent terminal flips on same Order | ✅ | §6.2 caveat is unchanged. Race contributes ≤1 to the §6.2 budget but does not amplify it. |
| `replay_suppressed` counter | ✅ | Fires only on `newEvents=0 && terminal && status unchanged` — race has no effect on this path. |

### 5.2 Repair-semantics implications

| Scenario | Reconciler reports | Repair action | Outcome |
|---|---|---|---|
| Healthy aggregate, no §6.2 | drift=−1, magnitude=1 | NOOP (within tolerance) | Aggregate stays correct. ✅ |
| Healthy aggregate, one §6.2 over-fire | drift=−2, magnitude=2 | NOOP (at tolerance) | Aggregate is +1 over true; reconciler is −1 under true. Difference between aggregate and reconciler = 2. Repair refuses. ✅ |
| Healthy aggregate, many §6.2 over-fires | drift exceeds tolerance | APPLY → `$set` to `expected` value | Aggregate "loses" 1 count vs the true count (because expected = true_count − 1 due to clock-skew). Self-heals on next chokepoint flip. ✅ bounded loss |
| Corrupted aggregate (manual tamper) | drift exceeds tolerance | APPLY → `$set` to `expected` | Aggregate lands at `true_count − 1`. Self-heals on next chokepoint flip (next $inc → true_count). ✅ bounded loss |

**The repair semantic is self-healing in all paths.** Worst case: a single repair undercounts by 1 vs the true count, and the next chokepoint flip closes the gap.

### 5.3 Reconciliation-trustworthiness implications

| Property | Status |
|---|---|
| Reconciler reports drift = 1 for every brand-new aggregate | ✅ truthfully reports the −1 race; this is honest accounting |
| `driftedKeys` (filtered to magnitude > tolerance) excludes the race | ✅ tolerance was specifically tuned for this race |
| `drift_detected` observability counter | ✅ stays at 0 for healthy production paths |
| Window-correctness against pre-flag terminal Orders | ✅ strict `<` is the right call to exclude pre-flag history |
| Single-key reconciliation reports `drift=1` even on healthy keys | 🟡 informational — operators inspecting a single key may see "drift=1" and assume a defect; the runbook should clarify |

### 5.4 Rollout-safety implications

| Property | Status |
|---|---|
| Per-merchant gates (`isWriteEnabledForMerchant` / `isReadEnabledForMerchant` / `isAnalyticsEnabledForMerchant`) | ✅ unaffected |
| Allowlist behaviour | ✅ unaffected |
| Phase-progression gating (run reconcile per allowlisted merchant) | 🟡 — operators will see `drift=1` on every fresh aggregate. The §5 runbook gate now needs to clarify "drift > tolerance blocks the phase advance", not "any drift". The runbook already says this in §4 (`driftedKeys` is filtered to magnitude > tolerance), but the §5 phase-gating sentence I added in the previous patch already correctly says "Drift > tolerance" — so this is fine. |
| Tier-1 / Tier-2 / Tier-3 rollback | ✅ unaffected |
| Schema validators on `AddressReliability` | ✅ unaffected |

### 5.5 Long-term maintenance implications

| Concern | Severity |
|---|---|
| Hardening tests fail in CI on every run | 🟡 — introduces noise; trains future engineers to ignore "delivery-reliability-hardening" failures, which is dangerous if a real defect ever lands |
| Future engineer "fixes" reconciler strict `<` to `≤` to make tests pass | 🔴 — would silently break the "no pre-flag terminal orders count" invariant. This is the more dangerous scenario than the current state. |
| Future engineer "fixes" by lowering DRIFT_TOLERANCE | 🔴 — would cause every fresh aggregate to flag as drifted in production |
| Future engineer "fixes" by passing `now` through the chokepoint | 🟢 — minimal, deterministic, correct (this is the recommended fix) |

The existence of failing tests is a **maintenance hazard** even if the underlying behaviour is correct. The risk is not that the system breaks today; the risk is that someone "fixes" the wrong thing 18 months from now to make CI green.

---

## 6. Acceptability summary

| Dimension | Verdict |
|---|---|
| **Architectural acceptability** | ✅ ACCEPTABLE. The race is bounded, deterministic, and the aggregate counter remains the truth-of-record. The reconciler's strict `<` filter is defensible (excludes pre-flag history correctly). |
| **Operational acceptability** | ✅ ACCEPTABLE. `drift_detected` stays at 0 for healthy paths. `driftedKeys` correctly excludes the race. Repair refuses to act on it. Aggregate truth is preserved. |
| **Long-term maintenance acceptability** | 🟡 MARGINAL. Failing tests in CI is a long-term hazard. Either the tests need to acknowledge the race, or the race needs to be eliminated by deterministic timestamp propagation. |

---

## 7. Recommendation

### Primary: **PATCH WRITE ORDERING** (recommended)

A one-call-site change in `applyTrackingEvents` propagates the chokepoint's `new Date()` (or `options.deliveredAt`) into the helper's optional `now` parameter. Both `Order.logistics.deliveredAt` and `CustomerReliability.firstOutcomeAt` then derive from the **same** `Date` object, eliminating the strict-< window exclusion deterministically.

**Conceptual shape (illustrative, NOT a code edit):**

```
// Inside applyTrackingEvents, when computing $set:
const terminalNow = options.deliveredAt ?? new Date();
if (normalizedStatus === "delivered" && !order.logistics?.deliveredAt) {
  set["logistics.deliveredAt"] = terminalNow;
  set["logistics.actualDelivery"] = terminalNow;
}
// ...
// In the fan-out block:
void recordCustomerOutcome({
  merchantId, phoneHash, outcome, district, orderId,
  now: terminalNow,    // ← the only new field
});
void recordAddressOutcome({
  merchantId, addressHash, phoneHash, outcome, district, orderId,
  now: terminalNow,    // ← the only new field
});
```

**Why this is safe:**

- The helpers ALREADY accept an injectable `now: Date` parameter (`delivery-reliability-writers.ts:114, 208`). The injection mechanism is pre-existing and tested.
- Helper's `normalizeNow` accepts any `Date`; passing a value identical to `Order.logistics.deliveredAt` makes `firstOutcomeAt` and `Order.deliveredAt` byte-equal.
- Reconciler's `terminalMs < windowStart.getTime()` (strict `<`) becomes strictly false → iteration 1's order is INCLUDED. drift=0.
- No reconciler-window change.
- No `DRIFT_TOLERANCE` change.
- No `STATUS_MAP`/G2/G6/G8 change.
- No replay-semantic change.
- No new tests of the existing replay-safety properties become flaky (all 13 in `tracking-reliability-integration.test.ts` are agnostic to which `Date` instance is used, as long as it's "delivery time").

**Risks of this fix:**

- 🟢 LOW. The helpers already document `now?: Date` as injectable for tests; using it from production is additive.
- One subtle implication: under `options.deliveredAt` from a webhook (e.g., Steadfast supplies a delivery timestamp from their side), `firstOutcomeAt` will equal that webhook-supplied timestamp, not the API server's `new Date()`. This is **more accurate** than the current behaviour (which has `firstOutcomeAt` = API server time, decoupled from the actual delivery time). No regression risk.

**Estimated diff:** ~6 lines in `tracking.ts`. No other files touched.

### Fallback: **PATCH TESTS ONLY**

If the operator prefers to leave the chokepoint untouched, the tests can be loosened to assert `>=N-1 && <=N` instead of exact `===N`. This acknowledges the documented race and the `DRIFT_TOLERANCE=2` design.

**Why this is acceptable but inferior:**

- ✅ Zero risk to production code.
- ✅ Documents the race in the test suite.
- ❌ Leaves the race in production. Every fresh aggregate eternally reports `drift=1` — observationally noisy.
- ❌ Future engineer reading the loosened tests may not understand WHY they're loose, raising the long-term maintenance hazard.
- ❌ Single-key reconciliation reports for healthy aggregates show `driftMagnitude=1`, which can confuse operators inspecting a specific key.

**Estimated diff:** ~10 assertion edits across `delivery-reliability-hardening.test.ts`. No source changes.

### Rejected alternatives

| Option | Why rejected |
|---|---|
| **PATCH RECONCILIATION WINDOW** (change strict `<` to `≤`) | 🔴 BREAKS the "no pre-flag terminal orders count" invariant. A pre-flag Order with `deliveredAt == firstOutcomeAt` (within ms) would be counted. Worse: under clock skew between API server and webhook source, pre-flag Orders could be admitted. The window's strict `<` is load-bearing. |
| **PATCH ARCHITECTURE** (anything more invasive than write-ordering) | 🔴 Out of proportion to a 1-count tolerated race. |
| **Lower `DRIFT_TOLERANCE`** | 🔴 Would cause every healthy fresh aggregate to flag as drifted in production. The opposite of the intent. |
| **Raise `DRIFT_TOLERANCE`** | 🔴 Masks larger real defects. Tolerance is already at the design ceiling. |

### Decision summary

| Path | Production risk | CI noise | Long-term maintenance | Effort |
|---|---|---|---|---|
| ACCEPT AS TOLERATED | 🟢 none | 🔴 9 tests fail forever | 🔴 hazardous | 0 |
| PATCH TESTS ONLY | 🟢 none | 🟢 clean CI | 🟡 race lives in code | small |
| **PATCH WRITE ORDERING (recommended)** | 🟢 minimal | 🟢 clean CI | 🟢 race eliminated | small |
| PATCH RECONCILIATION WINDOW | 🔴 breaks pre-flag invariant | 🟢 clean CI | 🔴 silent breakage | small |
| PATCH ARCHITECTURE (broader) | 🔴 disproportionate | n/a | n/a | large |

**Primary recommendation: PATCH WRITE ORDERING.** The race can be deterministically eliminated by propagating one `Date` value through an existing parameter on the helper. This is a strict win across all dimensions.

---

## 8. Production-risk STOP check

The user's instruction: *"If the race can realistically exceed `DRIFT_TOLERANCE` under production concurrency: STOP immediately and report that clearly."*

**Result: NO STOP-immediately condition was found.**

Under realistic production concurrency:
- The race contributes exactly **−1** per `(merchant, key)` aggregate, once, at row creation.
- Drift can only exceed tolerance when combined with **≥2 sustained §6.2 stale-snapshot incidents on the SAME buyer** — which is a webhook handler regression, not a normal operating condition, and is independently monitored via `invalidTransition`.
- The aggregate counter remains correct (truth-of-record).
- Repair is bounded, idempotent, and self-healing in all corruption-recovery paths.

The system is safe to leave as-is. The recommended fix (PATCH WRITE ORDERING) is small, low-risk, and improves the situation in every dimension.

---

## 9. Next step

This investigation concludes here. **No code was changed.** The investigation identified:

- A deterministic ~microsecond clock-skew race between two `new Date()` calls in `applyTrackingEvents`.
- Bounded at exactly 1 per fresh aggregate, permanently.
- Architecturally acceptable, operationally invisible.
- Recommended fix: PATCH WRITE ORDERING (one-line propagation of `now: Date` from chokepoint to helper).
- No production-risk STOP-immediately condition present.

The operator should choose between PATCH WRITE ORDERING (recommended) and PATCH TESTS ONLY (conservative fallback). Either path closes the failing tests cleanly. No other path is recommended.
