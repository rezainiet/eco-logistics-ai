# Delivery Reliability — Production Rollout Runbook

**Status:** operational runbook, 2026-05-08. Companion to S9 implementation.
**Audience:** the engineer / on-call operator running the rollout.
**Out of scope:** new feature work. This document is rollout discipline only.

The Delivery Reliability layer (S1–S8) ships with **four independent feature flags** plus an **optional staged-rollout merchant allowlist**. Flags default OFF in production. Nothing changes until a flag is flipped.

---

## 1. Flag matrix

| Flag                                              | Default | Controls                                                            |
|---------------------------------------------------|---------|---------------------------------------------------------------------|
| `DELIVERY_RELIABILITY_WRITE_ENABLED`              | `0`     | Chokepoint fan-out (`recordCustomerOutcome`, `recordAddressOutcome`).|
| `DELIVERY_RELIABILITY_READ_ENABLED`               | `0`     | Read-side classifier in `orders.getOrder` (`loadDeliveryReliability`).|
| `DELIVERY_RELIABILITY_ANALYTICS_ENABLED`          | `0`     | The four `analytics.*` reliability procedures.                      |
| `DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED`      | `1`     | Structured logs + in-process counters (S5).                         |
| `DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS`          | `""`    | Optional comma-separated merchant ObjectId allowlist (staged rollout). |

**Gate semantics (per-merchant):** each of the three primary gates evaluates as
`flagOn AND (allowlist empty OR merchantId in allowlist)`. When the allowlist is empty, behavior is identical to env-flag-only. When set, gates additionally restrict to listed merchants.

The four flags are **independent**. Disabling read does NOT disable write. Disabling analytics does NOT disable read. The rollout proceeds in dependency order: write → read → analytics → UI.

---

## 2. Rollout phases

### Phase 0 — Schema + indexes deployed (one-time)

State: `phase=off`, all flags `0`.

Pre-conditions:
- ✅ `customer_reliabilities` and `address_reliabilities` collections exist with their unique compound indexes.
- ✅ `apps/api` and `apps/web` deployed at the latest commit.
- ✅ `npm --workspace apps/api test` green.

No flags flipped. The new code path is dormant.

### Phase 1 — Internal-only verification (writes off)

State: `phase=off`. Flag `DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED=1` (default).

Run:
```
npm --workspace apps/api run verify:delivery-reliability
```

Expected:
- `phase: off`
- `flags.write: false`, `flags.read: false`, `flags.analytics: false`
- `merchants: []` (no aggregate data yet)
- All observability counters: 0
- Warnings: empty

Time: <1 minute. Read-only. Safe in production.

### Phase 2 — Staff merchant rollout (writes on, reads off, analytics off)

Set:
```
DELIVERY_RELIABILITY_WRITE_ENABLED=1
DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS=<comma-separated staff merchant ids>
```

State: `phase=writes_only`, `staged=true`.

This enables the chokepoint fan-out **only for the listed merchants**. Aggregate rows start to appear in `customer_reliabilities` / `address_reliabilities` for those merchants.

Verify (24h after flip):
```
npm --workspace apps/api run verify:delivery-reliability -- --merchant=<staff-merchant-id>
```

Success criteria:
- ✅ `customerRows`, `addressRows` non-zero for the staff merchant.
- ✅ `customerStalePct`, `addressStalePct` ≈ 0 (data is fresh).
- ✅ `integrityViolations: 0` across the sampled rows.
- ✅ `observabilityCounters.customerUpdated`, `addressUpdated` advancing in sync with the merchant's terminal-transition rate.
- ✅ `observabilityCounters.writeFailed` should be 0 or near-zero.
- ✅ `observabilityCounters.invalidTransition` should be near-zero (a small count is the §6.2 inheritance — bounded).

Failure criteria (rollback):
- ❌ `writeFailed` rate > 1% of `customerUpdated + addressUpdated`.
- ❌ `integrityViolations > 0` on the sample.
- ❌ Any chokepoint test starts failing in CI.
- ❌ Webhook `getOrder` p95 latency rises > +20ms.

Run for ≥7 days before promoting.

### Phase 3 — Low-volume merchant rollout (writes on for cohort, reads off)

Add 5–10 low-volume merchants to the allowlist:
```
DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS=<staff_ids>,<low_volume_ids>
```

