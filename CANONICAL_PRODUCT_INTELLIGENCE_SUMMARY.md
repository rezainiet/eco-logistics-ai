# CANONICAL PRODUCT INTELLIGENCE SUMMARY

Cordon — top-level synthesis. This document is the executive read of the
whole engine, grounded in the master docs in this repository.

Companion docs:
- `SYSTEM_ARCHITECTURE_MASTER.md`
- `DATABASE_SCHEMA_MASTER.md`
- `FEATURE_LOGIC_MASTER.md`
- `USER_FLOW_MASTER.md`
- `QUEUE_AND_WORKER_MASTER.md`
- `INTEGRATION_ARCHITECTURE_MASTER.md`
- `FRAUD_AND_INTELLIGENCE_ENGINE_MASTER.md`
- `OPERATIONAL_RUNTIME_MASTER.md`
- `DEPENDENCY_AND_RISK_MAP.md`
- `FUTURE_EVOLUTION_GUIDE.md`

---

## 1. What Cordon is, operationally

A multi-tenant e-commerce logistics + fraud-prevention SaaS. The core value
loop is: ingest the merchant's orders (push via webhooks, polling fallback,
bulk CSV, dashboard), score them for RTO risk with explainable signals,
auto-confirm where appropriate, auto-book the shipment via the best-performing
courier per merchant + district, track the shipment, learn from outcomes,
re-tune the merchant's signal weights monthly.

Around that loop sits an idempotent webhook ingest layer, a dead-letter queue
that never silently loses work, a tamper-evident audit log, a per-merchant
RBAC + step-up admin plane, a public branded tracking page, and a manual+Stripe
billing rail that supports BD-first payment methods (bKash / Nagad / bank).

---

## 2. Architectural maturity — verdict

**Production-ready for design-partner / early-paid scale (single-region,
Atlas + Redis on Railway, single api process).** The codebase has been
through deliberate hardening — `apps/api/CLAUDE.md` reads like an operational
postmortem of every class of bug encountered. The patterns are consistent:

- **Idempotency everywhere a replay can happen.**
- **CAS for stale-overwrite prevention** (`Order.version`).
- **Pure-function intelligence layers** with no opaque ML — every fraud signal carries a `(key, weight, detail)` tuple.
- **Env kill-switches for new subsystems** so a buggy new code path can be turned off without redeploy.
- **Dead-letter that ledger-writes** rather than throws — `safeEnqueue` returns three states, not "ok or throw".
- **Tamper-evident audit log** with append-only schema enforcement.

The recurring patterns are now strong enough that new features can be added
without re-litigating the fundamentals. That is the canonical sign of a SaaS
crossing from "scrappy" to "principled."

---

## 3. Strongest systems (in order)

### 3.1 The webhook ingest layer
Six concurrent inbound surfaces (Shopify, Woo, custom_api, courier, Stripe,
Twilio, SSL Wireless inbound + DLR, Shopify GDPR) all converge on the same
pattern: HMAC verify → idempotency-keyed inbox row → safeEnqueue. The
`WebhookInbox` collection is the heart of "no duplicate orders, ever," with
defense-in-depth via `Order.source.externalId` partial-unique. The phone-required
floor routes ambiguous events to `needs_attention` where merchants can manually
replay rather than silently dropping.

### 3.2 `safeEnqueue` and the DLQ replay sweeper
The discriminated union return type
```
ok:true | ok:true,deadLettered | ok:false
```
is load-bearing. It encodes "Redis blip but recovered," "Redis down but Mongo
caught the work," and "both stores down — caller must handle." The
`pendingJobReplay` worker drains the DLQ on a 30-second sweep with
exponential backoff and per-row claim safety. This is the single most
important architectural property: **the platform does not silently lose
queued work**.

