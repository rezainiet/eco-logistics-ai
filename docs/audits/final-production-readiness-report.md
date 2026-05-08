# Delivery Reliability — Final Production Readiness Report

**Branch:** `claude/staging-deploy`
**Generated:** 2026-05-08
**Scope:** final operational readiness review of the S1–S10 delivery
reliability engineering track. **No code changes** were made during this
review.
**Engineering verdict (from prior reports):** replay-safe, reconciliation-safe,
operationally bounded, additive-only compliant, production-grade stable.

---

## 0. TL;DR

**Recommendation: GO with two non-blocking prerequisites.**

The delivery reliability engineering work is structurally complete and verified across 1058 tests (full apps/api suite). The branch is mergeable as soon as two operational prerequisites are addressed:

1. **P0 — Wire `CustomerReliability` and `AddressReliability` into the production index-sync paths.** Without this, the unique compound indexes on `(merchantId, phoneHash)` and `(merchantId, addressHash)` will not be created in production, where `autoIndex: false`. Concurrent upserts could create duplicate rows.
2. **P1 — Add the five new `DELIVERY_RELIABILITY_*` env entries to `.env.example`.** Operators provisioning a new environment from `.env.example` currently won't see them. The values default safely (all 0 except observability=1), so this is discoverability rather than safety, but it should land before merge.

Both fixes are mechanical and well-scoped. Neither changes any chokepoint, replay, reconciliation, or repair semantic. After they land the branch is GO for a phase-1 staff-merchant rollout per the existing runbook.

---

## 1. Repository hygiene findings

### 1.1 Clean

| Check | Status |
|---|---|
| Stale `TODO` / `FIXME` / `XXX` / `HACK` markers in `delivery-reliability*` source | ✅ none |
| `.skip(` / `.only(` / `xit(` / `xdescribe(` in test files | ✅ none |
| Debug `console.log` in source (excluding documented observability emitter) | ✅ none — only `observability/delivery-reliability.ts:140` (the documented JSON-line emitter) |
| Temp scripts / scratch files | ✅ `.claude-staging/` is empty |
| Duplicate helpers across the layer | ✅ `safeMerchantOid` / `safeNum` / etc. are intentionally re-implemented per file to keep each module dependency-independent (matches existing repo convention for `lib/courier-intelligence.ts`, `lib/fraud-network.ts`) |
| Dead exports | ✅ all exports are consumed by tRPC routes, scripts, or the `__TEST` test surface |
| Unused imports in modified `tracking.ts` | ✅ verified clean (all imports referenced) |

### 1.2 Findings

| # | File | Finding | Severity |
|---|---|---|---|
| H1 | `apps/api/src/index.ts:131-153` | Boot-time `syncIndexes()` MODELS array does NOT include `CustomerReliability` / `AddressReliability`. Only 5 models sync at boot. | 🔴 P0 — see §3 |
| H2 | `apps/api/src/scripts/syncIndexes.ts:33-48` | Out-of-band `db:sync-indexes` script's MODELS array does NOT include `CustomerReliability` / `AddressReliability`. | 🔴 P0 — see §3 |
| H3 | `apps/api/src/server/admin.ts:162-208` | `POST /admin/sync-indexes` admin endpoint's MODELS array does NOT include `CustomerReliability` / `AddressReliability`. | 🔴 P0 — see §3 |
| H4 | `.env.example` | None of the 5 new `DELIVERY_RELIABILITY_*` env vars are listed. | 🟡 P1 |
| H5 | `docs/audits/delivery-reliability-implementation-blueprint.md` (10 occurrences) | References a stale flag name `DELIVERY_RELIABILITY_ENABLED`. The canonical name is `DELIVERY_RELIABILITY_READ_ENABLED`. | 🟢 doc drift |
| H6 | `docs/audits/delivery-reliability-engineering-execution-map.md` (5 occurrences) | Same stale flag name `DELIVERY_RELIABILITY_ENABLED` in the §S6 row, §rollback table, and the pre-rollout / rollout checklists. | 🟢 doc drift |
| H7 | `apps/api/src/env.ts:198` | The new flag JSDoc references the OLD name `DELIVERY_RELIABILITY_ENABLED` ("Independent of the read-side flag (`DELIVERY_RELIABILITY_ENABLED`, S6)"). | 🟢 doc drift |
| H8 | `.claude/settings.local.json` | Local-only Claude Code permission allowlist — diff has session-tracking artifacts. Should NOT be merged into main; treat as personal/ignored config. | 🟢 not a blocker |

H1/H2/H3 are the same root issue surfaced in three places. Fixing them is a single mechanical edit per file (add two entries to each MODELS list).

