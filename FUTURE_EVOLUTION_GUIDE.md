# FUTURE EVOLUTION GUIDE

**Not a roadmap fantasy.** This is a guide for what *can* evolve safely, what
*should not* be casually refactored, and where the architecture has explicit
extension seams.

Status labels: **STABLE** (don't touch casually), **EXTENSIBLE** (designed
for safe evolution), **FRAGILE** (refactoring requires careful test surface),
**OBSERVATION-ONLY** (turning observation into action requires explicit
phase work), **PLANNED** (known next steps, not yet code).

---

## 1. Where the architecture is extensible (safe seams)

### 1.1 Adding a new fraud signal
**EXTENSIBLE.** The signal registry in `apps/api/src/server/risk.ts` is structured to accept new signals without database migration:
- Add a `(key, defaultWeight, detector)` entry.
- The signal automatically participates in:
  - `Merchant.fraudConfig.signalWeightOverrides` (Map — no schema migration).
  - `fraudWeightTuning` per-signal precision/lift compute.
  - `FraudPrediction.signals[]` snapshot at scoring time.
  - Dashboard UI surface (signals are rendered iteratively from the array).
- Floor: `MIN_SIGNAL_HITS = 10` before tuning kicks in. New signals safely live alongside untuned defaults until they accrue evidence.
- **What NOT to do**: don't hardcode the signal key in UI rendering — render from `signals[]` array.

### 1.2 Adding a new BullMQ worker
**EXTENSIBLE.** The path is documented in `apps/api/CLAUDE.md` § Worker registration:
1. Add the symbol to `lib/queue.ts` `QUEUE_NAMES`.
2. Create `apps/api/src/workers/<name>.ts` exporting `register<Name>Worker()` and (if scheduled) `schedule<Name>(...)`.
3. Wire both in `apps/api/src/index.ts` boot sequence under `if (env.REDIS_URL)`.
4. Library logic lives in `lib/`, the worker file is the BullMQ wrapper.

If you forget step 3, the worker is dead in production. Use `apps/api/CLAUDE.md`'s "Currently wired" checklist to audit.

### 1.3 Adding a new commerce integration provider
**EXTENSIBLE.** Add a file to `apps/api/src/lib/integrations/<provider>.ts` implementing the type contract in `types.ts` (`fetchSampleOrders`, `validateCredentials`, `subscribeWebhooks`, `unsubscribeWebhooks`). Add the provider to:
- `Integration.provider` enum (`packages/db/src/models/integration.ts`)
- `Order.source.sourceProvider` enum (`packages/db/src/models/order.ts`)
- The webhook router's per-provider HMAC verifier (`apps/api/src/server/webhooks/integrations.ts`).
- The `orderSync` worker's adapter switch.

The hot-path-correctness invariants you must preserve: HMAC over raw body, idempotency key in `WebhookInbox`, missing-phone routing to `needs_attention`, `ingestNormalizedOrder` as the single ingest pipeline.

### 1.4 Adding a new courier
**EXTENSIBLE.** Drop a `lib/couriers/<provider>.ts` adapter. Add to:
- `Merchant.couriers[].name` enum.
- `lib/couriers/index.ts` registry.
- `lib/couriers/circuit-breaker.ts` registers automatically per `(provider:accountId)` key.
- `lib/courier-intelligence.ts` learns the provider's outcomes via `recordCourierOutcome` — no special-case code needed.

### 1.5 Adding a new admin scope
**EXTENSIBLE.** Add to `Merchant.adminScopes` enum. Add `scopedAdminProcedure(...)` checks in the router(s) that need it. Step-up tokens take a free-form `permission` so you can pin them to a custom verb.

### 1.6 Adding a new notification kind
**EXTENSIBLE.** Add to `Notification.kind` enum. Use `dispatchNotification({kind, severity, dedupeKey, ...})`. The fan-out fan-out is automatic per merchant `adminAlertPrefs`.

