# DATABASE SCHEMA MASTER

Per-model operational reference grounded in `packages/db/src/models/*.ts`.
Field-by-field is in the source — this document captures **operational role,
lifecycle, write paths, and replay implications** for every model.

All models exported from `@ecom/db` (`packages/db/src/index.ts`).

---

## Inventory at a glance

| Model               | Purpose (one-liner)                                                                                | Cardinality           |
| ------------------- | -------------------------------------------------------------------------------------------------- | --------------------- |
| `Merchant`          | Tenant root; auth, plan, fraud config, branding, automation policy, courier credentials             | 1 per tenant          |
| `Order`             | The atom. Customer order lifecycle from ingest to delivered/RTO                                     | many per merchant     |
| `MerchantStats`     | Denormalized order-state counters per merchant (totals, pending, delivered, rto…)                   | 1 per merchant         |
| `Integration`       | Per-(merchant, provider, accountKey) connector with encrypted credentials                           | up to N per merchant   |
| `WebhookInbox`      | Idempotent webhook ledger; permanent dedupe; payload reaped at 90d                                  | many per integration   |
| `ImportJob`         | Async one-shot import of N orders from connector; dashboard polls progress                          | one per merchant click |
| `BulkUploadBatch`   | Anti-replay guard for CSV uploads — re-submission collides                                          | one per upload         |
| `Payment`           | Manual + Stripe payment receipts; two-stage admin approval                                         | many per merchant      |
| `Usage`             | Monthly usage counters per (merchantId, period="YYYY-MM")                                          | 1 per merchant per month|
| `AuditLog`          | Append-only tamper-evident system action ledger                                                    | high-cardinality       |
| `Notification`      | In-app inbox (fraud, integration, billing alerts)                                                  | many per merchant      |
| `CallLog`           | Per-call record (Twilio / call center) tied to an order                                            | many per merchant      |
| `RecoveryTask`      | Abandoned-cart task queue per merchant                                                             | many per merchant      |
| `TrackingEvent`     | Raw storefront SDK events (page_view, add_to_cart, checkout_submit, …)                              | very high              |
| `TrackingSession`   | Aggregated rollup per session — funnel + intent analytics                                          | high                   |
| `FraudPrediction`   | Per-order prediction → outcome ledger; fed back into monthly weight tuning. TTL 400d                | one per scored order   |
| `FraudSignal`       | Cross-merchant anonymised fraud rollup keyed by `(phoneHash, addressHash)`                          | low (network-wide)     |
| `CourierPerformance`| Per-(merchant, courier, district) outcome counters; powers selection engine                         | small per merchant     |
| `MerchantFeedback`  | Design-partner feedback inbox                                                                      | low                    |
| `BrandingConfig`    | Single-row SaaS-level branding (key="saas"); admin-editable                                        | exactly 1              |
| `PendingAwb`        | Booking-attempt ledger stamped BEFORE upstream call; idempotent retries                            | one per booking attempt|
| `PendingJob`        | Dead-letter ledger for `safeEnqueue` when Redis is unreachable                                     | normally 0; transient  |
| `TrackingEvent` / `TrackingSession`| see above (behavioral)                                                                |                        |

---

## 1. Merchant — `packages/db/src/models/merchant.ts`

**Role**: tenant root. Every other write keys back to `merchantId`.

**Why this matters operationally**: the merchant document carries the *policy* a hot-path read needs (subscription status, automationConfig, fraudConfig, couriers). Hot-path reads cache aggressively (`lib/cache.ts`); writes invalidate. Subscription state is the killer field — `subscription.status` gates *every* `merchantProcedure`.

### Subdocs that drive runtime behavior