H4–H7 are documentation-tier issues. Operators following the runbook (the canonical operational doc) will use the correct flag names. The blueprint and execution map are historical/architectural and should be tidied for consistency but do not introduce production risk.

H8 is local Claude Code config — already covered by `.gitignore`-equivalent behavior; flag for the operator to review before commit.

---

## 2. Required env vars

### 2.1 New env vars introduced by this track

| Env var | Default | Type | Effect |
|---|---|---|---|
| `DELIVERY_RELIABILITY_WRITE_ENABLED` | `0` | `0` / `1` | Chokepoint fan-out (`recordCustomerOutcome`, `recordAddressOutcome`) |
| `DELIVERY_RELIABILITY_READ_ENABLED` | `0` | `0` / `1` | `loadDeliveryReliability` invocation in `getOrder` |
| `DELIVERY_RELIABILITY_ANALYTICS_ENABLED` | `0` | `0` / `1` | Four analytics tRPC procedures |
| `DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED` | `1` | `0` / `1` | Structured-log + counter emitter |
| `DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS` | `""` | csv hex | Optional staged-rollout merchant allowlist |

All five are validated by `apps/api/src/env.ts` (zod schema). All five default to safe values — `WRITE` / `READ` / `ANALYTICS` default `0` (off), `OBSERVABILITY` defaults `1` (on, fail-safe), `ROLLOUT_MERCHANTS` defaults `""` (no allowlist, behaves identically to env-flag-only when empty).

### 2.2 Discoverability

| Source of truth | Status |
|---|---|
| `apps/api/src/env.ts` zod schema with JSDoc per field | ✅ |
| `docs/audits/delivery-reliability-rollout-runbook.md §1` flag matrix | ✅ |
| `docs/audits/delivery-reliability-engineering-execution-map.md` S9/S10 sections | ✅ |
| `.env.example` | ❌ — missing (H4) |

**Recommendation:** add a `# --- Delivery Reliability v1 (defaults safe; flip per rollout-runbook) ---` block to `.env.example` listing all five with their defaults. Strictly mechanical.

---

## 3. Migration prerequisites

### 3.1 Schema additions

Two new collections, **auto-created by Mongoose on first write**:

| Collection | Source model | Unique compound index |
|---|---|---|
| `customer_reliabilities` | `packages/db/src/models/customerReliability.ts` | `{ merchantId: 1, phoneHash: 1 }` (unique) |
| `address_reliabilities` | `packages/db/src/models/addressReliability.ts` | `{ merchantId: 1, addressHash: 1 }` (unique) |

The `AddressReliability` schema also carries a Mongoose-level validator capping `distinctPhoneHashes.length ≤ 32`.

### 3.2 Index sync (P0 prerequisite)

Production runs with `mongoose.set("autoIndex", false)` (`apps/api/src/lib/db.ts:14`). This means **the unique compound indexes on the two new collections will NOT be auto-created in production**. Three places need to know about the new models, and **none of them currently do**:

| Path | File:line | Status |
|---|---|---|
| Boot-time fire-and-forget sync | `apps/api/src/index.ts:131-153` | ❌ missing |
| Out-of-band CLI | `apps/api/src/scripts/syncIndexes.ts:33-48` | ❌ missing |
| Admin HTTP endpoint `POST /admin/sync-indexes` | `apps/api/src/server/admin.ts:162-208` | ❌ missing |

**Required pre-rollout action (P0):**

Before flipping `DELIVERY_RELIABILITY_WRITE_ENABLED=1` in production, the unique indexes must exist. Pick ONE:

(a) **Code fix (recommended)** — append `["CustomerReliability", CustomerReliability]` and `["AddressReliability", AddressReliability]` to all three MODELS arrays. Future deploys self-heal.

(b) **One-time manual** — run `db.customer_reliabilities.createIndex({ merchantId: 1, phoneHash: 1 }, { unique: true })` and `db.address_reliabilities.createIndex({ merchantId: 1, addressHash: 1 }, { unique: true })` against the production DB before flipping the write flag. Risk: future production environments forget this step.

**Why this is P0:** without the unique compound index, two concurrent chokepoint writes on the same `(merchantId, phoneHash)` could each insert a fresh row (rather than upsert), creating duplicate aggregates. Subsequent `updateOne` calls would race-update either of the two rows, corrupting per-key counts.

In dev/test the autoIndex pathway covers this — so tests pass cleanly. The gap surfaces only in production.

### 3.3 No data backfill

Per `delivery-reliability-implementation-blueprint.md §3.1`: aggregates start collecting at the moment `WRITE_ENABLED=1` lands. **Pre-existing terminal orders are NOT retroactively counted.** The reconciler's window-aware design honors this (`firstOutcomeAt` is the floor; pre-flag terminal orders fall below the window and do not surface as drift).