Same `phase=writes_only`, larger allowlist.

Verify (24h):
```
npm --workspace apps/api run verify:delivery-reliability
```

Success criteria: same as Phase 2 across the broader cohort.

Run for ≥7 days.

### Phase 4 — General availability for writes

Clear the allowlist (or keep set if you prefer continued staged behaviour, but for true GA:):
```
DELIVERY_RELIABILITY_WRITE_ENABLED=1
DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS=
```

State: `phase=writes_only`, `staged=false`. Every merchant's chokepoint fan-out is now active.

Verify:
- ✅ Aggregate row counts grow proportionally to total terminal-transition rate.
- ✅ `verify:delivery-reliability` (global scope, no `--merchant`) shows healthy stale percentages and zero integrity violations across all merchants.

Run for ≥7 days before enabling reads.

### Phase 5 — Internal/dogfood reads (reads on for staff merchants only)

```
DELIVERY_RELIABILITY_WRITE_ENABLED=1
DELIVERY_RELIABILITY_READ_ENABLED=1
DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS=<staff merchant ids>
```

State: `phase=reads_on`, `staged=true`.

Now the `getOrder` response includes `deliveryReliability` for staff merchants only. The S8 panel renders in their order detail drawer.

Success criteria:
- ✅ `getOrder` p95 latency unchanged ±10ms (verified via existing latency dashboards).
- ✅ Staff merchants report the panel content matches expectations (manual visual check).
- ✅ No spike in `getOrder` errors.

Run for ≥3 days.

### Phase 6 — Reads on globally

Clear allowlist:
```
DELIVERY_RELIABILITY_WRITE_ENABLED=1
DELIVERY_RELIABILITY_READ_ENABLED=1
DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS=
```

State: `phase=reads_on`, `staged=false`. The panel is now visible to every merchant on every order detail.

Run for ≥7 days. Watch p95 latency, `delivery_reliability.classified` log volume.

### Phase 7 — Analytics on (general availability)

```
DELIVERY_RELIABILITY_WRITE_ENABLED=1
DELIVERY_RELIABILITY_READ_ENABLED=1
DELIVERY_RELIABILITY_ANALYTICS_ENABLED=1
DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS=
```

State: `phase=ga`.

The four analytics tRPC procedures (`deliveryReliabilitySummary`, `deliveryReliabilityDistribution`, `courierReliabilityOverview`, `reliabilityHealthSnapshot`) start answering for every merchant.

Currently no UI in `apps/web` consumes the analytics procedures (S8 only mounted the per-order panel). Surfaces using the analytics procedures will land in a future phase.

---

## 3. Rollback procedures

### Tier-1: instant rollback via env (preferred)

Each flag rolls back independently and immediately on next request. **No deploy required.**

| Action | Command |
|---|---|
| Disable analytics | `DELIVERY_RELIABILITY_ANALYTICS_ENABLED=0` (env var change + restart, OR live-reload via your deploy platform) |
| Disable read | `DELIVERY_RELIABILITY_READ_ENABLED=0` |
| Disable write | `DELIVERY_RELIABILITY_WRITE_ENABLED=0` |
| Constrain rollout | `DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS=<smaller list>` |