- `subscription` — lifecycle: `trial → active → past_due → suspended | cancelled | paused`. `gracePeriodEndsAt` set on Stripe `invoice.payment_failed`; `subscriptionGrace` worker flips to `suspended`. `billingProvider`: `manual | stripe_subscription`.
- `couriers[]` — encrypted (`v1:iv:tag:ct` AES-256-GCM via `lib/crypto.ts`) credentials per provider. `enabled` flag toggles use without re-validation.
- `fraudConfig` — merchant overrides for COD thresholds, blocklists, velocity, and **`signalWeightOverrides` Map** written by `fraudWeightTuning` worker; `baseRtoRate` calibrates P(RTO).
- `branding` — public-facing on `/track/[code]`. `primaryColor` validated `#rrggbb`; web sanitizes.
- `automationConfig` — `mode: manual | semi_auto | full_auto`, `maxRiskForAutoConfirm` (default 39), `autoBookEnabled`, `autoBookCourier`.
- `trackingKey` (sparse-unique) + `trackingSecret` + `trackingStrictHmac` — the storefront SDK's identity to the collector.
- `adminScopes[]` — RBAC: `super_admin | finance_admin | support_admin`.
- `adminAlertPrefs` — per-severity (info/warning/critical) channel toggles for in-app + email + SMS fan-out.
- `notificationsSent.trialEndingAt` — one-shot guard so `trialReminder` doesn't double-fire.

### Indexes (operational view)
- `email` unique
- `(country, createdAt:-1)`
- `(subscription.status)` — sweep base
- `(subscription.status, subscription.trialEndsAt)` — `trialReminder` worker
- `(subscription.status, subscription.gracePeriodEndsAt)` partial — `subscriptionGrace` worker
- `stripeCustomerId` partial-unique, `stripeSubscriptionId` partial-unique — webhook lookup O(1)

### Write paths
- `auth.ts` (signup, login, password reset, email verification consume tokens)
- `merchants` router (profile, branding, fraudConfig, couriers, automationConfig)
- `webhooks/stripe.ts` (subscription state machine)
- `subscriptionGrace`, `trialReminder` workers
- `fraudWeightTuning` (writes `fraudConfig.signalWeightOverrides`, `baseRtoRate`, `lastTunedAt`, `weightsVersion`)
- `admin.ts` REST + admin routers (RBAC scope grants, suspension, plan changes)

---

## 2. Order — `packages/db/src/models/order.ts` (681 lines, the largest model)

**Role**: every customer order from ingest to terminal state. Carries fraud, automation, logistics, and intelligence subdocs. **Every Order mutation must go through `lib/orderConcurrency.ts`** (CAS on `version`) — direct `findOneAndUpdate` without version check is a known bug class.

### Status / state machines (explicit enums)
- `order.status`: `pending | confirmed | packed | shipped | in_transit | delivered | cancelled | rto`
- `automation.state`: `not_evaluated | auto_confirmed | pending_confirmation | confirmed | rejected | requires_review`
- `fraud.reviewStatus`: `not_required | optional_review | pending_call | verified | rejected | no_answer`
- `fraud.level`: `low | medium | high`
- `logistics.trackingEvents[].normalizedStatus`: `pending | picked_up | in_transit | out_for_delivery | delivered | failed | rto | unknown`

