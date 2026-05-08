# Delivery Reliability — Final Implementation Status Report

**Branch:** `claude/staging-deploy`
**Generated:** 2026-05-08
**Scope:** S10 (enterprise operational hardening) — final pre-merge audit.
**Posture:** read-only audit. No source modifications were made.
**Companion docs:**
- `delivery-reliability-implementation-blueprint.md`
- `delivery-reliability-engineering-execution-map.md`
- `delivery-reliability-rollout-runbook.md`

---

## 0. TL;DR

S10 ships a substantial **operational hardening layer** that goes beyond what the original blueprint described (the blueprint treated S10 as "rollout, no code"). What landed instead is a coherent, additive, replay-safe set of read-only diagnostic tools (integrity, reconciliation), bounded explicit-invocation repair tooling, three operational CLIs, three admin tRPC surfaces, and a hardening test suite.

**The hardening surface is functionally complete and safe to merge.** Five well-scoped gaps remain — none replay-risk, none rollback-risk, none additive-violation. The largest gap is documentation/test drift, not implementation drift.

**Recommended next step:** ship a small "S10 finalization" patch that closes the five tracked gaps below before the rollout runbook is exercised in production. See §8.

---

## 1. Inventory inspected

### 1.1 New library files (additive)
| File | Role | Read | Write |
|---|---|---|---|
| `apps/api/src/lib/delivery-reliability.ts` | Pure classifier (S1) | — | — |
| `apps/api/src/lib/delivery-reliability-writers.ts` | Chokepoint fan-out helpers (S3/S4) | — | `customer_reliabilities`, `address_reliabilities` |
| `apps/api/src/lib/delivery-reliability-read.ts` | `getOrder` read adapter (S6) | 3 collections | — |
| `apps/api/src/lib/delivery-reliability-analytics.ts` | Bounded merchant-cohort summaries (S7) | 3 collections | — |
| `apps/api/src/lib/delivery-reliability-rollout.ts` | Per-merchant gate matrix (S9) | env only | — |
| `apps/api/src/lib/delivery-reliability-integrity.ts` | Pure integrity / drift checks (S10) | — | — |
| `apps/api/src/lib/delivery-reliability-reconciliation.ts` | Read-only drift reconciler (S10) | aggregates + Order | — |
| `apps/api/src/lib/delivery-reliability-repair.ts` | Bounded explicit-invocation repair (S10) | reconciler | aggregates only (`$set`) |
| `apps/api/src/lib/observability/delivery-reliability.ts` | Counter + structured-log emitter (S5) | env only | — |

### 1.2 Operational scripts (S10)
| File | Action | Default | Mutation cap |
|---|---|---|---|
| `apps/api/src/scripts/verifyDeliveryReliability.ts` | Health check | dry / read-only | none |
| `apps/api/src/scripts/reconcileDeliveryReliability.ts` | Drift detector | dry / read-only | none |
| `apps/api/src/scripts/repairDeliveryReliability.ts` | Aggregate repair | **dry-run** | per-key `$set` × `MAX_REPAIR_BATCH=100` |

### 1.3 DB models (additive)
- `packages/db/src/models/customerReliability.ts` (unique compound index `merchantId + phoneHash`)
- `packages/db/src/models/addressReliability.ts` (unique compound index `merchantId + addressHash`, bounded `distinctPhoneHashes` cap=32 with schema validator)
- `packages/db/src/index.ts` re-exports both

### 1.4 Modified server / web files (additive only)
- `apps/api/src/server/tracking.ts` — appended fan-out + 2 new observability emit-points
- `apps/api/src/server/routers/orders.ts` — appended `deliveryReliability` field on `getOrder`
- `apps/api/src/server/routers/analytics.ts` — appended 4 procedures + 1 helper
- `apps/api/src/server/routers/adminObservability.ts` — appended 3 admin procedures
- `apps/web/src/components/orders/tracking-timeline-drawer.tsx` — mounted `<DeliveryReliabilityPanel>`
- `apps/web/src/components/orders/delivery-reliability-panel.tsx` — new component
- `apps/api/src/env.ts` — added 5 flags (4 boolean + 1 allowlist)
- `apps/api/package.json` — wired 3 npm scripts (`verify` / `reconcile` / `repair`)

