# Operational Runtime + Infrastructure Guide

**Cordon e-commerce logistics platform** — complete deployment, observability, persistence, integrations, and graceful shutdown documentation.

---

## 1. Runtime Topology

### Service Layout
- **API**: `apps/api` (Express + tRPC server, BullMQ workers, Mongoose), port 4000
- **Web**: `apps/web` (Next.js 14 App Router, NextAuth, tRPC client, Tailwind), port 3001
- **MongoDB**: Persistent operational data, accessed via `MONGODB_URI`
- **Redis**: BullMQ queue state, rate-limit tokens, session store, optional cache
- **External**: Stripe, Resend (email), SSL Wireless (SMS), courier APIs (Pathao, Steadfast, RedX)

### Docker Compose (Dev/Local)
```yaml
services:
  mongo:      mongo:7 on 27017 with persistent volume
  redis:      redis:7-alpine on 6379 with persistent volume
```

Both services have `restart: unless-stopped` to auto-recover on crash.

### Bootstrap Order
1. Validate environment variables early (fail fast with readable error)
2. Connect MongoDB (sets `autoIndex=false` in production, auto-enables in dev/test)
3. Assert Redis is reachable (in prod only; dev warns and continues)
4. Seed singleton branding row (idempotent, non-fatal if it fails)
5. Fire-and-forget index sync (`syncIndexes()` on Order, WebhookInbox, Integration, Merchant, ImportJob) — runs in background, never blocks port bind
6. Initialize BullMQ queues (workers registered only if `REDIS_URL` is set)
7. Register all repeatable jobs (tracking sync, trial reminder, subscription grace, automation stale/watchdog, AWB reconcile, fraud weight tuning, cart recovery, order sync, pending job replay)
8. Bind Express server to port 4000, log "listening"

---

## 2. Environment Variables

### Categorization & Validation

#### Core (Required in All Environments)
- `NODE_ENV`: "development" | "production" | "test"
- `API_PORT`: default 4000
- `MONGODB_URI`: Valid mongodb:// or mongodb+srv:// URL
- `JWT_SECRET`: min 16 chars (authentication tokens)
- `COURIER_ENC_KEY`: base64-encoded 32-byte AES-256-GCM key; **REQUIRED in every env** (dev/test/staging/prod). Generation: `openssl rand -base64 32`

#### Production-Only (Validated at Boot)
- `REDIS_URL`: Required in production, optional in dev (with loud warning if missing)
- `ADMIN_SECRET`: min 24 chars (X-Admin-Secret header for /admin routes), required in production

#### Proxy Trust
- `TRUSTED_PROXIES`: Optional. Controls Express's `trust proxy` setting.
  - `false`/`0`/unset → don't trust X-Forwarded-For (default, safest)
  - `true` → trust all
  - Integer N → trust last N hops
  - Comma-separated CIDRs → trust those networks (e.g., "10.0.0.0/8,fd00::/8")
  - **Why this matters**: blindly trusting X-Forwarded-For lets attackers spoof client IP in fraud signals, audit logs, rate-limit keying. Misconfig = silent bypass of all IP-based defenses.

#### Trial & Billing
- `TRIAL_DAYS`: int 1-90, default 14
- `TRIAL_WARNING_DAYS`: int 1-14, default 3 (warn that many days before trial ends)
- `STRIPE_SECRET_KEY`: optional (card payments)
- `STRIPE_WEBHOOK_SECRET`: optional (Stripe event signature validation)
- `STRIPE_USE_USD`: "0"|"1", default "1" (charge in USD vs BDT)
- `STRIPE_PERIOD_DAYS`: int 1-365, default 30 (subscription length after Stripe checkout)
- `STRIPE_GRACE_DAYS`: int 1-30, default 7 (grace period before suspension on `invoice.payment_failed`)
- `STRIPE_PRICE_*`: STRIPE_PRICE_STARTER, STRIPE_PRICE_GROWTH, STRIPE_PRICE_SCALE, STRIPE_PRICE_ENTERPRISE (optional in dev; required for checkout in prod)

#### Courier Defaults (Per-Merchant Override)
- `PATHAO_BASE_URL`: default "https://api-hermes.pathao.com"
- `STEADFAST_BASE_URL`: default "https://portal.packzy.com"
- `REDX_BASE_URL`: default "https://openapi.redx.com.bd"
- `COURIER_MOCK`: "0"|"1", default "0" (force in-memory mocks, auto-on in test env)

#### Tracking Sync
- `TRACKING_SYNC_INTERVAL_MIN`: int 0-1440, default 60 (0 = disabled)
- `TRACKING_SYNC_BATCH`: int 1-500, default 100

#### Email (Resend)
- `RESEND_API_KEY`: optional (dev: logs to stdout; prod: warns if missing)
- `EMAIL_FROM`: optional (overrides branded sender)
- `PUBLIC_WEB_URL`: optional (defaults to localhost:3001, used in email link construction)