**Rollback hierarchy:**
1. **Analytics issue first?** → flip analytics flag off. Read/write paths unaffected. UI degrades cleanly (the four procedures return `FORBIDDEN`, but the panel doesn't depend on them).
2. **UI panel issue?** → flip read flag off. The panel disappears (renders null). Aggregates continue to accumulate (write flag still on).
3. **Aggregate write issue (drift, integrity violations, latency regression)?** → flip write flag off. Aggregates stop advancing. Existing rows remain valid. Read path returns `noData` for new buyers but works for existing ones.
4. **Catastrophic (any of the above isn't enough)?** → flip all three off + `DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED=0` if log volume is the problem.

Verified: tests in `tests/delivery-reliability-rollout.test.ts` exercise each flag-flip scenario and confirm immediate behavioral change on the next request.

### Tier-2: code rollback (if Tier-1 isn't enough)

If a code defect requires reverting source changes, the layer is purely additive — every change is in dedicated files (`apps/api/src/lib/delivery-reliability-*`, `apps/web/src/components/orders/delivery-reliability-panel.tsx`) plus minimal edits to the chokepoint, `getOrder`, and `analytics.ts`. The blueprint's blast radius analysis (§9 of `delivery-reliability-implementation-blueprint.md`) lists the six existing files modified across S1–S9. Reverting those six files restores pre-S1 behavior.

### Tier-3: schema rollback (last resort)

Drop the two new collections:
```
db.customer_reliabilities.drop()
db.address_reliabilities.drop()
```

Idempotent — they are aggregates, not authoritative state. Re-creation restarts the "v1 starts collecting from now" posture (per blueprint §3.1).

---

## 4. Verification commands

### `npm --workspace apps/api run verify:delivery-reliability`

Read-only operational health check. Safe to run during business hours.

**What it does:**
- Connects to the configured `MONGODB_URI`.
- Reads the global rollout state (flags + allowlist).
- Reads the in-process observability counter snapshot (S5).
- Per-merchant: counts `customer_reliabilities` / `address_reliabilities` / `courier_performances` rows + stale row counts (lastOutcomeAt > 180 days).
- Per-merchant: samples up to 200 customer + 200 address rows and runs `checkCustomerReliabilityIntegrity` / `checkAddressReliabilityIntegrity` against each.
- Prints a human-readable report (default) or JSON (`--json`).

**Flags:**
- `--merchant=<hex>` — scope to a single merchant (faster + targeted).
- `--json` — machine-readable output.

**What it does NOT do:**
- ❌ Never writes to any collection.
- ❌ Never enqueues a job.
- ❌ Never triggers `applyTrackingEvents`, `replayWebhookInbox`, or any chokepoint side-effect.
- ❌ Never runs aggregations over `Order`.
- ❌ Never modifies the rollout flags.

Verified by the rollout test suite — `does NOT issue any aggregate writes (read-only contract)` test confirms before/after counters match across two consecutive runs.

### Quick health-check checklist

| Symptom | Check |
|---|---|
| Aggregates not growing | `verify:delivery-reliability` shows `customerUpdated` / `addressUpdated` flat over time → write flag off OR allowlist excludes the production merchants. |
| Drift detector firing | Inspect `observabilityCounters.driftDetected` — 0 expected. Any non-zero is a defect signal. Emitted by `reconcileSlice` (single-shot per slice) when drift > tolerance OR a missing aggregate is observed. Run `reconcile:delivery-reliability --merchant=<hex>` to see which keys drifted. |
| `invalidTransition` spike | Means stale-snapshot writers are reaching the chokepoint after the order moved. Investigate webhook handler re-fetch logic; v1 inherits this caveat per deep-audit §6.2 but a sustained spike indicates a worker re-fetch regression. |
| `writeFailed` rate elevated | Mongo capacity issue OR index drop. Run `db.customer_reliabilities.getIndexes()` to verify the unique compound is intact. |
| `replaySuppressed` rate high | Expected. This is the canonical "webhook replayed but no transition" signal. Useful for replay confidence; not a defect. |

### `npm --workspace apps/api run reconcile:delivery-reliability`

Read-only drift detector. Compares aggregate counters against terminal Order observations within each aggregate's `firstOutcomeAt` window. **Never mutates anything.**

```
# All keys for one merchant + axis (capped at MAX_RECONCILE_SCAN=10000):
npm --workspace apps/api run reconcile:delivery-reliability -- --merchant=<hex> --axis=customer

# Single-key drift check:
npm --workspace apps/api run reconcile:delivery-reliability -- --merchant=<hex> --axis=customer --key=<phoneHash>

# JSON output for piping into ops tooling:
npm --workspace apps/api run reconcile:delivery-reliability -- --merchant=<hex> --json
```

**Output:** human-readable report (default) or JSON (`--json`). Reports per-key drift magnitude, the top 20 drifted keys, and any keys observed in `Order` but absent from the aggregate (chokepoint missed all writes for that key). Sets `truncated: true` when the bounded scan hit the cap — re-run with a smaller `--limit` or scope to a single `--key`.

**Side-effects:** none. No writes. No queue dispatches. No replay triggers.

### `npm --workspace apps/api run repair:delivery-reliability`

Bounded explicit-invocation aggregate repair. **Dry-run by default** — pass `--apply` to mutate. Even with `--apply`, the underlying helper enforces the `DRIFT_TOLERANCE=2` gate so trivial 1-count discrepancies do NOT produce a write.

```
# DRY-RUN — single-key repair plan:
npm --workspace apps/api run repair:delivery-reliability -- --merchant=<hex> --axis=customer --key=<phoneHash>

# APPLY — single-key repair (requires --apply):
npm --workspace apps/api run repair:delivery-reliability -- --merchant=<hex> --axis=customer --key=<phoneHash> --apply

# DRY-RUN — bounded slice repair (default limit = MAX_REPAIR_BATCH = 100):
npm --workspace apps/api run repair:delivery-reliability -- --merchant=<hex> --axis=address --limit=20

# APPLY — bounded slice repair:
npm --workspace apps/api run repair:delivery-reliability -- --merchant=<hex> --axis=address --limit=20 --apply
```

**Behaviour:**
- Uses `rebuildAggregateForKey` / `rebuildSliceForMerchant` — never recomputes its own expected counters; consumes the reconciler's output verbatim.
- Writes `aggregate.updateOne(filter, { $set: { deliveredCount, rtoCount, cancelledCount } })` — absolute, not `$inc`. **Idempotent**: re-running with the same Order state produces a byte-identical write.
- Refuses to recreate missing aggregates (v1 does not backfill).
- Refuses to mutate when `driftMagnitude ≤ DRIFT_TOLERANCE=2`.
- Per-invocation cap is `MAX_REPAIR_BATCH=100`. Larger drift cohorts: run multiple bounded passes.
- Emits an `integrity_warning` observability event with `reason: "repair_applied" | "repair_failed"` and a hashed-prefix-only `meta` block. Audit-trail-grade.

**Side-effects (apply mode):** writes ONLY to `customer_reliabilities` / `address_reliabilities`. Never touches `Order`, never re-enters `applyTrackingEvents`, never triggers FraudPrediction / CourierPerformance / MerchantStats updates. Verified at `delivery-reliability-hardening.test.ts:679` ("repairing does NOT push tracking events into Order.logistics.trackingEvents") and `:705` ("repairing does NOT modify FraudPrediction or any other collection").

### When drift is detected — operator runbook

Order-of-operations when `driftDetected > 0` or a phase-progression check finds non-zero drift:

1. **Identify scope.**
   ```
   npm --workspace apps/api run reconcile:delivery-reliability -- --merchant=<hex> --axis=customer
   npm --workspace apps/api run reconcile:delivery-reliability -- --merchant=<hex> --axis=address
   ```
   Read the `driftedKeys` count and the top-20 magnitude table. If `truncated: true`, re-run with a tighter `--key` or smaller `--limit`.

2. **Confirm — single-key dry-run.** For each drifted key, dry-run a repair plan and verify the `proposed` counters match expectations:
   ```
   npm --workspace apps/api run repair:delivery-reliability -- --merchant=<hex> --axis=customer --key=<hash>
   ```

3. **Apply — bounded slice (or single key).** Once the dry-run plan has been reviewed:
   ```
   npm --workspace apps/api run repair:delivery-reliability -- --merchant=<hex> --axis=customer --limit=20 --apply
   ```
   Re-run after each apply and watch `capped` shrink to 0. The CLI reports `APPLIED [...]`, `NOOP (drift_within_tolerance)`, `NOOP (missing_aggregate_skipped)`, or `FAILED: ...` per key.

4. **Verify post-repair.** Reconcile should now report `driftedKeys: []` (or only sub-tolerance entries):
   ```
   npm --workspace apps/api run reconcile:delivery-reliability -- --merchant=<hex>
   npm --workspace apps/api run verify:delivery-reliability -- --merchant=<hex>
   ```

5. **Check the audit trail.** Every applied repair emitted an `integrity_warning` event with `reason: "repair_applied"` and `meta: { hashKeyPrefix, driftMagnitude, delivered, rto, cancelled }`. The structured-log stream is the audit-of-record.

**Forbidden during incident response:**
- ❌ Don't run `repair --apply` without first dry-running the same invocation.
- ❌ Don't disable the drift-tolerance gate. Tiny drifts self-heal on the next chokepoint flip.
- ❌ Don't backfill missing aggregates by hand. v1 explicitly does not support this.
- ❌ Don't run repair for an axis that the writer flag never enabled — there is no drift to repair.

### Admin tRPC surfaces

Three read-only admin procedures expose the same diagnostics in-app under `adminProcedure`:

| Procedure | Returns |
|---|---|
| `adminObservability.deliveryReliabilityRolloutState({ merchantId? })` | Rollout phase + flag matrix + observability counter snapshot + optional per-merchant gate matrix. |
| `adminObservability.deliveryReliabilityMerchantHealth({ merchantId })` | Aggregate row counts + stale percentages + observability counter snapshot. |
| `adminObservability.deliveryReliabilityDriftSample({ merchantId, axis, scanLimit? })` | A `reconcileSlice` result. `scanLimit` capped at 10000. **Read-only** — no repair surface in tRPC by design. |

---

## 5. Operational invariants (do not violate)

1. **Never run a backfill in v1.** Aggregates start collecting at the moment `WRITE_ENABLED=1` lands. Pre-existing terminal orders are NOT retroactively counted. This is the v1 posture (blueprint §3.1).
2. **Never write to `customer_reliabilities` / `address_reliabilities` outside `applyTrackingEvents`.** Cancel-path writers (fraud reject, automation-stale, sms-inbound NO) do NOT instrument the new aggregates today. This is intentional (deep-audit §3.3 inherited gap). Adding instrumentation is a future effort, not part of v1 rollout.
3. **Never await the helpers inside the chokepoint.** Verified via the writer's `Promise<void>` return type and the chokepoint's `void X(...).catch(...)` pattern.
4. **Never expose raw PII through the analytics surfaces.** Verified — all surfaces return counts, rates, and tier labels only.
5. **Never modify `applyTrackingEvents`'s atomic guard, dedupe-key derivation, or `STATUS_MAP`.** The S4 chokepoint integration is at the END of the existing terminal block; the existing guards are untouched.
6. **Run `reconcile:delivery-reliability` per allowlisted merchant before promoting any phase.** Drift > tolerance on any allowlisted merchant **blocks the phase advance** until reconciliation is clean (or the drift has been repaired via the bounded `repair:delivery-reliability --apply` flow described in §4). This gate applies to Phase 2 → Phase 3, Phase 3 → Phase 4, and Phase 5 → Phase 6 in particular.

---

## 6. Phase progression timeline (suggested)

```
Day 0    Phase 0  schema + indexes deployed
Day 0+   Phase 1  internal verification (run verify script, baseline)
Day 1    Phase 2  staff merchant writes on, allowlist set
Day 8    Phase 3  add low-volume cohort to allowlist
Day 15   Phase 4  clear allowlist (writes GA)
Day 22   Phase 5  reads on for staff merchants (allowlist set again)
Day 25   Phase 6  reads on globally (allowlist cleared)
Day 32   Phase 7  analytics on globally (full GA)
```

This is a 32-day rollout with 7-day gates between most phases. Compress only if the Phase-N success criteria are met faster.

---

## 7. References

- `docs/audits/delivery-reliability-implementation-blueprint.md` — original architecture
- `docs/audits/delivery-reliability-engineering-execution-map.md` — phase-by-phase implementation map
- `docs/audits/deep-scoring-audit.md` — §6.2 caveat documentation
- `docs/audits/final-delivery-reliability-status-report.md` — pre-merge final audit
- `docs/audits/s10-finalization-verification-report.md` — S10 finalization verification
- `apps/api/src/lib/delivery-reliability-rollout.ts` — gate helpers (S9)
- `apps/api/src/lib/delivery-reliability-reconciliation.ts` — read-only drift reconciler (S10)
- `apps/api/src/lib/delivery-reliability-repair.ts` — bounded explicit-invocation repair (S10)
- `apps/api/src/lib/delivery-reliability-integrity.ts` — pure-function integrity checks (S10)
- `apps/api/src/scripts/verifyDeliveryReliability.ts` — verification CLI (S9)
- `apps/api/src/scripts/reconcileDeliveryReliability.ts` — drift detection CLI (S10)
- `apps/api/src/scripts/repairDeliveryReliability.ts` — bounded repair CLI (S10)
- `apps/api/tests/delivery-reliability-rollout.test.ts` — gate + verify-CLI tests
- `apps/api/tests/delivery-reliability-hardening.test.ts` — reconcile + repair + drift_detected emit tests
- `apps/api/tests/delivery-reliability-cli.test.ts` — reconcile + repair CLI helper tests
- `apps/api/tests/delivery-reliability-admin.test.ts` — admin tRPC procedure tests
