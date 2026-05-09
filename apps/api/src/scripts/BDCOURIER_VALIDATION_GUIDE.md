# BDCourier staging validation guide

Validates BDCourier integration data quality with REAL phones before merchant-facing rollout. **Do not skip.**

## Pre-flight

In staging only:
```bash
EXTERNAL_DELIVERY_ENABLED=1
BDCOURIER_ENABLED=1
BDCOURIER_API_KEY=<rotated key — set in deploy env, never committed>
NETWORK_EVIDENCE_SURFACE_ENABLED=0   # keep merchant UI dark
```

Verify provider is reachable:
```ts
trpc admin.externalProviderHealth()
// expect: providers[0].name === "bdcourier", configured: true
```

## Compose a cohort (20–50 phones)

Copy `bdcourier-cohort-template.json` and replace each `phone` with a REAL Bangladesh phone you can manually verify. The labels are categories you should cover; aim for at least one phone per category:

| Label | What to look for |
|---|---|
| `strong_delivery_known` | Buyer with verified strong history; `strong_delivery_history` should fire |
| `high_return_known` | Buyer you know has had multiple RTOs; `elevated_return_pattern` should fire |
| `sparse_history_new_buyer` | First-time COD buyer; `sparse_history` should fire |
| `shared_phone_family_household` | Phone shared across household members |
| `reseller_high_volume` | High-volume reseller phone — should NOT fire `elevated_return_pattern` if their delivery rate is genuinely high |
| `rural_cod_agent` | Rural COD agent / aggregator phone |
| `marketplace_business_phone` | Daraz/Bikroy-style merchant business number |
| `older_dormant_customer` | Customer with no orders in 12+ months |
| `newly_active_customer` | Customer active for <3 months |
| `merchant_cancellation_inflated` | Buyer where the merchant cancels often (out-of-stock); risk of false `elevated_return_pattern` |

## Run — three modes, run in this order

### 1. Pre-flight (env + provider + cohort sanity, no upstream calls)

Before burning provider quota, verify your environment and cohort first. This makes zero provider calls and catches misconfig early:

```bash
npx tsx apps/api/src/scripts/validateBdCourier.ts \
  --merchantId 507f1f77bcf86cd799439011 \
  --cohort ./my-staging-cohort.json \
  --preflight
```

The script reports `BLOCK` / `WARN` / `PASS` lines. **Fix every `BLOCK` before continuing.** Common blockers:
- `EXTERNAL_DELIVERY_ENABLED=0` — set to 1 in staging.
- `BDCOURIER_API_KEY is unset` — set in deploy env, never commit.
- `Cohort size N below minimum 10` — extend the cohort.
- `Refusing to run in NODE_ENV=production` — pre-flight is staging-only; pass `--allow-production` only if you genuinely need to run in prod (you usually don't).

### 2. Dry-run (fake providers, end-to-end pipeline test)

Validates the harness wiring is correct without making real provider calls. Produces a real-shaped report against synthetic data — **NOT real validation**, but proves the pipeline works:

```bash
npx tsx apps/api/src/scripts/validateBdCourier.ts \
  --merchantId 507f1f77bcf86cd799439011 \
  --cohort ./my-staging-cohort.json \
  --output ./dry-run-report.json \
  --dry-run
```

If this errors out, the harness has a bug. If it produces a report, you're ready for the real run.

### 3. Real run (BDCourier upstream against your cohort)

```bash
npx tsx apps/api/src/scripts/validateBdCourier.ts \
  --cohort ./my-staging-cohort.json \
  --merchantId 507f1f77bcf86cd799439011 \
  --output ./bdcourier-validation-report-2026-05-09.json \
  --notes "Initial staging validation, cohort assembled by ops 2026-05-09"
```

The script:
- normalises each phone, hashes it
- forces a fresh `getOrFetchExternalProfile` (bypasses cache + Mongo freshness)
- captures the canonical profile, signals, source, latency
- writes a JSON report containing **only phoneHash + cohortLabel** (never raw phone)
- computes the rollout-readiness verdict against documented thresholds

## Interpret the verdict

The report's top-level `verdict` field tells you the answer:
- `verdict.ready: true, blockers: [], warnings: []` → **safe to roll out**.
- `verdict.ready: true, warnings: […]` → **safe to roll out**, but address the warnings within 1–2 weeks.
- `verdict.ready: false, blockers: […]` → **DO NOT roll out**. Fix each blocker.

Hard-fail blockers documented in `validation-summary.ts`:
- BDCourier failure rate > 15%
- Mean latency > 2000ms or max > 5000ms
- `sparse_history` rate > 60% (BDCourier coverage too thin)
- Resolved-share < 50% (likely orchestrator misconfig)
- Any classifier-defect anomaly

## Manual review (always required before rollout)

Even with `verdict.ready: true`, do this before flipping `NETWORK_EVIDENCE_SURFACE_ENABLED=1`:

1. **Open the report's `summary.anomalies` array.** Every entry is a phone the harness flagged for manual eyes. Cross-check each against your operator knowledge — does the flag make sense?

2. **Sample 10 random `elevated_return_pattern` cases** from the report's outcomes. For each, check the buyer's actual history with the merchant (call-center notes, prior orders). If 3+ are clearly false positives, raise the threshold:
   - Either bump `ELEVATED_RETURN_RATE` from 0.25 → 0.35 in `signals.ts`
   - OR bump `ELEVATED_RETURN_MIN_OBSERVATIONS` from 10 → 15
   - Re-run the validation harness; verdict must stay green.

3. **Inspect the BD operational-edge-cases** — confirm at least one cohort phone per category is well-represented in the resolved set. If none of your `reseller_high_volume` phones produced data, the cohort isn't yet representative.

## Rollout sequence

After a clean validation run + manual review:
1. Flip `NETWORK_EVIDENCE_SURFACE_ENABLED=1` for 1–3 friendly merchants in staging.
2. Watch the structured-log stream for `external_profile_fetch_completed` / `external_provider_timeout` / `external_profile_cache_hit` for one week.
3. If clean, replicate to production — same flags, same merchant cohort first.

## What NOT to do

- Do NOT enable in production without a clean staging report.
- Do NOT raise `BDCOURIER_TIMEOUT_MS` above 30000.
- Do NOT log raw `BDCOURIER_API_KEY` anywhere.
- Do NOT commit the validation report containing real phoneHashes to a public repo (they're not raw phones, but treat them as sensitive).
- Do NOT add automation that consumes `signals.elevated_return_pattern` without an additional human-in-the-loop step.