#### SMS (Bangladesh — SSL Wireless)
- `SSL_WIRELESS_API_KEY`, `SSL_WIRELESS_USER`, `SSL_WIRELESS_SID`: optional trio
  - **Dev**: all unset → logs to stdout
  - **Prod**: any unset → loud warning, no-ops on send, never throws into request path
- `SSL_WIRELESS_DEFAULT_SENDER`: optional (alpha sender mask, max 20 chars, defaults to SID)
- `SSL_WIRELESS_BASE_URL`: default "https://smsplus.sslwireless.com"
- `SMS_WEBHOOK_SHARED_SECRET`: **Required in production** (HMAC verification for inbound SMS + DLR webhooks)

#### Manual Payments (Bangladesh)
- `PAY_BKASH_NUMBER`, `PAY_NAGAD_NUMBER`, `PAY_BANK_INFO`: optional (merchant sees only configured rails)
- `PAY_BKASH_TYPE`, `PAY_NAGAD_TYPE`: optional (e.g., "Send Money", "Payment")
- `PAY_MANUAL_DAILY_CAP`: int 1-50, default 3 (submissions per merchant per 24h)

#### Fraud Network
- `FRAUD_NETWORK_ENABLED`: "0"|"1", default "1" (master kill switch, no redeploy needed)
- `FRAUD_NETWORK_DECAY_DAYS`: int 1-3650, default 180 (signal staleness threshold)
- `FRAUD_NETWORK_WARMING_FLOOR`: int 0-100000, default 50 (network size below which bonuses are halved)

#### Address & Intent Intelligence (RTO Engine v1)
- `ADDRESS_QUALITY_ENABLED`: "0"|"1", default "1" (thana extraction + address quality stamp)
- `INTENT_SCORING_ENABLED`: "0"|"1", default "1" (order intent scoring post-identity resolution)
Both are observation-only, never affect automation/fraud/tracking decisions. Ops kill switches for instant rollback.

#### Shopify OAuth (Platform-Level, One-Time Setup)
- `SHOPIFY_APP_API_KEY`, `SHOPIFY_APP_API_SECRET`: optional
  - Both set → merchants see "One-click connect" pill, enter shop domain, complete OAuth
  - Unset → merchants fall back to custom-app flow (paste API key + secret)
- `PUBLIC_API_URL`: origin for OAuth redirect URI (default "http://localhost:4000"; prod: "https://api.your-domain.com")

#### Twilio (SMS via US Gateway)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`: optional
- `TWILIO_WEBHOOK_BASE_URL`: optional (DLR callback origin)

#### Telemetry (Sentry)
- `SENTRY_DSN`: optional (unset = telemetry is silent, no-op)
- `SENTRY_RELEASE`: optional

#### Frontend (apps/web)
- `NEXT_PUBLIC_API_URL`: default "http://localhost:4000"
- `NEXTAUTH_URL`: default "http://localhost:3001"
- `NEXTAUTH_SECRET`: min 32 chars (NextAuth session encryption)
- `NEXT_PUBLIC_SUPPORT_WHATSAPP`: WhatsApp number with country code (e.g., "8801712345678")
- `NEXT_PUBLIC_SUPPORT_URL`: fallback URL (help desk, Intercom, mailto, etc.)

#### CORS
- `CORS_ORIGIN`: default "http://localhost:3001" (origin Express allows)

### Validation Logic (env.ts)
- `.safeParse(process.env)` on boot; fail with readable issue list if any var violates schema
- Production-only refines:
  - `REDIS_URL` required in production (nil = fail boot)
  - `ADMIN_SECRET` required in production (nil = fail boot)
- Post-load warnings (non-fatal):
  - Production + no `SMS_WEBHOOK_SHARED_SECRET` → "inbound SMS + DLR webhooks will refuse all posts"
  - Production + no manual-payment rails → "BD merchants will only see Stripe"
  - Production + `TRUSTED_PROXIES` unset → "X-Forwarded-For will not be trusted"

---

## 3. Persistence

### MongoDB

**Connection**
- `connectDb()` mounts `mongoose.set("strictQuery", true)` for safety
- In production: `autoIndex=false`, `autoCreate=false` (prevent write locks on hot collections)
- In dev/test: `autoIndex=true` (auto-build on schema change, immediate ready)

**Boot-Time Index Sync**
- Fire-and-forget (non-blocking port bind)
- Syncs: Order, WebhookInbox, Integration, Merchant, ImportJob
- Large-DB index builds happen post-port-bind; Railway healthcheck passes while builds run in background
- Logging: `[boot/syncIndexes] {ModelName} ok in {ms}ms`

**Graceful Disconnect**
- `disconnectDb()` closes the Mongoose connection idempotently
- Called during shutdown sequence (step 3, after queue drain)
- Prevents in-flight queries from being force-closed by `process.exit`