### 1.5 Tests (additive)
| File | LOC | Covers |
|---|---|---|
| `delivery-reliability.test.ts` | 859 | Pure classifier (S1) |
| `delivery-reliability-writers.test.ts` | 712 | Writer helpers (S3) |
| `delivery-reliability-integrity.test.ts` | 389 | Integrity checks (S10 pure) |
| `delivery-reliability-observability.test.ts` | 577 | Counter + log emitter (S5) |
| `delivery-reliability-read.test.ts` | 568 | `loadDeliveryReliability` (S6) |
| `delivery-reliability-analytics.test.ts` | 677 | Cohort summaries (S7) |
| `delivery-reliability-rollout.test.ts` | 663 | Gates + verify CLI (S9) |
| `delivery-reliability-hardening.test.ts` | 771 | Reconciliation + repair (S10) |
| `tracking-reliability-integration.test.ts` | 628 | Chokepoint × replay × failure-isolation |

---

## 2. Completed S10 checklist

| # | Item | Evidence | Status |
|---|---|---|---|
| 1 | **Reconciliation library** — read-only, bounded, window-aware drift detector | `delivery-reliability-reconciliation.ts:208` `reconcileSlice`; `MAX_RECONCILE_SCAN=10000`; uses each aggregate's `firstOutcomeAt` as window floor | ✅ |
| 2 | **Repair library** — bounded, dry-run-by-default, idempotent `$set`, drift-tolerance gate | `delivery-reliability-repair.ts`; `MAX_REPAIR_BATCH=100`; refuses `driftMagnitude ≤ DRIFT_TOLERANCE=2`; refuses to recreate missing aggregates | ✅ |
| 3 | **Integrity helpers** — pure-function violation classifier | `delivery-reliability-integrity.ts`; 11 `IntegrityCode` types; `checkCustomerReliabilityIntegrity` / `checkAddressReliabilityIntegrity` / `checkReplayAnomaly` / `checkAggregateMismatch` | ✅ |
| 4 | **Verify CLI** | `scripts/verifyDeliveryReliability.ts`; safe-counts (`-1` on failure); 200-row integrity sample per axis; `--merchant` + `--json` flags | ✅ |
| 5 | **Reconcile CLI** | `scripts/reconcileDeliveryReliability.ts`; per-merchant + per-axis + optional `--key`; `--limit` cap (clamped to `MAX_RECONCILE_SCAN`); human + JSON output | ✅ |
| 6 | **Repair CLI** | `scripts/repairDeliveryReliability.ts`; **dry-run unless `--apply`**; `--limit` clamped to `[1, MAX_REPAIR_BATCH]`; single-key + slice modes | ✅ |
| 7 | **npm scripts** wired | `apps/api/package.json` adds `verify:delivery-reliability`, `reconcile:delivery-reliability`, `repair:delivery-reliability` | ✅ |
| 8 | **Admin tRPC surfaces** | `adminObservability.ts` adds `deliveryReliabilityRolloutState`, `deliveryReliabilityMerchantHealth`, `deliveryReliabilityDriftSample` — all `adminProcedure`, all read-only | ✅ |
| 9 | **Repair audit trail** | Repair emits `integrity_warning` events with `reason: "repair_applied" \| "repair_failed"` and `meta.hashKeyPrefix` truncated for privacy | ✅ |
| 10 | **Reconcile read-only invariants tested** | `delivery-reliability-hardening.test.ts:334` "does NOT issue any aggregate writes / Order writes" | ✅ |
| 11 | **Repair idempotency tested** | `delivery-reliability-hardening.test.ts:507` "running again produces no new mutation" | ✅ |
| 12 | **Repair drift-tolerance tested** | `delivery-reliability-hardening.test.ts:427` "noops when drift is within tolerance (≤ 2)" | ✅ |
| 13 | **Repair backfill-refusal tested** | `delivery-reliability-hardening.test.ts:447` "refuses to recreate a missing aggregate" | ✅ |
| 14 | **No replay-side-effects tested** | `delivery-reliability-hardening.test.ts:679` "repairing does NOT push tracking events / FraudPrediction" | ✅ |
| 15 | **Bounded slice cap** | `delivery-reliability-hardening.test.ts:604` "returns capped > 0 when limit is smaller than the drifted-key count" | ✅ |
| 16 | **Reconciliation truncation surfaced** | `delivery-reliability-hardening.test.ts:286` "reports truncated=true when set exceeds scan limit" | ✅ |
| 17 | **Window-aware reconciliation** | `delivery-reliability-hardening.test.ts:244` "respects the per-aggregate firstOutcomeAt window — pre-window orders do NOT count" | ✅ |
| 18 | **Mongo-failure resilience** | `delivery-reliability-hardening.test.ts:366` "returns gracefully when the Order scan rejects" | ✅ |
| 19 | **Per-merchant rollout snapshot** | `getMerchantRolloutSnapshot` returns the gate matrix; surfaced via `deliveryReliabilityRolloutState` | ✅ |
| 20 | **Per-merchant health snapshot** | `loadReliabilityHealthSnapshot` exposed via `deliveryReliabilityMerchantHealth` admin proc | ✅ |
| 21 | **Per-merchant drift sample** | `reconcileSlice` exposed via `deliveryReliabilityDriftSample` admin proc with `scanLimit` capped at 10000 | ✅ |
| 22 | **Observability emit on chokepoint write rejection** (`§6.2 caveat`) | `tracking.ts:205` emits `invalid_transition` when atomic Order guard rejected the write | ✅ |
| 23 | **Observability emit on terminal-status replay** | `tracking.ts:281` emits `replay_suppressed` on `newEvents=0 && terminal && status unchanged` | ✅ |

