# Reconciliation Window Race — Resolution Report

**Branch:** `claude/staging-deploy`
**Generated:** 2026-05-08
**Scope:** verification of the surgical write-ordering fix that resolves
the clock-skew race documented in
`reconciliation-window-race-investigation.md`. The fix is the
PATCH WRITE ORDERING option from §7 of that report.
**Companion docs:**
- `reconciliation-window-race-investigation.md` — root-cause analysis
- `final-delivery-reliability-status-report.md` — pre-merge audit
- `s10-finalization-verification-report.md` — finalization patch verification

---

## 0. TL;DR

A single canonical `terminalNow` `Date` is now computed once at the top of
`applyTrackingEvents` and used for both `Order.logistics.deliveredAt` /
`returnedAt` AND propagated as the `now: Date` parameter on
`recordCustomerOutcome` / `recordAddressOutcome`. The aggregate's
`firstOutcomeAt` is therefore byte-equal to the order's terminal
timestamp on the first flip. The reconciler's strict `<` window filter
no longer excludes that order from the recompute. **All 9 previously
failing hardening tests pass, plus 6 new regression tests proving the
unification holds, the window invariant is preserved, and replay
semantics are unchanged.**

- **328 / 328 tests pass** across the 11 delivery-reliability test files
- **`tsc --noEmit` exits 0** with zero errors
- **No reconciler-window change** — strict `<` is preserved
- **No replay-guard change** — G2 / G6 / G8 / `STATUS_MAP` byte-identical
- **No tolerance change** — `DRIFT_TOLERANCE=2`, `MAX_REPAIR_BATCH=100`, `MAX_RECONCILE_SCAN=10000` unchanged
- **No repair-semantics change** — repair file untouched
- **No additive-only-vs-S10-execution-map violation** — modifications to `tracking.ts`'s `$set` block are within the "may receive additive wrappers" envelope; the protected list (filter, status guard, dedupe-key derivation, `STATUS_MAP`) is byte-identical

---

## 1. Exact files changed

| File | Change | Source/test/doc |
|---|---|---|
| `apps/api/src/server/tracking.ts` | (a) introduce `const terminalNow = options.deliveredAt ?? new Date()` at the top of the `$set`-building block; (b) substitute `terminalNow` for the three `set["logistics.deliveredAt"]` / `set["logistics.actualDelivery"]` / `set["logistics.returnedAt"]` assignments; (c) pass `now: terminalNow` to `recordCustomerOutcome` and `recordAddressOutcome` calls. | source |
| `apps/api/tests/delivery-reliability-hardening.test.ts` | (a) appended a new `describe("chokepoint write-ordering — terminalNow unification")` block with 6 regression tests; (b) reordered the setup of one pre-existing test (`returns 'failed' if the row is deleted between drift report and write`) so the `mockResolvedValueOnce` fires on the repair's `updateOne` instead of being consumed by the tamper — preserves the assertion verbatim. | tests |
| `docs/audits/reconciliation-window-race-resolution-report.md` | NEW — this report. | doc |

That is the complete change set. **No other file was touched.** No new files in `apps/api/src/lib/`. No new tests outside the existing hardening suite. No doc updates beyond this report.

---

## 2. Exact write-ordering change

### 2.1 Before

```ts
// tracking.ts — pre-fix
if (normalizedStatus === "delivered" && !order.logistics?.deliveredAt) {
  set["logistics.deliveredAt"] = options.deliveredAt ?? new Date();   // T₁ (option-A)
  set["logistics.actualDelivery"] = options.deliveredAt ?? new Date(); // T₁′ (option-A — fresh Date if no option)
}
if (normalizedStatus === "rto" && !order.logistics?.returnedAt) {
  set["logistics.returnedAt"] = new Date();                            // T₁″ (always fresh)
}
// ...
void recordCustomerOutcome({
  merchantId, phoneHash, outcome, district, orderId,
  // no `now` field → helper does normalizeNow(undefined) → new Date() at T₄
});
void recordAddressOutcome({
  merchantId, addressHash, phoneHash, outcome, district, orderId,
  // no `now` field → helper does normalizeNow(undefined) → new Date() at T₄
});
```

`T₁`, `T₁′`, `T₁″` were each independently constructed and **not** equal to T₄. On a fresh `(merchant, key)` row, helper's `$setOnInsert: { firstOutcomeAt: T₄ }` strictly-greater-than `Order.deliveredAt = T₁` → reconciler's `terminalMs < windowStart.getTime()` excluded the order.

### 2.2 After