### 1.7 Adding a new audit action
**EXTENSIBLE.** Add to `AuditLog.action` enum (currently 134 values). The chain hash logic is enum-agnostic.

### 1.8 Adding a new env-gated subsystem
**EXTENSIBLE.** Pattern is in `env.ts`: define a `*_ENABLED` flag (default ON) plus its tuning knobs. The Address Intelligence v1 and Intent Intelligence v1 kill switches show the pattern (`ADDRESS_QUALITY_ENABLED`, `INTENT_SCORING_ENABLED`, `FRAUD_NETWORK_ENABLED`). Default ON, single env flip for instant rollback without redeploy.

### 1.9 Adding a new tier or plan
**EXTENSIBLE in app, FRAGILE in env.** Add to `subscription.tier` enum, plans config in `lib/plans.ts`, entitlements in `lib/entitlements.ts`. **Stripe price IDs require deploy + new env (`STRIPE_PRICE_<TIER>`).** Manual rail just needs the plan in `lib/plans.ts`.

### 1.10 Adding new operational hints
**EXTENSIBLE.** Add a hint code to the `OperationalHint` union type, a detector branch in `classifyOperationalHint`, a UI translation in the order-detail drawer. Pure-function classifier with no side effects.

---

## 2. STABLE systems — refactor only with deliberate care

### 2.1 `safeEnqueue` discriminated union
The return type's three states `{ok:true | ok:true,deadLettered | ok:false}` are load-bearing for every caller. Adding a fourth state requires updating every call site. The DLQ behavior is what distinguishes "deferred" from "lost"; conflating the two would be a regression.

### 2.2 `Order.version` CAS contract
Every Order mutation must go through `lib/orderConcurrency.ts`. The Mongoose `__v` quirk is documented verbatim:
> *"`__v` is only checked by `doc.save()` — every Order mutation in this codebase goes through `findOneAndUpdate` / `updateOne`, where `__v` is silently ignored."*

A future reader who "simplifies" by removing the `version` field reintroduces the entire stale-overwrite class of bugs.

### 2.3 `WebhookInbox` permanent dedupe + payload reap separation
The fact that the row persists forever (no TTL on the collection) but the *payload* is reaped at 90 days is a deliberate split. Removing either half breaks something:
- Removing dedupe row TTL = duplicates re-flow.
- Keeping payloads forever = collection bloat.

The `payloadReaped: boolean` flag is a stable signal that the payload was cleared — without it, reaped rows could re-trigger reap.

### 2.4 The boot order in `apps/api/src/index.ts`
Verbatim:
> *"Boot order: connect DB → init queues → register every worker → start every schedule → start HTTP server."*