**Legacy Migrations** (Idempotent, Run at Boot)
- `dropLegacyWebhookInboxTtl()`: remove old TTL index on webhookinboxes (permanent idempotency needed webhook rows now)
- `dropLegacyOrderListingIndex()`: drop old (merchantId, createdAt:-1, order.status) index in favor of ESR-compliant (merchantId, order.status, createdAt:-1)

### Redis

**Connection**
- `getRedis()` lazily initializes ioredis client on first call
- `maxRetriesPerRequest: 3`, `lazyConnect: false`
- Error handler logs to stdout

**Validation**
- `assertRedisOrExit()` called at boot:
  - Dev: missing `REDIS_URL` logs warning, continues with degraded caching
  - Prod: missing or unreachable → `process.exit(1)` (hard requirement)
- Startup log: `[redis] ping ok` on success

**Usage**
- BullMQ queue state (jobs, repeatables, workers)
- Rate-limit token buckets (merchant per-second/per-hour caps, webhook per-IP, login/signup)
- Admin step-up tokens (5-min TTL, single-use, permission-scoped)
- Optional cache layer (if enabled in future; caching currently best-effort via @ecom/db models)

---

## 4. Authentication + Session Management

### JWT
- **Secret**: `JWT_SECRET` (min 16 chars)
- **Issued at**: signup, login, password reset
- **Scope**: per-merchant ID + payload (user email, roles)
- **Validation**: tRPC context extractor reads Authorization header, validates signature

### NextAuth (Web)
- **Secret**: `NEXTAUTH_SECRET` (min 32 chars for session encryption)
- **URL**: `NEXTAUTH_URL` (default localhost:3001)
- **Session store**: secured by NEXTAUTH_SECRET

### Merchant Rate-Limit Token Bucket
- Per-merchant token bucket (defined in merchantRateLimit.ts)
- Keyed on merchant ID + endpoint
- Defaults: 1 request/sec per merchant (configurable per route)
- Fallback: Redis absent in dev = unlimited
- Purpose: fair-share quota, prevents single merchant from clogging shared workers