---

## 3. Incomplete S10 checklist

| # | Item | Evidence | Severity |
|---|---|---|---|
| I1 | **`drift_detected` event is declared but never emitted.** The runbook §4 explicitly tells ops to watch `observabilityCounters.driftDetected`, yet `reconcileSlice` never calls `recordReliabilityOutcome({event: "drift_detected"})`. The counter is permanently 0. | `observability/delivery-reliability.ts:32,63,74,82,174` declares + counters; `grep drift_detected apps/api/src` finds no emit-side caller | 🟡 medium — doc/runbook drift |
| I2 | **Unused `env` import in `tracking.ts`.** Line 23 imports `env` but the symbol is only referenced in a comment (line 302). | `grep -n "\\benv\\." apps/api/src/server/tracking.ts` returns 1 import + 1 comment hit | 🟢 low — lint / tidy |
| I3 | **No CLI tests for `reconcileDeliveryReliability.ts`.** `parseArgs` and `formatHumanReport` are exposed via `__TEST` but no test file imports them. Only the verify CLI has parseArgs/formatter coverage (in `delivery-reliability-rollout.test.ts:634`). | Grep confirms only `verifyDeliveryReliability.ts`'s helpers are tested | 🟡 medium — coverage gap |
| I4 | **No CLI tests for `repairDeliveryReliability.ts`.** Same pattern — `__TEST` is exported but no test consumes it. | Grep confirms | 🟡 medium — coverage gap |
| I5 | **No tRPC tests for the three new admin procedures.** `deliveryReliabilityRolloutState` / `deliveryReliabilityMerchantHealth` / `deliveryReliabilityDriftSample` are not covered by any test file. | `grep -r "deliveryReliabilityRolloutState\\|deliveryReliabilityMerchantHealth\\|deliveryReliabilityDriftSample" apps/api/tests` returns no results | 🟡 medium — coverage gap |
| I6 | **`docs/audits/delivery-reliability-engineering-execution-map.md` is out of date.** §1 still lists S10 as "production rollout (NO file changes)" but S10 actually shipped 4 new lib files, 3 scripts, 3 admin procs, 1 test file, and `package.json` script wiring. | `grep -n "S10" delivery-reliability-engineering-execution-map.md` returns 3 hits, none describe the hardening surface | 🟡 medium — doc drift |
| I7 | **`docs/audits/delivery-reliability-rollout-runbook.md` does not document reconcile/repair operations.** The runbook's Phase progression and "Verification commands" sections only describe `verify:delivery-reliability`. There is no procedure for "drift detected — what does ops do?" beyond the implicit "run verify". | `grep -n "reconcile\\|repair" runbook` returns 0 hits | 🟡 medium — doc drift |

No P0 / P1 items remain. Items I1 and I6/I7 are the ones most likely to bite the operator running the rollout.

---

## 4. Dangerous implementation findings

