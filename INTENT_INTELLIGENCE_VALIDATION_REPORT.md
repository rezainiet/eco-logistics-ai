# INTENT_INTELLIGENCE_VALIDATION_REPORT.md

**Phase:** Intent Intelligence Validation (observation → decision-readiness)
**Repository:** `C:\devs\ecommerce-logistics` (Cordon)
**Date:** 2026-05-07
**Status:** **NOT READY** for `computeRisk` integration — see §5 verdict.

---

## 0. Methodology Framing — Read this first

This report is produced from the repository alone. **The repository contains code and tests; it does not contain a production data warehouse, an ETL'd outcome dataset, or any historical export.** Every statistical claim that this milestone genuinely needs (delivered % per intent tier, RTO % per signal, score-band separation, etc.) requires reading **production Mongo** — specifically `Order.intent.*` joined to `Order.order.status` over a 7/30/90 day window across the live merchant corpus.

To be honest about what is and isn't possible from inside this repo:

| Question | Answerable from repo? | Where the truth lives |
|---|---|---|
| What signals does Intent Intelligence v1 produce? | ✅ Yes — `apps/api/src/lib/intent.ts` | code |
| What weights are assigned to each signal? | ✅ Yes — code | code |
| What does the schema persist per order? | ✅ Yes — `packages/db/src/models/order.ts:380-420` | code |
| Are outcomes labeled per order? | ✅ Yes — `Order.order.status` ∈ {delivered, rto, cancelled, …} | code |
| Are intent predictions snapshot-frozen for retro-tuning? | ✅ Yes — `FraudPrediction` (mirrors what we'd want for intent) | code |
| **Does intent tier "verified" actually deliver at ≥2× the rate of "unverified"?** | ❌ Requires production data | live Mongo |
| **Which signals predict best independently?** | ❌ Requires production data | live Mongo |
| **Are score bands monotonically separating outcomes?** | ❌ Requires production data | live Mongo |
| **What's the no_data rate?** | ❌ Requires production data | live Mongo |

**Therefore this document is structured as:**

1. The **validation methodology** for each phase, using existing analytics or specifying runnable Mongo aggregations.
2. The **architectural review** — qualitative findings from reading the code that the production-data run will either confirm or refute.
3. The **calibration recommendations** grounded in the code itself, not in invented outcome numbers.
4. The **operator-trust audit** — readable from `intent.ts` alone.
5. The **readiness verdict** — `NOT READY` until the Phase 1 queries run against production AND meet the documented thresholds.

A team member can run §1–2's queries against production Mongo, paste the results into the marked **`[FILL: ...]`** placeholders, and ship the resulting populated report as the empirical companion to this methodology document.

> ⚠️ **DO NOT** invent the numbers. The placeholders are explicit so the team can see at a glance what evidence is missing.

---

## Phase 1 — Correlation Analysis

### 1.A · Intent Tier vs Outcome (7d / 30d / 90d)

**Procedure already exists.** No code change needed.

`analytics.intentDistribution({days})` (refactored into
`apps/api/src/server/services/intelligence/intelligenceHandlers.ts:intentDistributionHandler`)
returns exactly this. Each tier bucket carries `total`, `delivered`, `rto`,
`cancelled`, `inFlight`, `resolved`, `deliveredRate`, `rtoRate`. Rates are
computed over RESOLVED orders only — in-flight excluded so a busy pending
pipeline can't make `verified` look pessimistic.

#### Methodology

For each of `days ∈ {7, 30, 90}` and for each tier ∈ `{verified, implicit, unverified, no_data}`:

- **delivered %** = `bucket.deliveredRate` (or `null` when `bucket.resolved === 0`)
- **RTO %** = `bucket.rtoRate`
- **cancelled %** = `bucket.cancelled / bucket.resolved` (compute client-side from the buckets)
- **unresolved %** = `bucket.inFlight / bucket.total` (NB: denominator differs — this is "still pending", not a rate over resolved)

#### Index hit (verified at write-time)

`(merchantId, intent.tier, createdAt:-1)` partial-filter on `intent.tier:string`.
The `$match` clause `"intent.tier": { $type: "string" }` matches the partial
expression so the planner stays narrow.

#### Run instructions (per merchant)

```ts
// scripts/intentValidation.ts (or admin tsx invocation)
const caller = appRouter.createCaller({ user, request: ... });
for (const days of [7, 30, 90]) {
  const r = await caller.analytics.intentDistribution({ days });
  console.log({ days, ...r });
}
```

Or, for cross-merchant validation (admin-only — bypasses the per-merchant guard):

```js
db.orders.aggregate([
  { $match: {
      createdAt: { $gte: ISODate(/* now − 30d */) },
      "intent.tier": { $type: "string" }
  } },
  { $group: {
      _id: { tier: "$intent.tier", status: "$order.status" },
      count: { $sum: 1 }
  } }
]);
```

#### Findings — `[FILL]`

| Window | Tier | Total | Delivered % | RTO % | Cancelled % | Unresolved % |
|---|---|---:|---:|---:|---:|---:|
| 7d  | verified   | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 7d  | implicit   | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 7d  | unverified | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 7d  | no_data    | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 30d | verified   | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 30d | implicit   | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 30d | unverified | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 30d | no_data    | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 90d | verified   | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 90d | implicit   | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 90d | unverified | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 90d | no_data    | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |

#### Architectural expectations (to compare against once filled)

By design (`apps/api/src/lib/intent.ts:355-357`):

- **verified**: score ≥ 70. Reachable only via `multi_day return + organic` OR `confirmation reply` paths. Should have the **lowest RTO rate**.
- **implicit**: 40–69. Single-session strong-engagement OR repeat-visitor + paid social. Mid-pack RTO rate expected.
- **unverified**: <40. Thin paid-social, no engagement signals. Highest RTO rate expected of session-attached cohorts.
- **no_data**: no session matched. Wildcard — could be CSV imports (potentially high quality from an established merchant's customer list) OR storefront-not-instrumented orders. Distribution depends entirely on merchant SDK adoption.

**Failure mode to watch for** (read this when populating the table):

- If `verified` and `unverified` have similar RTO rates → the score is not separating — STOP, debug calibration.
- If `no_data` dominates total volume (>50%) → SDK adoption is too low for tier to be useful at risk-engine integration. Push for SDK rollout before wiring.
- If `verified.deliveredRate < 1.5 × unverified.deliveredRate` → separation too weak; tier is descriptive, not predictive.

---

### 1.B · Intent Score Bands (0–20, 21–40, 41–60, 61–80, 81–100)

**Procedure does NOT exist** — score-band aggregation was deliberately scoped out of v1 (the dashboard cards bucket by tier, not by 5-band score). For validation we run an ad-hoc aggregation.

#### Methodology

Score is on `Order.intent.score` (0–100). Buckets are inclusive on the lower bound, exclusive on the upper, with the top band inclusive on both.

#### Aggregation (Mongo shell)

```js
db.orders.aggregate([
  { $match: {
      createdAt: { $gte: ISODate(/* now − 30d */) },
      "intent.score": { $type: "number" }
  } },
  { $bucket: {
      groupBy: "$intent.score",
      boundaries: [0, 21, 41, 61, 81, 101],
      default: "other",
      output: {
        total: { $sum: 1 },
        delivered: { $sum: { $cond: [{ $eq: ["$order.status", "delivered"] }, 1, 0] } },
        rto:       { $sum: { $cond: [{ $eq: ["$order.status", "rto"] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ["$order.status", "cancelled"] }, 1, 0] } },
        inFlight:  { $sum: {
            $cond: [
              { $in: ["$order.status", ["pending", "confirmed", "packed", "shipped", "in_transit"]] },
              1, 0
            ]
        } }
      }
  } }
]);
```

The current schema has a partial-filter index on `(merchantId, intent.tier, createdAt:-1)` but **NOT** on `intent.score`. The aggregation above will scan via the primary `(merchantId, order.status, createdAt:-1)` listing index and filter `intent.score` in-memory — fine for a one-shot validation, expensive if this becomes a routine query. **Do not promote to a recurring dashboard card without first adding a partial-filter index on `intent.score`.**

#### Findings — `[FILL]`

| Score band | Total | Delivered % (over resolved) | RTO % (over resolved) | Resolved | In-flight |
|---|---:|---:|---:|---:|---:|
| 0–20    | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 21–40   | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 41–60   | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 61–80   | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| 81–100  | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |

#### Statistical separation quality — what to compute

Once filled, validate three conditions:

1. **Monotonicity** — is `deliveredRate` strictly non-decreasing as score band rises? (It SHOULD be; if not, the score is unstable.)
2. **Range spread** — is `deliveredRate(81–100)` − `deliveredRate(0–20)` ≥ **20 percentage points**? Anything less indicates a noisy score.
3. **Bin saturation** — do all bands have ≥30 resolved orders? Otherwise rates are too noisy to trust band-by-band.

If any of the three fails, score banding is not yet a defensible input to `computeRisk`.

#### Overlap problem to look for

The current intent ceiling for a single-session buyer is `12 (repeat) + 8 (engagement) + 10 (dwell) + 10 (funnel) + 15 (organic) = 55` — this is **mid-implicit territory**. Multi-session buyers + confirmation reply are required to enter `verified`. **Expected band shape:** sparse `81–100` band, dense `41–60` and `61–80` bands. If `81–100` is empty in the data, that's a feature of the design, not a bug — but it means score banding alone can't replace tier banding for risk decisions.

---

### 1.C · Signal-Level Predictive Power

Each `Order.intent.signals[]` row records `{ key, weight, detail }`. To measure independent predictive power per signal we can group by signal key.

#### Methodology

For each signal key in `INTENT_SIGNAL_KEYS` (`apps/api/src/lib/intent.ts:33-44`), measure outcome rates among the orders that **did** carry that signal vs orders that **did not** carry it (within the same merchant, within the same window).

#### Aggregation (Mongo shell)

```js
// Per-signal "had this signal" cohort
db.orders.aggregate([
  { $match: { createdAt: { $gte: ISODate(/* now − 30d */) },
              "intent.tier": { $type: "string" } } },
  { $unwind: "$intent.signals" },
  { $group: {
      _id: { key: "$intent.signals.key", status: "$order.status" },
      count: { $sum: 1 }
  } }
]);

// Baseline cohort: every scored order, regardless of which signals fired
db.orders.aggregate([
  { $match: { createdAt: { $gte: ISODate(/* now − 30d */) },
              "intent.tier": { $type: "string" } } },
  { $group: { _id: "$order.status", count: { $sum: 1 } } }
]);
```

Then per signal `k`:

- `RTO_with_signal_k = rto / (delivered + rto + cancelled)` over the unwound cohort filtered to key=k
- `RTO_without_signal_k = (totalRto − rtoWithK) / (totalResolved − resolvedWithK)`
- **Lift** = `RTO_without / RTO_with`. Lift > 1 means the signal's presence is associated with **lower** RTO (i.e. the signal is doing its job). Lift > 1.5 is a strong signal; 1.0–1.2 is noise.

#### Findings — `[FILL]`

| Signal key | Cohort size (had signal) | RTO% with | RTO% without | Lift | Verdict |
|---|---:|---:|---:|---:|---|
| `no_session_data` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `repeat_visitor` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `deep_engagement` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `long_dwell` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `funnel_completion` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `organic_landing` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `multi_session_converter` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `confirmation_delivered` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `confirmation_replied` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `fast_confirmation` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |

#### Architectural expectations

By design (and informed by BD COD operations literature):

- **`confirmation_replied`** SHOULD be the strongest signal. A buyer who manually typed back a code via SMS has demonstrated ownership of the phone + intent to receive. If lift < 2.0, the SMS gateway DLR pipeline likely has a calibration issue — investigate before accepting the signal.
- **`multi_session_converter`** SHOULD be strong (lift > 1.5). Multi-day return is a powerful intent signal in BD where impulse-then-regret patterns dominate.
- **`organic_landing`** SHOULD be moderate (lift 1.2–1.5). Organic search has selection bias toward considered purchase, but BD organic is also dominated by brand-name searches that don't filter for intent.
- **`repeat_visitor`** is at risk of being weak. The TrackingSession `repeatVisitor` flag is set on any anonId observed before — could be a returning buyer (good) or a buyer comparison-shopping (mixed). **Watch this signal.**
- **`deep_engagement`** is at risk of being noisy. The OR clause (`productViews ≥ 3` OR `maxScrollDepth ≥ 50`) is a soft union — split it into two separate signals if the combined cohort shows inconsistent outcomes.
- **`long_dwell`** is at risk of being inflated by tab-left-open behavior. Dwell time is dirty data unless we exclude background-tab time. **If lift is unexpectedly low or even inverted, this is the first signal to drop.**
- **`funnel_completion`** SHOULD be moderate. The 0.5 ratio threshold is generous; merchants whose checkout has friction will see this fire even on indecisive buyers.
- **`no_session_data`** is the comparison floor — it's not a positive signal, it's "we don't know." If `no_session_data` cohort RTO is statistically indistinguishable from `unverified` tier RTO, that confirms our "no_data is wildcard" framing.

#### Edge cases the architecture would surface

- **Single-merchant dominant cohort**: if one large merchant has 80% of orders in the dataset, the per-signal lift is skewed by that merchant's idiosyncrasies. Include a merchant-coverage check: ensure ≥10 merchants have ≥30 scored orders each before treating cross-merchant lift as meaningful.
- **Time-bias**: 30-day windows during/right-after Eid will show RTO inflation regardless of intent. Run the 30d view and the 7d view separately; if they disagree by > 8 percentage points on the same tier, the broader window is contaminated.

---

### 1.D · Address Quality Correlation

Two procedures already exist:

- `analytics.addressQualityDistribution({days})` — completeness × outcome
- `analytics.topThanas({days, limit})` — thana × outcome (volume + rates)

Plus we need additional aggregations for `landmarks`, `scriptMix`, and the `no_anchor` hint specifically.

#### Methodology

##### D.1 — Landmark presence vs delivery success

```js
db.orders.aggregate([
  { $match: { createdAt: { $gte: ISODate(/* now − 30d */) },
              "address.quality.completeness": { $type: "string" } } },
  { $project: {
      hasLandmark: { $gt: [{ $size: "$address.quality.landmarks" }, 0] },
      status: "$order.status"
  } },
  { $group: {
      _id: { hasLandmark: "$hasLandmark", status: "$status" },
      count: { $sum: 1 }
  } }
]);
```

Architectural expectation: orders WITH at least one landmark should deliver at a measurably higher rate. The strategy doc claims "30–60% of BD RTOs trace to address ambiguity, not buyer intent" — this is the test of that claim against our own corpus.

##### D.2 — Thana completeness vs RTO

Direct — pull `analytics.topThanas({days: 90, limit: 50})` and look at:
- Does `pendingRate` correlate with `rtoRate`? (Stuck-in-pending may flip to RTO later — pending_rto pipeline.)
- Are thanas with very low total volume (< 20 orders) showing extreme rates? (They will — small-N noise; exclude from the aggregate verdict.)

##### D.3 — Mixed-script vs courier failure

```js
db.orders.aggregate([
  { $match: { createdAt: { $gte: ISODate(/* now − 30d */) },
              "address.quality.scriptMix": { $type: "string" } } },
  { $group: {
      _id: { scriptMix: "$address.quality.scriptMix", status: "$order.status" },
      count: { $sum: 1 }
  } }
]);
```

Architectural expectation: `mixed` scriptMix should show measurably higher RTO than `latin` or `bangla` alone. The penalty in `address-intelligence.ts` (line 175) is 5 points — small. If the production data shows `mixed` RTO is materially worse, that penalty is undercalibrated.

##### D.4 — Incomplete address vs cancellation

The `addressQualityDistribution` procedure already returns this. Look specifically at:
- `incomplete.cancellationRate` (compute as `cancelled / resolved` from the bucket)
- vs `complete.cancellationRate`

Hypothesis to test: incomplete-address orders are also more likely to get **cancelled at the call-center step** (operator can't reach buyer to fix the address). If this hypothesis holds, address quality is doing double duty as a delivery-feasibility signal AND a buyer-reachability signal.

#### Findings — `[FILL]`

| Slice | Cohort size | Delivered % | RTO % | Cancelled % |
|---|---:|---:|---:|---:|
| `landmarks: yes` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `landmarks: no`  | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `scriptMix: latin`  | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `scriptMix: bangla` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `scriptMix: mixed`  | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `completeness: complete`   | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `completeness: partial`    | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |
| `completeness: incomplete` | `[FILL]` | `[FILL]` | `[FILL]` | `[FILL]` |

#### Verdict template

Address Intelligence is materially useful **iff** `incomplete.RTO% ≥ 1.5 × complete.RTO%`. Anything less and address quality is descriptive but not predictive.

---

## Phase 2 — False Signal Analysis

### 2.A · High-intent orders that became RTO ("verified RTOs")

These are the orders that lost us money despite our best signal. Understanding them is the highest-leverage diagnostic in this entire phase.

#### Pull query

```js
db.orders.find({
  createdAt: { $gte: ISODate(/* now − 90d */) },
  "intent.tier": "verified",
  "order.status": "rto"
}).limit(100).project({
  _id: 1,
  merchantId: 1,
  "customer.thana": 1,
  "customer.district": 1,
  "address.quality.completeness": 1,
  "address.quality.scriptMix": 1,
  "address.quality.missingHints": 1,
  "logistics.courier": 1,
  "logistics.shippedAt": 1,
  "logistics.returnedAt": 1,
  "logistics.trackingEvents": { $slice: -5 },
  "logistics.rtoReason": 1,
  "fraud.reviewStatus": 1,
  "fraud.signals": 1,
  "intent.signals": 1,
  "automation.confirmationDeliveryStatus": 1,
  "automation.confirmedAt": 1,
  createdAt: 1
});
```

#### Manual classification protocol

Cluster the 100-order sample by **first-cause analysis**:

1. **Logistics delay** — `(returnedAt − shippedAt) > P95(courier × district transit time)`. The buyer was committed; the parcel took too long. → **Not an intent failure**; courier or routing failure.
2. **Address ambiguity** — `address.quality.completeness ∈ {partial, incomplete}` despite intent verified. → **Address layer caught the issue but didn't gate the order**; this is exactly what the upcoming pre-dispatch address-confirm step would prevent.
3. **Late tracking events with `failed` status** — courier reported "couldn't deliver" but no rebooking attempt. → **NDR engine failure** (separate milestone); not an intent failure.
4. **Family refusal at door** — no preceding red flag in tracking events; a clean delivery attempt that ended in refusal. → **The "household decides" pattern from the BD strategy doc is real**; intent score on the BUYER didn't capture the household.
5. **Buyer cancelled by SMS reply post-dispatch** — `automation.state` flipped after dispatch (rare path). → **Process gap**, not an intent failure.
6. **Misleading ad** — multiple verified-RTOs from the same `merchantId` + `campaign.source/medium`. Cluster: same campaign drives high-intent buyers who then refuse. → **Merchant-side ad-quality issue**; the intent score correctly observed engagement but the engagement was for a misrepresented product.

#### Findings — `[FILL]`

Sample size: `[FILL]` orders.

| Cause cluster | Count | % of sample |
|---|---:|---:|
| Logistics delay (courier/routing) | `[FILL]` | `[FILL]` |
| Address ambiguity                 | `[FILL]` | `[FILL]` |
| Late tracking / failed-not-recovered | `[FILL]` | `[FILL]` |
| Family refusal at door            | `[FILL]` | `[FILL]` |
| Buyer SMS-cancelled post-dispatch | `[FILL]` | `[FILL]` |
| Misleading ad (clustered campaign)| `[FILL]` | `[FILL]` |
| Other / unclassifiable            | `[FILL]` | `[FILL]` |

#### What the cluster shape determines

- If **address ambiguity** dominates (>40%) → ship Layer 2 pre-dispatch address-confirm flow BEFORE wiring intent into computeRisk.
- If **logistics delay** dominates (>40%) → wiring intent doesn't help; the failure mode is downstream of intent.
- If **family refusal** dominates → intent IS predicting buyer commitment correctly; the gap is the household-confirmation gap (out of v1 scope).
- If **misleading ad** clusters strongly per-merchant → the network-level ad-quality scoring (Layer 6 in the strategy) is needed before intent gets to drive decisions.

---

### 2.B · Low-intent orders that delivered successfully ("unverified deliveries")

#### Pull query

```js
db.orders.find({
  createdAt: { $gte: ISODate(/* now − 90d */) },
  "intent.tier": { $in: ["unverified", "no_data"] },
  "order.status": "delivered"
}).limit(100).project({
  _id: 1,
  "customer.thana": 1,
  "address.quality": 1,
  "intent": 1,
  "source.channel": 1,
  "source.sourceProvider": 1,
  "source.placedAt": 1,
  createdAt: 1
});
```

#### Manual classification protocol

1. **CSV / dashboard imports** — `source.channel ∈ {bulk_upload, dashboard}`, often `intent.tier = no_data`. Established merchant's known-good repeat buyer base. → **Not an intent failure**; intent is structurally blind to these.
2. **First-time buyers from paid social who delivered** — tier=unverified because of paid-social attribution rule (`apps/api/src/lib/intent.ts:147-150`). → If clustered, the paid-social penalty is too harsh — paid social is correlated with low-intent BUT not exclusively low-intent.
3. **SDK-not-yet-installed merchants** — high `no_data` cohort delivering normally. → **SDK rollout issue**, not an intent issue.
4. **Single-session-no-engagement-but-delivered** — buyer landed once, didn't scroll, didn't dwell, ordered, delivered. → The signal IS missing something. Possibilities: phone-trust history (we have it in `customerTier`), prior-merchant-relationship, COD-amount-fits-merchant-pattern. Architectural opportunity.

#### Findings — `[FILL]`

Sample size: `[FILL]` orders.

| Cause cluster | Count | % of sample |
|---|---:|---:|
| CSV / dashboard imports (no_data structural) | `[FILL]` | `[FILL]` |
| Paid-social conversions (unverified)         | `[FILL]` | `[FILL]` |
| SDK-not-installed merchants                  | `[FILL]` | `[FILL]` |
| Single-session-no-engagement                 | `[FILL]` | `[FILL]` |
| Other                                        | `[FILL]` | `[FILL]` |

#### What the cluster shape determines

- If **CSV / dashboard** dominates the unverified-delivered cohort → intent's `no_data` tier is correctly handled. Don't downweight `no_data` in computeRisk.
- If **paid-social** dominates → the paid-social heuristic is too harsh. Recommend changing `paid_social` from "no organic bonus" to "small organic bonus reduced by half" (e.g. +5 instead of 0).
- If **single-session-no-engagement** is large → intent is missing a signal. The phone-trust signal (`customerTier`) from `apps/api/src/server/risk.ts:374-394` is the obvious bridge — but that's already in `computeRisk`. Wiring intent INTO `computeRisk` would let the two signals compose naturally.

---

## Phase 3 — Signal Calibration Recommendations (CODE-GROUNDED ONLY)

The user instructed: "DO NOT modify production scoring yet. Ground recommendations in observed outcomes ONLY. No intuition-based tuning."

**That means we cannot recommend specific weight changes from this phase.** Production data is required. What we CAN recommend, from code review alone, is:

### 3.1 Architectural calibration recommendations (not weight changes)

| Concern | Current state | Recommendation | Trigger |
|---|---|---|---|
| `deep_engagement` is an OR (productViews ≥ 3 OR scroll ≥ 50) — same weight for either path | `apps/api/src/lib/intent.ts:251-263` | Split into two signal keys (`deep_engagement_products`, `deep_engagement_scroll`) so per-signal lift is measurable independently | After Phase 1.C, if combined `deep_engagement` lift is < 1.2 |
| `long_dwell` uses summed `durationMs` across sessions | `apps/api/src/lib/intent.ts:88` (aggregate sum), `269` (60s threshold) | If lift is unexpectedly low, switch to `max(durationMs)` instead of `sum` — long backgrounded tabs inflate sums | After Phase 1.C, if `long_dwell` lift < 1.1 |
| `repeat_visitor` fires on `repeatVisitor === true` OR `sessions.length ≥ 2` — these are different signals | `apps/api/src/lib/intent.ts:240-247` | Same as `deep_engagement` — split if combined cohort doesn't separate cleanly | After Phase 1.C |
| Paid-social earns no organic bonus (binary penalty) | `apps/api/src/lib/intent.ts:289-308` | If unverified-delivered cohort is dominated by paid-social, soften to a half-bonus | After Phase 2.B |
| `no_data` tier's risk profile depends on channel mix | All `no_data` orders treated identically in tier classification | Surface `source.channel` alongside `intent.tier` in the dashboard so operators see "no_data because CSV" vs "no_data because no SDK" | Read the data; if no_data RTO varies materially by channel, this is high priority |
| Score banding doesn't have an index | Schema only indexes `intent.tier`, not `intent.score` | Add `(merchantId, intent.score, createdAt:-1)` partial index ONLY IF score-band cards become recurring dashboard reads | Defer to post-validation |

### 3.2 What we will **not** do based on code review alone

- ❌ Change any signal **weight** (12, 8, 10, 15, 20, etc.). All weight changes require Phase 1.C lift data.
- ❌ Add new signal keys. Out of milestone scope (and the validation period is precisely about confirming the v1 set, not extending it).
- ❌ Move thresholds (the 70/40 tier cutoffs). Same logic — needs band data.

### 3.3 What we WOULD recommend if Phase 1 data confirms expectations

Conditional on Phase 1 numbers landing as expected:

```
IF: verified.deliveredRate ≥ 1.5 × unverified.deliveredRate
AND: confirmation_replied lift > 2.0
AND: no_data cohort < 50% of total volume
THEN: Phase 7 of the master strategy ("Intent score wired into risk weights")
      can begin — the WEIGHT to use is computed by the existing
      `fraudWeightTuning.ts` worker pattern (already runs monthly), not
      hand-tuned. Specifically: introduce a new RiskSignal `intent_low_commitment`
      (mirror of `risk.ts:33-60` shape) seeded at +12, then let the tuner
      adapt per merchant.
```

This is the calibrated, grounded path. It depends on Phase 1.

---

## Phase 4 — Operator Trust Analysis

This phase IS answerable from the repo alone — every signal carries a `detail` string that the operator UI surfaces verbatim. We can audit those strings directly.

### Signal-by-signal trust audit

Each row reads the `detail` template from `apps/api/src/lib/intent.ts` and rates:

- **understandability**: would a non-technical merchant understand the sentence?
- **actionability**: does it suggest a next step (or at least bound the merchant's mental model)?
- **explainability**: can the merchant verify the claim against their own dashboard?

| Signal key | `detail` template | Understand | Action | Explain | Verdict |
|---|---|:-:|:-:|:-:|---|
| `no_session_data` | "No storefront session matched this order. Likely placed via dashboard, CSV import, or a storefront where the Cordon SDK is not installed." | ✅ | ✅ ("install SDK or this is your CSV import") | ✅ | ✅ ship as-is |
| `repeat_visitor` (single) | "Buyer had visited your store at least once before this session." | ✅ | ➖ (descriptive) | ✅ (visible on tracking session) | ✅ ship as-is |
| `repeat_visitor` (multi) | "Buyer visited your store across N sessions before placing this order." | ✅ | ➖ | ✅ | ✅ ship as-is |
| `deep_engagement` (products) | "Buyer viewed N products before checkout." | ✅ | ➖ | ✅ | ✅ ship as-is |
| `deep_engagement` (scroll) | "Buyer scrolled X% through the product page." | ✅ | ➖ | ✅ | ✅ ship as-is |
| `long_dwell` | "Buyer spent Ns on your store before checking out." | ✅ | ➖ | ✅ | ⚠️ trust-but-verify — explain that "session time" excludes background tab time only if it actually does (it doesn't today — see §3.1) |
| `funnel_completion` | "Buyer reached the checkout submit step on their first or second try." | ⚠️ slightly clunky | ➖ | ✅ | ⚠️ rephrase to "Buyer completed checkout without restarting" — same meaning, cleaner |
| `organic_landing` (organic) | "Buyer arrived from organic search (google)." | ✅ | ✅ ("your SEO is working") | ✅ | ✅ ship as-is |
| `organic_landing` (direct) | "Buyer arrived directly — no campaign attribution captured." | ✅ | ➖ | ✅ | ✅ ship as-is |
| `multi_session_converter` | "Buyer returned across N day(s) before ordering." | ✅ | ✅ ("retargeting works for this buyer cohort") | ✅ | ✅ ship as-is |
| `confirmation_delivered` | "Order-confirmation SMS reached the buyer's handset (DLR confirmed)." | ⚠️ "DLR" is jargon | ➖ | ⚠️ DLR is internal-only | 🔧 **rename to "delivery receipt"**; the operator doesn't speak SMS-ops |
| `confirmation_replied` | "Buyer replied to confirm the order." | ✅ | ✅ ("strongest commitment signal") | ✅ | ✅ ship as-is |
| `fast_confirmation` | "Buyer replied within an hour of the prompt." | ✅ | ➖ | ✅ | ✅ ship as-is |

### Findings

- **11 of 13 signal templates** are operator-ready as written.
- **1 signal template** (`funnel_completion`) is clunky — small rephrase recommended.
- **1 signal template** (`confirmation_delivered`) leaks the term "DLR" — change to "delivery receipt".

These two copy changes are non-functional. They can ship in the same change as the `computeRisk` integration without any code-correctness risk.

### Trust-preservation rules

For any future signal added, every contribution string MUST:

- Be a complete sentence in the merchant's reading voice ("Buyer X-ed Y" — never "the system detected X").
- Reference an observable fact (sessions, scrolls, replies) — never an opaque computation.
- Avoid internal jargon (DLR, anon_id, sid, OFD, etc.).
- Pass the "would a non-technical merchant ask 'what does this mean?'" sniff test.

These aren't suggestions; they're enforced via code review. Add the rule to `apps/api/src/lib/intent.ts`'s file-level comment as a **trust contract**.

---

## Phase 5 — Risk Engine Readiness Verdict

### Verdict: **NOT READY**

`computeRisk` integration is conditional on five gates. Three of them are unmeasurable without production data; two of them are partially measurable from the codebase already.

### The five gates

| # | Gate | Source | Status |
|---|---|---|---|
| 1 | **Tier separation** — `verified.deliveredRate ≥ 1.5 × unverified.deliveredRate` (90-day window, ≥10 merchants, ≥30 resolved orders per tier) | Phase 1.A | ❌ unknown — requires production query |
| 2 | **At least 3 signals with material lift** — lift ≥ 1.3, cohort size ≥ 100 resolved | Phase 1.C | ❌ unknown — requires production query |
| 3 | **Score-band monotonicity** — `deliveredRate` strictly non-decreasing across the 5 score bands; band 81–100 deliveredRate − band 0–20 deliveredRate ≥ 20 percentage points | Phase 1.B | ❌ unknown — requires production query |
| 4 | **Address layer materially useful** — `incomplete.RTO% ≥ 1.5 × complete.RTO%` | Phase 1.D | ❌ unknown — requires production query |
| 5 | **`no_data` rate ≤ 50%** of total volume | Phase 1.A or aggregate of all 5 | ❌ unknown, but checkable from existing dashboard procedure call |

**Meeting all five gates → READY.**
**Meeting 3–4 gates → PARTIALLY READY** (specific compensations apply — see below).
**Meeting fewer → NOT READY.**

### Code-side checks (already passing)

These are independently necessary and have already been verified during the implementation milestones:

- ✅ Intent computation never throws back into ingest (Milestone 1, fire-and-forget pattern).
- ✅ Intent subdoc is observation-only — `computeRisk` does not currently read it.
- ✅ All 13 signal `detail` strings are operator-readable (Phase 4 above; 2 minor copy fixes pending).
- ✅ Kill-switches exist (`INTENT_SCORING_ENABLED=0`, `ADDRESS_QUALITY_ENABLED=0`).
- ✅ Audit log retains every state change (Milestone 1).
- ✅ Schema is forward-compatible — legacy orders deserialize, new fields are additive.

### Why "PARTIALLY READY" needs to be defined

If Phase 1 data passes 3-of-5 gates but not all five, the team will be tempted to "ship the bits that work." Specify in advance what "partial" means so the conversation stays grounded:

- **Tier passes (#1) but signals don't (#2)** → integrate **only the tier**, not the score. Use tier as a categorical RiskSignal: verified=−10, implicit=0, unverified=+10. (Nothing for no_data.)
- **Signals pass (#2) but tier doesn't (#1)** → integrate **only the strongest 1–2 signals** as RiskSignals (each capped at +10). Don't surface the tier.
- **Score bands fail monotonicity (#3) but tier passes (#1)** → tier-only integration; the score is a UX number only.
- **Address layer fails (#4) but intent passes (#1, #2, #3)** → ship intent-into-risk; defer address-into-risk for the next milestone.
- **`no_data` > 50% (#5)** → STOP. The risk engine path would be inert for half of orders. Push SDK rollout as a prerequisite.

### Operational stability concerns (not blocking, but worth flagging)

- **Cache invalidation**: `tokenCache` and `subCache` in `apps/api/src/server/trpc.ts` would not need invalidation on intent integration; intent doesn't enter the auth/sub gate. Safe.
- **Worker tuner integration**: `fraudWeightTuning.ts` runs monthly (line 1-30 of that file). When intent enters as a RiskSignal, the tuner will start adjusting its weight per-merchant. This is the correct path — DO NOT hardcode weights. But: the tuner needs **at least 2 months** of post-integration data before its first adjustment lands meaningfully. Plan for the tuner's first-pass output to be conservative.
- **Frozen-snapshot integrity**: every existing `FraudPrediction` row has `weightsVersion` baked in (`apps/api/src/server/risk.ts:84`). Adding intent will require bumping `DEFAULT_WEIGHTS_VERSION` from `"v2.0"` to `"v2.1"` and ensuring the tuner correctly handles the transition. Specify the cutover date in the bump.

### Operational rollout sequence (when READY)

If the gates pass:

1. Bump `DEFAULT_WEIGHTS_VERSION` to `"v2.1"` and add an `intent_low_commitment` (or similar) entry to the `WEIGHTS` block in `risk.ts`. **Initial weight: 0.** Yes, zero — see step 2.
2. Ship as a **shadow signal**: stamp the contribution into `RiskResult.signals` so the agent UI can show it, but with weight 0 it doesn't change scores. Run for 30 days.
3. After 30 days, increase weight in 4-point increments per cycle (4 → 8 → 12) with explicit go/no-go review at each step. The weight target depends on the lift data from Phase 1.C.
4. After the third increment, hand control to the monthly tuner and let per-merchant calibration take over.

### Failure-mode contingency

If any cycle increases merchant-reported false-positive complaints by ≥10% from baseline:

- Roll the weight back to its previous value within one deploy.
- Set `INTENT_SCORING_ENABLED=0` if the cause appears to be intent-side. (Already supported.)
- Audit which signals fired on the false-positive sample; if a single signal accounts for >40% of complaints, drop that signal's weight to 0 and re-investigate.

---

## Summary — Where this leaves us

**What this report establishes:**

1. The validation methodology for every Phase 1 question is fully specified — the team can run it against production Mongo today.
2. The architecture is sound enough to support rigorous validation (every needed field is persisted; every needed index exists or is documented).
3. The operator-trust audit (Phase 4) is complete — 11/13 signal strings ship as-is, 2 need minor rephrases (no functional change).
4. The readiness criteria for `computeRisk` integration are precise enough that the go/no-go decision is mechanical once Phase 1 data lands.

**What this report DOES NOT establish:**

- The actual numerical correlations. They live in production Mongo, not in this repository.
- The actual go/no-go answer. It depends on running the Phase 1 queries against ≥30 days of production data across ≥10 merchants.

**Recommended immediate next action:**

Run the Phase 1 queries (one Node script with 5 Mongo aggregations, ~150 LOC) against staging or production and **populate every `[FILL]` placeholder in this document**. The populated document IS the validation deliverable — this template-with-methodology document is the prerequisite for it.

**Recommended followup action — gated on the populated report:**

If gates 1–4 pass, begin the `computeRisk` shadow-mode integration described in §5's rollout sequence.
If fewer than 3 gates pass, the milestone result is "intent observation needs more time / more SDK rollout / signal redesign" — and the next implementation milestone returns to validation, not to risk-engine integration.

---

**End of validation report.**

*All file paths and signal weights cited in this document are verified against the current `main` branch. The `[FILL]` placeholders are deliberate — populating them with real numbers is the empirical work this milestone exists to scope, not to perform from a development repository.*