### Admin Step-Up
- **File**: lib/admin-stepup.ts
- **Flow**:
  1. Admin makes sensitive request (payment.approve, fraud.override, merchant.suspend)
  2. Server challenges for step-up confirmation (password re-entry or explicit confirmation)
  3. `issueStepupToken()` mints a 5-minute, single-use, permission-scoped token
  4. Admin's next request includes token in header
  5. `consumeStepupToken()` atomically checks & deletes (can't replay)
- **Storage**: Redis if available (GETDEL = atomic); fallback to in-memory Map with expiry check
- **Token format**: 32-byte base64url random, stored as SHA-256 hash only (never plaintext)
- **Why short TTL + single-use**: leaked token is useless after 5 min or one request; different admin actions can't reuse same token

---

## 5. Observability

### Telemetry (Sentry-Compatible)
**File**: lib/telemetry.ts

- **DSN Parsing**: extracts protocol, public key, host, projectId from SENTRY_DSN
- **Envelope Format**: Sentry's HTTP envelope (not SDK; ~400KB lighter)
- **Fire-and-Forget**: failures in telemetry never break request paths
- **API**: `captureException(err, {tags, user, contexts})`, `captureMessage(msg, extras)`
- **Process Hooks**: `installProcessHooks()` attaches to `unhandledRejection` + `uncaughtException`, tags with source
- **When Disabled**: `SENTRY_DSN` unset = all calls are no-ops (dev/test silent)

### Audit Log
**File**: lib/audit.ts

- **Chain Model**: Every audit row links to the previous via `prevHash` (SHA-256 of prior row's fields)
  - Genesis hash: 64 zeros
  - New writes compute `selfHash` = SHA-256 of (own fields + prevHash)
  - Tamper detection: any in-place edit cascades to all downstream rows' prevHash links

- **Canonicalization**: Keys sorted recursively; Dates → ISO; ObjectIds → hex; stable JSON for hash stability

- **Write Pattern**:
  1. Read chain tail from DB (or use cached in-memory version)
  2. Compute selfHash of new entry
  3. Insert with (prevHash, selfHash)
  4. Cache the new tail in-memory
  - Best-effort: Mongo errors swallowed, log + continue (business action never fails)

- **Verification** (`verifyAuditChain()`):
  - Walk forward in time (at+_id sort)
  - Check every row's prevHash == prior row's selfHash
  - Recompute selfHash and compare
  - First mismatch halts, returns (ok=false, firstBreakAt, firstBreakId)

- **Action Types** (90+ auditable actions):
  - order.* (booked, cancelled, ingested)
  - risk.* (scored, recomputed, alerted)
  - review.* (verified, rejected, no_answer, reopened)
  - subscription.* (checkout_started, recurring_started, synced, payment_recovered, payment_failed, suspended, activated, cancelled, extended, plan_changed)
  - integration.* (connected, disconnected, test, webhook, first_event, webhook_replayed, webhook_dead_lettered, webhook_secret_rotated, shopify_oauth, shopify_webhooks_retried, woo_webhooks_retried, paused, resumed, issues_resolved)
  - automation.* (config_updated, auto_confirm, auto_confirm_and_book, await_confirmation, requires_review, confirmed, rejected, bulk_confirmed, bulk_rejected, sms_confirm, sms_reject, auto_booked, auto_book_failed, auto_expired, confirmation_sms_*, escalated_no_reply, watchdog_exhausted, watchdog_reenqueued, restored, queue_rebuilt, worker_skipped)
  - admin.* (role_granted, role_revoked, scope_granted, scope_revoked, stepup_issued, stepup_consumed, stepup_failed, merchant_suspended, merchant_unsuspended, fraud_override, unauthorized_attempt)
  - payment.* (submitted, reviewed, first_approval, approved, rejected, flagged, checkout_started, checkout_completed, proof_uploaded)
  - auth.* (signup, reset_requested, password_reset, password_changed, email_verified, logout_all)
  - branding.* (updated, reset)
  - tracking.* (identified)
  - alert.* (fired)
  - merchant.* (branding_updated, test_sms_sent)

### Alerts vs Notifications vs Admin-Alerts

**alerts.ts** — Fraud Alert Writer
- `fireFraudAlert(input)` writes two things:
  1. In-app Notification row (inbox for merchant)
  2. Audit log entry (action="risk.alerted")
- Dedupe-keyed by (merchantId, orderId, kind) so rescores don't spawn duplicate notifications
- Optional SMS fan-out: if critical + merchant has phone + fraudConfig.alertOnPendingReview=true, send SMS
- Best-effort: notification/SMS failures swallowed

**notifications.ts** — General Dispatcher
- `dispatchNotification(input)` writes in-app Notification + optional SMS
- Wraps direct Notification.create() calls with optional dedupe (dedupeKey)
- Difference from alerts.ts:
  - Caller is responsible for all dedupe logic (including dedupeKey)
  - No audit entry minted (caller may mint separately)
  - Generic notification kinds (order_confirmed, delivery_update, etc.)
- SMS only on critical severity + first write (inAppCreated=true) to avoid spam

**admin-alerts.ts** — Observability Anomaly
- Background daemon (separate worker, not in this scope)
- Triggers on anomalies (RTO spike, fraud signal spike, Stripe errors)
- Sends email to on-call admin + in-app notification
- Subject: "[CRITICAL] RTO spike" etc.

### Observability / Fraud Network
**File**: lib/observability/fraud-network.ts (referenced, not detailed here)

- Cross-merchant fraud signal sharing (lookup + contribution)
- Enabled by `FRAUD_NETWORK_ENABLED` (0 = instant kill switch, no redeploy)
- Signals expire after `FRAUD_NETWORK_DECAY_DAYS`
- Warming floor: below `FRAUD_NETWORK_WARMING_FLOOR` signals, bonuses halved (early rollout safety)

---

## 6. Crypto + Secrets

**File**: lib/crypto.ts

### Encryption Format
- **Cipher**: AES-256-GCM (authenticated encryption, 256-bit key)
- **IV**: 12-byte random per message (nonce)
- **Auth Tag**: 16-byte GCM tag (proof of authenticity)
- **Plaintext Envelope**: `v1:<b64 iv>:<b64 tag>:<b64 ciphertext>`

### Key Management
- **Source**: `COURIER_ENC_KEY` (base64-encoded, must decode to 32 bytes)
- **Validation at Boot**: env.ts validates presence + base64 + length
  - If invalid, rejects boot
  - No fallback to derived key (risk: leaked ciphertexts become unreadable after key rotation)
- **Lazy Loading**: `getKey()` caches buffer in module scope (`_key`)

### API
- `encryptSecret(plaintext)` → `v1:...` envelope
- `decryptSecret(payload)` → plaintext (throws on format mismatch / auth failure)
- `isEncryptedPayload(value)` → boolean (quick check: v1: prefix + 4 colons)
- `maskSecretPayload(payload)` → "••••{last4}" (UI preview, never decrypts)
- `safeStringEqual(a, b)` → boolean (constant-time comparison for token validation)

### Usage
- Courier API keys / secrets (stored encrypted in Merchant.couriers[].apiKey / apiSecret)
- Decryption happens only when creating adapter (adapterFor in lib/couriers/index.ts)
- Never log plaintext, never store on disk unencrypted

---

## 7. Email + SMS

### Email (Resend)
**File**: lib/email.ts

- **Endpoint**: https://api.resend.com/emails (HTTP POST)
- **Dev Fallback**: no RESEND_API_KEY → logs to stdout instead (keeps signup/reset flows working)
- **Prod Fallback**: no RESEND_API_KEY → `sendEmail()` no-ops with warning, never throws
- **Branding**: templates read from centralized `@ecom/branding`; can override per-call with `branding` param
- **From Address**: `EMAIL_FROM` env takes precedence; else branded sender (e.g., "Cordon <hello@cordon.io>")
- **Web URL Builder**: `webUrl(path)` resolves from PUBLIC_WEB_URL (or NEXTAUTH_URL fallback)
- **Templates**:
  - `buildVerifyEmail()`: signup email verification
  - `buildPasswordResetEmail()`: password-reset link + IP note
  - `buildTrialEndingEmail()`: X-day warning before trial expiry
  - `buildPaymentApprovedEmail()`: subscription activated
  - `buildPaymentFailedEmail()`: payment declined, grace period warning
  - `buildSubscriptionSuspendedEmail()`: account suspended (grace expired)
  - `buildAdminAlertEmail()`: [CRITICAL]/[WARNING]/[INFO] anomaly notification (severity, kind, message, metric details)
- **HTML Rendering**: inline-styled, works in Gmail/Outlook without CSS resets
- **Result**: `{ok, id?, error?, skipped?}` (ok=true + skipped=true for dev mode)

### SMS (Bangladesh — SSL Wireless)
**File**: lib/sms/index.ts

- **Provider**: SSL Wireless (https://smsplus.sslwireless.com)
- **Dev Fallback**: no SSL Wireless keys → logs to stdout
- **Prod Fallback**: no keys → no-ops with warning, never throws
- **Segment Cap**: max 160 chars (GSM-7/Unicode), warns if truncating
- **Templates** (purpose-built helpers):
  - `sendOtpSms(phone, code)`: 6-digit OTP, 5-min TTL hint
  - `sendPasswordResetAlertSms(phone)`: alert that a reset link was sent (separate channel, panic button)
  - `sendOrderConfirmationSms(phone, {orderNumber, codAmount, confirmationCode})`: bilingual EN+Bangla "Reply YES/NO with code"
  - `sendOrderExpiredSms(phone)`: order confirmation timed out
  - `sendDeliveryUpdateSms(phone)`: status change ("order is now in_transit")
  - `sendCriticalAlertSms(phone, body)`: merchant-facing RTO/fraud/payment alert
- **CSMS ID**: request-level correlation ID for DLR (Delivery Receipt) cross-reference
- **Webhook Verification**: inbound SMS + DLR webhooks signed with `SMS_WEBHOOK_SHARED_SECRET` (HMAC)
- **Result**: `{ok, providerMessageId?, providerStatus?, error?}`

---

## 8. Stripe + Billing

### Files
- `lib/plans.ts` — plan definitions (starter, growth, scale, enterprise)
- `lib/billing.ts` — trial date math (daysLeftUntil, hasElapsed, computeTrialState)
- `lib/entitlements.ts` — plan feature gates (API limits, webhook count, etc.)
- `lib/usage.ts` — per-merchant usage tracking (orders this month, etc.)

### Stripe Configuration
- **Keys**: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
- **Currency**: STRIPE_USE_USD ("1" = USD, "0" = BDT via international acquirer)
- **Period**: STRIPE_PERIOD_DAYS (default 30 days per subscription)
- **Grace**: STRIPE_GRACE_DAYS (default 7 days after invoice.payment_failed before suspension)
- **Price IDs**: STRIPE_PRICE_STARTER, STRIPE_PRICE_GROWTH, STRIPE_PRICE_SCALE, STRIPE_PRICE_ENTERPRISE (optional in dev; required for checkout)

### Webhook Flow
- Stripe sends signed POST to /api/webhooks/stripe
- Router verifies signature over raw bytes (express.raw middleware inside router, before JSON parser)
- Event types handled:
  - `invoice.payment_succeeded` → activate subscription
  - `invoice.payment_failed` → start grace-period countdown
  - `charge.refunded` → mark refund in audit log

### Plan Entitlements
- Starter, Growth, Scale, Enterprise tiers
- Feature gates: API request rate, webhook delivery count, merchant team seats, etc.
- Checked at runtime: `getEntitlements(planTier)` returns capabilities object

### Trial + Renewal
- All new merchants start with TRIAL_DAYS (default 14)
- Trial status: `subscription.status === "trial"`
- Trial-ending reminder: sent TRIAL_WARNING_DAYS before expiry (default 3 days)
- Post-trial: must choose plan to keep service active
- Manual-payment rails: bKash, Nagad, bank transfer (if configured)

---

## 9. Couriers

**File**: lib/couriers/index.ts

### Registry Pattern
- `registry: Map<CourierName, AdapterFactory>`
- `registerCourierAdapter(name, factory)` — register or override (Day 4+ onboarding, tests)
- `hasCourierAdapter(name)` — check availability
- `adapterFor(config)` — resolve stored config → usable adapter (decrypts secrets on the way)

### Adapter List (Currently Supported)
1. **pathao** → PathaoAdapter
2. **steadfast** → SteadfastAdapter
3. **redx** → RedxAdapter

Additional adapter stubs planned: ecourier, paperfly, other

### Merchant Config Storage
- Per merchant: `couriers: [{name, accountId, apiKey, apiSecret?, baseUrl?, enabled?}]`
- apiKey / apiSecret: stored encrypted (v1:... envelope)
- baseUrl: per-merchant override for provider's API root
- enabled: soft delete (merchant can disable without losing credentials)

### Circuit Breaker
**File**: lib/couriers/circuit-breaker.ts

**Problem**: 15s fetch timeout × 3 retries × 3-courier auto-book chain = 135s blocking order flow during partial outage

**Solution**: Per-key circuit breaker with three states:

- **Closed** (normal): failures counted; after failureThreshold (default 5) consecutive failures → Open
- **Open** (circuit tripped): every call fast-fails with `circuit_open` error for openDurationMs (default 30s). No upstream traffic, no waiting.
- **Half-Open** (probing): after cooldown elapses, next call is a probe. If it succeeds → Closed + reset counters; if fails → Open + fresh cooldown. Concurrent calls during probe fast-fail (no stampede).

**Wall-Time Guarantee**: Every `fn()` call runs under AbortSignal with totalBudgetMs deadline (default 5s). When deadline fires:
- fn() loses race to synthetic timeout
- AbortSignal fires (downstream fetch/retry can react)
- failure counter increments
- Call returns error, upstream never blocks beyond 5s

**Keying**: callers pass `pathao:account-123` (provider + accountId). One merchant's bad credentials don't trip breaker for everyone.

**Observability**: `snapshotBreakers()` returns state for all keys; `breakerStateOf(key)` for one; `forceBreakerState(key, state)` for ops manual recovery.

---

## 10. Graceful Shutdown

**File**: apps/api/src/index.ts, lines 303–370 (comment: "Graceful shutdown sequence. Order matters:")

### Shutdown Sequence
1. **Stop accepting new connections** (server.close(cb))
   - In-flight requests finish
   - Await callback (all live sockets must close)
   - This prevents new requests landing during queue drain

2. **Drain BullMQ workers** (shutdownQueues())
   - `worker.close()` on each registered worker
   - Current job finishes before disposal
   - Webhook mid-process is not torn
   - Shared Redis connection `quit()`'d

3. **Close Mongo connection** (disconnectDb())
   - Closes mongoose connection idempotently
   - Out-of-band scripts already do this; API server previously skipped it
   - Prevents force-close of in-flight queries by process.exit

4. **Exit with status 0** (process.exit(0))
   - Only after 1–3 have resolved

### Watchdog Timer (25s)
- If any step deadlocks (stuck Mongo socket, runaway worker job that never yields), force-exit before platform SIGKILLs us
- `unref()` so timer never alone keeps process alive after clean shutdown
- Sits comfortably inside Railway's default 30s drain window

### Idempotency
- A second SIGTERM during shutdown is ignored ("shutdown already in progress")
- Prevents accidentally restarting the shutdown chain

### Signal Handlers
- `SIGINT` (Ctrl-C in local dev)
- `SIGTERM` (platform graceful shutdown, Kubernetes eviction, etc.)
- Both trigger the same async `shutdown(signal)` function

### Result
- Clean, ordered teardown with hard timeout fallback
- No orphaned jobs, no torn requests, no leaked resources

---

## 11. Scripts

### backup-mongo.sh
**Purpose**: Production MongoDB backup with S3 upload + local retention

**Usage**: Cron entry like:
```bash
15 3 * * * /opt/ecom/scripts/backup-mongo.sh >> /var/log/ecom-backup.log 2>&1
```

**Steps**:
1. `mongodump --uri="$MONGODB_URI" --archive="$ARCHIVE" --gzip --quiet`
   - Single binary stream (portable, restores with `mongorestore --archive=...`)
   - Compresses inline (~80% smaller)
2. Report size: `[backup] dump complete (500MB)`
3. If `BACKUP_S3_URI` set: `aws s3 cp "$ARCHIVE" "$TARGET" --no-progress`
4. Local retention: `find ... -mtime "+$RETENTION_DAYS" -delete` (default 14 days)

**Required Env**:
- `MONGODB_URI`: Standard connection (read-only credentials recommended)
- `BACKUP_DIR`: Directory to write archives

**Optional Env**:
- `BACKUP_RETENTION_DAYS`: Local keep (default 14)
- `BACKUP_S3_URI`: e.g., s3://my-bucket/ecom/
- `AWS_PROFILE`, `AWS_REGION`: AWS CLI pass-through

**Exit**: non-zero on any failure (cron MAILTO catches it)

### e2e-stack.mjs
**Purpose**: All-in-one e2e bootstrap for Playwright tests

**Services Spun Up**:
1. MongoDB Memory Server (ephemeral, in-process)
2. apps/api in dev mode (npm run dev)
3. apps/web in dev mode (npm run dev)

**Lifecycle**:
- Parent process owns child lifecycle
- Child processes inherit minted env (consistent JWT/admin/encryption keys across stack)
- On parent SIGTERM/SIGINT:
  1. `child.kill("SIGTERM")` to all children
  2. 5s grace period
  3. `child.kill("SIGKILL")` if still alive
  4. `mongod.stop()`
  5. `process.exit(0)`

**Env Minting** (hardcoded for test stability):
- `E2E_ENV`: NODE_ENV=test, JWT_SECRET, COURIER_ENC_KEY (stable base64), ADMIN_SECRET, COURIER_MOCK=1 (offline), STRIPE_USE_USD=1
- `WEB_ENV`: NEXT_PUBLIC_API_URL, NEXTAUTH_URL, NEXTAUTH_SECRET, NEXT_TELEMETRY_DISABLED=1

**Readiness**:
- API: waits for `[api] listening` in stdout
- Web: waits for `Ready` OR `started server` OR `Local:` in stdout (Next.js version variance)
- Parent logs "stack up — api+web ready, awaiting test driver"

**Usage**: Playwright spawns directly via webServer.command in config

---

## 12. GitHub Actions Workflows

### .github/workflows/e2e.yml

**Trigger**: On pull_request to main, push to main

**Concurrency**: Cancel previous runs of same PR on new commit

**Job**: golden-path (ubuntu-22.04, 25-min timeout)

**Steps**:
1. Checkout code
2. Setup Node.js 20, npm cache
3. `npm ci` (install deps)
4. Cache Playwright browsers (~150 MB, keyed on @playwright/test version)
   - On cache miss: `npm run test:e2e:install`
5. Cache mongodb-memory-server binary (~500 MB)
6. `npm run build` (all workspaces)
7. `npm run typecheck` (TypeScript check)
8. `npm --workspace @ecom/api test` (unit tests)
9. `npm run test:e2e` (Playwright e2e suite)
   - Sets CI=true env
   - Runs e2e-stack.mjs under the hood (via Playwright config)
10. Upload Playwright report artifact (14-day retention)
11. Upload Playwright traces on failure (14-day retention)

**Outcome**: Full regression + e2e coverage before merge to main

---

## 13. Deployment Checklist

### Pre-Deployment
1. Verify all environment variables are set and valid
2. Confirm Redis + MongoDB are healthy and accessible
3. Run `npm run build` locally to catch build errors
4. Run `npm run typecheck` for TypeScript errors
5. Run full test suite (`npm test`) + e2e tests
6. Check audit log chain with `verifyAuditChain()` if Mongo is live

### At Deploy Time
1. Set all required env vars (API_PORT, MONGODB_URI, REDIS_URL, JWT_SECRET, COURIER_ENC_KEY, ADMIN_SECRET, TRUSTED_PROXIES, etc.)
2. Confirm TRUSTED_PROXIES matches your edge proxy setup (prevent IP spoofing)
3. Spin up MongoDB + Redis services (or use managed services)
4. Deploy API service first (healthcheck on `/health`)
5. Deploy web service (depends on API being reachable at NEXT_PUBLIC_API_URL)
6. Warm up BullMQ queue state by allowing API to boot fully
7. Monitor logs for boot errors, queue registration, index sync completion
8. Smoke test: sign up, create an order, verify webhook ingestion

### Post-Deployment
1. Check logs for "[api] listening", "[redis] ping ok", "[shutdown] complete" if previously running
2. Test critical paths:
   - Merchant signup → trial activation
   - Order ingestion → webhook callback
   - Fraud scoring → alert notification
   - Payment flow → Stripe checkout
   - Courier booking → tracking sync
3. Monitor Sentry (if enabled) for unhandled errors
4. Check database indexes built: `[boot/syncIndexes] {Model} ok in {ms}ms`
5. Verify audit log integrity: `verifyAuditChain()` succeeds

### Emergency Rollback
1. Kill the new deployment gracefully (SIGTERM)
2. Rollback env vars to previous version
3. Redeploy old code
4. Verify `/health` returns 200 + services operational

---

## 14. Operational Hazards + Mitigations

### Courier Circuit Breaker Trips (Pathao/RedX/Steadfast Outage)
- **Symptom**: Orders stuck in pending_book state, autobook times out quickly
- **Fix**: Circuit breaker auto-recovers after 30s (half-open probe); if upstream still down, auto-retries every 30s
- **Manual Override** (ops emergency): `forceBreakerState(key, "closed")` in admin console to force retry immediately

### Redis Unavailable
- **Dev**: Logs warning, continues (rate limiting + caching disabled)
- **Prod**: Boot fails (`process.exit(1)`) — hard requirement to prevent cache incoherence
- **Recovery**: Restore Redis, redeploy API

### Mongo Write Lock (Index Builds on Live Collection)
- **Mitigation**: Production sets autoIndex=false; index sync runs post-port-bind
- **If Stuck**: New deployments can bind + serve while index builds in background (Railway healthcheck passes)
- **Large DB**: Index builds can take minutes; API still operational

### Telegram Flood (SMS Spam)
- **Dev**: logs to stdout, never sends (safe)
- **Prod**: SSL Wireless keys unset → warnings logged, no-ops (never crashes request path)
- **if Compromised**: Rotate SSL_WIRELESS_API_KEY (no redeploy needed; cached transport reloads on next request)

### Audit Log Tamper Attempt
- **Detection**: `verifyAuditChain()` recomputes selfHash and prevHash links
- **Fix**: Admin runs chain verification, surfaces firstBreakAt + firstBreakId for investigation
- **Recovery**: Restore MongoDB backup from known-good point

### Payment Gateway Credential Leak
- **Courier Keys**: Encrypted at rest with AES-256-GCM (COURIER_ENC_KEY)
- **Stripe Secret**: Never stored on disk, injected via env (Railway secrets)
- **Response**: Rotate credentials in provider portal, redeploy with new env

### Admin Step-Up Token Leak
- **Surface**: Minted as plaintext in response; consumed is one-use
- **Mitigation**: 5-minute TTL + single-use + permission-scoped (leaked token can't be replayed for different action)
- **If Concerned**: Issue new token, ask admin to use that instead

### Rate Limiter Bypass (Spoofed X-Forwarded-For)
- **Root Cause**: TRUSTED_PROXIES unset or misconfigured
- **Fix**: Set TRUSTED_PROXIES to match your edge proxy (IP, CIDR, hop count)
- **Check**: Verify logs that rate-limit keying uses correct IP source

### Graceful Shutdown Hangs Beyond 25s
- **Watchdog**: Fires at 25s, force-exits (satisfies Railway's 30s drain window)
- **Typical Cause**: Mongo socket stuck, runaway worker job never yields
- **Debug**: Check logs for last log line before watchdog ("mongo disconnected" = hung there)
- **Recovery**: Increase watchdog timeout if legitimate jobs take >25s (rare); usually indicates deadlock

---

## 15. Performance Considerations

### BullMQ Concurrency Defaults
- Most workers: concurrency=N (auto per CPU)
- Pending job replay: concurrency=1 (conservative, don't spam on recovery)
- Order sync polling: concurrency=1 (safe fallback when webhooks break)

### Repeatable Job Scheduling
- Tracked-sync: every 60 min (configurable TRACKING_SYNC_INTERVAL_MIN)
- Trial reminder: daily
- Subscription grace: daily
- Automation stale sweep: every 5 min
- Automation watchdog: every 5 min (detects stuck orders)
- AWB reconcile: daily
- Fraud weight tuning: weekly
- Cart recovery: daily
- Pending job replay: every 30 s (dead-letter catch-all)
- Order sync polling: every 5 min (fallback when webhooks silent)
- Repeatable sweep: every startup (idempotent, no duplicates)

### Index Strategy (MongoDB)
- ESR order: (Equality, Sort, Range) — used by order listing dashboard
- Partial indexes: (merchantId, externalId) for de-duping ingestion race
- TTL indexes: removed (legacy cleanup, webhook idempotency is permanent)

### Rate Limiting Tiers
- Merchant per-endpoint: 1 req/sec (token bucket, Redis-backed)
- Webhook per-IP: global limiter (prevents replay/spam)
- Login/signup/passwordReset: per-IP + per-email
- Public tracking: wide-open (storefronts on any origin)
- tRPC data plane: no global cap (per-merchant + auth-gated procedures discriminate)

---

## Summary

This deployment architecture balances operational simplicity (stateless API, external Mongo + Redis), safety (audit chain, encryption, step-up confirmation), and resilience (graceful shutdown with watchdog, circuit breaker, rate limiting). Key production requirements:
- REDIS_URL (hard requirement)
- ADMIN_SECRET (hard requirement)
- TRUSTED_PROXIES (strongly recommended, prevents IP spoofing)
- SMS_WEBHOOK_SHARED_SECRET (hard requirement for SMS webhook safety)
- Courier, Stripe, Resend credentials (optional, graceful fallback if absent)

The system is designed to self-heal on boot (index sync, repeatable job registration, branding seeding) and to shut down cleanly under SIGTERM with a 25s watchdog failsafe.