### 3.3 The fraud engine
`computeRisk` is a pure function of `(order, merchantConfig, history,
networkSignal)`. Every signal is explainable. Hard blocks pin to ≥85;
combinations are required for HIGH; gold-tier customers bypass soft signals.
Cross-merchant signal aggregation runs entirely on SHA-256 hashes — privacy
boundary enforced at write *and* read time. Monthly per-merchant weight
tuning closes the feedback loop: outcome (RTO/delivered/cancelled) → 90-day
window → precision/lift → multiplier clamped `[0.5, 1.5]` → updated weights.

### 3.4 Order CAS via `Order.version`
The `__v`-vs-`version` distinction is real and load-bearing. Every Order
mutation routes through `lib/orderConcurrency.ts`. Stale-overwrite is the
class of bug that produces "the booking lock is set but nobody set it,"
"the order was rejected but it's still pending," "fraud rescore overwrote
a manual verification." Closing this class is what made the automation
chain trustworthy.

### 3.5 The booking pipeline
`automationBook` + `PendingAwb` + `awbReconcile` + `idempotencyKey =
sha256(orderId:attempt)` is end-to-end correct under crashes. The PendingAwb
row written *before* the upstream call means a process crash mid-flight is
recoverable (the reconciler probes `Order.logistics.trackingNumber` to decide
whether the upstream actually booked). Fallback chain capped at three couriers
prevents infinite re-booking. The circuit breaker (rolling 1-hour window)
de-ranks flapping couriers without removing them.

### 3.6 Per-merchant rate-limit token bucket
`safeEnqueue` consults a per-merchant token bucket (`lib/merchantRateLimit.ts`)
keyed on `(queueName, merchantId)`. On exhaustion the job is *deferred* (BullMQ
delay, capped at 30s), never silently dropped. Fairness across tenants
without globally throttling the platform.

### 3.7 The tamper-evident audit log
`AuditLog.prevHash + selfHash` SHA-256 chain. Mutations blocked at the schema
level. 134 distinct action enum values across every meaningful state
transition. `actorEmail` captured at write time so the trail survives
merchant deletion.

---

## 4. Weakest systems (real, named)

### 4.1 Single-process api
HTTP + 16 BullMQ workers in one Node process. Acceptable for current scale
but eventually trackingSync + automationBook will compete for cycles. A
process split (api ↔ worker) is documented as a deployment-only change in
`FUTURE_EVOLUTION_GUIDE.md` § 5.9.

### 4.2 Bidirectional integration sync (PLANNED, not implemented)
We *read* from upstream; we don't push status updates back. Merchants who
expect Shopify orders to show "shipped" automatically won't see it.

### 4.3 `custom_api` polling fallback absence
`orderSync` covers Shopify + WooCommerce only. `custom_api` integrations get
no polling-based recovery if their webhook delivery breaks.

### 4.4 Manual payment proof stored in Mongo
`Payment.proofFile.data` is base64 in Mongo. Acceptable at current volume;
needs an S3 migration before the volume becomes unwieldy.

### 4.5 Stripe tier additions require deploy
`STRIPE_PRICE_<TIER>` env vars. Adding a new pricing tier needs an env
update + deploy. Acceptable for infrequent plan changes.

### 4.6 Hardcoded anomaly multipliers / floors
`lib/anomaly.ts` thresholds (e.g. ≥10 in last hour, 3× baseline) are in
code. Tuning per-deploy is fine today but env-vars would make per-environment
tuning easier.

### 4.7 Thana lexicon coverage
v1 seed; weighted to BD divisions where current merchants concentrate. Full
BD coverage is code-only growth, and tracked via the partial-unique index
`(merchantId, customer.thana, createdAt:-1)` already in place.

### 4.8 Operational hints are observation-only
NDR engagement automation is explicitly out of scope (`operational-hints.ts`
verbatim). Hints surface on the order detail drawer; merchants act manually.

### 4.9 Intent Intelligence v1 not wired into risk
`intent.ts:16-17` verbatim:
> *"v1 does NOT feed the risk score; we observe against `FraudPrediction.outcome` for ≥14 days before wiring into `computeRisk` (covered in roadmap Phase 7)."*