### Lifecycle subdocs
- **`fraud`** — riskScore (0-100), level, reasons[], signals[{key,weight,detail}], reviewStatus, smsFeedback, hardBlocked, confidence, confidenceLabel `Safe | Verify | Risky`. **`preRejectReviewStatus` / `preRejectLevel`** stamped at reject; cleared on restore.
- **`automation`** — state, decidedBy, reasons, confirmationCode (6-digit; OTP for SMS YES-replies), confirmationDeliveryStatus + DLR fields, selectedCourier + selectionReason + selectionBreakdown, attemptedCouriers[] (capped `MAX_ATTEMPTED_COURIERS = 3`), pinnedCourier, **`preRejectState`** for restore, `lateReplyAcknowledgedAt`.
- **`logistics`** — courier, trackingNumber, shippedAt, deliveredAt, returnedAt, lastPolledAt, lastWebhookAt, pollErrorCount/pollError, **`bookingInFlight` + `bookingLockedAt` + `bookingAttempt`** (atomic exclusive lock for bookings; idempotency key seed = `(orderId, attempt)`).
- **`source`** — ip, userAgent, addressHash (stable fingerprint), channel `dashboard | bulk_upload | api | webhook | system`, **`externalId`** (provider-side id, partial-unique), **`clientRequestId`** (caller idempotency token, partial-unique), `sourceProvider`, `integrationId`, customerEmail, placedAt.
- **`intent`** — Intent Intelligence v1; observation-only; populated post-identity-resolution from `TrackingSession` rollup. tier: `verified | implicit | unverified | no_data`.
- **`address`** — `quality` subdoc with score, completeness `complete | partial | incomplete`, missingHints, scriptMix, tokenCount, hasNumber, landmarks. Populated synchronously by `computeAddressQuality` at ingest; observation-only.
- **`preActionSnapshot`** (`Mixed`) — full pre-action picture written at reject time. `restoreOrder` reverses fraud + automation + status atomically. Stored top-level (not nested) due to a known Mongoose strict-mode quirk that drops `Mixed` payloads on `_id: false` sub-schemas.

### `version` (optimistic concurrency)
Verbatim from `order.ts`:
> *"`__v` is only checked by `doc.save()` — every Order mutation in this codebase goes through `findOneAndUpdate` / `updateOne`, where `__v` is silently ignored. An explicit field with a documented read-modify-write contract closes the stale-overwrite class of bugs the audit caught (booking lock vs fraud worker, restore vs riskRecompute, etc)."*

### Indexes (operational view)
- `(merchantId, orderNumber)` unique
- `(merchantId, order.status, createdAt:-1)` — primary listing index, ESR-correct
- `(merchantId, customer.phone, createdAt:-1)` — phone history scan
- `(merchantId, fraud.riskScore:-1)` — fraud queue sort
- `(merchantId, fraud.reviewStatus, fraud.riskScore:-1, _id:-1)` — fraud queue list with stable pagination
- `(merchantId, source.externalId)` partial-unique — webhook idempotency
- `(merchantId, source.clientRequestId)` partial-unique — dashboard/API idempotency
- `(merchantId, source.ip, createdAt:-1)` partial — IP velocity signal
- `(merchantId, source.addressHash, createdAt:-1)` partial — address-reuse signal
- `(merchantId, logistics.courier, order.status, _id:-1)` partial — courier analytics
- `(merchantId, address.quality.completeness, createdAt:-1)` partial — Address Intelligence cohorts
- `(merchantId, customer.thana, createdAt:-1)` partial — thana-aware courier perf (medium-term)
- `(merchantId, intent.tier, createdAt:-1)` partial — Intent cohorts
- `(order.status, logistics.lastPolledAt)` partial — `trackingSync` worker pickup
- `logistics.trackingNumber` sparse — courier-webhook lookup