### 3.4 No schema changes to existing collections

`packages/db/src/index.ts` only adds re-exports. No existing model is modified.

---

## 4. Operational scripts — discoverability check

| Script | npm script | Path | Documentation |
|---|---|---|---|
| Verify health | `verify:delivery-reliability` | `apps/api/src/scripts/verifyDeliveryReliability.ts` | runbook §4 |
| Reconcile drift | `reconcile:delivery-reliability` | `apps/api/src/scripts/reconcileDeliveryReliability.ts` | runbook §4 |
| Repair drift | `repair:delivery-reliability` | `apps/api/src/scripts/repairDeliveryReliability.ts` | runbook §4 |

All three are wired in `apps/api/package.json:14-16` and documented in the rollout runbook §4 with example invocations and "When drift is detected" runbook (added in the S10 finalization patch). ✅

Admin tRPC surfaces (read-only diagnostics):

| Procedure | Coverage |
|---|---|
| `adminObservability.deliveryReliabilityRolloutState` | ✅ |
| `adminObservability.deliveryReliabilityMerchantHealth` | ✅ |
| `adminObservability.deliveryReliabilityDriftSample` | ✅ |

All three are admin-procedure gated, read-only, and tested at `delivery-reliability-admin.test.ts`. ✅

---

## 5. Rollout order

Reproduced verbatim from `delivery-reliability-rollout-runbook.md §6`. **Do not compress without runbook §2 success criteria being met.**

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

Phase-gating per runbook §5 invariant #6: **drift > tolerance on any allowlisted merchant blocks the phase advance** until reconciliation is clean (or the drift has been repaired via `repair:delivery-reliability --apply`).

### Phase-by-phase env state

| Phase | WRITE | READ | ANALYTICS | OBSERVABILITY | ALLOWLIST |
|---|---|---|---|---|---|
| 0 (deploy) | 0 | 0 | 0 | 1 | "" |
| 1 (verify) | 0 | 0 | 0 | 1 | "" |
| 2 (staff writes) | 1 | 0 | 0 | 1 | `<staff_ids>` |
| 3 (low-vol writes) | 1 | 0 | 0 | 1 | `<staff_ids>,<low_vol_ids>` |
| 4 (writes GA) | 1 | 0 | 0 | 1 | "" |
| 5 (staff reads) | 1 | 1 | 0 | 1 | `<staff_ids>` |
| 6 (reads GA) | 1 | 1 | 0 | 1 | "" |
| 7 (analytics GA) | 1 | 1 | 1 | 1 | "" |

---

## 6. Rollback order

Per runbook §3, three tiers:

### Tier-1: env flag flip (preferred — no deploy)

Reverse-priority of features that misbehave. Each flag flips back independently:

```
Analytics misbehaves?    DELIVERY_RELIABILITY_ANALYTICS_ENABLED=0
UI panel misbehaves?     DELIVERY_RELIABILITY_READ_ENABLED=0
Aggregate write issues?  DELIVERY_RELIABILITY_WRITE_ENABLED=0
Catastrophic?            All three off + DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED=0 if log volume is the issue
Constrain blast radius?  DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS=<smaller list>
```

Effect is **immediate on the next request** — no in-process flag cache. Verified at `delivery-reliability-rollout.test.ts:356, 420` ("flipped off mid-session → ... immediate rollback").

### Tier-2: code revert

If a code defect requires reverting source, the layer is purely additive — every change is in dedicated files (`apps/api/src/lib/delivery-reliability-*`, `apps/web/src/components/orders/delivery-reliability-panel.tsx`) plus minimal additive edits to the chokepoint, `getOrder`, `analytics.ts`, `adminObservability.ts`, and `tracking-timeline-drawer.tsx`. Reverting those files restores pre-S1 behavior. The aggregate collections continue to exist (their absence-tolerant: classifier degrades to `tier: "no_data"` cleanly).

### Tier-3: schema rollback (last resort)

```
db.customer_reliabilities.drop()
db.address_reliabilities.drop()
```

Idempotent. Aggregates are not authoritative state — they're recomputable observations. Re-creating restarts the "v1 starts collecting from now" posture per `delivery-reliability-implementation-blueprint.md §3.1`.

---

## 7. Operational monitoring checklist

To watch during each rollout phase:

| Signal | Source | Healthy range |
|---|---|---|
| `observabilityCounters.customerUpdated` | `verify:delivery-reliability` (or admin tRPC) | growing in proportion to terminal-flip rate |
| `observabilityCounters.addressUpdated` | same | growing in proportion to terminal-flip rate |
| `observabilityCounters.writeFailed` | same | < 1% of `customerUpdated + addressUpdated` |
| `observabilityCounters.aggregateSkipped` | same | reflects flag-off and missing-hash paths; spikes when allowlist excludes traffic |
| `observabilityCounters.replaySuppressed` | same | high is EXPECTED on chatty couriers; not a defect |
| `observabilityCounters.invalidTransition` | same | near-zero — sustained spikes indicate webhook handler re-fetch regression (deep-audit §6.2) |
| `observabilityCounters.driftDetected` | same | 0 in healthy state — non-zero is a defect signal; run `reconcile:delivery-reliability` to inspect |
| `observabilityCounters.integrityWarning` | same | 0 in healthy state — non-zero indicates corruption (impossible counters, monotonic violations) or a repair-applied audit event |
| `getOrder` p95 latency | existing latency dashboards | unchanged ±10ms |
| `customerStalePct` / `addressStalePct` (per merchant) | `verify:delivery-reliability --merchant=<hex>` | low; high stale% means slow-moving merchant cohort |
| Webhook ingestion error rates | existing webhook dashboards | unchanged |
| Mongo write latency (especially on `customer_reliabilities` / `address_reliabilities`) | atlas dashboards | within prior baseline |

---

## 8. Production safety checklist

Pre-flip (before `WRITE_ENABLED=1`):

- [ ] Both `customer_reliabilities` and `address_reliabilities` collections have their unique compound indexes — see §3.2 P0
- [ ] `tsc --noEmit` passes on `apps/api`
- [ ] Full apps/api test suite passes — verified: 1058/1058 pass
- [ ] `.env` has all five `DELIVERY_RELIABILITY_*` entries set with intended values
- [ ] `verify:delivery-reliability` runs cleanly against staging with `phase=off`
- [ ] No webhook handler regressions in CI
- [ ] Latency dashboards baseline captured for `getOrder` p95
- [ ] On-call rotation aware of the rollout window
- [ ] Rollback runbook (§3) printed/known to on-call

Pre-flip (before `READ_ENABLED=1`):

- [ ] Aggregates have ≥7 days of organic data on allowlisted merchants
- [ ] `verify:delivery-reliability` shows `integrityViolations=0` across sampled rows
- [ ] `reconcile:delivery-reliability` per allowlisted merchant: `driftedKeys=[]` (or only sub-tolerance)
- [ ] `getOrder` p95 latency unchanged ±10ms after the read flag is flipped (verified in staging or staff cohort)
- [ ] Manual visual inspection of the order-detail drawer for staff merchants

Pre-flip (before `ANALYTICS_ENABLED=1`):

- [ ] Reads have been on globally for ≥7 days without regression
- [ ] No `getOrder` error spike

Continuous (during all phases):

- [ ] `verify:delivery-reliability` runs at least daily during the rollout window
- [ ] `driftDetected` counter checked at each phase gate
- [ ] `invalidTransition` counter trending flat or 0
- [ ] `writeFailed` rate < 1% of total writes

Steady-state (post Phase 7):

- [ ] Monthly: run `verify:delivery-reliability` (global scope, no `--merchant`) — pass-fail on integrity violations
- [ ] Quarterly: spot-check `reconcile:delivery-reliability` per top-N merchants
- [ ] Document any drift > tolerance incidents and their resolution paths

---

## 9. Merchant rollout recommendations

Layered cohorts, conservative pacing:

| Cohort | Phase | Why first |
|---|---|---|
| **Staff merchants** (your own demo / dogfood accounts) | Phase 2 (writes), Phase 5 (reads) | You see every write and read; you'd notice anomalies first |
| **Low-volume real merchants** (1–10 orders/day) | Phase 3 | Small absolute volume bounds blast radius if anything regresses; representative real traffic |
| **Mid-volume merchants** (10–500 orders/day) | implicit between Phase 3 and Phase 4 (gradual allowlist expansion) | Confirms no per-merchant scaling defect |
| **High-volume merchants** | Phase 4 (allowlist cleared) | Last to onboard |

**Avoid:**
- Mass-migrating top merchants on Day 1 — the §6.2 caveat is most visible at the highest write rates.
- Compressing the 7-day phase gates on first deploy. Compressing later, after real-world signal, is fine.
- Inviting merchants to "preview" the panel before Phase 5 — `READ_ENABLED=0` means the panel is null, so there's nothing to preview.