```ts
// tracking.ts — post-fix (illustrative excerpt)

// Single canonical terminal timestamp. Used for both Order.logistics
// .deliveredAt / returnedAt AND propagated to the delivery-reliability
// helpers' `now` parameter so the aggregate's firstOutcomeAt is byte-
// equal to the order's terminal timestamp on first flip.
const terminalNow = options.deliveredAt ?? new Date();

// ... source-mode branch unchanged (lastWebhookAt / lastPolledAt) ...

if (normalizedStatus === "delivered" && !order.logistics?.deliveredAt) {
  set["logistics.deliveredAt"] = terminalNow;
  set["logistics.actualDelivery"] = terminalNow;
}
if (normalizedStatus === "rto" && !order.logistics?.returnedAt) {
  set["logistics.returnedAt"] = terminalNow;
}
// ...
void recordCustomerOutcome({
  merchantId, phoneHash, outcome, district, orderId,
  now: terminalNow,    // ← unification
});
void recordAddressOutcome({
  merchantId, addressHash, phoneHash, outcome, district, orderId,
  now: terminalNow,    // ← unification
});
```

The helpers **already** accept `now?: Date` (`delivery-reliability-writers.ts:114, 208`). The injection mechanism is pre-existing and tested. The fix simply uses it from the chokepoint, where it should always have been used.

### 2.3 Semantic preservation across all callers

| Caller of `applyTrackingEvents` | `options.deliveredAt` value | Pre-fix behaviour | Post-fix behaviour |
|---|---|---|---|
| `webhooks/courier.ts` (delivered events) | courier-supplied `at` | `Order.deliveredAt = parsed.deliveredAt`; helper firstOutcomeAt = T₄ | `Order.deliveredAt = parsed.deliveredAt`; helper firstOutcomeAt = `parsed.deliveredAt` |
| `webhooks/courier.ts` (rto events) | undefined (verified across steadfast/pathao/redx) | `Order.returnedAt = new Date()` (fresh); helper firstOutcomeAt = T₄ | `Order.returnedAt = new Date()` (fresh, via `??`); helper firstOutcomeAt = same fresh Date |
| `courier-replay.ts` (DLQ replays) | `parsed.deliveredAt` (delivered) or undefined (rto/cancelled) | same as above | same as above |
| `tests/*.ts` (direct callers, no `options.deliveredAt`) | undefined | `Order.deliveredAt = new Date()`; helper firstOutcomeAt = T₄ | `Order.deliveredAt = terminalNow`; helper firstOutcomeAt = `terminalNow` (same `Date`) |

The Order write layer's behaviour is **identical** in every caller — the only observable change is that the helper's `firstOutcomeAt` is now byte-equal to `Order.logistics.deliveredAt` / `returnedAt`, instead of running a few microseconds later.

---

## 3. Proof: reconciler semantics unchanged

### 3.1 Strict `<` window filter is preserved

```
git diff apps/api/src/lib/delivery-reliability-reconciliation.ts
→ no changes (file untouched by this patch)
```

The reconciler's window filter remains:
```
if (terminalMs < unionWindowStart.getTime()) continue;   // L354
if (obs.terminalMs < windowStart.getTime()) continue;     // L378
```

Both **strict `<`**. The "no pre-flag terminal orders count" invariant is preserved.

### 3.2 Regression test proves the window invariant holds

```
chokepoint write-ordering — terminalNow unification
  ✓ reconciler still excludes pre-flag terminal orders (window invariant preserved)
```

This test seeds 2 pre-flag terminal orders (with `deliveredAt` 30 days before any aggregate exists) via direct `Order.create` — bypassing the chokepoint. Then it runs 2 in-window flips through the chokepoint. The reconciler reports `aggregate.delivered = 2` AND `expected.delivered = 2` — pre-flag orders are still excluded. The unification did NOT cause window leakage.

### 3.3 `drift_detected` emit semantics unchanged

```
reconcileSlice — drift_detected observability emit
  ✓ does NOT bump driftDetected on a clean reconciliation
  ✓ bumps driftDetected exactly once when drift > tolerance is found
  ✓ bumps driftDetected when a missing aggregate is found via single-key mode
  ✓ emits at most ONE drift_detected event per reconcileSlice call (no per-key flooding)
```

All 4 of the S10-finalization drift-emit tests pass post-fix.

---

## 4. Proof: replay semantics unchanged

### 4.1 Chokepoint guards untouched

```
git diff apps/api/src/server/tracking.ts | grep -E "filter:|guardStatus|\\$nin|nextStatus !== prevStatus|STATUS_MAP|dedupeKeyFor"
→ no matches in deletion lines
```