### Hooks
- `pre('save')` flags `_wasNew` for the post-save stats fan-out.
- `post('save')` upserts `MerchantStats.totalOrders + status counter`. Critically, when the save runs inside a Mongoose `ClientSession` (e.g. `createOrder`'s exactly-once tx), the stats `$inc` runs in the **same** session — otherwise the tx aborts and stats are double-counted.
- `post('insertMany')` aggregates stats per merchant and upserts in one round-trip.

### Slice ceiling
`MAX_TRACKING_EVENTS = 100`. Writers use `$push: { trackingEvents: { $each: [...], $slice: -MAX_TRACKING_EVENTS } }` so couriers chattering 8-12 events per delivery never grow a single doc past 16 MB.

---

## 3. Integration — `packages/db/src/models/integration.ts`

Per-merchant connector (`shopify | woocommerce | custom_api | csv`). Status: `pending | connected | disconnected | error`. Multiple rows per merchant allowed via unique `(merchantId, provider, accountKey)`.

Stores **encrypted** credentials in `credentials` (apiKey/apiSecret/accessToken/consumerKey/consumerSecret/siteUrl/scopes/installNonce/installStartedAt). Webhook subscriptions tracked under `webhookStatus.subscriptions[]`. Health: `health.{ok, lastError, lastCheckedAt}`. Counts: `counts.{ordersImported, ordersFailed}`. Pause states: `degraded`, `pausedAt`, `pausedReason`, `pausedBy`.

Indexes: `(merchantId, provider, accountKey)` unique; `(merchantId, status)`.

Read paths: `integrations` router (list, test, manual sync), `webhooks/integrations.ts` (lookup by provider+accountKey), `orderSync` worker.

---

## 4. WebhookInbox — `packages/db/src/models/webhookInbox.ts`

**Role**: idempotent webhook ledger. Every inbound webhook stamps `(merchantId, provider, externalId)` row before processing. Replays never produce duplicate orders.

Status: `received | processing | succeeded | failed | needs_attention`. Verbatim:
- `received` — row stamped, awaiting processing
- `succeeded` — order created OR topic ignored (non-order event)
- `failed` — transient failure; retry per `nextRetryAt`
- `needs_attention` — order-shaped event we CANNOT process (e.g. customer phone missing); surfaces in dashboard for manual replay; **NOT retried automatically**

Indexes:
- `(merchantId, provider, externalId)` unique — **permanent dedupe; NO TTL on collection**
- `(status, nextRetryAt)` partial `status: failed` — `webhookRetry` pickup
- `(merchantId, receivedAt:-1)` partial `status: needs_attention` — merchant inbox
- `(payloadReapAt)` partial `status: succeeded, payloadReaped: false` — reap sweeper

`payloadReapAt` defaults to `receivedAt + 90d`. The sweeper NULLs `payload` + `payloadBytes` once that passes (Shopify orders are 5-50 KB and would otherwise grow the collection unboundedly). The dedupe key persists forever; defense-in-depth is `Order.source.externalId` partial-unique as second-line guard.

---

## 5. PendingJob — `packages/db/src/models/pendingJob.ts`

Dead-letter ledger for `safeEnqueue` when Redis is unreachable. Sweeper replays every 30s with exponential backoff [1m, 5m, 15m, 1h, 4h]; after `MAX_REPLAY_ATTEMPTS = 5` flips to `exhausted` and fires a critical merchant alert.

Indexes:
- `(nextAttemptAt)` partial `status: pending` — sweeper claim
- `(queueName, status, createdAt:-1)` — operator triage

Atomic claim: `findOneAndUpdate` with forward-bumped `nextAttemptAt` so multi-instance sweepers don't double-process.

---

## 6. PendingAwb — `packages/db/src/models/pendingAwb.ts`

Booking-attempt ledger stamped **before** the upstream courier call. `idempotencyKey = sha256(orderId + ":" + attempt)` — sent as upstream header so a process-crash retry collapses duplicates server-side.

Status: `pending | succeeded | failed | orphaned | abandoned`.

`(orderId, attempt)` is unique. The `awbReconcile` worker (60s cron) sweeps stale `pending` rows and either marks them `succeeded` (if `Order.logistics.trackingNumber` was already written), retries (if within budget), or flips to `abandoned` and releases `Order.logistics.bookingInFlight`.

---

## 7. FraudPrediction — `packages/db/src/models/fraudPrediction.ts`

**Role**: per-order prediction snapshot at scoring time + outcome stamp when tracking pipeline lands a terminal status. Powers the monthly `fraudWeightTuning` worker.

Why separate from `Order`:
- Keeps Order writes narrow (every fraud rescore would otherwise rewrite Order).
- Preserves the *immutable signals snapshot at scoring time* (Order's signals can be re-overwritten on rescore).
- TTL independently — 400 days (12 months window + 1 month grace).

Fields: `riskScore`, `pRto` (probability RTO), `levelPredicted`, `customerTier`, `signals[{key,weight}]`, `weightsVersion`, `outcome` (`delivered | rto | cancelled`), `outcomeAt`, `scoredAt`, `expiresAt`.

Indexes:
- `(orderId)` unique
- `(merchantId, outcomeAt)` partial date — tuning-worker primary scan
- `(outcomeAt)` partial date — cross-merchant monthly sweep
- `(merchantId, scoredAt)` — sweep for orders needing outcome
- `(expiresAt)` `expireAfterSeconds: 0` — TTL

---

## 8. FraudSignal — `packages/db/src/models/fraudSignal.ts`

**Role**: cross-merchant anonymised rollup keyed by `(phoneHash, addressHash)`. Either may be `_none_` sentinel. Tracks `deliveredCount/rtoCount/cancelledCount` and `merchantIds` (capped at 64 distinct contributors via schema-level validator).

**Privacy posture (verbatim)**:
> *"raw phone numbers and addresses are NEVER persisted in this collection… Tenant isolation: this collection is global by design — that's the point. The privacy boundary is enforced at write time (only hashes persist) and at read time."*

Read helpers expose counts only — never the merchant list.

Indexes: `(phoneHash, addressHash)` unique; `(phoneHash)`; `(addressHash)`.

Gated by env: `FRAUD_NETWORK_ENABLED` (master), `FRAUD_NETWORK_DECAY_DAYS` (lookup staleness, default 180), `FRAUD_NETWORK_WARMING_FLOOR` (bonus damper threshold, default 50).

---

## 9. CourierPerformance — `packages/db/src/models/courierPerformance.ts`

Per-(merchantId, courier, district) bucket. Counters tick on every order outcome; reads pick the best courier per district (with `_GLOBAL_` fallback when district lacks evidence).

Why per-merchant: courier behaviour varies wildly across merchants (a merchant in Sylhet sees different RedX numbers than one in Dhaka).

Why district + global: at low data volume per-district stats are noisy; selection engine prefers district when a threshold of observations exists, otherwise the merchant's global average.

Fields: `deliveredCount`, `rtoCount`, `cancelledCount`, `totalDeliveryHours` ($inc-only — no read-modify-write), `lastOutcomeAt`, `recentFailureCount` + `recentFailureWindowAt` (rolling-1h circuit-breaker window).

Indexes: `(merchantId, courier, district)` unique; `(merchantId, courier, lastOutcomeAt:-1)`.

---

## 10. AuditLog — `packages/db/src/models/auditLog.ts`

**Append-only** tamper-evident ledger. The pre-save hook **blocks all mutations** (`updateOne`, `updateMany`, `findOneAndUpdate`, `replaceOne`, `deleteOne`, `deleteMany`, `findOneAndDelete`, `findOneAndReplace`). Document-level `save()` refuses re-saves of existing rows.

Each row stores `prevHash` and `selfHash` (SHA-256). Tampering breaks the chain at the row *after* the deletion — not just the deleted one. Verifier in `lib/audit.ts` walks the chain.

Action enum: 134 distinct actions across risk, review, order, courier, fraud, automation, payment, subscription, integration, tracking, auth, merchant, Shopify GDPR, admin RBAC, alerts, branding.

Indexes: `(merchantId, at:-1)`, `(merchantId, subjectType, subjectId, at:-1)`, `(merchantId, action, at:-1)`, `(actorType, at:-1)`, `(action, at:-1)`, `selfHash`.

`actorEmail` captured at write time even if the user is later deleted, so the audit trail survives merchant deletion.

---

## 11. Notification — `packages/db/src/models/notification.ts`

In-app inbox per merchant (`fraud.pending_review`, `fraud.rescored_high`, `fraud.velocity_breach`, `fraud.blocked_match`, `integration.webhook_failed`, `integration.webhook_needs_attention`, `subscription.plan_downgrade_enforced`, `recovery.cart_pending`, `automation.stale_pending`, `automation.watchdog_exhausted`, `queue.enqueue_failed`, `queue.stalled`, `admin.alert`).

`severity: info | warning | critical`. `dedupeKey` partial-unique per `(merchantId, dedupeKey)` — collapses rapid-fire alerts on the same subject (e.g. one `queue.enqueue_failed` per `(queue, merchant, kind, hourBucket)`).

---

## 12. CallLog — `packages/db/src/models/callLog.ts`

Per-call record (Twilio outbound + inbound + manual call-center logs). Pre-validate hook derives `hour` and `dayOfWeek` from `timestamp` for the analytics indexes. Twilio-specific fields: `callSid` sparse-unique, `recordingUrl/Sid`, status enum mirroring Twilio's, error codes.

---

## 13. RecoveryTask — `packages/db/src/models/recoveryTask.ts`

Abandoned-cart task per `(merchantId, sessionId)` (unique). State: `pending | contacted | recovered | dismissed | expired`. Linked to `TrackingSession` (source) and optionally `Order` (when buyer converts).

`cartRecovery` worker upserts with `$setOnInsert` so re-runs never overwrite agent state.

---

## 14. TrackingEvent + TrackingSession — `packages/db/src/models/trackingEvent.ts`, `trackingSession.ts`

`TrackingEvent` is the raw stream from the storefront SDK (`/track` collector). PII bounded: `phone` and `email` only stamped on `checkout_submit` or `identify`. `clientEventId` partial-unique per `(merchantId, sessionId)` for batch-retry idempotency. `ip` and `userAgent` server-side only — never trusted from the SDK.

`TrackingSession` is the rollup: counts (pageViews, productViews, addToCartCount, checkoutStartCount, checkoutSubmitCount, clickCount), `maxScrollDepth`, `firstSeenAt/lastSeenAt`, channel attribution, `repeatVisitor`, `abandonedCart`, `converted`, `riskHint` + `riskFlags`. **`resolvedOrderId`** stamps the identity-resolution stitch when a session's phone/email matches an order.

The Intent Intelligence v1 reads `TrackingSession.{resolvedOrderId, sessionsConsidered}` to score `Order.intent` — observation-only.

---

## 15. ImportJob — `packages/db/src/models/importJob.ts`

Async one-shot import of N orders from a connector. Status: `queued | running | succeeded | failed | cancelled`. Counters: `totalRows / processedRows / importedRows / duplicateRows / failedRows`. Partial success (some imported + some duplicates + some failed) is treated as `succeeded`.

Indexes: `(merchantId, createdAt:-1)`, `(integrationId, status, createdAt:-1)`.

Verbatim: *"Resumable behavior intentionally NOT modeled — adapters only support fetch-most-recent-N, so retried job restarts from scratch."*

---

## 16. BulkUploadBatch — `packages/db/src/models/bulkUploadBatch.ts`

Per CSV upload. `(merchantId, externalBatchId)` unique — re-submission collides on insert and the bulkUpload procedure rejects with a clear "this batch was already uploaded" error. `mode: skip | replace | review` decides duplicate handling. Counters: `rowsParsed/Inserted/Replaced/DuplicatesSkipped/Errors`. Captures `ip` + `userAgent` for abuse triage.

---

## 17. Payment — `packages/db/src/models/payment.ts`

Manual + Stripe receipts. `provider: manual | stripe`. `status: pending | reviewed | approved | rejected | refunded`.

Anti-fraud at submission:
- `txnIdNorm` — normalized txn id; cross-merchant collision detection
- `proofHash` — SHA-256 of uploaded proof image; collision detection
- `metadataHash` — replay detection
- `riskScore` (0-100) + `riskReasons[]`
- `requiresDualApproval` locked in **at submission** to avoid post-hoc tuning

Two-stage review: `>= 60` triggers dual-approval (4-eyes); `>= 80` surfaces in suspicious-activity dashboard.

Stripe partial-uniques:
- `providerSessionId` (Checkout)
- `providerEventId` (idempotency on webhook events)
- `invoiceId` (idempotency on subscription invoices)
- `(merchantId, clientRequestId)` (caller idempotency)

---

## 18. MerchantStats — `packages/db/src/models/merchantStats.ts`

Denormalized order-state counters per merchant (`totalOrders / pending / confirmed / packed / shipped / in_transit / delivered / cancelled / rto`). Updated atomically by Order's post-save and post-insertMany hooks. `timestamps: false` (manual `updatedAt`).

---

## 19. Usage — `packages/db/src/models/usage.ts`

Monthly counters per `(merchantId, period="YYYY-MM")` (UTC). `$inc`-only; never read-modify-write. Counters: `ordersCreated`, `shipmentsBooked`, `fraudReviewsUsed`, `callsInitiated`, `callMinutesUsed`. Helper `currentUsagePeriod(now?)` returns the period key.

`(merchantId, period)` unique.

---

## 20. BrandingConfig — `packages/db/src/models/brandingConfig.ts`

Single SaaS-level branding row (`key: "saas"`). Mutated by `adminBranding` router; consumed by `lib/branding-store.ts` and the public-facing `getBrandingSync()` (no async, SSR-safe).

`Mixed` subtrees for `colors / assets / email / seo / operational` so partial admin updates don't have to thread Mongoose paths for every nested key. Validation lives in zod (`@ecom/branding/schema`) at the router boundary.

`version` is a monotonically incrementing optimistic-concurrency counter for the admin Branding Panel — every write bumps it; UI sends it back to detect concurrent edits.

---

## 21. MerchantFeedback — `packages/db/src/models/merchantFeedback.ts`

Design-partner feedback inbox. Append-only at the application layer (no edits expected from the merchant). `kind: onboarding | integration | support | bug | feature_request | general`. `severity: info | warning | blocker`. `status: new | triaged | resolved | dismissed`. `actorEmail` preserved verbatim even if user later deleted.

Internal ops can update `status / internalNotes / triagedAt` via the admin router only.

---

## Cross-cutting patterns

- **Optimistic concurrency**: Every Order mutation routes through `lib/orderConcurrency.ts` (CAS on `version`). Subscription and BrandingConfig also expose a `version` field.
- **Idempotency keys**:
  - `Order.source.externalId` (provider events)
  - `Order.source.clientRequestId` (caller token)
  - `WebhookInbox(merchantId, provider, externalId)` (permanent dedupe)
  - `PendingAwb.idempotencyKey = sha256(orderId:attempt)` (sent upstream as header)
  - `Payment.providerEventId` and `invoiceId` (Stripe webhook dedupe)
  - `BulkUploadBatch.externalBatchId` (CSV upload)
  - `FraudPrediction.orderId` unique
- **Append-only ledgers**: AuditLog (mutation-blocked at schema level), MerchantFeedback (application-layer convention).
- **Sparse / partial indexes**: every "exists, indexed when present" pattern uses `partialFilterExpression` (Mongo's grammar) instead of `sparse: true` where the planner needs the type predicate to use the index.
- **TTLs**:
  - `FraudPrediction.expiresAt` — 400d
  - `WebhookInbox.payloadReapAt` — 90d (reaps payload only; row persists for permanent dedupe)
- **Hot-fan-out hooks**: Order's post-save / post-insertMany updates `MerchantStats`. Inside a transaction the hook reuses the active session so stats stay consistent if the tx aborts.

---

## What's NOT modeled (status, not roadmap)

- Per-merchant Mongo databases. Tenant isolation is row-level, not database-level. Cross-merchant aggregation (FraudSignal, BrandingConfig) is intentional.
- Soft-delete on Order. `cancelled` is a status; the row persists. Hard delete is a manual ops action via Compass / scripts.
- Append-only versioning on all models. Only AuditLog enforces append-only at the schema level. Order mutations are CAS-safe but not versioned-snapshot.
- Multi-region. Atlas single-region today.