| # | Finding | Status |
|---|---|---|
| D1 | Repair uses **absolute `$set` of `expected.*Count`** (not `$inc`). Re-running with the same Order state produces a byte-identical write. | ✅ safe |
| D2 | Repair refuses to mutate when **`driftMagnitude ≤ DRIFT_TOLERANCE=2`**. Race-induced 1-count drifts self-heal on the next chokepoint flip; repair never papers over them. | ✅ safe |
| D3 | Repair refuses to **recreate missing aggregates** (v1 backfill is explicitly out of scope). | ✅ safe — tested at hardening.test.ts:447 |
| D4 | Reconciliation is **window-aware** — only Orders with `terminalAt ∈ [aggregate.firstOutcomeAt, now]` are counted. Pre-write-flag terminal orders do not surface as drift. | ✅ safe — tested at hardening.test.ts:244 |
| D5 | Reconciliation is **bounded** at `MAX_RECONCILE_SCAN=10000` with `truncated: true` warning when the cap is hit. | ✅ safe |
| D6 | Repair is **bounded** at `MAX_REPAIR_BATCH=100` per invocation. Larger merchant cohorts run multiple bounded passes. | ✅ safe |
| D7 | All admin tRPC surfaces are **read-only**. `deliveryReliabilityDriftSample` calls `reconcileSlice` (not `rebuildSliceForMerchant`) — repair is CLI-only. | ✅ safe |
| D8 | Repair emit of audit-trail event is **after** the Mongo write resolves (success path) or **on caught error** (failure path). No event is emitted for the dry-run path — by design. | ✅ safe |
| D9 | `reconcileSlice` issues **no Mongoose transaction** and reads `Order` with `.lean()` — it cannot accidentally take a write lock. | ✅ safe |
| D10 | The reconciler's `OrderLeanRow.terminalAt` derivation **explicitly skips `terminalMs > now`** (future-dated) and `terminalMs < unionWindowStart` (pre-window) — both protective filters. | ✅ safe |

No dangerous patterns slipped in.

---

## 5. Replay-risk findings

| # | Finding | Status |
|---|---|---|
| R1 | Chokepoint fan-out remains gated by **G8 (`nextStatus !== prevStatus`)** + **G6 (atomic `$nin newKeys` + status-set filter)**. S10 added zero new code inside G6/G8; only appended emits **after** the existing block. | ✅ safe — verified in tracking.ts diff |
| R2 | New `replay_suppressed` log fires **only** in the `else` branch of `if (nextStatus !== prevStatus)` — i.e. on a no-op replay. Pure observation; does not change chokepoint behaviour. | ✅ safe |
| R3 | New `invalid_transition` log fires **only** when `!persisted` inside the existing `if (nextStatus === ... terminal)` block — observation of the §6.2 caveat manifesting. | ✅ safe |
| R4 | Repair writes **NEVER pass through `applyTrackingEvents`** — they are direct `aggregate.updateOne($set: ...)` calls. There is no path by which repair could re-trigger the chokepoint or any of its fan-outs. Verified at `hardening.test.ts:679` "repairing does NOT push tracking events". | ✅ safe |
| R5 | Repair is **idempotent across both axes** (verified at `hardening.test.ts:533`). Running the same repair twice yields a `noop:drift_within_tolerance` on the second pass. | ✅ safe |
| R6 | Reconciler **does NOT enqueue, replay, or trigger any chokepoint side-effect**. Verified at `hardening.test.ts:334` "does NOT issue any aggregate writes / does NOT issue any Order writes". | ✅ safe |
| R7 | The §6.2 inherited fan-out double-fire (under stale in-memory snapshots, two callers can both pass `nextStatus !== prevStatus`) is **bounded** by repair's idempotent `$set` — even if a future operator runs repair right after a §6.2 double-fire, the absolute-$set semantics flatten counter to `expected`. | ✅ safe |

No new replay risks introduced. The §6.2 caveat is unchanged and now actively monitored via the new `invalid_transition` counter.

---

## 6. Rollback-safety findings