**Communication posture (UI):**
- The S8 panel is observation-only. No CTA, no automation hook, no fraud-language. Per `delivery-reliability-panel.tsx:27-31`: "Calm, operational, trustworthy. No 'fraud' / 'AI' / 'threat' language."
- The panel renders nothing when `tier: "no_data"` is returned (cold-start posture). Merchants will see it light up over the first 1–4 weeks as their cohorts accumulate terminal flips. This is intentional.

---

## 10. Unresolved non-blocking concerns

| # | Concern | Severity | Notes |
|---|---|---|---|
| C1 | Pre-existing chokepoint stale-snapshot caveat (deep-audit §6.2) | 🟡 monitored | The clock-skew race resolution patch ELIMINATED the reconciler's contribution to drift. The §6.2 caveat (stale `lean` snapshots can cause two callers to both pass `nextStatus !== prevStatus` and over-fire by +1) is INHERITED from existing fan-outs (FraudPrediction, contributeOutcome, recordCourierOutcome, MerchantStats) — v1 does NOT add a new guarantee. Operators monitor `invalidTransition`. Sustained spikes indicate a webhook handler re-fetch regression and should trigger investigation, not panic. |
| C2 | Cancel-path writers (fraud reject, automation-stale, sms-inbound NO) do not instrument the new aggregates | 🟢 future scope | Documented as inherited gap (deep-audit §3.3 / runbook §5 invariant #2). Not part of v1; adding instrumentation is a v1.5 effort. The aggregates correctly reflect what the chokepoint sees; cancel-path cancellations that bypass the chokepoint legitimately do not surface in the buyer-side reliability picture. |
| C3 | Single-key reconciliation reports `driftMagnitude=0` on healthy aggregates after the timestamp unification fix | 🟢 informational | Pre-fix, healthy fresh aggregates reported drift=1 due to the documented clock-skew race. The race resolution patch eliminates this. Operators inspecting a single key should now see drift=0 for healthy keys. |
| C4 | Reconciliation `MAX_RECONCILE_SCAN=10000` cap may surface as `truncated: true` for merchants with > 10k terminal Orders in window | 🟢 by design | Operators tighten `--limit=N` or scope to a single `--key=<hash>`. For now this is the bounded-protection ceiling per blueprint design. |
| C5 | Tests in `apps/api/tests/delivery-reliability-hardening.test.ts:680-720` previously had a 25ms `setTimeout` after each `applyTrackingEvents` call. Remained adequate after the fix; no flakiness observed in the most recent full suite. | 🟢 monitor | If CI flakes appear in the future, replace with a deterministic await on the upsert. Out of scope for current rollout. |

None of C1–C5 are production blockers. C1 is the only one operators actively monitor (via `invalidTransition`).

---

## 11. Final go/no-go recommendation

### GO (with two prerequisites)

The delivery reliability infrastructure is structurally complete and verified across:

- **1058 / 1058 tests pass** (full apps/api suite, 70 test files)
- **328 / 328 delivery-reliability-specific tests pass** (11 files)
- **`tsc --noEmit` exits 0**
- All chokepoint guards (G2 / G6 / G8 / `STATUS_MAP`) byte-identical to pre-S1
- All replay-safety / idempotency invariants verified by integration tests
- Repair is bounded, idempotent, dry-run-by-default, refuses to backfill
- Reconciler is read-only, window-aware, bounded
- Three independent rollback paths (env flag → code revert → schema drop)
- 32-day phased rollout runbook with phase-gating discipline

### Two prerequisites before merge / first prod flag flip

1. **P0 — Index sync wired for the two new models.** Pick one of:
   - (a) Append `CustomerReliability` + `AddressReliability` to all three MODELS arrays (`apps/api/src/index.ts:131-153`, `apps/api/src/scripts/syncIndexes.ts:33-48`, `apps/api/src/server/admin.ts:162-208`). Three mechanical edits, ~6 lines each.
   - (b) One-time manual `createIndex` against the production DB before flipping `WRITE_ENABLED=1`.
2. **P1 — `.env.example` updated** with a `# --- Delivery Reliability v1 ---` block listing all five env vars and their defaults.

### Recommended order

1. Apply P0 (index sync) and P1 (env.example) as a single small PR titled "delivery-reliability: index sync + env discoverability".
2. Tidy doc drift (H5/H6/H7 — references to old `DELIVERY_RELIABILITY_ENABLED` flag name) in the same PR or a follow-up. Non-blocking.
3. Merge the branch.
4. Begin Phase 0 → Phase 1 → Phase 2 per `delivery-reliability-rollout-runbook.md §6`.

The branch is **NOT recommended for merge until P0 lands.** The unique compound index gap is a real production hazard. Once that gap is closed, GO.

---

## 12. Appendix — checklists

### Merge-preparation checklist

- [ ] **(P0)** Append `CustomerReliability` + `AddressReliability` to:
  - [ ] `apps/api/src/index.ts:131-153` boot-time MODELS
  - [ ] `apps/api/src/scripts/syncIndexes.ts:33-48` script MODELS
  - [ ] `apps/api/src/server/admin.ts:162-208` admin endpoint MODELS
- [ ] **(P1)** Add `DELIVERY_RELIABILITY_*` block to `.env.example`
- [ ] **(P3 — optional)** Tidy stale `DELIVERY_RELIABILITY_ENABLED` references in blueprint + execution map (H5/H6) and the JSDoc on `env.ts:198` (H7)
- [ ] Re-run `npm --workspace apps/api test` — confirm 1058+ pass
- [ ] Re-run `npm --workspace apps/api run typecheck` — confirm exit 0
- [ ] Confirm `git diff --stat` shows zero deletions in pre-S1 source lines outside the explicit S10 finalization scope
- [ ] Confirm `.claude/settings.local.json` is NOT included in the commit (local-only)

### Rollout checklist (Phase 0 → Phase 7)

- [ ] **Phase 0** — branch merged, deploy lands; confirm `customer_reliabilities` + `address_reliabilities` collections + unique indexes exist on prod (`db.customer_reliabilities.getIndexes()`)
- [ ] **Phase 1** — `npm run verify:delivery-reliability` against staging shows `phase: off`, all counters 0, no warnings
- [ ] **Phase 2** — set `DELIVERY_RELIABILITY_WRITE_ENABLED=1` + `DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS=<staff_ids>`; restart api
- [ ] **Phase 2 verify (≥24h)** — `verify` shows aggregates growing for staff merchants; `writeFailed=0`; `integrityViolations=0`; `reconcile` shows `driftedKeys=[]`
- [ ] **Phase 2 hold ≥7d** — gate phase advance on phase-gate criteria
- [ ] **Phase 3** — append low-volume merchants to allowlist
- [ ] **Phase 3 verify (≥7d)** — same criteria; broader cohort
- [ ] **Phase 4** — clear allowlist (`DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS=`); writes GA
- [ ] **Phase 4 verify (≥7d)** — `verify` global scope shows healthy stale% and zero integrity violations across all merchants
- [ ] **Phase 5** — set `DELIVERY_RELIABILITY_READ_ENABLED=1` + allowlist back to staff; manually inspect drawer panel
- [ ] **Phase 5 verify (≥3d)** — `getOrder` p95 unchanged ±10ms; staff confirm panel content
- [ ] **Phase 6** — clear allowlist; reads GA
- [ ] **Phase 6 verify (≥7d)** — p95 stable, no `getOrder` errors
- [ ] **Phase 7** — set `DELIVERY_RELIABILITY_ANALYTICS_ENABLED=1`; analytics GA

### Production-enablement checklist (steady-state)

- [ ] On-call has runbook §3 (rollback procedures) bookmarked
- [ ] On-call has runbook §4 ("When drift is detected") bookmarked
- [ ] Daily `verify:delivery-reliability` is wired into ops dashboard (or scheduled cron)
- [ ] `driftDetected` counter is alerting when > 0
- [ ] `writeFailed` rate alerting when > 1% of total writes
- [ ] `invalidTransition` counter alerting on sustained spike
- [ ] Quarterly review of `reconcile:delivery-reliability` per top-N merchants
- [ ] Aggregate growth rate dashboard (rows/day per merchant) wired into existing Grafana
- [ ] No automated repair worker has been added (v1 invariant — repair stays CLI-only)
- [ ] No backfill has been initiated (v1 invariant — pre-flag terminal orders are not retroactively counted)

---

## 13. Prerequisite-patch completion (2026-05-08)

After the readiness review above, the operator approved the P0 + P1 prerequisite patches. Both have been applied. This section is appended-only — the §1–§12 review above is preserved verbatim.

### 13.1 Implemented items

| Item | Status |
|---|---|
| **P0 — Wire `CustomerReliability` + `AddressReliability` into all three production index-sync paths.** | ✅ |
| **P1 — Add `# --- Delivery Reliability v1 ---` block to `.env.example`.** | ✅ |
| **Doc drift — replace stale `DELIVERY_RELIABILITY_ENABLED` references with the canonical `DELIVERY_RELIABILITY_READ_ENABLED`.** | ✅ |

No other code paths were touched. No runtime logic, replay semantic, reconciliation logic, writer, or rollout sequencing was modified.

### 13.2 Exact files touched

| File | Change | Net |
|---|---|---|
| `apps/api/src/index.ts` | Boot-time fire-and-forget `syncIndexes()` MODELS array now includes `CustomerReliability` + `AddressReliability`. The destructured import was extended (1-line split into multi-line). | +14 / -1 |
| `apps/api/src/scripts/syncIndexes.ts` | Out-of-band CLI `MODELS` array now includes both reliability models. New imports added. | +5 / 0 |
| `apps/api/src/server/admin.ts` | `POST /admin/sync-indexes` `MODELS` array now includes both reliability models. New imports added. | +5 / 0 |
| `apps/api/src/env.ts` | JSDoc for `DELIVERY_RELIABILITY_WRITE_ENABLED` now references the canonical `DELIVERY_RELIABILITY_READ_ENABLED` (was: stale `DELIVERY_RELIABILITY_ENABLED`). Pure doc-string. | 1-token swap |
| `.env.example` | New `# --- Delivery Reliability v1 ---` block listing all five `DELIVERY_RELIABILITY_*` env vars with their canonical defaults (4 `=0`, observability `=1`, allowlist empty). | +29 / 0 |
| `docs/audits/delivery-reliability-implementation-blueprint.md` | Stale flag-name occurrences (10) replaced with `DELIVERY_RELIABILITY_READ_ENABLED`; one stale `DELIVERY_RELIABILITY_ANALYTICS` (without `_ENABLED`) corrected. Pure doc edits. | text replacements only |
| `docs/audits/delivery-reliability-engineering-execution-map.md` | Stale flag-name occurrences (5) replaced with `DELIVERY_RELIABILITY_READ_ENABLED`. Pure doc edits. | text replacements only |
| `docs/audits/final-production-readiness-report.md` | This append section. | +N / 0 |

**Total: 8 files. Zero deletions of pre-S1 source lines outside the explicit S10 finalization scope. All source-side changes are additive substitutions inside curated MODEL lists or doc-string corrections.**

### 13.3 Proof — production index-sync coverage

`grep -nE "CustomerReliability|AddressReliability" apps/api/src/index.ts apps/api/src/scripts/syncIndexes.ts apps/api/src/server/admin.ts`:

```
apps/api/src/index.ts:139:        CustomerReliability,
apps/api/src/index.ts:140:        AddressReliability,
apps/api/src/index.ts:153:        ["CustomerReliability", CustomerReliability as unknown as { syncIndexes: () => Promise<unknown> }],
apps/api/src/index.ts:154:        ["AddressReliability", AddressReliability as unknown as { syncIndexes: () => Promise<unknown> }],
apps/api/src/scripts/syncIndexes.ts:3:  AddressReliability,
apps/api/src/scripts/syncIndexes.ts:6:  CustomerReliability,
apps/api/src/scripts/syncIndexes.ts:51:  ["CustomerReliability", CustomerReliability],
apps/api/src/scripts/syncIndexes.ts:52:  ["AddressReliability", AddressReliability],
apps/api/src/server/admin.ts:6:  AddressReliability,
apps/api/src/server/admin.ts:9:  CustomerReliability,
apps/api/src/server/admin.ts:180:    ["CustomerReliability", CustomerReliability as unknown as { syncIndexes: () => Promise<unknown> }],
apps/api/src/server/admin.ts:181:    ["AddressReliability", AddressReliability as unknown as { syncIndexes: () => Promise<unknown> }],
```

**All three production index-sync code paths reference both reliability models.** This means:

| Path | Trigger | Coverage |
|---|---|---|
| Boot-time `syncIndexes()` (apps/api/src/index.ts:131-160) | Every API boot under `if (env.REDIS_URL)` | ✅ Both models |
| Out-of-band CLI (`npm run db:sync-indexes`) | Manual / deploy step | ✅ Both models |
| Admin endpoint `POST /admin/sync-indexes` | `X-Admin-Secret`-gated HTTP call | ✅ Both models |

The unique compound indexes — `{ merchantId: 1, phoneHash: 1 }` (unique) on `customer_reliabilities` and `{ merchantId: 1, addressHash: 1 }` (unique) on `address_reliabilities` — will be provisioned in production on the next deploy boot, with `npm run db:sync-indexes`, OR via an admin HTTP call.

### 13.4 Proof — no semantic / runtime changes

| Verification | Result |
|---|---|
| Schema definitions (`packages/db/src/models/customerReliability.ts`, `packages/db/src/models/addressReliability.ts`) | **Untouched.** No `git diff` entries. |
| Index definitions on the two models | **Untouched.** The unique compound indexes were declared at model-creation time (S2); this patch only ensures they are *applied* in production. |
| `applyTrackingEvents` / chokepoint guards | **Untouched.** `tracking.ts` does not appear in this patch's file list. |
| Reconciliation / repair / integrity logic | **Untouched.** Files do not appear in this patch's file list. |
| Rollout flag semantics (`delivery-reliability-rollout.ts`) | **Untouched.** Pure doc-string + env-example additions. |
| Observability emit semantics | **Untouched.** `observability/delivery-reliability.ts` not in this patch's file list. |
| Writers (`recordCustomerOutcome`, `recordAddressOutcome`) | **Untouched.** |
| Constants — `DRIFT_TOLERANCE`, `MAX_REPAIR_BATCH`, `MAX_RECONCILE_SCAN`, `ANALYTICS_MAX_SCAN`, `DISTINCT_PHONE_HASHES_CAP` | **Untouched.** Verified by `grep`. |

### 13.5 Test verification

| Suite | Result |
|---|---|
| `npm --workspace apps/api run typecheck` (`tsc --noEmit`) | exit 0 |
| `npm --workspace apps/api test -- --run tests/delivery-reliability*.test.ts tests/tracking-reliability-integration.test.ts` | **328 / 328 passed** (11 files) |
| `npm --workspace apps/api test` (full apps/api suite) | **1058 / 1058 passed** (70 files) |

No regression. No replay or idempotency invariant changed. All 13 chokepoint replay/idempotency integration tests pass.

### 13.6 Additive-only verification

| Modified file | Deletions vs `main` |
|---|---|
| `apps/api/src/index.ts` | 1 (the destructured import line, replaced with the multi-line equivalent that adds 2 entries; semantically equivalent — same module, same identifiers + 2 new) |
| `apps/api/src/scripts/syncIndexes.ts` | 0 |
| `apps/api/src/server/admin.ts` | 0 |
| `apps/api/src/env.ts` | 0 (the JSDoc edit was within an addition that was already part of the S9 patch — no pre-existing lines on `main` were removed) |
| `.env.example` | 0 |
| `docs/audits/delivery-reliability-implementation-blueprint.md` | text replacements only (file is untracked vs `main`) |
| `docs/audits/delivery-reliability-engineering-execution-map.md` | text replacements only (file is untracked vs `main`) |

The single source-side deletion (`apps/api/src/index.ts:139` — the destructured import) is a **refactor-equivalent substitution**: the same `import` was replaced with a multi-line form that adds the two new identifiers. No behavior at the import layer changed; the same modules are still imported. This is within the "additive wrappers" envelope described by the engineering execution map.

### 13.7 Updated go/no-go

**GO. The branch is now mergeable.**

Both prerequisites from §11 are closed:

- ✅ P0 — index sync wired in all three production paths
- ✅ P1 — `.env.example` documents all five `DELIVERY_RELIABILITY_*` flags

After merge, Phase 0 → Phase 1 of the rollout runbook (`delivery-reliability-rollout-runbook.md §6`) can begin without further code changes. The first production boot will trigger `syncIndexes()` for the two new collections; the unique compound indexes will be created idempotently. `verify:delivery-reliability` (`npm run verify:delivery-reliability`) is the canonical post-deploy smoke check.

### 13.8 Items deferred to follow-up (not blocking)

| # | Item | Severity |
|---|---|---|
| F1 | Pre-existing references to a stale flag name `DELIVERY_RELIABILITY_ENABLED` inside the §1 hygiene-findings table of THIS report (rows H6/H7) are kept as-is — they describe the historical drift findings and serve as a record. The actual canonical name is now in use everywhere it matters. | doc archive |
| F2 | The `.claude/settings.local.json` diff is local Claude Code permission allowlist — should NOT be committed to `main`. Operator should `git checkout` that file or stash it before commit. | local-only |

No new follow-ups identified.

---

## 14. References

- `docs/audits/delivery-reliability-implementation-blueprint.md` — original architecture
- `docs/audits/delivery-reliability-engineering-execution-map.md` — phase-by-phase implementation map
- `docs/audits/delivery-reliability-rollout-runbook.md` — operational runbook
- `docs/audits/final-delivery-reliability-status-report.md` — pre-merge final audit
- `docs/audits/s10-finalization-verification-report.md` — finalization patch verification
- `docs/audits/reconciliation-window-race-investigation.md` — clock-skew race investigation
- `docs/audits/reconciliation-window-race-resolution-report.md` — clock-skew race resolution
- `docs/audits/deep-scoring-audit.md` §3.3, §6.2 — chokepoint inherited caveats
- `apps/api/src/lib/delivery-reliability-*.ts` — source modules
- `apps/api/src/scripts/{verify,reconcile,repair}DeliveryReliability.ts` — operational CLIs
- `apps/api/tests/delivery-reliability-*.test.ts` + `tracking-reliability-integration.test.ts` — test suite