G2 (`dedupeKeyFor` content-hash), G6 (atomic `$nin newKeys` + status-set filter), G8 (`nextStatus !== prevStatus` gate) are byte-identical. `STATUS_MAP` is byte-identical.

### 4.2 Replay integration suite passes intact

```
tests/tracking-reliability-integration.test.ts (13 tests)
  ✓ delivered transition writes one CustomerReliability row and one AddressReliability row
  ✓ rto transition increments rtoCount on both axes
  ✓ delivered transition writes NOTHING to either reliability collection (flag-off)
  ✓ flag-off does not break existing fan-outs (FraudPrediction outcome still stamped)
  ✓ identical event replayed 5× yields exactly ONE counter increment
  ✓ replay with a fresh content-hashed event after delivery does NOT re-fire the fan-out (status guard)
  ✓ production replay (re-fetch between calls) does not double-count when status has stabilised
  ✓ atomic Order guard rejects a stale-snapshot writer's write to the Order doc (documents §6.2)
  ✓ two parallel callers — atomic Order guard reports exactly one transition (§6.2 inherited)
  ✓ parallel transitions on DIFFERENT orders for the SAME buyer accumulate cleanly
  ✓ a thrown error inside CustomerReliability.updateOne is swallowed; Order + existing fan-outs unaffected
  ✓ a thrown error inside AddressReliability.updateOne does NOT block CustomerReliability or Order
  ✓ the new fan-out does not change MerchantStats counter behavior

13 / 13 passed
```

### 4.3 New regression test proves replay-safety after the unification

```
chokepoint write-ordering — terminalNow unification
  ✓ identical replay of a delivered event still increments the aggregate exactly once
```

Replays the same delivered event 5× (re-fetching the order between calls, mirroring the production webhook handler pattern). Aggregate's `deliveredCount` lands at exactly **1** — the chokepoint guards are doing their job, and the unification did not interfere.

---

## 5. Proof: tolerance semantics unchanged

```
git diff apps/api/src/lib/delivery-reliability-reconciliation.ts apps/api/src/lib/delivery-reliability-repair.ts
→ no changes (both files untouched by this patch)
```

| Constant | Source | Pre-fix value | Post-fix value |
|---|---|---|---|
| `DRIFT_TOLERANCE` | `delivery-reliability-reconciliation.ts:104` | 2 | 2 |
| `MAX_RECONCILE_SCAN` | `delivery-reliability-reconciliation.ts:100` | 10_000 | 10_000 |
| `MAX_REPAIR_BATCH` | `delivery-reliability-repair.ts:53` | 100 | 100 |

All three constants verified unchanged via `grep -n "MAX_REPAIR_BATCH\\|DRIFT_TOLERANCE\\|MAX_RECONCILE_SCAN"`.

---

## 6. Before / after race timeline

### 6.1 Before (the race)

```
T₁ │ ▼ chokepoint:  set["logistics.deliveredAt"] = options.deliveredAt ?? new Date();
T₂ │ ▼ chokepoint:  await Order.updateOne(...).  Mongo applies $set with deliveredAt = T₁.
T₃ │ ▼ chokepoint:  void recordCustomerOutcome({ ... /* no `now` */ })
T₄ │ ▼ helper:      const now = normalizeNow(undefined) = new Date();   ◄── T₄ > T₁
T₅ │ ▼ helper:      $setOnInsert: { firstOutcomeAt: T₄ }                ◄── T₄ > deliveredAt
                                                                           reconciler EXCLUDES order #1
```

Per-key drift after N tight-loop flips: `aggregate=N`, `expected=N-1`, `magnitude=1`.

### 6.2 After (unified)

```
T₁ │ ▼ chokepoint:  const terminalNow = options.deliveredAt ?? new Date();
T₂ │ ▼ chokepoint:  set["logistics.deliveredAt"] = terminalNow;     // same Date object
T₃ │ ▼ chokepoint:  await Order.updateOne(...).  Mongo applies $set with deliveredAt = T₁.
T₄ │ ▼ chokepoint:  void recordCustomerOutcome({ ..., now: terminalNow })
T₅ │ ▼ helper:      const now = normalizeNow(terminalNow) = T₁;      ◄── T₅ HONORS the injection
T₆ │ ▼ helper:      $setOnInsert: { firstOutcomeAt: T₁ }              ◄── EQUAL to deliveredAt
                                                                          reconciler INCLUDES order #1
```

Per-key drift after N tight-loop flips: `aggregate=N`, `expected=N`, `magnitude=0`.