| # | Finding | Status |
|---|---|---|
| RB1 | Three primary flags (`WRITE` / `READ` / `ANALYTICS`) and the allowlist are **independently flippable**. Verified across 5 dedicated rollback tests in `delivery-reliability-rollout.test.ts:436` (`rollback isolation` describe-block). | ✅ safe |
| RB2 | Flag flip is **immediate on the next request** — no in-process cache, no warm-up. Verified at `delivery-reliability-rollout.test.ts:356` ("write flag flipped off mid-session → ... immediate rollback"). | ✅ safe |
| RB3 | Allowlist is the only cached value, and the cache key is the **raw env string** — env change → cache miss → re-parse. `__resetRolloutAllowlistCache` exposed for tests; production simply restarts on env change (consistent with the rest of the codebase). | ✅ safe |
| RB4 | `deliveryReliabilityDriftSample` is the only admin surface that scans Order — it is `adminProcedure` (gated) and `scanLimit` is hard-capped at `10_000`. There is no merchant-facing admin endpoint that can trigger an unbounded scan. | ✅ safe |
| RB5 | Repair CLI is **opt-in via `--apply`**. Default behaviour is dry-run even when invoked with valid args. There is no automated repair worker, no scheduled repair, no admin endpoint that triggers repair. | ✅ safe |
| RB6 | Repair CLI cannot affect data outside the `customer_reliabilities` / `address_reliabilities` collections — `applyKeyRepair` is the only mutator and it issues exactly one `aggregate.updateOne(filter, {$set: proposed})`. | ✅ safe |
| RB7 | Schema-level `distinctPhoneHashes` cap validator on `AddressReliability` (max 32) means even a buggy direct insert is rejected at the model layer. | ✅ safe |
| RB8 | The integrity helpers' `checkAggregateMismatch` is pure-function — invoking it cannot cause a write under any circumstance. | ✅ safe |

Rollback story is intact.

---

## 7. Operational-hardening findings

| # | Finding | Status |
|---|---|---|
| O1 | Per-merchant `verifyDeliveryReliability` mode (`--merchant=<hex>`) for targeted health-check during a staged rollout. | ✅ |
| O2 | Drift-detection is **separated from repair** at the library boundary — `reconciliation.ts` is consumed by `repair.ts` but never the other way round. Repair refuses to compute its own expected counters (`reconcileKey` is the source of truth). | ✅ |
| O3 | Repair **emits an audit trail** via `recordReliabilityOutcome({event: "integrity_warning", reason: "repair_applied"})` with hashed prefixes only — no raw PII enters logs. | ✅ |
| O4 | The verify script's `inspectMerchant` uses `safeCount` to swallow per-collection failures and **report `-1`** rather than crashing the whole report. Verified at `rollout.test.ts:648` (`degraded mode`). | ✅ |
| O5 | Verify integrity sample (`LIMIT_PER_AXIS = 200`) is bounded **per-axis** — even a worst-case run inspects ≤ 600 rows per merchant. | ✅ |
| O6 | Reconcile slice + reconcile key share `reconcileSlice` so behaviour is consistent — `reconcileKey` is a one-line wrapper that asserts `entries[0]` is the right key. | ✅ |
| O7 | Repair surfaces three explicit `RepairAction.kind` discriminants (`noop`, `applied`, `failed`) so admin output can be parsed without string-matching. | ✅ |
| O8 | Admin observability counter snapshot is **process-local** and cannot accidentally persist or leak across requests — the counters live in module-scope `Record<event, number>` with a test-only `__resetReliabilityCounters`. | ✅ |
| O9 | The verify CLI's `parseArgs` rejects malformed `--merchant=` values via `Types.ObjectId.isValid` and surfaces a `warnings` entry; it does **not** abort the run. | ✅ |
| O10 | **Drift instrumentation gap (I1):** `reconcileSlice` returns a populated drift report but never bumps the `driftDetected` counter / log channel. The runbook §4 instructs ops to watch this counter as a defect signal. | 🟡 see §3 / §8 |

---

## 8. Additive-only compliance findings