This is intentional; the gap is by design until ≥14 days of paired data
accumulates.

### 4.10 Multi-region disaster recovery absent
Single Atlas region + single Railway region. Sufficient at current customer
distribution; would need multi-region Mongo + Railway-equivalent to evolve.

---

## 5. Highest operational risks

In priority order (also see `DEPENDENCY_AND_RISK_MAP.md` for full taxonomy):

1. **MongoDB outage** — every write/read depends on it. Mitigation: Atlas
   replica set + read-from-secondary fallback in places it's safe; api boot
   refuses to start without it.
2. **Redis outage** — workers stop. Mitigation: `safeEnqueue` DLQ catches
   every enqueue; `pendingJobReplay` drains on recovery. Caller-visible
   semantics: "deferred, not lost."
3. **`safeEnqueue` contract regression** — would silently lose work.
   Mitigation: discriminated union return type forces caller-side handling;
   in-process counters surface anomalies.
4. **`Order.version` CAS bypass** — stale-overwrite class of bug.
   Mitigation: `lib/orderConcurrency.ts` is the only sanctioned mutation
   path; new code that bypasses it is the failure-mode signal.
5. **Webhook idempotency drift** — index loss = duplicates re-flow.
   Mitigation: `(merchantId, provider, externalId)` unique on
   `WebhookInbox`, `(merchantId, source.externalId)` partial-unique on
   `Order` — both must be present.
6. **Stripe webhook race** — invoice events delivered twice could double-bill.
   Mitigation: `Payment.providerEventId` and `invoiceId` partial-unique.
7. **Booking duplicate AWB** — process crash mid-flight could double-book.
   Mitigation: `PendingAwb` ledger written *before* upstream call;
   `idempotencyKey = sha256(orderId:attempt)` sent as upstream header for
   server-side collapse.
8. **Tamper of audit log** — would obscure ops actions. Mitigation: pre-save
   hook blocks every mutation type; SHA-256 chain detects out-of-order or
   missing rows.
9. **Courier credential exposure** — vendor-facing breach.
   Mitigation: AES-256-GCM at rest (`v1:iv:tag:ct`), constant-time compare,
   never returned in plaintext to client.
10. **Public tracking page PII leak** — server-rendered, deliberate
    minimal-field projection; would need a code review on any new field
    to prevent inadvertent exposure.

---

## 6. Most scalable subsystems

These are the parts of the architecture where adding more merchants + more
volume continues to work without structural change:

- **`Order` model + indexes**: ESR-correct primary list index, partial
  indexes on every selective filter, hard slice ceiling on tracking events.
- **`WebhookInbox` permanent dedupe + payload reap**: write-once row
  persists; payload reaped at 90 days bounds collection growth.
- **BullMQ workers + repeatable schedules**: multi-instance ready; schedule
  keys collapse on identical (name, opts).
- **Per-merchant token bucket**: fairness scales linearly with merchant count.
- **Cross-merchant fraud network**: SHA-256-keyed; merchant count cap (64)
  per signal row caps document growth.
- **`FraudPrediction` TTL 400d**: bounded retention with a 1-month grace beyond
  the 12-month tuning window.
- **Boot-time `syncIndexes` in background**: port-bind doesn't wait for index
  builds; healthcheck is fast.
- **Pure-function intelligence layers**: `computeRisk`, `computeIntentScore`,
  `computeAddressQuality`, `classifyOperationalHint` are O(input) each.

---

## 7. Safest future extension points

Listed by ratio of *value* to *risk*. See `FUTURE_EVOLUTION_GUIDE.md` for
the full guide.