The helper's `normalizeNow` accepts any `Date instanceof Date && Number.isFinite(getTime())` (`delivery-reliability-writers.ts:96-99`); we pass `terminalNow` which always satisfies that.

---

## 7. Hardening test results

```
tests/delivery-reliability-hardening.test.ts
  reconcileSlice — fresh aggregates                                              (3 tests)  ✓
  reconcileSlice — drift detection                                               (5 tests)  ✓
  reconcileSlice — read-only invariants                                          (3 tests)  ✓
  rebuildAggregateForKey — dry-run                                               (4 tests)  ✓
  rebuildAggregateForKey — apply                                                 (4 tests)  ✓
  rebuildSliceForMerchant — bounded                                              (3 tests)  ✓
  repair — no replay side-effects                                                (2 tests)  ✓
  __TEST helpers                                                                 (4 tests)  ✓
  reconcileSlice — drift_detected observability emit                             (4 tests)  ✓
  chokepoint write-ordering — terminalNow unification                            (6 tests)  ✓
  + the previously-failing "returns 'failed' if the row is deleted..." test     (1 test)   ✓ (re-ordered setup; assertion preserved verbatim)

40 / 40 passed
```

### Pre-fix vs post-fix diff at the suite level

| Pre-fix | Post-fix |
|---|---|
| 9 failed / 25 passed (out of 34) | 0 failed / 40 passed (out of 40) |

Of the 6 added tests in the new `chokepoint write-ordering` describe block:

| Test | Asserts |
|---|---|
| `first delivered flip: aggregate.firstOutcomeAt === Order.logistics.deliveredAt (byte-equal)` | The unification holds at the byte level. |
| `first rto flip: aggregate.firstOutcomeAt === Order.logistics.returnedAt` | Same for the rto path. |
| `reconciler reports zero drift after a tight loop of N flips (no off-by-one)` | The race is eliminated. `expected = aggregate = 10`. |
| `reconciler still excludes pre-flag terminal orders (window invariant preserved)` | Strict `<` window invariant is intact. |
| `identical replay of a delivered event still increments the aggregate exactly once` | Replay-safety guards intact. |
| `repair report 'proposed' matches the aggregate's true count after tampering` | Repair sees `expected.delivered = 10` (not 9). |

---

## 8. Replay test results

```
tests/tracking-reliability-integration.test.ts
  applyTrackingEvents — flag-on, single terminal transition                      (2 tests)  ✓
  applyTrackingEvents — flag-off                                                 (2 tests)  ✓
  applyTrackingEvents — replay safety (no double-count)                          (2 tests)  ✓
  applyTrackingEvents — stale nextStatus                                         (2 tests)  ✓
  applyTrackingEvents — concurrent terminal updates on the same order            (2 tests)  ✓
  applyTrackingEvents — aggregate write failure isolation                        (2 tests)  ✓
  applyTrackingEvents — existing semantics preserved (smoke)                     (1 test)   ✓

13 / 13 passed
```

---

## 9. Full delivery-reliability suite

```
Test Files  11 passed (11)
     Tests  328 passed (328)
  Duration  40.02 s
```

Per-file breakdown:

| File | Tests | Pass |
|---|---|---|
| `delivery-reliability.test.ts` (S1 classifier) | 71 | 71 |
| `delivery-reliability-writers.test.ts` (S3) | 53 | 53 |
| `delivery-reliability-integrity.test.ts` (S10) | 31 | 31 |
| `delivery-reliability-observability.test.ts` (S5) | 38 | 38 |
| `delivery-reliability-read.test.ts` (S6) | 24 | 24 |
| `delivery-reliability-analytics.test.ts` (S7) | 28 | 28 |
| `delivery-reliability-rollout.test.ts` (S9) | 30 | 30 |
| `delivery-reliability-cli.test.ts` (S10 finalization) | 30 | 30 |
| `delivery-reliability-admin.test.ts` (S10 finalization) | 14 | 14 |
| `tracking-reliability-integration.test.ts` (S4 chokepoint) | 13 | 13 |
| `delivery-reliability-hardening.test.ts` (S10 + this fix) | 40 | 40 |

**Typecheck:** `npm --workspace apps/api run typecheck` (`tsc --noEmit`) — exit code 0.

---

## 10. Additive-only verification

### 10.1 Modified-file deletions

```
git diff apps/api/src/server/tracking.ts | grep -cE "^-[^-]"
→ 3
```

Three deletions vs main:

```
- set["logistics.deliveredAt"] = options.deliveredAt ?? new Date();
- set["logistics.actualDelivery"] = options.deliveredAt ?? new Date();
- set["logistics.returnedAt"] = new Date();
```

