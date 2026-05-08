# FEATURE LOGIC MASTER

Per-feature deep-logic doc. Every feature below corresponds to real code paths
under `apps/api/src/` and `apps/web/src/`. UI surfaces, backend logic, queue
interactions, DB writes, replay behavior, failure semantics, recovery semantics
are documented end-to-end.

Aspirational features are NOT documented here. Phase/PLANNED markers are
explicit.

---

## 1. Onboarding (merchant signup → first import)

**Purpose**: get a merchant from signup to "their orders are flowing" with the smallest possible UI surface.

### Backend (`apps/api/src/server/auth.ts`)

REST endpoints (NOT tRPC — auth is REST so NextAuth's CredentialsProvider can hit them):
- `POST /auth/signup` — create Merchant, send email verification token (hashed; `tokenSchema` in merchant.ts), 14-day trial set on `subscription.trialEndsAt`.
- `POST /auth/login` — verify password (`bcryptjs`), mint JWT, write Mongo session.
- `POST /auth/refresh` — silent token refresh on 401.
- `POST /auth/logout` — revoke session.
- `POST /auth/logout-all` — revoke all sessions.
- `POST /auth/forgot-password` — single-use hashed token, emailed via Resend.
- `POST /auth/reset-password` — consume token, write new bcrypt hash, revoke all sessions (defense in depth).
- `POST /auth/verify-email` — consume `emailVerification` token, set `emailVerified=true`.
- `POST /auth/resend-verification` — re-mint and email.

### UI (`apps/web/src/app/(auth)/*`, plus `forgot-password`, `reset-password`, `verify-email*`)
- Login / signup wrapped in `<Providers>` (SessionProvider + tRPC + QueryClient).
- Forgot/reset/verify pages **don't** wrap providers — they POST directly via `fetch` and stay light.
- All auth-flavored pages use `components/shell/cordon-auth-shell.tsx`. Legacy `account-shell.tsx` is deprecated.
- NextAuth `/api/auth/[...nextauth]` adapts the REST `/auth/login` into a NextAuth Credentials session (JWT strategy).

### Onboarding state machine (`apps/web/src/lib/onboarding/*`)
Five steps, **derived from dashboard queries** (no separate persisted onboarding row):
1. Connect store (`Integration.status==="connected"`)
2. Import orders (`Order.count >= 1`)
3. Add courier (`Merchant.couriers[].length >= 1`)
4. Enable automation (`Merchant.automationConfig.enabled === true`)
5. Test SMS (`Merchant.couriers[].length >= 1` AND a recent automationSms confirmation seen — heuristic)

`/dashboard/getting-started` renders progress; `NewMerchantRedirect` pushes a freshly-signed-in merchant here on first dashboard visit. `FirstFlagBanner` celebrates milestones.

### Failure semantics
- Email send is fire-and-forget; in dev → stdout, in prod with no key → silent skip + warn. Auth flow never blocks on email delivery.
- Token consumption is single-use: the schema's `consumedAt` is set; replay returns 400.
- Email verification token TTL: enforced via `expiresAt`; expired → 400 (UI offers resend).

### Recovery
- Lost password → `/forgot-password` → token email → `/reset-password`.
- Lost session → silent refresh on 401 (custom `SESSION_UNAUTHORIZED_EVENT` triggers re-auth).
- Email verification token expired → `/verify-email` page offers resend.

---

## 2. Integrations connect (Shopify / WooCommerce / custom_api / CSV)

**Purpose**: connect a commerce platform; auto-register webhooks; pull a sample import.

### Backend (`apps/api/src/server/routers/integrations.ts`, `lib/integrations/*`)

tRPC procedures (merchantProcedure unless noted):
- `list` (query) — list this merchant's `Integration` rows; redacts encrypted credentials.
- `connect` (mutation) — provider-specific:
  - **shopify**: if env has app credentials → return install URL; on completion (GET `/api/integrations`), exchange code, persist `accessToken`, register webhooks. Else (legacy custom-app): merchant supplies `apiKey + apiSecret` directly; encrypt + persist; register webhooks.
  - **woocommerce**: persist `consumerKey + consumerSecret + siteUrl` encrypted; probe auth strategy; mint webhook secret; POST to `/wc/v3/webhooks` to subscribe.
  - **custom_api**: persist `apiKey` encrypted; mint and return `webhookSecret`.
- `disconnect` (mutation) — set `status=disconnected`, drop scheduled webhooks where applicable.
- `pause` / `resume` (mutation) — mark `pausedAt`, `pausedReason`. Polling worker skips paused.
- `test` (mutation) — provider-specific health probe; updates `health.{ok, lastError, lastCheckedAt}`.
- `importOrders` (mutation, billable) — create `ImportJob` row, enqueue `commerceImport`.
- `replayWebhooks` (mutation, scoped admin) — replay `WebhookInbox` rows in a window.

### UI (`apps/web/src/app/dashboard/integrations/*` + `_components/*`)
- List of connected integrations.
- "Connect" dialog opens a per-provider form.
- "Issues" sub-page (`/dashboard/integrations/issues`) lists `WebhookInbox` rows in `needs_attention` for manual replay.
- Manual sync button → `importOrders`.

### Queue interactions
- Connect → no enqueue.
- Webhook receipt → `webhookProcess` (event-driven, concurrency 8).
- Manual import → `commerceImport` (concurrency 2).
- Sweep recovery → `webhookRetry` (cron 60s).
- Polling fallback → `orderSync` (cron 5m).

### Replay behavior
- Webhook row in `WebhookInbox` is the canonical idempotency key. Replay never produces duplicate Order.
- Polling fallback re-fetches and uses the same key.

### Failure semantics
- HMAC mismatch → 401, no inbox row.
- Stale freshness (>5 min) → 401.
- Phone missing → `needs_attention`, NOT auto-retried.
- Other transient errors → `failed` + exponential `nextRetryAt`. After cap → `deadLetteredAt`.

### Recovery
- Manual replay from `/dashboard/integrations/issues` (per-row).
- Bulk replay (admin) via `replayWebhooks`.

---

## 3. Order create (dashboard, API, bulk upload, webhook)

**Purpose**: ingest an order. Single canonical pipeline (`ingestNormalizedOrder`) regardless of source.

### Entry points
- Dashboard create (tRPC `orders.create`) — channel `dashboard`. Carries `clientRequestId` for double-click idempotency.
- Bulk upload (tRPC `orders.bulkUpload`) — channel `bulk_upload`. CSV parsed per row; `BulkUploadBatch` row created first (anti-replay).
- Webhook (per-provider) — channel `webhook`.
- API (PLANNED — currently only via dashboard create).
- System (e.g. test seeds) — channel `system`.

### Pipeline (full path documented in `INTEGRATION_ARCHITECTURE_MASTER.md` § 4)
1. Phone canonicalize.
2. Address normalize + thana extract.
3. Duplicate guard.
4. Quota reserve.
5. Address Intelligence stamp.
6. computeRisk (fraud + network bonus).
7. Order.create (in tx; post-save updates MerchantStats in same session).
8. FraudPrediction.create.
9. Integration counters bump.
10. Identity resolution stitch.
11. Intent scoring stamp.
12. Automation engine decision.

### DB writes (per order)
- `Order` (1)
- `MerchantStats` increment (post-save hook, in-session)
- `FraudPrediction` (1, best-effort)
- `Integration.counts.ordersImported` increment, `lastSyncAt` touch
- `TrackingSession.resolvedOrderId` (fire-and-forget identity-resolution)
- `Order.intent` patch (fire-and-forget intent score)
- `WebhookInbox` upsert (when webhook-sourced; status flows `received → processing → succeeded`)
- `BulkUploadBatch` row (when bulk-upload-sourced)

### Queue interactions
- `automationSms` enqueued when state lands `pending_confirmation`.
- `automationBook` enqueued when state lands `auto_confirmed` AND `autoBookEnabled`.
- `risk` rescore NOT enqueued at create (the create itself ran computeRisk synchronously).

### Failure semantics
- Duplicate `(merchantId, source.externalId)` → defense-in-depth via partial-unique; the transaction's E11000 catch returns the existing order.
- Quota exhausted → `RESOURCE_EXHAUSTED`; quota refund applies.
- Phone invalid → 400 (dashboard) / `needs_attention` (webhook).

---

## 4. Fraud review

**Purpose**: surface orders that scored HIGH or `pending_call`; let the merchant verify or reject.

### Backend (`apps/api/src/server/routers/fraud.ts`)
- `listPendingReviews` (query) — paginated; filter by status/level; sorted by `(fraud.riskScore desc, _id desc)` using the dedicated index.
- `markVerified` (mutation, billable) — `fraud.reviewStatus=verified`, free-form note. Idempotent.
- `markRejected` (mutation, billable) — `fraud.reviewStatus=rejected`, `order.status=cancelled`, `automation.state=rejected`. **Builds `preActionSnapshot`** before writing so restore is reversible.
- `markNoAnswer` (mutation, billable) — `reviewStatus=no_answer`. Triggers operational hint `customer_unreachable_pending_call` on UI.
- `rescore` (mutation, scoped admin) — manual trigger; enqueues `risk` recompute.
- `restoreOrder` (mutation) — apply `preActionSnapshot` reversal; CAS via `version`.

### UI (`apps/web/src/app/dashboard/fraud-review/*`, components in `components/fraud/*`)
- Queue list with score, level, signals (verbatim from `fraud.signals[]`), confidence label, network bonus indicator.
- Per-order drawer: customer history, fraud reasons, signal explainability, action buttons.
- Soft pin: HIGH-score orders show with "Risky" badge; the `pending_call` queue is the dispatch surface.

### DB writes
- `Order.fraud.{reviewStatus, reviewedAt, reviewedBy, reviewNotes, preRejectReviewStatus, preRejectLevel}`
- `Order.preActionSnapshot` on reject
- `AuditLog.action = fraud.{verified|rejected|no_answer}`
- `Notification` if rescored to HIGH (kind `fraud.rescored_high`)

### Replay behavior
- Manual review never re-overrides terminal state once verified/rejected.
- riskRecompute respects this — verified/rejected orders are skipped.

### Recovery
- Reject → restore via `preActionSnapshot`. Atomically reverses fraud + automation + status.

---

## 5. Automation engine (auto-confirm + auto-book)

**Purpose**: apply per-merchant policy (`automationConfig`) to every new order.

Policy modes (`Merchant.automationConfig.mode`):
- `manual` — every order → `pending_confirmation`. Merchant clicks Confirm or Reject. Default — safest.
- `semi_auto` — low risk → `auto_confirmed`; medium/high → `pending_confirmation`. **Auto-book OFF** unless explicitly enabled.
- `full_auto` — low risk + `riskScore <= maxRiskForAutoConfirm` (default 39) → `auto_confirmed` AND `automationBook` enqueued. Medium → `pending_confirmation`. High → `requires_review`.

### automationSms (`workers/automationSms.ts`)
- Sends "Reply YES <code> to confirm" via SSL Wireless.
- 6-digit confirmation code stamped on `automation.confirmationCode`.
- BullMQ attempts: 5; backoff 15s exponential; jobId `auto-sms:{orderId}` dedupes.
- Inbound SMS handler matches `YES <code>` → confirm + auto-book (full_auto).

### automationStale (`workers/automationStale.ts`)
- 24h stale → notify + `fraud.reviewStatus=pending_call`.
- 72h stale → auto-cancel: `order.status=cancelled`, `automation.state=rejected`, `fraud.smsFeedback=no_reply`.

### automationBook + fallback chain (`workers/automationBook.ts`)
- Selects best courier via `selectBestCourier`; honours `pinnedCourier` first attempt.
- Stamps `PendingAwb` row before upstream call; sends `idempotencyKey = sha256(orderId:attempt)` as upstream header.
- On success → `Order.logistics.{trackingNumber, courier, shippedAt}`.
- On failure → enqueue fallback with next-best courier (jobId encodes attempt). Cap at `MAX_ATTEMPTED_COURIERS=3`.
- All exhausted → critical merchant notification.

### automationWatchdog (`workers/automationWatchdog.ts`)
- Sweeps `auto_confirmed AND autoBookEnabled` orders that didn't get a booking — re-enqueues book with `enforceMerchantQuota=false`.

### awbReconcile (`workers/awbReconcile.ts`)
- Sweeps `PendingAwb.status=pending` past 90s stale.
- Three outcomes: success-catchup, retry, abandon (release booking lock).

### UI
- `/dashboard/orders` shows automation state; per-order drawer surfaces signals + selection breakdown.
- Settings page lets merchant toggle mode + autoBookEnabled + autoBookCourier + maxRiskForAutoConfirm.

---

## 6. Tracking + courier sync

**Purpose**: keep `Order.logistics` fresh; trigger fraud rescore on terminal outcome.

### `trackingSync` worker
- Cadence: env-tunable (default 60 min).
- Picks orders with `lastPolledAt` stale + `trackingNumber` set + status `shipped | in_transit`.
- Calls courier adapter; pushes new normalized events into `trackingEvents` (sliced -100); stamps `lastPolledAt`.
- On RTO/cancelled → `enqueueRescore` (riskRecompute).
- On terminal delivered → updates `Order.logistics.deliveredAt`, contributes outcome to `FraudSignal` cross-merchant network and `CourierPerformance`.

### Courier webhooks
- `/api/webhooks/courier/{merchantId}/{provider}` mounted before JSON parser.
- HMAC per courier; idempotent via SHA1 hash of `(trackingCode, providerStatus, timestamp)`.
- Same write path as trackingSync — appends events, may trigger rescore.

### Public tracking page (`/track/[code]`)
- Server-rendered. Resolves a public tracking code → order (no merchant auth needed).
- Branded per-merchant (`Merchant.branding.{displayName, logoUrl, primaryColor, supportPhone, supportEmail}`).
- Shows the timeline with normalized statuses; never exposes internal fields (PII bounded to public minimums).

---

## 7. Manual + Stripe billing

**Purpose**: BD merchants pay via bKash/Nagad/bank (manual rail); international merchants via Stripe.

### Manual rail
- Merchant submits `payments.submitManual` (mutation):
  - Uploads proof image (base64-stored in `Payment.proofFile.data` via Schema.Types.Mixed; size cap; MIME guard).
  - txnId, sender phone, plan, amount.
  - `clientRequestId` partial-unique catches double-click.
  - Anti-fraud: `txnIdNorm` cross-merchant lookup, `proofHash`, `metadataHash`. Risk score 0-100; ≥60 → `requiresDualApproval`; ≥80 → suspicious-activity dashboard.
- Admin path (`adminBilling`): list pending → review → approve/reject. Approval flips `Merchant.subscription.status=active`, sets `currentPeriodEnd`. Dual-approval requires distinct first/second approvers.

### Stripe rail
- `billing.createSubscriptionCheckout` (mutation, billable) — `stripe.checkout.sessions.create` with `STRIPE_PRICE_*` env. Mode `subscription`. Cancel/success URLs land back in `/dashboard/billing?stripe=...`.
- Webhook `/api/webhooks/stripe`:
  - `checkout.session.completed` → Payment row stamped, `stripeCustomerId/SubscriptionId` persisted.
  - `invoice.payment_succeeded` → status `active`, `currentPeriodEnd` advanced, `gracePeriodEndsAt` cleared.
  - `invoice.payment_failed` → `past_due` + `gracePeriodEndsAt = now + STRIPE_GRACE_DAYS`.
  - `customer.subscription.updated` → tier change; `enforceDowngradeIfNeeded` async.
  - `customer.subscription.deleted` → `cancelled`.
- Idempotency: `Payment.providerEventId` and `Payment.invoiceId` partial-unique.

### Lifecycle
```
trial ──(activate)─► active ──(invoice fail)─► past_due ──(grace expires)─► suspended
                       │                            │
                       └──(invoice succeed)─────────┘
                       └──(merchant cancel)───────► cancelled (kept access until period end)
```

`subscriptionGrace` worker flips `past_due → suspended`. `trialReminder` worker fires once at `TRIAL_WARNING_DAYS` before trial end.

### UI
- `/dashboard/billing` — plan picker, manual proof upload, Stripe checkout button, billing portal button.
- `/admin/billing` — pending payment queue, review actions, plan change, extend trial.

---

## 8. Storefront tracker SDK + collector

**Purpose**: collect behavioral events from the merchant's storefront; feed Intent Intelligence + cart recovery.

### Collector (`/track`, `apps/api/src/server/tracking/collector.ts`)
- CORS open (`origin: true`) — storefronts on any origin can post.
- Auth: `merchant.trackingKey` resolves → merchantId. Optional HMAC: `HMAC-SHA256(secret, timestamp + "." + body)`. Strict mode `trackingStrictHmac=true` rejects unsigned.
- Each event written to `TrackingEvent` (raw, append-only, idempotent via `(merchantId, sessionId, clientEventId)` partial-unique).
- Aggregate rollup written to `TrackingSession` (page/product/cart counts, scroll depth, identity columns, channel attribution, abandonedCart/converted flags, riskHint).

### Identity resolution
- On `checkout_submit` or `identify`, phone/email stamped on TrackingSession.
- `ingestNormalizedOrder` runs identity resolution: match TrackingSession by phone/email → set `resolvedOrderId`.
- Intent scoring then reads sessions linked to the order.

### Cart recovery (`workers/cartRecovery.ts`)
- Sweeps abandoned-cart sessions (≥30 min old, ≤7 days old, `phone` or `email` known, no `resolvedOrderId`, no later converted session for same identity).
- Upserts `RecoveryTask` (one per `(merchantId, sessionId)`) with `$setOnInsert` so agent state is preserved on re-runs.
- Notifies merchant once per day via dedupe-keyed `Notification`.

### UI
- `/dashboard/recovery` — list of pending RecoveryTasks.
- `/dashboard/analytics/behavior` — funnel + intent + repeat-visitor cohorts.

---

## 9. Notifications + admin alerts

**Purpose**: in-app + email/SMS fan-out on critical events.

### `lib/notifications.ts` `dispatchNotification`
- Writes a `Notification` row keyed `(merchantId, dedupeKey)` partial-unique.
- Channels:
  - in-app — always written
  - email — gated on `Merchant.adminAlertPrefs[severity].email` (admins only); merchant prefs surfaced via `merchants` router for non-admin merchants.
  - SMS — gated on `adminAlertPrefs[severity].sms`.
- Severity: `info | warning | critical`.

### Default admin prefs (verbatim from `merchant.ts`)
```
info     — inApp only
warning  — inApp + email
critical — inApp + email + sms
```

### Admin alerts (`lib/admin-alerts.ts`)
- Powered by `AuditLog.action = "alert.fired"` rows.
- Anomaly detectors (`lib/anomaly.ts`) write the audit row, then `deliverAdminAlert` fans out.

### UI
- `/dashboard` topbar Notification icon → `/notifications` route renders unread + recent.
- `/admin/alerts` shows the admin-side anomaly stream.

---

## 10. Audit + observability

### Audit log
- `AuditLog` is append-only at the schema level (mutations blocked).
- Tamper-evident: `prevHash` (previous row's `selfHash`) + `selfHash` (SHA-256 of canonical row form). Verifier in `lib/audit.ts`.
- 134 distinct `action` enum values across risk, order, courier, fraud, automation, payment, subscription, integration, tracking, auth, merchant, Shopify GDPR, admin RBAC, alerts, branding.
- `actorEmail` captured at write time (survives merchant deletion).

### Telemetry
- `lib/telemetry.ts` wraps Sentry-compatible reporting. Fire-and-forget; never breaks request paths. Process hooks (`installProcessHooks`) catch unhandled rejection / uncaught exception.
- Structured per-job logs from worker `on('failed')` and `on('active')` (see `QUEUE_AND_WORKER_MASTER.md`).

### Admin observability surfaces (`adminObservability` router → `/admin/system`)
- Queue snapshot: BullMQ counts per queue + dead-letter rows + `snapshotEnqueueCounters`.
- Webhook failures: recent `WebhookInbox` rows in `failed` / `needs_attention`.
- Fraud overview, payment overview, support snapshot.
- Anomaly stream (last 24h).

---

## 11. Branding (per-merchant + SaaS-level)

### Merchant branding (`Merchant.branding`)
- displayName, logoUrl, logoDataUrl (in-app sidebar/hero, ≤280k chars), primaryColor (`#rrggbb`), supportPhone, supportEmail.
- Surfaced on `/track/[code]` (customer-facing).

### SaaS branding (`BrandingConfig` singleton row, key `"saas"`)
- name, legalName, tagline, productCategory, defaultLocale, URLs (home, status, terms, privacy, support), email contacts, colors/assets/email/seo/operational (Mixed subtrees).
- Resolver: `@ecom/branding` `getBrandingSync()` — pure, no DB call, SSR-safe; merges DB row + `DEFAULT_BRANDING`.
- Admin Branding Panel (`/admin/branding`) → `adminBranding` router. Optimistic concurrency via `BrandingConfig.version`.

### Boot-time seed
`apps/api/src/scripts/seedBranding.ts` runs at boot — idempotent. Failure is non-fatal (resolver falls back to defaults).

---

## 12. Admin RBAC + step-up

### Roles + scopes (`Merchant.adminScopes[]`)
- `super_admin` — full power; implies all others.
- `finance_admin` — payment approval/refund, plan changes.
- `support_admin` — merchant suspension, fraud override.

### Step-up (`lib/admin-stepup.ts`)
- Mints 32-byte single-use tokens with **5-minute TTL**, scoped to a specific permission.
- Required by `scopedAdminProcedure`'s most destructive paths.
- Emits AuditLog entries on grant + use.

### UI (`/admin/access`)
- Whoami; current scopes; alert prefs.
- Grant / revoke scopes (super_admin only).
- Step-up confirmation dialogs on dangerous actions.

---

## 13. Call center + Twilio

### `call` + `callCenter` routers
- `call.dialOrder` (mutation, scoped) — initiates Twilio outbound call to the order's customer phone; stamps `CallLog`.
- `call.recent` (query) — recent calls for an order.
- `callCenter.logManual` (mutation) — manual entry for non-Twilio calls.
- Twilio webhooks (`/api/webhooks/twilio`) — status callbacks, recording webhook, inbound SMS via Twilio path. Updates `CallLog` keyed by `callSid`.

### UI
- `/dashboard/call-customer` — call composer, recent calls, dispatch from fraud review.

---

## 14. Public tracking page (customer-facing)

`/track/[code]` — server-rendered.
- Resolves `code` (a tracking-page slug derived from order) → order without auth.
- Renders: timeline (normalized statuses), branded header (merchant logo + color + support contacts), estimated delivery.
- PII bounded — no internal fraud fields, no risk indicators.
- This is a public surface and the only place where customer-side trust is built. Branding fidelity matters operationally.

---

## 15. Operational replay + recovery surfaces

| Surface                                            | Scope                              | Trigger              |
| -------------------------------------------------- | ---------------------------------- | -------------------- |
| `/dashboard/integrations/issues`                   | per-row WebhookInbox replay        | merchant click       |
| `integrations.replayWebhooks` (admin)              | range replay                       | admin                |
| `pendingJobReplay` (cron 30s)                      | DLQ replay onto BullMQ             | automatic            |
| `awbReconcile` (cron 60s)                          | stale booking lock release         | automatic            |
| `restoreOrder`                                     | reject → restore                   | merchant click        |
| `subscriptionGrace`                                | past_due → suspended               | automatic            |
| `automationStale`                                  | pending_confirmation escalation    | automatic            |
| `webhookRetry`                                     | failed inbox replay                | automatic            |

---

## 16. Feature status snapshot

| Feature                              | Status        | Surfaces                                  |
| ------------------------------------ | ------------- | ----------------------------------------- |
| Onboarding (signup → first import)   | IMPLEMENTED   | (auth) routes, /dashboard/getting-started |
| Shopify OAuth + webhooks             | IMPLEMENTED   | integrations router, webhooks/integrations |
| WooCommerce + custom_api + CSV       | IMPLEMENTED   | same                                      |
| Polling fallback (orderSync)         | IMPLEMENTED (since 2026-05-07)| order-sync queue              |
| computeRisk + signal registry        | IMPLEMENTED   | fraud router, ingest pipeline             |
| Cross-merchant fraud network         | IMPLEMENTED   | env-gated; admin/fraud surfaces           |
| Address Intelligence v1              | IMPLEMENTED + OBS-ONLY | analytics cohorts                |
| Intent Intelligence v1               | IMPLEMENTED + OBS-ONLY | dashboard analytics, order drawer |
| Operational hints                    | IMPLEMENTED + VIS-ONLY | order detail drawer              |
| Reject snapshot / restore            | IMPLEMENTED   | fraud + orders routers                    |
| Automation engine (manual/semi/full) | IMPLEMENTED   | merchant settings, /dashboard/orders      |
| automationSms reliable outbound      | IMPLEMENTED   | order create + watchdog                   |
| automationBook + fallback chain      | IMPLEMENTED   | automationBook worker                     |
| Tracking sync + courier webhooks     | IMPLEMENTED   | trackingSync worker, /track public page   |
| Manual payments (BD)                 | IMPLEMENTED   | billing + adminBilling routers            |
| Stripe subscription                  | IMPLEMENTED   | billing router, webhooks/stripe           |
| Cart recovery                        | IMPLEMENTED   | cartRecovery worker, /dashboard/recovery  |
| Notifications + admin alerts         | IMPLEMENTED   | notifications router, /admin/alerts       |
| Audit log + tamper chain             | IMPLEMENTED   | adminAudit router                         |
| Branding (SaaS + merchant)           | IMPLEMENTED   | adminBranding router, /track              |
| Admin RBAC + step-up                 | IMPLEMENTED   | adminAccess + scopedAdminProcedure        |
| Call center + Twilio                 | IMPLEMENTED   | call + callCenter routers, /dashboard/call-customer |
| Weight tuning (monthly)              | IMPLEMENTED   | fraudWeightTuning worker                  |
| Anomaly detection (admin)            | IMPLEMENTED   | adminObservability router                 |
| Intent → risk wiring                 | **PLANNED**   | Phase 7                                   |
| NDR engagement automation            | **PLANNED**   |                                           |
| Thana-aware courier scoring          | **PLANNED**   | medium-term                               |
| Bidirectional integration sync       | **PLANNED**   |                                           |
| API-keyed external order create      | **PLANNED**   |                                           |