| File | Type of change | Compliance |
|---|---|---|
| `apps/api/src/lib/delivery-reliability.ts` | NEW | ✅ |
| `apps/api/src/lib/delivery-reliability-writers.ts` | NEW | ✅ |
| `apps/api/src/lib/delivery-reliability-read.ts` | NEW | ✅ |
| `apps/api/src/lib/delivery-reliability-analytics.ts` | NEW | ✅ |
| `apps/api/src/lib/delivery-reliability-rollout.ts` | NEW | ✅ |
| `apps/api/src/lib/delivery-reliability-integrity.ts` | NEW | ✅ |
| `apps/api/src/lib/delivery-reliability-reconciliation.ts` | NEW | ✅ |
| `apps/api/src/lib/delivery-reliability-repair.ts` | NEW | ✅ |
| `apps/api/src/lib/observability/delivery-reliability.ts` | NEW | ✅ |
| `apps/api/src/scripts/verifyDeliveryReliability.ts` | NEW | ✅ |
| `apps/api/src/scripts/reconcileDeliveryReliability.ts` | NEW | ✅ |
| `apps/api/src/scripts/repairDeliveryReliability.ts` | NEW | ✅ |
| `packages/db/src/models/customerReliability.ts` | NEW | ✅ |
| `packages/db/src/models/addressReliability.ts` | NEW | ✅ |
| `apps/web/src/components/orders/delivery-reliability-panel.tsx` | NEW | ✅ |
| `apps/api/tests/delivery-reliability*.test.ts` (8 files) | NEW | ✅ |
| `apps/api/tests/tracking-reliability-integration.test.ts` | NEW | ✅ |
| `packages/db/src/index.ts` | append-only re-exports | ✅ — execution map §1 explicitly permits |
| `apps/api/src/env.ts` | append 5 flags (4 boolean + 1 allowlist) | ✅ — defaults preserve pre-S1 behaviour |
| `apps/api/package.json` | append 3 npm scripts | ✅ |
| `apps/api/src/server/tracking.ts` | append fan-out at end of terminal block + 2 obs-emit points | ✅ — execution map §1 explicitly permits "additive wrapper" inside terminal block. **G6, G8, G2, G11 ordering, STATUS_MAP all untouched.** Single drift = unused `env` import (I2). |
| `apps/api/src/server/routers/orders.ts` | append `deliveryReliability` field on `getOrder` | ✅ — execution map §1 permits |
| `apps/api/src/server/routers/analytics.ts` | append 4 new procedures + helper, no existing procedure modified | ✅ |
| `apps/api/src/server/routers/adminObservability.ts` | append 3 new admin procedures | ✅ |
| `apps/web/src/components/orders/tracking-timeline-drawer.tsx` | append `<DeliveryReliabilityPanel>` mount, no other change | ✅ |

**Verdict:** additive-only compliance is intact. The single deviation (I2) is a tidy-up issue, not a contract violation. No file in the "DO-NOT-TOUCH for v1" or "ONLY ADDITIVE WRAPPERS" lists in `delivery-reliability-engineering-execution-map.md §1` was modified outside its allowed envelope.

---

## 9. Replay/idempotency invariants — summary table

| Invariant | Where enforced | Test |
|---|---|---|
| Chokepoint fan-out fires at-most-once per real terminal transition | `tracking.ts` G6 (atomic filter) + G8 (`nextStatus !== prevStatus`) | `tracking-reliability-integration.test.ts:262` |
| Chokepoint helpers do NOT dedupe by orderId; caller is the gate | `delivery-reliability-writers.ts:130` (doc) | `tracking-reliability-integration.test.ts:431` |
| Repair `$set` is idempotent | `delivery-reliability-repair.ts:134` | `delivery-reliability-hardening.test.ts:507` |
| Repair tolerance gate refuses to mutate small drifts | `delivery-reliability-repair.ts:213` | `delivery-reliability-hardening.test.ts:427` |
| Repair refuses to recreate missing aggregates | `delivery-reliability-repair.ts:204` | `delivery-reliability-hardening.test.ts:447` |
| Reconcile is window-aware (`firstOutcomeAt` floor) | `delivery-reliability-reconciliation.ts:372` | `delivery-reliability-hardening.test.ts:244` |
| Reconcile is read-only (no Order/aggregate writes) | `delivery-reliability-reconciliation.ts:1–42` (doc) | `delivery-reliability-hardening.test.ts:334` |
| Verify is read-only | `scripts/verifyDeliveryReliability.ts:35` (doc) | `delivery-reliability-rollout.test.ts:535` |

---

## 10. Exact recommended next implementation step

Do **one** small, well-scoped finalization patch covering the five tracked gaps. Order matters — the test additions are cheap and prove the doc/wiring fixes do not regress anything.

### Patch contents (in order)

1. **Emit `drift_detected` from `reconcileSlice`.** When `result.driftedKeys.length > 0`, emit one `recordReliabilityOutcome({event: "drift_detected", merchantId, axis, meta: { drifted: driftedKeys.length, missing: missingKeys.length, ordersScanned, truncated }})`. Single call, after the result is built, before return. Closes I1.
   - File: `apps/api/src/lib/delivery-reliability-reconciliation.ts`
   - New test in `delivery-reliability-hardening.test.ts`: assert `snapshotReliabilityCounters().driftDetected` advances when the reconciler finds drift, stays at 0 on a clean run.