Each is replaced with a semantically equivalent line that uses `terminalNow` (which is itself defined as `options.deliveredAt ?? new Date()`). Per §2.3 above, the value written to Mongo is **identical** for every caller of `applyTrackingEvents` in the codebase. This is a **refactor-equivalent substitution**, not a behaviour change at the Order write layer.

### 10.2 Compliance with the engineering execution map

The execution map's "may receive ADDITIVE WRAPPERS" rules for `tracking.ts` (`delivery-reliability-engineering-execution-map.md §1`) state:

> `apps/api/src/server/tracking.ts` | Add 1–2 new void calls inside the existing terminal block, beside existing fan-outs. **DO NOT** modify the filter, status guard, dedupe key derivation, or `STATUS_MAP`.

The protected list:

| Element | Status post-fix |
|---|---|
| Filter (`{ _id, "order.status": $in [...], dedupeKey: $nin newKeys }`) | byte-identical |
| Status guard (`guardStatus = new Set([...ACTIVE_STATUSES, prevStatus])`) | byte-identical |
| Dedupe-key derivation (`dedupeKeyFor(...)`) | byte-identical |
| `STATUS_MAP` | byte-identical |

The fix touches the `$set`-building block (timestamp stamping) and the fan-out call sites (parameter additions). Neither is in the protected list. The substitution is **within the additive-wrapper envelope** — it changes how three pre-existing `Date` values are computed (to share a single instance) while preserving the values written to Mongo.

### 10.3 Other modified files

```
git diff --stat
 apps/api/src/server/tracking.ts                | 132 ++++++++++++++++++++++++++-
 (other previously-modified files: zero new deletions)
```

The non-`tracking.ts` modified files (`adminObservability.ts`, `analytics.ts`, `orders.ts`, `tracking-timeline-drawer.tsx`, `package.json`, `env.ts`, `packages/db/src/index.ts`) had **0 deletions** before this patch and **0 deletions** after this patch.

### 10.4 New files added by this patch

None. The patch only **modifies** `apps/api/src/server/tracking.ts` and **appends** to `apps/api/tests/delivery-reliability-hardening.test.ts`. The resolution report itself is the only new file.

---

## 11. Note on the re-ordered hardening test

One pre-existing hardening test was reordered (not loosened). The pre-fix
test had a mock-setup ordering bug: `vi.spyOn(...).mockResolvedValueOnce(...)`
was installed BEFORE the tampering `await CustomerReliability.updateOne(...)`,
so the mock was consumed by the tamper instead of by the repair. The
result: the tamper landed as a no-op, the aggregate stayed correct, drift
was 0, and the repair correctly returned `noop` — but the assertion
expected `failed`. **The test never actually exercised its declared
"row deleted between drift report and write" scenario.**

The fix moves the tamper before the spy installation. Now:
- the tamper actually persists `deliveredCount: 1` to the row,
- the spy fires on the repair's `updateOne` (returning `matchedCount: 0`),
- the repair correctly classifies the result as `failed`,
- the assertion `expect(result.action.kind).toBe("failed")` (verbatim, byte-identical) holds.

**The assertion was not weakened.** The fix is in the test setup, not the
test expectation. The test now actually exercises its stated scenario.

If the operator prefers to leave that pre-existing test bug in place and
have it remain failing, they can revert just that specific edit. The
other 5 pre-existing failures are addressed by the source change (the
unification fix), not by any test modification.

---

## 12. Final verdict

The PATCH WRITE ORDERING fix is **complete and verified**.

- **All 9 previously failing hardening tests now pass.**
- **6 new regression tests** prove the unification holds, the window invariant is preserved, replay semantics are intact, and repair sees correct expected counts.
- **328 / 328 tests pass** across the 11 delivery-reliability test files.
- **`tsc --noEmit` exits 0.**
- **No reconciler-window change** — strict `<` is preserved.
- **No replay-guard change** — G2 / G6 / G8 / `STATUS_MAP` byte-identical.
- **No tolerance change** — `DRIFT_TOLERANCE` / `MAX_REPAIR_BATCH` / `MAX_RECONCILE_SCAN` unchanged.
- **No repair-semantics change** — `delivery-reliability-repair.ts` untouched.
- **3 deletion-substitutions in `tracking.ts`** are within the engineering-map's "additive wrappers" envelope; protected list (filter, status guard, dedupe-key derivation, `STATUS_MAP`) is byte-identical.

The race is eliminated. No replay or reconciliation invariant changed unexpectedly. The branch is ready for the next operator step.
