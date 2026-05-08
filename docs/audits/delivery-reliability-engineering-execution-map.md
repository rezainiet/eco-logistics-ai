# Delivery Reliability — Engineering Execution Map

**Status:** pre-implementation surgical plan, 2026-05-08. **NO code in this doc.**
**Audience:** the engineer who will implement v1.
**Companion docs:** [deep-scoring-audit](./deep-scoring-audit.md), [delivery-reliability-implementation-blueprint](./delivery-reliability-implementation-blueprint.md). Read both first.
**Contract:** every claim about an existing code path is anchored to `path:line` in the current tree. If the line numbers drift between this doc and the code, trust the code and re-anchor.

This document maps the blueprint to specific files and engineering motions. It is intended to make the implementation **non-improvisational** — every decision the engineer needs is here.

---

## 0. Reading order for the engineer

1. `apps/api/CLAUDE.md` — worker registration + graceful shutdown rules.
2. `apps/api/src/server/tracking.ts:77 applyTrackingEvents` (read fully) — this is the chokepoint you are extending.
3. `apps/api/src/lib/courier-intelligence.ts` (read fully) — this is the existing pattern you are mirroring.
4. `apps/api/src/lib/fraud-network.ts` (read `contributeOutcome` and the helper for hash) — this is the privacy + idempotency pattern you are reusing.
5. `apps/api/src/lib/operational-hints.ts` and `apps/api/src/lib/intent.ts` — these are the pure-function contract you must mirror.
6. This document.

Do not start coding before reading 1–5. The patterns are not optional.

---

## 1. File-level execution map (S1 → S10)

Legend:
- 🟢 LOW-RISK — additive, dead-until-flagged
- 🟡 MEDIUM-RISK — additive but visible to consumers; flag-gated
- 🔴 HIGH-RISK — touches a chokepoint; deserves the most review
- ⛔ DO NOT TOUCH — out of scope; refactoring here invalidates the v1 contract

### S1 — Pure function classifier + types

| File | Action | Risk | Reason |
|---|---|---|---|
| `apps/api/src/lib/delivery-reliability.ts` | **CREATE** | 🟢 | Holds `classifyDeliveryReliability` + types + signal-key constants. PURE module, no I/O. |
| `apps/api/tests/delivery-reliability.test.ts` | **CREATE** | 🟢 | Vitest unit tests against the pure function; no `mongodb-memory-server` needed. |

Additive-only: ✅. Replay-sensitive: no. Operationally critical: no. Feature flag: no. Tests: required (≥30 cases, see §5).
Rollback: revert two files; nothing else is affected.

### S2 — Aggregate schemas + indexes

| File | Action | Risk | Reason |
|---|---|---|---|
| `packages/db/src/models/customerReliability.ts` | **CREATE** | 🟢 | New Mongoose model. Mirror the shape of `courierPerformance.ts`. |
| `packages/db/src/models/addressReliability.ts` | **CREATE** | 🟢 | Same pattern. Add the bounded `distinctPhoneHashes` array. |
| `packages/db/src/index.ts` | **MODIFY** | 🟢 | Add two `export * from "./models/*.js"` lines. Pure re-export. |
| `apps/api/src/scripts/syncIndexes.ts` | **MODIFY** (optional) | 🟢 | Already enumerates models that need explicit `syncIndexes`. Append the two new models. |

Additive-only: ✅. Replay-sensitive: no (empty collections at create time). Operationally critical: no. Feature flag: no. Tests: not required for the schema files; the writers tested in S3 prove the shapes.
Rollback: drop the two collections; revert the four files. Idempotent.

### S3 — Writer helpers + observability primitives (NOT YET WIRED)

| File | Action | Risk | Reason |
|---|---|---|---|
| `apps/api/src/lib/delivery-reliability.ts` | **MODIFY** | 🟢 | Add `recordCustomerOutcome`, `recordAddressOutcome`. Add the per-process counter map (mirror `lib/queue.ts:_counters`). |
| `apps/api/tests/delivery-reliability-writers.test.ts` | **CREATE** | 🟢 | Integration test using `mongodb-memory-server`. Drives the writers directly with no chokepoint. |

Additive-only: ✅. Replay-sensitive: helpers are written so callers, not the helpers, are responsible for replay safety (§3 of this doc). Operationally critical: no (still dead until S4). Feature flag: no. Tests: required.
Rollback: revert two files.

### S4 — Wire writer helpers into the chokepoint

| File | Action | Risk | Reason |
|---|---|---|---|
| `apps/api/src/server/tracking.ts` | **MODIFY** | 🔴 | Inside `applyTrackingEvents`'s existing terminal block, add two new fire-and-forget fan-outs (§2). NO other change. |
| `apps/api/src/env.ts` | **MODIFY** | 🟢 | Add `DELIVERY_RELIABILITY_WRITE_ENABLED` (boolean, default `false`). |
| `apps/api/tests/tracking-reliability-integration.test.ts` | **CREATE** | 🟢 | Drives `applyTrackingEvents` end-to-end against in-memory Mongo: status flip → assert exactly one row per axis with correct counters. Replay-storm scenario MUST be one of the cases. |
| `apps/api/CLAUDE.md` | **MODIFY** (optional) | 🟢 | Add a one-line note about the new fan-out so future audits don't miss it. |