2. **Remove the unused `env` import from `tracking.ts`.** Closes I2.
   - File: `apps/api/src/server/tracking.ts:23`
   - No new test needed; existing chokepoint tests must still pass.

3. **Add CLI tests for reconcile + repair scripts.** Closes I3 + I4.
   - New file: `apps/api/tests/delivery-reliability-cli.test.ts` (or extend hardening.test.ts).
   - Test `reconcileDeliveryReliability.__TEST.parseArgs` for all flags (`--merchant=`, `--axis=`, `--limit=`, `--key=`, `--json`).
   - Test `reconcileDeliveryReliability.__TEST.formatHumanReport` produces a non-empty string for both empty and populated reports.
   - Same for `repairDeliveryReliability.__TEST.parseArgs` (incl. `--apply`, `--limit=` clamping to `[1, MAX_REPAIR_BATCH]`).
   - Test `repairDeliveryReliability.__TEST.formatKeyResult` covers all `RepairAction.kind` discriminants.

4. **Add tests for the three new admin tRPC procedures.** Closes I5.
   - Extend `apps/api/tests/adminObservability.test.ts` (or create `delivery-reliability-admin.test.ts`):
     - `deliveryReliabilityRolloutState` — returns the gate matrix; `merchant` field populated when valid hex passed.
     - `deliveryReliabilityMerchantHealth` — returns null on invalid hex; returns aggregate-counts shape on valid hex.
     - `deliveryReliabilityDriftSample` — returns `null` on invalid hex; `scanLimit` is honoured up to 10_000; admin auth required.

5. **Update `delivery-reliability-engineering-execution-map.md` §1 + §S10.** Closes I6.
   - Replace the current "S9 / S10 — Production rollout (NO file changes)" row with a new S10 section that lists the four new lib files (`integrity`, `reconciliation`, `repair`, `rollout`), three scripts, three admin procs, package.json wiring, and the test file.
   - Mark S10 status as ✅.

6. **Update `delivery-reliability-rollout-runbook.md` §4 + §5.** Closes I7.
   - Add a "When drift is detected" subsection describing the `reconcile:delivery-reliability` invocation, the `--key` single-key mode, and the bounded-batch repair sequence (`--limit=N` then `--apply`).
   - Add a phase-gating sentence to §5: "Run `reconcile:delivery-reliability` per-merchant before promoting any phase. Drift > tolerance on any allowlisted merchant blocks the phase advance."

### Why one patch, not six

These items are coupled — emitting `drift_detected` (1) only makes operational sense if the runbook (6) tells operators to watch it. CLI tests (3, 4) and admin tests (5) prove the procedures landed before the runbook (6) instructs operators to use them. Doing this as a single patch avoids a mid-rollout state where the docs say "watch X" but X is never emitted.

### What NOT to do in this patch

- **Do NOT** change repair's `$set` to `$inc` to "make it look like a chokepoint write". The current absolute-$set is the correctness story.
- **Do NOT** lower `MAX_REPAIR_BATCH=100` or `DRIFT_TOLERANCE=2` "to be safer" — these are tuned and tested.
- **Do NOT** add an automated repair worker / scheduled job. v1's posture is explicit-invocation only.
- **Do NOT** start a backfill of pre-flag terminal Orders. The blueprint §3.1 / runbook §5 invariants forbid this.
- **Do NOT** add a `deliveryReliabilityRepair` tRPC procedure. Repair stays CLI-only by design.

---

## 11. Outcome

The S10 hardening surface is **safe to merge as-is**. Five minor finalization items remain (§3, §8); together they form a single small follow-up patch (§10) that closes documentation/test drift without touching the load-bearing implementation.

The replay-safety, rollback-safety, additive-only-compliance, and bounded-repair stories are all intact and tested. The chokepoint's existing guards (G6 / G8 / G2 / G11) are untouched. The §6.2 inherited caveat is now actively monitored via the new `invalid_transition` counter. The rollout runbook's recommended phase progression (Phase 0 → Phase 7, ~32 days) is supported end-to-end by the tooling on this branch.