1. **Add a new fraud signal** — `risk.ts` registry pattern; `signalWeightOverrides` Map; tuning auto-adopts.
2. **Add a new BullMQ worker** — followed by wiring it in `index.ts` (the canonical pitfall).
3. **Add a new commerce integration provider** — type contract is small; webhook router is per-provider switch; `ingestNormalizedOrder` is provider-agnostic.
4. **Add a new courier adapter** — `lib/couriers/index.ts` registry; circuit breaker is automatic.
5. **Add a new admin scope or notification kind** — additive enums.
6. **Add a new operational hint** — pure classifier addition.
7. **Add a new env kill switch** — match the pattern (default ON, single env flip).

---

## 8. Dangerous future refactor zones

Non-exhaustive; see `FUTURE_EVOLUTION_GUIDE.md` § 6.

- **Replacing `Order.version` with Mongoose `__v`** — silently breaks CAS.
- **Merging `WebhookInbox` and `Order.source.externalId`** — defense-in-depth disappears.
- **Moving `<Providers>` into the root layout** — marketing bundle bloats.
- **Bypassing `safeEnqueue`** — loses fairness, retry, DLQ, alerting.
- **Relaxing `AuditLog` mutation guards** — tamper chain breaks.
- **Re-nesting `preActionSnapshot` inside `_id:false` sub-schema** — Mongoose strict-mode quirk strips the field.
- **Removing the `payloadReaped` flag** — reaped rows could re-trigger reap.
- **Dropping the per-merchant token bucket** — one merchant could starve all others on a queue.
- **Trusting `req.ip` without `TRUSTED_PROXIES`** — IP spoofing of fraud signals + audit logs + rate-limit keys.

---

## 9. Recommended long-term architectural direction

### 9.1 Continue investing in the hot-path correctness floor
The CAS + idempotency + DLQ patterns are working. Future complexity (multi-store
per merchant, bidirectional sync, NDR engine) should be added *on top of* these
patterns, not by introducing parallel paths.

### 9.2 Keep intelligence layers pure
`computeRisk`, `computeIntentScore`, `computeAddressQuality`,
`classifyOperationalHint` are pure functions. New layers should follow the
same shape: take a snapshot of state in, return a `(key, weight, detail)[]`
shape out, let the caller decide what to do with it. This is the difference
between "explainable SaaS" and "opaque ML SaaS."

### 9.3 Promote observation-only systems via phased data
Intent → risk wiring is gated on ≥14 days of paired data. Address Intelligence
→ pre-dispatch pause is gated on cohort RTO comparison. Operational hints →
NDR automation is gated on per-merchant opt-in + audit. Each promotion is a
discrete project with measurable cohort comparison, not a "flip the switch"
event.

### 9.4 Process separation as deployment topology
When the single-process api becomes a bottleneck, split into `api` (HTTP) and
`worker` (BullMQ). The code split is trivial — `register*` and `schedule*`
calls move into the worker process. `safeEnqueue` and `getQueue` work
unchanged across processes. Don't pre-emptively split before scale demands it.

### 9.5 Multi-region only when customers demand it
Atlas + Railway in a single region is sufficient for current geography. The
data model is region-agnostic; the work to multi-region is operational, not
schema. Don't build multi-region capability until a paying customer demands
it; build right when they do.