Reordering produces hard-to-diagnose races (e.g. starting workers before DB is connected → `safeEnqueue` could DLQ to a Mongo that isn't ready).

### 2.5 The graceful-shutdown sequence
Verbatim:
> *"1. Stop accepting new connections … 2. Drain workers + queues … 3. Close Mongo … 4. process.exit(0) only after 1–3 resolve."*

A 25s watchdog `unref`'d setTimeout force-exits if any step deadlocks; this sits inside Railway's default 30s drain window. Skipping the await on `server.close` was the documented past pain point — in-flight requests responded with TCP RST instead of a clean response.

### 2.6 `AuditLog` schema-level mutation block
Pre-save hook blocks `updateOne`, `updateMany`, `findOneAndUpdate`, `replaceOne`, `deleteOne`, `deleteMany`, `findOneAndDelete`, `findOneAndReplace`. **Don't relax this.** The tamper chain depends on it.

### 2.7 Webhook mount-before-JSON-parser order
The HMAC verification happens over raw bytes. Mounting `express.json` first re-parses the body and `req.rawBody` is gone. The router knows to call `express.raw` internally for Stripe; for Shopify/Woo/custom_api the global mount order matters.

### 2.8 `ingestNormalizedOrder` step ordering
Quota reserve before fraud scoring. Fraud scoring before Order.create. Order.create in transaction with stats update. Identity resolution + intent scoring fire-and-forget *after* commit so they don't roll back the order on stitch failure. Reordering produces double-charges, partial commits, or orphan stats.

---

## 3. FRAGILE areas — touch with test coverage

### 3.1 `Order.preActionSnapshot` reversal logic
The Mongoose strict-mode quirk that drops `Mixed` payloads on `_id:false` sub-schemas is real and undocumented in Mongoose itself. The choice to put `preActionSnapshot` at top level (not nested) is the mitigation. Future migrations that try to "tidy up" by re-nesting will silently break restore.

### 3.2 `Order.fraud.preReject*` legacy fields
Fallback path for `restoreOrder` on rows rejected before the snapshot existed. The schema comment says "Intentionally without `enum:`" because the same Mongoose quirk applies. Don't add an enum constraint and don't drop the legacy fields until the population is fully migrated (and even then, document the cutover).

### 3.3 BullMQ repeatable schedules
Keys are hashed by `(name, repeat opts)`. Renaming a worker but keeping the schedule cron the same orphans the old repeatable in Redis until manually cleaned. Best practice: pick distinct names; if changing cadence, the existing key auto-collides.

### 3.4 `Merchant.fraudConfig.signalWeightOverrides` (Map)
Mongoose Map vs Record<string,number> — the `lean()` projection returns it differently depending on Mongoose version. Code reads both shapes intentionally. Don't "tidy up" to a plain object; the Map type lets per-signal updates avoid full-config rewrites.

### 3.5 The `version` field placement
On `Order`, top-level. On other models that need optimistic concurrency (BrandingConfig), also top-level. **Do not** confuse with Mongoose `__v` (default Mongoose internal); they are intentionally distinct.

### 3.6 The cross-merchant fraud network bonus damper
`FRAUD_NETWORK_WARMING_FLOOR=50` halves bonuses while the network is small. Removing the damper before the network has substantial signal mass causes false-positive spikes during early rollout.

### 3.7 The `Merchant.subscription.status` field
Cached aggressively; webhook-invalidated. Adding a new `status` enum value requires updating: every `merchantProcedure` middleware that enumerates statuses, the entitlements layer, the cache TTL, and the admin UI display. Missing one = silent privilege escalation or denial.

### 3.8 `payloadReaped` boolean vs payload-null heuristics
Future code that checks `payload === null` to mean "reaped" misses the case where a row was malformed at insert. The `payloadReaped` flag is the canonical signal. Don't replace it with implicit nulls.

---

## 4. OBSERVATION-ONLY systems — promotion to action requires phased work

### 4.1 Address Intelligence v1
**Today**: stamped on every order; consumed only by analytics cohorts and order-detail drawer.
**Next**: feed `address.quality.completeness` into a `requires_clarification_pre_dispatch` automation that pauses booking until merchant confirms. This is a real product motion but requires:
- Merchant UI to surface the pause + clarify call-to-action.
- Per-merchant config to opt in.
- Cohort-level A/B comparison vs current RTO baseline.

Don't do this casually — observation-only existence is a feature, not an oversight.

### 4.2 Intent Intelligence v1
**Today**: stamped on every resolved order; surfaced in dashboard.
**Next** (from `intent.ts:16-17` verbatim):
> *"v1 does NOT feed the risk score; we observe against `FraudPrediction.outcome` for ≥14 days before wiring into `computeRisk` (covered in roadmap Phase 7)."*

Promotion requires:
- ≥14 days of paired (intent score, FraudPrediction outcome) data.
- Confirm intent score's RTO discrimination is positive (not just inversely correlated to fraud signals already firing).
- Add as a new signal in `computeRisk` with a conservative initial weight; let `fraudWeightTuning` tune from there.

### 4.3 Operational hints
**Today**: pure-function classifier; UI consumes; no automation.
**Next** (NDR Engine roadmap, multiple PLANNED docs in `RTO_*` files):
- `address_clarification_needed` → trigger an outbound SMS template + booking pause.
- `customer_unreachable_pending_call` → trigger agent dispatch via `callCenter`.
- `confirmation_sms_undelivered` → fall-back to WhatsApp/manual call.

Each hint becoming an action requires:
- Per-merchant opt-in + per-action config.
- New audit action enum entries.
- Failure semantics (what if the SMS fails, what if the call fails?).

---

## 5. PLANNED — concrete next-step features

These are explicitly marked in code/comments or in the existing audit docs.

### 5.1 Intent → risk wiring (Phase 7)
Per `intent.ts:16-17`. Trigger when ≥14 days of outcome data has accumulated.

### 5.2 NDR engagement automation
Per `operational-hints.ts:14-15` ("out of scope for this milestone"). The hints are the input; outbound action is the output. RTO Engine v2 covers this in `RTO_ENGINE_EXECUTION_ROADMAP.md`.

### 5.3 Thana-aware courier scoring
Per `order.ts` index comment: `(merchantId, customer.thana, createdAt:-1)` partial index already exists *for this future*. The lexicon `lib/thana-lexicon.ts` is a v1 seed; full coverage requires:
- Lexicon expansion (code-only change, kept under code review).
- New `CourierPerformance.thana` field + `(merchantId, courier, district, thana)` unique upgrade.
- Selection engine prefers thana-level evidence when ≥10 observations exist.

### 5.4 Bidirectional integration sync
Today we *read* from upstream. PLANNED: pushing order/status updates back (e.g. tag Shopify order as "fraud_review", "shipped"). Requires:
- Per-provider write API support.
- New `Integration.permissions[]` capability flags.
- Idempotency on the *outbound* side too (don't re-tag).

### 5.5 API-keyed external order create
Today the `api` channel exists in the `Order.source.channel` enum but no programmatic API entrypoint. PLANNED:
- API key model (per-merchant, scoped, hashed at rest).
- Rate-limited /api/v1/orders create endpoint.
- Same `ingestNormalizedOrder` pipeline.

### 5.6 Per-thana lexicon expansion
Per `thana-lexicon.ts:9-12`: deliberately weighted to BD divisions where merchants concentrate. Coverage growth is code-only; the seed grows with merchant geography.

### 5.7 RTO Engine v2 (full prevention loop)
Per `RTO_ENGINE_EXECUTION_ROADMAP.md` and `RTO_PREVENTION_STRATEGY_MASTERPLAN.md`. Out of scope for this canonical doc — tracked separately.

### 5.8 Multi-region Mongo + cross-region replication
Today: single Atlas region. PLANNED only if traffic patterns demand. The data model is region-agnostic; the work is operational not schema.

### 5.9 Worker process separation
Today: api process runs HTTP + 16 workers. PLANNED if scaling forces:
- Split into `api` and `worker` processes.
- The boot order moves `register*Worker` and `schedule*` calls into the worker process; the api process just `app.listen`.
- `safeEnqueue` and `getQueue` work unchanged across processes.

This is a deployment topology change, not a code rewrite.

---

## 6. Where NOT to refactor casually

### 6.1 Don't replace `Order.version` with `__v`
`__v` is silently ignored on `findOneAndUpdate`. The explicit field is the entire CAS contract.

### 6.2 Don't merge `WebhookInbox` and `Order.source.externalId` indexes
They are deliberately redundant. Defense in depth.

### 6.3 Don't move `<Providers>` into the root layout
Marketing currently ships zero auth/tRPC weight. Moving providers up = bundle bloat for visitors who never sign in.

### 6.4 Don't introduce a parallel TS palette object for design tokens
Per `apps/web/CLAUDE.md`: *"the previous `lib/design-system.ts` (blue-Logistics palette) was deleted on the Cordon rebrand; don't re-create it."*

### 6.5 Don't add `tsx` to the production runtime
Per `apps/api/CLAUDE.md`: *"Don't add tsx to the production runtime — `tsx` is a dev/test dep."* Production = `node dist/index.js`.

### 6.6 Don't relax `AuditLog` mutation guards
The pre-save hook is the entire append-only contract.

### 6.7 Don't bypass `safeEnqueue` and call `Queue.add` directly
You'd lose: per-merchant fairness, in-process Redis retry, dead-letter to Mongo, merchant alerting, idempotency context.

### 6.8 Don't trust `req.ip` without `TRUSTED_PROXIES` configured
Verbatim: *"blindly trusting `X-Forwarded-For` lets a direct caller spoof the client IP we record for fraud signals + audit logs + rate-limit keying."*

### 6.9 Don't commit `dist/` artifacts
Per root `CLAUDE.md`: *"`apps/api/dist`, `packages/*/dist`, `apps/web/.next`, `apps/web/test-results`, `apps/web/tsconfig.tsbuildinfo` are gitignored. Don't commit them."*

### 6.10 Don't skip `npm --workspace` invocations from root
Per root `CLAUDE.md`: *"From the root, never `cd apps/web && npm install` — use `npm --workspace apps/web ...`."*

### 6.11 Don't leave a route stub when moving a page into a route group
Verbatim from `apps/web/CLAUDE.md`:
> *"Next.js refuses to compile when `app/foo/page.tsx` AND `app/(group)/foo/page.tsx` both exist — they resolve to the same `/foo` URL. If you move a page into a route group, **delete the old folder in the same change**."*

---

## 7. Operational maturity gaps (real, prioritized)

| Gap                                                              | Priority  | Why                                                          |
| ---------------------------------------------------------------- | --------- | ------------------------------------------------------------ |
| Single-process api running both HTTP and 16 workers              | medium    | Splitting is deployment-only; not blocking for current scale |
| Stripe price IDs in env (deploy required for new tiers)          | medium    | Acceptable for plan changes that are infrequent              |
| Manual replay UI for `/dashboard/integrations/issues`            | low       | Already shipped; surface UX could improve                    |
| `orderSync` only covers Shopify + Woo                            | medium    | `custom_api` polling absent (no contract guaranteed)         |
| Bidirectional integration sync (push to upstream)                | medium    | Today we only read                                           |
| Thana coverage in lexicon                                         | low       | Code-only growth; merchant geography drives                  |
| Anomaly multipliers and floors are hardcoded                      | low       | Surface to env vars when tuning becomes per-deploy           |
| `apps/web/.next` cache strategy on long-tail pages                | low       | Marketing surface only; user dashboard is dynamic            |
| Manual payment proof storage (Mixed in Mongo)                    | medium    | Migrating to S3 is straightforward; current cap is OK       |
| Multi-region disaster recovery                                   | low       | Not yet a customer requirement                              |

---

## 8. Architectural directionality

The codebase has converged on a small set of recurring patterns. New work should respect them:

1. **Single canonical pipeline per ingest type** — `ingestNormalizedOrder`, `dispatchNotification`, `safeEnqueue`. Don't add parallel paths.
2. **Idempotency at every replay surface** — webhook, dashboard create, bulk upload, bookings, Stripe events.
3. **CAS via explicit `version` for hot mutations** — Order, BrandingConfig.
4. **Append-only ledgers for compliance + replay** — AuditLog, FraudPrediction, PendingAwb, PendingJob, WebhookInbox.
5. **Per-merchant rate-limit + DLQ for queue fairness** — `safeEnqueue`'s contract.
6. **Pure-function intelligence layers** — computeRisk, computeIntentScore, computeAddressQuality, classifyOperationalHint.
7. **Env kill switches for new subsystems** — `FRAUD_NETWORK_ENABLED`, `ADDRESS_QUALITY_ENABLED`, `INTENT_SCORING_ENABLED`.
8. **Observation before automation** — Intent, Address Intelligence, Operational Hints all stamp data first; turn into actions only with explicit phased work.

A new feature that doesn't fit one of these patterns is either innovation (defend it) or drift (push back).