Additive-only: ✅ (the new fan-out additions don't replace anything). Replay-sensitive: 🔴 yes — the chokepoint's existing guards must continue to hold (§2). Operationally critical: 🔴 yes (this is THE chokepoint). Feature flag: ✅ required. Tests: required, including replay storm (§5).
Rollback: revert chokepoint change; flag flip alone is sufficient if revert is non-trivial.

### S5 — Observability instrumentation

| File | Action | Risk | Reason |
|---|---|---|---|
| `apps/api/src/lib/delivery-reliability.ts` | **MODIFY** | 🟢 | Add structured-log emission inside the helpers (`evt: delivery_reliability.aggregated` and `delivery_reliability.write_failed`); add classifier-side `evt: delivery_reliability.classified` (called from S6's path). |
| `apps/api/src/lib/anomaly.ts` | **MODIFY** | 🟡 | Add a fifth detector: `detectDeliveryReliabilityDrift`. Append it to `runAnomalyDetection`'s detector array. |
| `apps/api/src/server/routers/adminObservability.ts` | **MODIFY** | 🟢 | Expose the new counters via the existing `/admin/system` snapshot output. Pure additive read. |

Additive-only: ✅. Replay-sensitive: no. Operationally critical: 🟡 (anomaly detector is operationally important but failure is benign; existing detectors are independent). Feature flag: no (logs + counters are always-on; detector reads are read-only and cheap). Tests: include `anomaly.test.ts`-equivalent for the new detector.
Rollback: revert three files.

### S6 — Read-time integration in `getOrder`

| File | Action | Risk | Reason |
|---|---|---|---|
| `apps/api/src/server/routers/orders.ts` | **MODIFY** | 🟡 | Inside the `getOrder` procedure (currently around line 1636), add three parallel small reads (`CustomerReliability.findOne`, `AddressReliability.findOne`, reuse existing courier+network reads), then call `classifyDeliveryReliability(...)`. Append the result to the response. |
| `apps/api/src/env.ts` | **MODIFY** | 🟢 | Add `DELIVERY_RELIABILITY_READ_ENABLED` (boolean, default `false`). |
| `apps/api/tests/orders.delivery-reliability.test.ts` | **CREATE** | 🟢 | Integration test: getOrder returns `deliveryReliability` when flag on; absent when flag off; `tier: "no_data"` when aggregates absent; tolerates one read failure. |
| `packages/types/src/router.ts` | **NO CHANGE** | ⛔ | The router type is automatically inferred from `appRouter`. Do not hand-edit. |

Additive-only: ✅. Replay-sensitive: no. Operationally critical: 🟡 (read path latency for a hot endpoint). Feature flag: ✅ required. Tests: required, including p95 latency check.
Rollback: flip flag off.

### S7 — Analytics tRPC procedure

| File | Action | Risk | Reason |
|---|---|---|---|
| `apps/api/src/server/routers/analytics.ts` | **MODIFY** | 🟡 | Append `deliveryReliabilitySummary` procedure. Read-only aggregate over `CustomerReliability` + `AddressReliability` for the merchant. |
| `apps/api/src/env.ts` | **MODIFY** | 🟢 | Add `DELIVERY_RELIABILITY_ANALYTICS` (default `false`). |
| `apps/api/tests/analytics.delivery-reliability.test.ts` | **CREATE** | 🟢 | Read-side integration test. |

Additive-only: ✅. Replay-sensitive: no. Operationally critical: 🟢. Feature flag: ✅. Tests: required.

### S8 — UI surface

| File | Action | Risk | Reason |
|---|---|---|---|
| `apps/web/src/components/orders/delivery-reliability-panel.tsx` | **CREATE** | 🟢 | New presentational component. Mirrors `intelligence-panels.tsx` shape (badge + signals list). |
| `apps/web/src/components/orders/tracking-timeline-drawer.tsx` | **MODIFY** | 🟡 | Mount `<DeliveryReliabilityPanel>` next to `<OperationalHintPanel>` (line 179 area). Conditional on `order.deliveryReliability` being present. |
| `apps/web/src/lib/i18n.tsx` (or equivalent) | **MODIFY** (optional) | 🟢 | Localized copy if i18n is in use. |

Additive-only: ✅. Replay-sensitive: no. Operationally critical: no. Feature flag: shares S6's flag (data absence ⇒ panel hidden naturally). Tests: Playwright visual if available.

### S9 — Per-merchant rollout gates + verification CLI

| File | Action | Risk | Reason |
|---|---|---|---|
| `apps/api/src/lib/delivery-reliability-rollout.ts` | **CREATE** | 🟢 | Single source of truth for the four flags + optional staged-rollout merchant allowlist. Pure (env-only). |
| `apps/api/src/scripts/verifyDeliveryReliability.ts` | **CREATE** | 🟢 | Read-only health check CLI (rollout state + counters + per-merchant stale% + integrity sample). |
| `apps/api/src/env.ts` | **MODIFY** | 🟢 | Add `DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS` allowlist. |
| `apps/api/src/server/routers/orders.ts` | **MODIFY** | 🟢 | `loadDeliveryReliability` switches to per-merchant gate. |
| `apps/api/src/server/routers/analytics.ts` | **MODIFY** | 🟢 | Analytics procedures swap to `isAnalyticsEnabledForMerchant`. |
| `apps/api/src/server/tracking.ts` | **MODIFY** | 🟡 | Chokepoint fan-out swaps to `isWriteEnabledForMerchant`. Filter / dedupe / status guard untouched. |
| `apps/api/package.json` | **MODIFY** | 🟢 | Wire `verify:delivery-reliability` npm script. |
| `docs/audits/delivery-reliability-rollout-runbook.md` | **CREATE** | 🟢 | 32-day phased rollout (write → read → analytics) with Tier-1/2/3 rollback procedures. |
| `apps/api/tests/delivery-reliability-rollout.test.ts` | **CREATE** | 🟢 | Gate matrix + chokepoint integration + verify-CLI helpers. |

Additive-only: ✅. Replay-sensitive: no. Operationally critical: 🟢. Feature flag: ✅ (gates are themselves the flags). Status: ✅ shipped.

### S10 — Operational hardening (reconciliation + repair + admin diagnostics)

| File | Action | Risk | Reason |
|---|---|---|---|
| `apps/api/src/lib/delivery-reliability-integrity.ts` | **CREATE** | 🟢 | Pure-function integrity / drift checks (negative counters, monotonic timestamps, bounded `distinctPhoneHashes`, replay-anomaly, aggregate-vs-source mismatch). 11 stable `IntegrityCode` types. No I/O. |
| `apps/api/src/lib/delivery-reliability-reconciliation.ts` | **CREATE** | 🟡 | Read-only drift reconciler. Window-aware (uses each aggregate's `firstOutcomeAt`). Bounded at `MAX_RECONCILE_SCAN=10000` per merchant scan. Emits `drift_detected` (single-shot per slice) when drift > tolerance OR a missing aggregate is observed. |
| `apps/api/src/lib/delivery-reliability-repair.ts` | **CREATE** | 🟡 | Bounded explicit-invocation repair. **Dry-run by default.** `MAX_REPAIR_BATCH=100`. Idempotent `$set` of absolute counter values from the reconciler's expected output. Drift-tolerance gate (`DRIFT_TOLERANCE=2`) refuses small races. Refuses to recreate missing aggregates (no backfill in v1). Audit trail via `integrity_warning` events. |
| `apps/api/src/scripts/reconcileDeliveryReliability.ts` | **CREATE** | 🟢 | CLI wrapper around `reconcileSlice`. `--merchant` / `--axis` / `--limit` / `--key` / `--json`. Read-only. |
| `apps/api/src/scripts/repairDeliveryReliability.ts` | **CREATE** | 🟡 | CLI wrapper around `rebuildAggregateForKey` / `rebuildSliceForMerchant`. **Dry-run unless `--apply`.** `--limit` clamped to `[1, MAX_REPAIR_BATCH]`. |
| `apps/api/src/server/routers/adminObservability.ts` | **MODIFY** | 🟢 | Append three admin-only read procedures: `deliveryReliabilityRolloutState`, `deliveryReliabilityMerchantHealth`, `deliveryReliabilityDriftSample`. No mutation procedures. |
| `apps/api/src/server/tracking.ts` | **MODIFY** | 🟡 | Add two observability emit-points (`invalid_transition` on rejected atomic write — §6.2 caveat manifesting; `replay_suppressed` on terminal-status no-op replay). Filter / dedupe / status guard / fan-out ordering untouched. |
| `apps/api/package.json` | **MODIFY** | 🟢 | Wire `reconcile:delivery-reliability` and `repair:delivery-reliability` npm scripts. |
| `apps/api/tests/delivery-reliability-integrity.test.ts` | **CREATE** | 🟢 | Pure-function tests for the integrity helpers. |
| `apps/api/tests/delivery-reliability-hardening.test.ts` | **CREATE** | 🟢 | Reconciliation + repair correctness, idempotency, bounded-batch, replay-side-effect-free, drift-tolerance gate, `drift_detected` emit. |
| `apps/api/tests/delivery-reliability-cli.test.ts` | **CREATE** | 🟢 | Reconcile + repair CLI helper tests (`parseArgs`, `formatHumanReport`, `formatKeyResult`, `formatSliceResult`, `formatSingleKeyResult`). |
| `apps/api/tests/delivery-reliability-admin.test.ts` | **CREATE** | 🟢 | Tests for the three admin tRPC procedures (admin-role gating, graceful degradation on bad input, `scanLimit` bounds, no-write invariant). |

Additive-only: ✅. Replay-sensitive: ✅ verified — repair uses idempotent `$set`, refuses small drifts (`DRIFT_TOLERANCE=2`), refuses to recreate missing aggregates, never re-enters `applyTrackingEvents`. Operationally critical: 🟡 (operator-triggered, dry-run by default). Status: ✅ shipped (S10 finalization patch closed `drift_detected` emit, CLI/admin test coverage, and doc drift).

#### S10 invariants (binding)

1. **Repair is operator-triggered only.** No worker, no scheduled job, no admin endpoint mutates aggregates. Repair is exclusively the `repair:delivery-reliability` CLI with `--apply` opt-in.
2. **Repair is bounded.** Per-invocation cap is `MAX_REPAIR_BATCH=100`. Operators with larger drift cohorts run multiple bounded passes.
3. **Repair is idempotent.** Absolute `$set` of `expected.*Count` from the reconciler. Re-running with the same Order state produces a byte-identical write.
4. **Reconciler is read-only.** No write paths exist in `delivery-reliability-reconciliation.ts`. Verified at `delivery-reliability-hardening.test.ts:334`.
5. **Reconciler is window-aware.** Pre-flag terminal Orders (those preceding the aggregate's `firstOutcomeAt`) are NOT counted as drift.
6. **Drift tolerance is non-negotiable.** `DRIFT_TOLERANCE=2` covers the chokepoint's small race window where a terminal flip fires the helper before the aggregator's read snapshot completes. Repair refuses to mutate at or below this threshold.
7. **No backfill in v1.** Repair refuses to recreate missing aggregates. Cancel-path writers (fraud reject, automation-stale, sms-inbound NO) remain non-instrumented (deep-audit §3.3).

### Production rollout — flag flips (NO file changes)

| Action |
|---|
| Flip `DELIVERY_RELIABILITY_WRITE_ENABLED=1` first. Watch `verify:delivery-reliability` + `reconcile:delivery-reliability` for 7 days per `delivery-reliability-rollout-runbook.md`. |
| Flip `DELIVERY_RELIABILITY_READ_ENABLED=1`. UI panel becomes visible. |
| Flip `DELIVERY_RELIABILITY_ANALYTICS_ENABLED=1`. Analytics procedures answer for every merchant. |

Rollback: any flag flips back to `0` independently. No data loss; aggregates remain valid.

### Files explicitly DO-NOT-TOUCH for v1

| File | Why |
|---|---|
| `apps/api/src/server/risk.ts` | `computeRisk` is the fraud engine. Adding a delivery-reliability signal here is **out of scope**. |
| `apps/api/src/server/ingest.ts` | Ingestion path. The new aggregates write at terminal-flip time, not at ingest. Touching this file is a sign the design has drifted. |
| `apps/api/src/server/courier-replay.ts` | Replay path. The new fan-out runs from `applyTrackingEvents`; replay re-enters that function. Do not duplicate the call here. |
| `apps/api/src/server/webhooks/courier.ts` | Webhook entry. Same reason. |
| `apps/api/src/server/webhooks/integrations.ts` | Webhook entry. Same reason. |
| `apps/api/src/lib/queue.ts` | `safeEnqueue` discriminated union. v1 helpers do not enqueue; do not change the enqueue surface. |
| `apps/api/src/lib/courier-intelligence.ts` | The existing `recordCourierOutcome` / `selectBestCourier`. Mirroring its pattern, NOT modifying it. |
| `apps/api/src/lib/fraud-network.ts` | Cross-merchant network. Shared hash helper is reused via import; nothing here changes. |
| `packages/db/src/models/order.ts` | No `Order.deliveryReliability` subdoc in v1 (v2 only). |
| `packages/db/src/models/courierPerformance.ts` | Existing model. v1 does not modify. |
| `packages/db/src/models/fraudPrediction.ts` | Existing. |
| `packages/db/src/models/fraudSignal.ts` | Existing. |
| `apps/api/src/lib/operational-hints.ts` | Per-order acute-attention surface, distinct domain from delivery reliability. |
| `apps/api/src/lib/intent.ts` | Buyer-engagement scoring. Distinct domain. |
| `apps/api/src/lib/address-intelligence.ts` | Pure address-quality classifier. Distinct domain (its output is an INPUT to delivery reliability). |
| `apps/api/src/workers/riskRecompute.ts` | Risk recompute fan-out. Distinct domain. |
| `apps/api/src/workers/fraudWeightTuning.ts` | Monthly fraud tuner. Distinct domain. |
| `apps/api/src/workers/automationBook.ts` | Auto-book uses `selectBestCourier`. v1 leaves selection unchanged. |
| `apps/web/src/components/orders/operational-hint-panel.tsx` | Existing UI; do not merge with the new panel. |
| `apps/web/src/components/orders/intelligence-panels.tsx` | Existing UI; do not merge. |

### Files that may ONLY receive ADDITIVE WRAPPERS

| File | What is allowed |
|---|---|
| `apps/api/src/server/tracking.ts` | Add 1–2 new `void` calls inside the existing terminal block, beside existing fan-outs. **DO NOT** modify the filter, status guard, dedupe key derivation, or `STATUS_MAP`. |
| `apps/api/src/server/routers/orders.ts` | Add 1 classifier call inside `getOrder` AFTER the existing `operationalHint` neighborhood. **DO NOT** modify the existing fields in the response shape; add a NEW `deliveryReliability` field. |
| `apps/api/src/server/routers/analytics.ts` | Append a new procedure. **DO NOT** modify any existing procedure. |
| `apps/api/src/lib/anomaly.ts` | Append a new detector to the array. **DO NOT** change existing detector logic or thresholds. |
| `packages/db/src/index.ts` | Add re-exports. **DO NOT** rename existing exports. |

### Files where logic must remain OBSERVATIONAL-ONLY in v1

| File | Why |
|---|---|
| `apps/api/src/lib/delivery-reliability.ts:classifyDeliveryReliability` | The pure function never decides automation, fraud, or status. Output flows ONLY to the `getOrder` response. |
| `apps/api/src/lib/delivery-reliability.ts:recordCustomerOutcome` | Writes to one collection only. Never reads `Order`. Never enqueues. Never throws. |
| `apps/api/src/lib/delivery-reliability.ts:recordAddressOutcome` | Same. |
| `apps/api/src/server/routers/analytics.ts:deliveryReliabilitySummary` | Read-only aggregate. No write side. |

---

## 2. Chokepoint safety map (`applyTrackingEvents`)

### 2.1 Existing guards (load-bearing — DO NOT MODIFY)

`apps/api/src/server/tracking.ts:77`. Numbered for unambiguous reference.

| # | Line range (approx, current tree) | Guard | What it protects |
|---|-----------------------------------|-------|------------------|
| G1 | ~86–95   | `existing` set built from `logistics.trackingEvents.dedupeKey` and per-event dedupe drop | Webhook re-delivery doesn't re-append the same event |
| G2 | ~91      | `dedupeKeyFor(providerStatus, description, location)` content-hash | Polling and webhook overlap doesn't double-append |
| G3 | ~107     | `STATUS_MAP[normalizedStatus] ?? prevStatus` | Unmapped event preserves prevStatus — no spurious transition |
| G4 | ~110–124 | `set` building branches by `source: "webhook" \| "poll"` and presence of deliveredAt/returnedAt | Source-correct timestamps; idempotent `$set` of `deliveredAt` only when absent |
| G5 | ~131–138 | `$push` with `$slice: -MAX_TRACKING_EVENTS(100)` | Document size cap |
| G6 | ~150–157 | filter `{_id, "order.status": $in [active set ∪ prevStatus], "logistics.trackingEvents.dedupeKey": $nin newKeys}` | **Atomic guard.** Stale-snapshot writers + dedupe-race writers see no-op. |
| G7 | ~158–162 | `effectivelyAppended = persisted ? newEvents.length : 0` | Caller sees zero new events when guard rejects |
| G8 | ~164     | `if (nextStatus !== prevStatus)` gate around all fan-outs | Fan-outs only fire on real transitions |
| G9 | ~165–172 | `MerchantStats.updateOne` $inc[prev]:-1, $inc[next]:+1 | Stats-counter coherence |
| G10| ~174–185 | RTO branch: `enqueueRescore({trigger:"order.rto"})` | Rescore fan-out is at-most-once per transition |
| G11| ~191–264 | Terminal block: `if (nextStatus ∈ {delivered, rto, cancelled})` | Outcome-side fan-outs (FraudPrediction.outcome, contributeOutcome, recordCourierOutcome) |
| G12| `void X(...).catch(...)` everywhere in the terminal block | Side-effect failures never reach back into the caller |

### 2.2 Where the new fan-out attaches

**Inside G11. Beside G12 calls. Never outside.**

The new code lives between the existing `recordCourierOutcome` call and the closing `}` of the terminal block. Two new `void` calls:

```
PSEUDO-PLACEMENT (illustrative — DO NOT copy as code):

  if (nextStatus === "delivered" || nextStatus === "rto" || nextStatus === "cancelled") {
    // [existing] FraudPrediction outcome stamp                        (G11.a)
    // [existing] full = await Order.findById(...).select(...).lean()  (G11.b)
    // [existing] phoneHash = hashPhoneForNetwork(phone)               (G11.c)
    // [existing] addressHash = ... (recompute from raw if missing)    (G11.d)
    // [existing] void contributeOutcome(...)                          (G11.e)
    // [existing] orderCourier && district → void recordCourierOutcome (G11.f)
    //
    //  ┌──────────── new fan-out attaches here ────────────┐
    //  │
    //  │  if (env.DELIVERY_RELIABILITY_WRITE_ENABLED) {
    //  │    if (phoneHash) {
    //  │      void recordCustomerOutcome({
    //  │        merchantId: order.merchantId,
    //  │        phoneHash,
    //  │        outcome: nextStatus,
    //  │        district: district ?? null,
    //  │        orderId: order._id,
    //  │      }).catch(err => console.error("[delivery-reliability]", ...));
    //  │    }
    //  │    if (addressHash) {
    //  │      void recordAddressOutcome({
    //  │        merchantId: order.merchantId,
    //  │        addressHash,
    //  │        phoneHash: phoneHash ?? null,
    //  │        outcome: nextStatus,
    //  │        district: district ?? null,
    //  │        orderId: order._id,
    //  │      }).catch(err => console.error("[delivery-reliability]", ...));
    //  │    }
    //  │  }
    //  └────────────────────────────────────────────────────┘
  }
```

### 2.3 Attachment rules — non-negotiable

1. **AFTER `Order.updateOne` resolves and `effectivelyAppended` is computed.** The fan-out runs only when the order write actually persisted (i.e., `nextStatus !== prevStatus` and the atomic guard accepted).
2. **AFTER the existing four fan-outs** (FraudPrediction, FraudSignal, CourierPerformance, MerchantStats). Adding ours last keeps the existing code untouched and makes diffs reviewable.
3. **`void` + `.catch(console.error)`** — same pattern as `recordCourierOutcome`. Never `await`ed. A new `await` here regresses webhook latency.
4. **No new try/catch wrapping the existing block.** The helpers carry their own try/catch internally (§3). Wrapping the existing block changes its error semantics and is forbidden.
5. **Reuse the already-computed `phoneHash` and `addressHash`.** They are computed once in G11.c/G11.d. Do not recompute them.
6. **The flag check is `if (env.DELIVERY_RELIABILITY_WRITE_ENABLED) { ... }` ONLY around the two new calls.** Do not extend the gate to anything else.
7. **No new model imports inside `tracking.ts`.** All Mongo I/O lives in `lib/delivery-reliability.ts`. `tracking.ts` only imports the two helper functions.
8. **No new conditional logic inside G11 beyond the helper calls.** If the helpers need richer inputs, package them inside the helper, not at the call site.

### 2.4 Things that MUST NEVER happen inside `applyTrackingEvents`

| Forbidden change | Why |
|---|---|
| Modifying G6 (the atomic filter) | Replay correctness is anchored on the exact `$nin newKeys` predicate. |
| Modifying G2 (`dedupeKeyFor`) | Existing rows' dedupe keys would no longer match new ones; replays would double-append. |
| Adding `await` inside G11 | Latency regresses for every webhook + poll cycle. |
| Adding a synchronous read of `Order` after the write inside G11 | Already done once for G11.b's `customer.phone/address/district` read. Don't add another. |
| Throwing the helper's error back up | Order write succeeded; failing the function would mislead the caller (route handler) into surfacing 500. |
| Adding a transaction to wrap the new fan-out | Existing fan-outs are deliberately separate from the order-write txn. New helpers are best-effort. |
| Using `findOneAndUpdate({_id}, ..., {new:true})` patterns to round-trip the aggregate row | The helpers are `$inc` upserts; round-tripping wastes a read. |
| Reading any new collection from inside the chokepoint | Reads belong in `getOrder`, not in `applyTrackingEvents`. |
| Reordering the existing G11 calls | The current order is reviewable; reorder makes diffs noisy. |
| Inserting the new fan-out outside G8's gate | Non-transition fan-outs would trigger on every webhook event, double-counting on every poll. |

### 2.5 Things the chokepoint MUST remain

- **Side-effect free outside the explicit fan-outs.** No silent metric writes, no audit emissions inside the helpers' code paths.
- **Deterministic.** Same inputs in same database state → same outputs.
- **Replay-safe.** Already proven by G2 + G6 + G8. New fan-out inherits.
- **Single chokepoint.** Per the deep audit §3.6, this is the one writer of `delivered`/`rto`. Adding a second writer in v1 is forbidden.

---

## 3. Writer contracts

### 3.1 `recordCustomerOutcome` (in `apps/api/src/lib/delivery-reliability.ts`)

```
Input contract:
  {
    merchantId: ObjectId | string         REQUIRED
    phoneHash:  string                    REQUIRED, length 32 (sha256[:32]); empty/null → silent return
    outcome:    "delivered" | "rto" | "cancelled"   REQUIRED
    district?:  string | null             optional; if provided, normalized via normalizeDistrict
    orderId?:   ObjectId | null           optional; written to lastOrderId for telemetry only
  }

Normalization:
  - merchantId → coerce to ObjectId via `new Types.ObjectId(String(...))`. Same idiom as
    `lib/courier-intelligence.ts:206`.
  - phoneHash → use as-is. Caller (chokepoint) computes via `hashPhoneForNetwork` from
    `lib/fraud-network.ts:47`. NEVER recompute or accept raw phone.
  - district → if provided, `normalizeDistrict(district)` from `lib/district.ts`. Defensive.
  - outcome → no transformation; helper expects already-narrowed enum.

Null-handling rules:
  - empty/missing phoneHash      → return immediately (silent). NO throw, NO log.
  - missing merchantId           → return immediately (silent). Caller's bug; do not surface.
  - missing outcome              → return immediately. Defensive; should never happen.
  - missing district             → proceed; do not write district fields.
  - missing orderId              → proceed.

Idempotency expectations:
  - Helper does NOT dedupe by orderId. Caller (chokepoint) is the sole gatekeeper.
  - Each call performs ONE upsert with $inc + $set + $setOnInsert. A repeated call
    advances the counter; idempotency is the chokepoint's responsibility, not the helper's.
  - Helper IS idempotent in the trivial sense: same inputs from same caller produce same
    Mongo update doc → if the call were ever issued under a transactional retry, the
    update is well-defined.

Logging behavior:
  - On successful upsert: emit single-line JSON `evt: delivery_reliability.aggregated`
    with fields per blueprint §4.1.
  - On caught throw: emit `evt: delivery_reliability.write_failed` + bump
    `customerReliability.failures` counter. Re-throw is FORBIDDEN.

Error-handling rules:
  - One try/catch wraps the Mongo call.
  - Catch logs and returns. NEVER re-throws.
  - This pattern matches `recordCourierOutcome` (`courier-intelligence.ts:374`) and
    `contributeOutcome` (`fraud-network.ts:315`) — copy the shape.

Performance expectations:
  - Single upsert via `CustomerReliability.updateOne(..., {upsert: true})`.
  - Hits the unique compound index → O(log n).
  - Target p95 ≤ 5 ms. Target p99 ≤ 30 ms (Mongo writeConcern majority on Atlas).
  - The helper does NOT batch and does NOT defer. Fire-and-forget at the caller is
    sufficient; a second-layer queue would invert the chokepoint guarantee.

Forbidden behavior:
  ❌ Read Order, Merchant, or any other model.
  ❌ Recompute phoneHash from a raw phone.
  ❌ Read or write Redis.
  ❌ Enqueue a BullMQ job.
  ❌ Mutate `fraud.*`, `automation.*`, `MerchantStats`, `FraudPrediction`, `FraudSignal`.
  ❌ Call `applyTrackingEvents` (cyclic).
  ❌ Throw back into the caller. Any exception is caught + logged + swallowed.
  ❌ Hold a connection / cursor across awaits.
  ❌ Use Mongo transactions.

Update shape (illustrative, not code):
  CustomerReliability.updateOne(
    { merchantId, phoneHash },
    {
      $setOnInsert: { merchantId, phoneHash, firstOutcomeAt: now },
      $set: { lastOutcomeAt: now, lastDistrict: districtOrUndefined,
              lastOrderId: orderIdOrUndefined },
      $inc: { [counterField(outcome)]: 1 },
    },
    { upsert: true },
  )
```

### 3.2 `recordAddressOutcome` (in `apps/api/src/lib/delivery-reliability.ts`)

Same shape as 3.1, plus:

```
Additional input:
  phoneHash?: string | null   optional; if present, added to distinctPhoneHashes (capped)

Additional update:
  - distinctPhoneHashes maintained via aggregation-pipeline $set:
      distinctPhoneHashes: $slice [
        $setUnion [ $ifNull [$distinctPhoneHashes, []], [phoneHash] ],
        -DISTINCT_PHONE_HASH_CAP   // = 32
      ]
  - Same $ifNull-guards on every counter (the FraudSignal pattern from
    `lib/fraud-network.ts:340–360`) because aggregation-pipeline upserts
    don't apply schema defaults.

Same forbidden behavior as 3.1, plus:
  ❌ Storing the raw address. addressHash only.
  ❌ Storing the raw phone. phoneHash only.
```

### 3.3 `classifyDeliveryReliability` (in `apps/api/src/lib/delivery-reliability.ts`)

```
Input contract — STRUCTURAL shapes, NOT Mongoose documents:
  {
    customerStats?: { deliveredCount, rtoCount, cancelledCount,
                      lastOutcomeAt, firstOutcomeAt }
    addressStats?:  { deliveredCount, rtoCount, cancelledCount,
                      lastOutcomeAt, firstOutcomeAt,
                      distinctPhoneCount }
    courierStats?:  {
                      successRate, rtoRate, avgDeliveryHours,
                      observations, coldStart, stale,
                      matchedOn  // "district" | "global" | "cold_start"
                    }
    thana?:         string | null
    addressQuality?: { completeness, score, missingHints[] }
    networkAggregate?: NetworkRiskAggregate    // existing type
    now?:           Date  // injectable for tests; defaults to new Date()
  }

Output contract:
  {
    score: number 0..100
    tier: "verified" | "implicit" | "unverified" | "no_data"
    signals: [{ key: STABLE_KEY, weight: number, detail: string }]
    samplesConsidered: { customer: number, address: number, courier: number }
    computedAt: Date
  }

Purity rules (binding):
  ✅ Same inputs → same outputs.
  ✅ NO DB I/O.
  ✅ NO env reads.
  ✅ NO clock reads (use `now` or `new Date()` once at top).
  ✅ NO Mongoose imports inside the function body.

  Unit tests MUST be runnable without `mongodb-memory-server`.

No-data rule:
  - If ALL of {customerStats, addressStats, courierStats} are absent OR
    every observation count is below MIN_OBSERVATIONS_FOR_SIGNAL (=3):
      return { score: 0, tier: "no_data", signals: [{key:"no_history_data",
        weight: 0, detail: "Not enough delivery history yet to score this
        order."}], samplesConsidered: {0,0,0}, computedAt }

Tier thresholds:
  ≥70 → "verified"     ≥40 → "implicit"     <40 → "unverified"
  no-data short-circuit above

Stale-input handling:
  - customerStats.lastOutcomeAt > 180d ago → treat as cold_start (mirror
    courier-intelligence.ts:113 behavior)
  - addressStats.lastOutcomeAt > 180d ago → same
  - courierStats.stale === true → already classified by selectBestCourier;
    classifier accepts the flag and downweights

Observability:
  - The CALLER (getOrder path) emits `evt: delivery_reliability.classified`
    after invoking the function. The function itself does NOT log. Pure.

Forbidden behavior:
  ❌ Mongo I/O.
  ❌ Reads of any global mutable state.
  ❌ Throws (return no_data on input degenerate cases instead).
  ❌ Reading env.
  ❌ Mutating any input object.
  ❌ Calling computeRisk, lookupNetworkRisk, or any other engine.
  ❌ Coupling to fraud, automation, or order workflow.
```

### 3.4 Helper invariants — SUMMARY TABLE

| Question | Answer |
|---|---|
| May helpers throw? | ❌ Never back to caller. Internal try/catch only. |
| May helpers read Order? | ❌ Never. The caller passes whatever data is needed. |
| May helpers trigger side-effects beyond their own collection write? | ❌ Never. `recordCustomerOutcome` writes only to `customer_reliabilities`. `recordAddressOutcome` writes only to `address_reliabilities`. |
| May helpers enqueue jobs? | ❌ Never. v1 has no job-driven path. |
| May helpers mutate fraud state? | ❌ Never. The classifier's output never feeds `computeRisk`. |
| May helpers run inside a Mongo transaction? | ❌ Never. Best-effort fan-out. |
| May the classifier read a Mongoose doc? | ❌ Never. Inputs are structural shapes. |
| May the classifier write to Mongo? | ❌ Never. Pure. |
| May the classifier emit logs? | ❌ The caller logs. Function is pure. |
| May the classifier read the env? | ❌ Never. Caller is the gate. |

---

## 4. Helper invariants (deeper)

These are the load-bearing invariants the helpers' implementation must preserve. They map 1:1 to test assertions.

| Invariant | Where enforced | Test assertion |
|---|---|---|
| Helper never throws back to caller | try/catch wrapping Mongo call | call helper with deliberately invalid merchantId; assert resolves; assert error log emitted |
| Helper writes exactly one row per call | upsert by unique key | call twice with same key; assert one row, counters = 2 |
| Helper does not dedupe across calls | helper has no orderId index | call twice with same orderId; assert counters = 2 |
| Helper increments only the named counter | `$inc: { [counterField]: 1 }` | call with `delivered`; assert deliveredCount=1, rto=0, cancelled=0 |
| Helper sets firstOutcomeAt on insert only | `$setOnInsert` | call twice; assert firstOutcomeAt unchanged on second |
| Helper sets lastOutcomeAt on every write | `$set` | call twice with different `now`; assert lastOutcomeAt advances |
| addressReliability caps distinctPhoneHashes at 32 | `$slice: -32` | call 50× with distinct phoneHashes; assert array length = 32, ordered by recency |
| Helper does not read Order | static analysis | grep helper file for `Order` import — must be absent |
| Helper does not import BullMQ | static analysis | grep helper file for `bullmq` — must be absent |
| Helper does not call applyTrackingEvents | static analysis | grep helper file for `applyTrackingEvents` — must be absent |
| Helper resolves silently on null phoneHash | early-return | call with empty phoneHash; assert no Mongo call, no log |
| classifier does not import Mongoose | static analysis | grep classifier file — must not import `@ecom/db` model objects |
| classifier emits no logs | code inspection | classifier body has no `console.*` calls |

---

## 5. Testing matrix

### 5.1 By layer

#### S1 — Pure-function classifier tests (`apps/api/tests/delivery-reliability.test.ts`)

Required scenarios (≥30):

```
GROUP A — no-data semantics (4 tests)
  - all three stats absent → tier:"no_data"
  - all three stats present but observations<3 each → tier:"no_data"
  - customerStats present (≥3) only → tier transitions correctly
  - networkAggregate without other stats → tier:"no_data" (network is non-load-bearing)

GROUP B — tier thresholds (6 tests)
  - score=0 → unverified
  - score=39 → unverified, score=40 → implicit
  - score=69 → implicit, score=70 → verified
  - score=100 → verified
  - boundaries on each axis

GROUP C — signal precedence + composition (8 tests)
  - customer_repeat_success + courier_lane_strong + organic-direction → verified
  - address_repeat_rto alone (medium weight) → unverified
  - customer_low_success_rate (high weight) + courier_lane_strong → implicit (mixed)
  - all positive signals → score capped at 100
  - all negative signals → score floored at 0
  - paid-social analog (no positive signal) → unverified
  - signal `detail` strings render verbatim (length, content)
  - signal weights sum equals score (within rounding)

GROUP D — staleness (4 tests)
  - customerStats with lastOutcomeAt 200d ago → treated as cold-start
  - courierStats.stale=true → classifier respects the flag
  - addressStats lastOutcomeAt 200d ago → treated as cold-start
  - mixed: stale customer + fresh courier → uses courier signal

GROUP E — degenerate input (5 tests)
  - undefined inputs object → still returns no_data (not throw)
  - empty arrays in optional fields → no crash
  - negative count anywhere → defensive clamp
  - NaN in stats fields → defensive clamp
  - distinctPhoneCount > 1000 (impossible but defensive) → bounded handling

GROUP F — purity (3 tests)
  - same inputs → same outputs (run 2× with frozen `now`, deep-equal)
  - input object unchanged after call (object freeze + invocation + frozen-still)
  - classifier does not throw on any input enumerated above
```

#### S3 — Writer integration tests (`apps/api/tests/delivery-reliability-writers.test.ts`)

Uses `mongodb-memory-server` (existing setup at `tests/globalSetup.ts`).

Required scenarios:

```
GROUP A — recordCustomerOutcome (8 tests)
  - first call inserts row with counters
  - second call $incs the matching counter
  - parallel 50 calls land 50 increments (idempotency stress)
  - empty phoneHash → no Mongo write occurred (assert collection empty)
  - missing district → write succeeds without district field
  - lastOutcomeAt advances; firstOutcomeAt frozen on second call
  - thrown Mongo error caught + logged + helper resolves
  - never reads Order (assert via mock spy on Order)

GROUP B — recordAddressOutcome (8 tests)
  - first call inserts; counters + initial distinctPhoneHashes
  - second call same phoneHash → distinctPhoneHashes unchanged length
  - 50 different phoneHashes → distinctPhoneHashes capped at 32, oldest dropped
  - null phoneHash → distinctPhoneHashes unchanged
  - parallel writes maintain unique-merge semantics (race-tolerant)
  - aggregation-pipeline $ifNull guards: row inserted via pipeline has every counter ≥ 0 numeric
  - missing addressHash → no write
  - thrown Mongo error path

GROUP C — never-throws contract (3 tests)
  - inject Mongo timeout via mock → helper resolves with no throw
  - inject duplicate-key into upsert (manual race) → handled, no throw
  - call helper before db.connect() → handled, no throw
```

#### S4 — Chokepoint integration tests (`apps/api/tests/tracking-reliability-integration.test.ts`)

Uses `mongodb-memory-server`, drives `applyTrackingEvents` directly.

Required scenarios:

```
GROUP A — flag-off baseline (4 tests)
  Flag DELIVERY_RELIABILITY_WRITE_ENABLED=false:
    - terminal flip to delivered → CustomerReliability collection EMPTY
    - terminal flip to rto       → AddressReliability collection EMPTY
    - non-terminal in_transit    → no aggregate writes
    - cancelled (via the cancel paths NOT exercised by applyTrackingEvents)
      → no aggregate writes (those paths don't go through this chokepoint anyway)

GROUP B — flag-on happy path (6 tests)
  Flag on:
    - delivered terminal flip → exactly one CustomerReliability row, deliveredCount=1
    - rto terminal flip       → exactly one CustomerReliability row, rtoCount=1
    - cancelled terminal flip → exactly one row per axis, cancelledCount=1
    - delivered with no addressHash → CustomerReliability row, NO AddressReliability row
    - delivered with no phoneHash   → AddressReliability row, NO CustomerReliability row
    - delivered with neither        → NO new rows (only existing fan-outs run)

GROUP C — replay storms (4 tests, MOST IMPORTANT)
  - 1000× same WebhookInbox row replayed via replayCourierInbox →
    CustomerReliability counters delta ≤ 1 (MUST be exactly 1 in correct impl)
  - applyTrackingEvents called 1000× with same content-hashed event →
    counters delta = 1
  - re-fire delivered after status already delivered (G6 guard rejects) →
    counters unchanged
  - polling worker + webhook deliver same event 50ms apart →
    counters = 1, MerchantStats matches

GROUP D — guard inheritance (3 tests)
  - manual order rollback to pre-terminal status (synthetic) → next terminal
    flip increments BOTH the existing fan-outs AND the new aggregates (this
    documents the §6.2 caveat in the blueprint, NOT a v1 bug)
  - concurrent transitions on different orders, same buyer → both $inc land
  - simulate Mongo timeout on the new helpers → existing fan-outs unaffected;
    Order updateOne result unchanged

GROUP E — cancel-path coverage gap (1 test)
  - automationStale auto-cancel → CustomerReliability NOT updated (documents
    §3.3 of deep audit, expected behavior in v1)
```

#### S6 — Read-path tests (`apps/api/tests/orders.delivery-reliability.test.ts`)

```
GROUP A — flag presence (3 tests)
  - flag off → response has no `deliveryReliability` field
  - flag on, no aggregates exist → tier:"no_data"
  - flag on, full aggregates → tier matches classifier output

GROUP B — fallback (3 tests)
  - CustomerReliability lookup throws → tier:"no_data" (graceful)
  - AddressReliability lookup throws → tier reflects only customer side
  - Both throw → tier:"no_data"

GROUP C — performance (1 test)
  - getOrder p95 latency ≤ baseline + 10ms across 100 calls

GROUP D — legacy data (2 tests)
  - order with no addressHash on source → classifier still works
  - order with no fraud subdoc (legacy) → classifier still works
```

#### S5 — Anomaly detector test

Single test file extending `anomaly.test.ts`:
- Seed `Order` with known counts; populate `customer_reliabilities` to drift; run detector; assert alert fires with right `kind`.

#### S7 — Analytics test

Read-only smoke test on the new procedure: returns expected aggregate shape; merchant-scoped; 200ms p95.

### 5.2 Replay-test scenarios — explicit list

| # | Scenario | What it proves |
|---|---|---|
| R1 | 1000× replay of one courier webhook | New helpers inherit chokepoint replay-safety |
| R2 | webhook + poll race for same event | dedupeKey + status guard short-circuit second writer |
| R3 | replayCourierInbox loop after worker crash | Replay sweep does not double-count |
| R4 | pendingJobReplay drains 100 dead-lettered webhook-process jobs | None of them double-count |
| R5 | Two parallel webhooks same merchantId different orderIds same buyer | Both increments land |
| R6 | webhookRetry sweep picks up an orphaned `received` row > 5min old | Replay path is identical to fresh path |

### 5.3 Corruption scenarios — explicit list

| # | Scenario | What it proves |
|---|---|---|
| C1 | Inject Mongo write failure on `customer_reliabilities` | Order/status write proceeds; counters lag; log fires |
| C2 | Drop the unique index by hand, re-run writer twice | Two rows result (proves the index is load-bearing); restored on rebuild |
| C3 | Run drift detector after seeded mismatch | Detector flags |
| C4 | Backfill (v2) and live writes both running, dual-counter discipline broken | Verification step (§3.2.6) catches divergence |

### 5.4 Rollback scenarios — explicit list

| # | Scenario | What it proves |
|---|---|---|
| RB1 | Flip `DELIVERY_RELIABILITY_WRITE_ENABLED=false` mid-day | Writes stop; existing rows valid; reads (when flag on) still classify against the frozen counters |
| RB2 | Flip `DELIVERY_RELIABILITY_READ_ENABLED=false` mid-day | UI panel disappears; writes continue; no data loss |
| RB3 | Drop both new collections | System functional; classifier returns `tier:"no_data"`; no errors |
| RB4 | Revert chokepoint commit | Existing fan-outs unchanged; new helpers become dead code |

### 5.5 Pre-flight gates

```
BEFORE enabling DELIVERY_RELIABILITY_WRITE_ENABLED in production:
  [ ] All S1, S3, S4 tests pass
  [ ] Replay tests R1–R6 pass
  [ ] Corruption tests C1–C2 pass
  [ ] Indexes confirmed via getIndexes() in staging
  [ ] Drift detector wired and exercising in staging for 24h
  [ ] One-merchant dogfood completed in staging (24h+)

BEFORE enabling DELIVERY_RELIABILITY_READ_ENABLED in production:
  [ ] WRITE flag has been on globally for ≥7d
  [ ] Drift detector green for 7d in production
  [ ] Aggregate write counter shows steady state (per-second writes
      proportional to terminal-transition rate)
  [ ] All S6 tests pass
  [ ] p95 latency check in staging

BEFORE rolling out S8 UI:
  [ ] READ flag is on for INTERNAL merchants for ≥3d
  [ ] No spike in `delivery_reliability.classified` errors
  [ ] No regression in `getOrder` p95
```

---

## 6. Implementation danger inventory

The MOST DANGEROUS mistakes a senior engineer could still make. For each: **why dangerous / how corruption happens / how to detect / how to prevent.**

### D1 — Awaiting the new helpers in `applyTrackingEvents`

- **Why dangerous.** Webhook handlers' end-to-end target is sub-second. The chokepoint already runs synchronously through `Order.updateOne` + `MerchantStats.updateOne`. Adding another awaited Mongo call doubles the synchronous tail.
- **How corruption happens.** Not data corruption — operational. A slow Mongo cluster on the new index could cascade into webhook-process worker stalls and inbox backlog growth.
- **How to detect.** `getOrder` p95 watch (irrelevant), `webhook-process` BullMQ wait-time alarm via existing `queue.wait_time` log (`lib/queue.ts:88`).
- **How to prevent.** Mandatory `void X(...).catch(...)` pattern. Code review must reject any `await` on the new helpers.

### D2 — Querying Order inside `recordCustomerOutcome` / `recordAddressOutcome`

- **Why dangerous.** The chokepoint already loaded the order; re-reading it inside the helper introduces stale-read risk AND latency. Worse, a future engineer might use the read result to "enrich" the write, coupling helper logic to Order schema.
- **How corruption happens.** Stale `Order.fraud.*` reads → mis-attributed signal → wrong tier in the future.
- **How to detect.** Static analysis: grep `lib/delivery-reliability.ts` for `Order` import. Code review.
- **How to prevent.** Documented in §3 helper contract: "Never read Order." Reviewer rejects on PR.

### D3 — Coupling the classifier output into `computeRisk`

- **Why dangerous.** The deep audit's load-bearing recommendation is observation-only. Folding the tier into `riskScore` flips the contract to influence and makes every future fraud tuner cycle conflate operational reliability with fraud probability.
- **How corruption happens.** A merchant in a slow-rural-thana would be flagged HIGH for COURIER reasons; their buyers experience false fraud declines.
- **How to detect.** Static analysis: grep `server/risk.ts` for `deliveryReliability` — must be absent. Grep `routers/orders.ts` and `workers/riskRecompute.ts` similarly.
- **How to prevent.** OUT-OF-SCOPE list in blueprint §12. PR template would mandate the answer "does this PR import classifyDeliveryReliability into risk.ts?" be NO.

### D4 — Inserting the new fan-out OUTSIDE the `nextStatus !== prevStatus` gate

- **Why dangerous.** The gate is what makes the existing fan-outs at-most-once per real transition. Outside it, every webhook event would tick the counters — including non-status-changing events like `out_for_delivery` updates that preserve `in_transit` status.
- **How corruption happens.** A typical Pathao delivery emits 8–12 events. A 12× double-count per delivery within a week of rollout corrupts every customer's reliability tier.
- **How to detect.** Drift detector (§4.3 of blueprint) would alert within 6h.
- **How to prevent.** PR review against this doc's §2.3 attachment rules.

### D5 — Bypassing the chokepoint by adding writes elsewhere

- **Why dangerous.** Adding a second writer (e.g. inside `automationStale` to "also count cancellations") creates a non-chokepoint replay risk. Cancellation paths today are scattered (deep audit §3.2); each new writer is a new replay-correctness obligation.
- **How corruption happens.** Each writer is an independent contract — `automationStale` re-fires on stale-read CAS-conflict, no replay guard, double-count.
- **How to detect.** Grep for new imports of `recordCustomerOutcome` / `recordAddressOutcome` outside `tracking.ts`. Should be zero in v1.
- **How to prevent.** Helper module exports clearly comment: "v1 contract: ONE caller — applyTrackingEvents."

### D6 — Storing raw phone or raw address in either new collection

- **Why dangerous.** Privacy regression. The deep audit's reuse story rests on `FraudSignal`'s privacy posture. Diluting it here makes the new collections a PII-bearing target.
- **How corruption happens.** A future log line that includes the row would log raw PII.
- **How to detect.** Schema review — schema must define `phoneHash`/`addressHash` strings, length 32.
- **How to prevent.** Schema field naming. Test asserts no `phone` / `address` field exists in the schema.

### D7 — Using `findOneAndUpdate({...}, {...}, {new: true})` and reading the result for application logic

- **Why dangerous.** The helper becomes a read-after-write that callers may start to depend on. v1's chokepoint pattern is fire-and-forget; introducing a read-after-write makes it impossible to swap to a queue-backed shape in v2 without breaking callers.
- **How corruption happens.** Future v2 backfill assumes counters are eventually consistent; coupling reads to the helper output forces synchronous correctness.
- **How to detect.** Helper return type. v1 helpers must return `Promise<void>`. PR review.
- **How to prevent.** Type signature.

### D8 — Adding the helpers to a transaction with the order update

- **Why dangerous.** Existing fan-outs (`FraudPrediction.outcome`, `contributeOutcome`, `recordCourierOutcome`) are explicitly OUTSIDE the order update transaction. Adding ours INSIDE creates cross-collection transaction overhead AND inverts the existing best-effort contract.
- **How corruption happens.** A transient hiccup on the new index would fail the order write itself. Webhook 5xx → upstream retry → replayWebhookInbox → potential double-fire after recovery.
- **How to detect.** Grep helper file for `startSession` / `withTransaction`. Must be absent.
- **How to prevent.** Helper contract §3 forbids transactions. PR review.

### D9 — Using `$inc` on a row whose schema defaults haven't been written yet

- **Why dangerous.** Aggregation-pipeline upserts (the `recordAddressOutcome` pipeline form) skip Mongoose schema defaults. A counter that doesn't exist returns `undefined`; downstream arithmetic in lookups becomes `NaN`.
- **How corruption happens.** First-ever address with that hash gets `deliveredCount=undefined` → classifier reads `undefined` → `tier: "no_data"` even though we wrote the row.
- **How to detect.** Lookup in classifier returning `no_data` after a known-good write.
- **How to prevent.** Mirror `fraud-network.ts:340–360` — every counter wrapped in `$ifNull: ["$counter", 0]` in the pipeline. Test C2 covers this.

### D10 — Computing `phoneHash` from a non-canonical phone

- **Why dangerous.** `hashPhoneForNetwork(rawPhone)` produces different hashes for `01711...` vs `+8801711...` vs `8801711...`. Counters fragment across multiple keys for the same buyer.
- **How corruption happens.** Customer sees `tier: no_data` despite having ten prior orders.
- **How to detect.** Compare CustomerReliability row count to distinct `customer.phone` count for a sample merchant. Drift > 1.05× = fragmentation.
- **How to prevent.** Use the chokepoint's already-canonicalized `customer.phone` (the order doc went through `normalizePhoneOrRaw` at ingest, `ingest.ts:85`). Pass it through `hashPhoneForNetwork`. Do NOT rehash from a raw external ID.

### D11 — Treating the classifier's output as authoritative for automation

- **Why dangerous.** Some future engineer will see `tier: "unverified"` and want to automatically hold the order, mirroring fraud's `pending_call`. v1 explicitly does not do this.
- **How corruption happens.** False-decline cascade — observation surface becomes a decision gate without the validation gates the blueprint defines (§8.6 of deep audit).
- **How to detect.** Search for new branches in `automationBook` / `riskRecompute` keyed on `deliveryReliability.tier`.
- **How to prevent.** Out-of-scope list. v1 wires the classifier into `getOrder` only; v2 may revisit only after the §8.6 gates are met.

### D12 — Non-deterministic classifier output

- **Why dangerous.** Classifier called twice for the same order in the same `getOrder` returns different tiers because `now` evolves. Tests catch the obvious case; subtle drift (e.g. reading a `Date` from the input that mutates) is sneakier.
- **How corruption happens.** Cache layer in v2 stores tier A; UI reads tier B; debugging chase.
- **How to detect.** Purity test in S1 group F.
- **How to prevent.** Single `now` capture at top of function; no other `Date`/`Date.now()` calls.

### D13 — Reading `recentFailureCount` from `CourierPerformance` and treating it as a delivery signal

- **Why dangerous.** `recentFailureCount` is the BOOKING-failure circuit breaker, not a delivery-failure signal. Conflating them double-penalises a courier that's failing to ACCEPT bookings (network outage) for delivery success.
- **How corruption happens.** Tier drops after Pathao's API has a 30-min outage; merchant sees fake reliability degradation.
- **How to detect.** Inspect classifier inputs in S1 tests.
- **How to prevent.** Classifier reads only `successRate / rtoRate / avgDeliveryHours / observations / coldStart / stale / matchedOn` from courier stats. Do NOT thread `recentFailureCount` through.

### D14 — Surfacing the new tier label as "fraud risk"

- **Why dangerous.** Merchant trust posture: the existing fraud queue has a specific UX commitment ("Risky / Verify / Safe"). Reusing the same tier vocabulary on a different concept would confuse merchants AND attribute fraud-decline blame to delivery reliability.
- **How corruption happens.** Support tickets blaming "fraud system" for delivery-reliability lows.
- **How to detect.** UI copy review. Tier labels must read "Verified / Implicit / Unverified / No data" — same as the intent panel — not "Safe / Verify / Risky".
- **How to prevent.** UI copy locked to the intent-panel vocabulary. PR copy review.

---

## 7. Do-not-touch inventory

Single consolidated list. Refactoring any of these in the same PR as the v1 implementation is grounds to split the PR.

```
apps/api/src/server/risk.ts
apps/api/src/server/ingest.ts
apps/api/src/server/courier-replay.ts
apps/api/src/server/webhooks/courier.ts
apps/api/src/server/webhooks/integrations.ts
apps/api/src/lib/queue.ts
apps/api/src/lib/courier-intelligence.ts
apps/api/src/lib/fraud-network.ts
apps/api/src/lib/operational-hints.ts
apps/api/src/lib/intent.ts
apps/api/src/lib/address-intelligence.ts
apps/api/src/workers/riskRecompute.ts
apps/api/src/workers/fraudWeightTuning.ts
apps/api/src/workers/automationBook.ts
apps/api/src/workers/awbReconcile.ts
apps/api/src/workers/orderSync.worker.ts
apps/api/src/workers/trackingSync.ts
apps/api/src/workers/webhookProcess.ts
apps/api/src/workers/webhookRetry.ts
apps/api/src/workers/pendingJobReplay.ts
packages/db/src/models/order.ts                            (v1; v2 will add a subdoc)
packages/db/src/models/courierPerformance.ts
packages/db/src/models/fraudPrediction.ts
packages/db/src/models/fraudSignal.ts
packages/db/src/models/webhookInbox.ts
packages/db/src/models/pendingJob.ts
packages/db/src/models/pendingAwb.ts
apps/web/src/components/orders/operational-hint-panel.tsx
apps/web/src/components/orders/intelligence-panels.tsx
apps/web/src/components/intelligence/rto-intelligence-section.tsx
apps/web/src/components/fraud/network-signal.tsx
```

A change in any of the above must be flagged and justified in the PR; default reviewer disposition is **request changes**.

---

## 8. Operational-critical-path inventory

The functions / files where a regression has the largest blast radius. Reviewers must inspect these regions per-PR.

| File / function | Why critical |
|---|---|
| `tracking.ts:applyTrackingEvents` | The chokepoint. Replay correctness for delivery + RTO. |
| `tracking.ts:syncOrderTracking` | Polling fallback feeds the chokepoint. |
| `ingest.ts:ingestNormalizedOrder` | Order create + risk + identity stitching. |
| `ingest.ts:replayWebhookInbox` | Webhook retry sweep + manual replay. |
| `courier-replay.ts:replayCourierInbox` | Courier replay sweep. |
| `lib/queue.ts:safeEnqueue` | The durable enqueue contract. |
| `lib/orderConcurrency.ts:updateOrderWithVersion` | Optimistic CC. |
| `workers/pendingJobReplay.ts:sweepPendingJobs` | DLQ replay sweeper. |
| `workers/webhookRetry.ts:sweepWebhookRetryQueue` | Webhook retry + orphan recovery. |

v1 modifies ONE of these (`tracking.ts:applyTrackingEvents`). The other 8 are read-only references.

---

## 9. Additive-only enforcement rules

These are the rules a reviewer applies mechanically:

```
A1. New code must NOT delete or rename any existing exported symbol.
A2. New code must NOT change any existing function's signature.
A3. New code must NOT change any existing tRPC procedure's input or
    output schema. Only NEW fields may be added to outputs; new procedures
    may be added.
A4. New code must NOT change any existing Mongoose schema's existing
    fields, indexes, or default values. Only NEW collections may be
    added in v1.
A5. New code must NOT introduce a new `await` inside any function
    listed in §8 (operational-critical-path).
A6. New code must NOT introduce Mongo transactions in the chokepoint
    fan-out.
A7. New code must NOT register a new BullMQ worker in v1.
A8. New code must NOT mount a new Express route in v1.
A9. New code must NOT introduce a new env var without a default that
    preserves prior behavior (every flag defaults to "off"/legacy).
A10. New code must NOT log raw PII (phone, address, email) at INFO or
     above. Hashes only.
```

---

## 10. Final engineer checklist

Use this list end-to-end. Every item is binary. Do not start the next group until the prior group is fully checked.

### Group 1 — preparation

```
[ ] Read deep-scoring-audit.md fully
[ ] Read delivery-reliability-implementation-blueprint.md fully
[ ] Read this engineering execution map fully
[ ] Read apps/api/src/server/tracking.ts fully (the chokepoint)
[ ] Read apps/api/src/lib/courier-intelligence.ts fully (the pattern)
[ ] Read apps/api/src/lib/fraud-network.ts fully (the privacy pattern)
[ ] Confirm the file list in §1 matches the current tree
[ ] Re-anchor §2 line numbers if drift exists
```

### Group 2 — S1 (pure function)

```
[ ] Create apps/api/src/lib/delivery-reliability.ts with the pure function only
[ ] Create apps/api/tests/delivery-reliability.test.ts (≥30 cases per §5.1)
[ ] All tests pass locally
[ ] PR review: assert no Mongoose import in the lib file
[ ] PR review: assert no console.* in the classifier function body
[ ] Land
```

### Group 3 — S2 (schemas)

```
[ ] Create packages/db/src/models/customerReliability.ts (mirror courierPerformance.ts shape)
[ ] Create packages/db/src/models/addressReliability.ts (with capped distinctPhoneHashes)
[ ] Add re-exports in packages/db/src/index.ts
[ ] Confirm `npm --workspace packages/db run build` succeeds
[ ] PR review: indexes match §1.2 / §1.3 of the blueprint
[ ] Land
```

### Group 4 — S3 (writers + observability primitives)

```
[ ] Add recordCustomerOutcome to apps/api/src/lib/delivery-reliability.ts
[ ] Add recordAddressOutcome to the same file
[ ] Add per-process counters (mirror lib/queue.ts:_counters pattern)
[ ] Create apps/api/tests/delivery-reliability-writers.test.ts (per §5.1)
[ ] All tests pass
[ ] PR review: helpers respect §3 contract (never throw, never read Order, etc.)
[ ] Land
```

### Group 5 — S4 (chokepoint wiring) — HIGH RISK

```
[ ] Add DELIVERY_RELIABILITY_WRITE_ENABLED to apps/api/src/env.ts (default false)
[ ] Modify apps/api/src/server/tracking.ts per §2 placement rules:
    - inside G11 terminal block
    - after the existing four fan-outs
    - flag-gated
    - void + .catch
    - reuse already-computed phoneHash + addressHash
[ ] Create apps/api/tests/tracking-reliability-integration.test.ts (per §5.1)
[ ] Replay-storm test (1000× same event) passes
[ ] PR review: NO modification to G1–G7 (existing guards intact)
[ ] PR review: A1–A6 hold
[ ] Land WITH FLAG OFF
[ ] Verify on staging: aggregate collections empty (flag off → no writes)
```

### Group 6 — S5 (observability)

```
[ ] Add structured-log emission to helpers per §3.1 / §3.2
[ ] Add detector to apps/api/src/lib/anomaly.ts (5th detector)
[ ] Update apps/api/src/server/routers/adminObservability.ts to expose counters
[ ] Anomaly detector test passes
[ ] Land
```

### Group 7 — S6 (read-time integration)

```
[ ] Add DELIVERY_RELIABILITY_READ_ENABLED to env (default false)
[ ] Modify apps/api/src/server/routers/orders.ts:getOrder to add classifier call
[ ] Promise.allSettled wraps the small reads — no failure cascades into the response
[ ] Create apps/api/tests/orders.delivery-reliability.test.ts
[ ] Latency check: p95 unchanged with flag off
[ ] PR review: A1–A4 hold (no signature changes; only additive output field)
[ ] Land WITH READ FLAG OFF
```

### Group 8 — S7 + S8 (analytics + UI)

```
[ ] Add deliveryReliabilitySummary to analytics.ts
[ ] Create apps/web/src/components/orders/delivery-reliability-panel.tsx
[ ] Mount in tracking-timeline-drawer.tsx (next to OperationalHintPanel)
[ ] UI copy uses Verified / Implicit / Unverified / No data (§D14)
[ ] Tier badge styling consistent with intelligence-panels.tsx
[ ] Land WITH READ FLAG OFF
```

### Group 9 — production rollout

```
[ ] Pre-flight write-flag gates per §5.5 satisfied
[ ] Flip DELIVERY_RELIABILITY_WRITE_ENABLED=true in production
[ ] Watch drift detector + lag metric for 7 days
[ ] Pre-flight read-flag gates per §5.5 satisfied
[ ] Flip DELIVERY_RELIABILITY_READ_ENABLED=true for INTERNAL merchants
[ ] Watch metrics for 3 days
[ ] Flip DELIVERY_RELIABILITY_READ_ENABLED=true globally
```

### Group 10 — close-out

```
[ ] Create v2 backlog issues (Order.deliveryReliability subdoc, CourierThanaPerformance, backfill)
[ ] Update apps/api/CLAUDE.md with the new chokepoint fan-out
[ ] Document the actual final p95 latency hit in the blueprint
[ ] Document the steady-state aggregate write rate
```

---

## 11. Out-of-scope reminder

Repeat from the blueprint, with surgical anchors:

- ⛔ Do not import `classifyDeliveryReliability` into `apps/api/src/server/risk.ts`.
- ⛔ Do not call `recordCustomerOutcome` / `recordAddressOutcome` from any file other than `tracking.ts:applyTrackingEvents` in v1.
- ⛔ Do not modify `tracking.ts:applyTrackingEvents`'s atomic guard (G6) or dedupe key (G2).
- ⛔ Do not register a new BullMQ worker.
- ⛔ Do not add a new Express route.
- ⛔ Do not modify `packages/db/src/models/order.ts` in v1 (no subdoc).
- ⛔ Do not change `courierPerformance.ts` schema.
- ⛔ Do not introduce backfill in v1.
- ⛔ Do not introduce a cache in v1.
- ⛔ Do not introduce a per-merchant feature flag in v1.

— end of execution map —