### 9.6 Bidirectional integration sync as a real product surface
Today we *read*. Pushing status back to Shopify ("fraud_review", "shipped",
"rto") is a real merchant value. Implement once with idempotency on the
*outbound* side too (don't re-tag on retry). Per-provider write API support
will dictate scope.

### 9.7 RTO Engine v2 as the next major arc
`RTO_ENGINE_EXECUTION_ROADMAP.md` and `RTO_PREVENTION_STRATEGY_MASTERPLAN.md`
exist in this repo and represent a coherent next-arc roadmap. The current
observation-only systems (Intent, Address, Operational Hints) are the input
substrate; the RTO Engine v2 is the action layer. This is where the platform
crosses from "track fraud" to "prevent RTO."

---

## 10. Production maturity verdict

| Dimension                                          | Maturity |
| -------------------------------------------------- | -------- |
| Hot-path correctness (idempotency, CAS, replay)    | ★★★★★    |
| Webhook ingest layer                               | ★★★★★    |
| Fraud engine (signal explainability + tuning)      | ★★★★★    |
| Tamper-evident audit                               | ★★★★★    |
| BullMQ queue topology + DLQ                        | ★★★★★    |
| Cross-merchant network privacy boundary            | ★★★★★    |
| Booking pipeline + reconciliation                  | ★★★★☆    |
| Stripe + manual billing                            | ★★★★☆    |
| Storefront tracker SDK + identity resolution       | ★★★★☆    |
| Public tracking page + branding                    | ★★★★☆    |
| Cart recovery                                      | ★★★☆☆    |
| Operational observability (admin /system)          | ★★★★☆    |
| Tenant rate-limit fairness                         | ★★★★☆    |
| Process topology (single-process api + workers)    | ★★★☆☆    |
| Multi-region DR                                    | ★☆☆☆☆    |
| Bidirectional integration sync                     | ☆☆☆☆☆ (PLANNED) |
| Operational hints → NDR action                     | ☆☆☆☆☆ (PLANNED) |
| Intent → risk wiring                               | ☆☆☆☆☆ (PLANNED) |

**Overall: production-ready for design-partner / early-paid scale.** The next
inflection point is RTO Engine v2 (action layer over the existing observation
substrate) and the deployment-topology split into separate `api` / `worker`
processes when scale demands it.

---

## 11. Recommended next engineering milestone

Based on the real architecture state — not roadmap fantasy:

**Promote Intent Intelligence v1 from observation-only to a `computeRisk`
signal.** The criteria from `intent.ts:16-17` are objective: ≥14 days of
paired (intent score, FraudPrediction.outcome) data, positive RTO
discrimination over noise, conservative initial weight. The infrastructure
is in place: `Order.intent` is stamped, `FraudPrediction.outcome` is
stamped, the tuning worker auto-adopts new signals. The work is:

1. Run the cohort comparison (existing analytics surface; no new code).
2. Add `intent_low` and `intent_high` signal entries to `risk.ts` registry
   with conservative initial weights (e.g. 8 each).
3. Let the next monthly `fraudWeightTuning` cycle adjust.
4. Surface in dashboard (already partially surfaced as observation; just
   add to the order-drawer signals section).

This converts the platform from "observe + score" to "observe + score +
re-score on intent." It's a one-PR change with measurable cohort impact and
no net-new infrastructure.

The runner-up milestone is **NDR engagement automation on the
`address_clarification_needed` operational hint**, which is the highest-impact
direct action conversion in the current observation substrate. The complexity
sits in per-merchant opt-in + outbound SMS template design + audit, not the
underlying classifier (which is already implemented).

---

## 12. One-paragraph summary for a non-engineering reader

Cordon is a multi-tenant SaaS that ingests merchants' e-commerce orders
across Shopify / WooCommerce / custom integrations, scores each order for
return-to-origin (RTO) risk using fifteen explainable signals plus a
privacy-preserving cross-merchant fraud network, auto-confirms low-risk
orders by SMS, auto-books shipments via the historically best-performing
courier per merchant + district, tracks delivery via courier webhooks +
polling, and re-tunes each merchant's risk weights monthly from outcomes.
The system is built on Next.js + Express + tRPC + BullMQ + MongoDB + Redis;
deployed on Railway with Atlas-managed Mongo and a managed Redis; integrated
with Stripe (international billing) and bKash/Nagad/bank-receipt rails (BD
billing), SSL Wireless SMS, Twilio voice, and Resend email. Every replay
surface is idempotent. Every queued job has a dead-letter ledger. Every
order mutation uses optimistic concurrency. Every admin action is recorded
in a tamper-evident chain. Every fraud signal is explainable, mergeable,
and per-merchant tunable. The architecture is production-ready at design-partner
scale; the next major arc is converting observation-only intelligence layers
(Intent, Address Quality, Operational Hints) into action layers via the RTO
Engine v2.
