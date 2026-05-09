# Production cutover runbook — ConfirmX

**Authored:** 2026-05-09
**Branch at authorship:** `claude/staging-deploy` (3 commits ahead
of `origin/claude/staging-deploy`)
**Companion docs:** `shopify-go-live-checklist.md` (env vars + flip
sequence), `shopify-reviewer-test-flow.md` (reviewer happy-path),
`audits/shopify-production-gap-matrix.md` (residual blockers).

This runbook is **executable**. Each step is a copy-paste command,
an expected output, and a capture field. Ops runs it top-to-bottom
and either fills the capture field or stops at the first failure.

The runbook **assumes the brand/ops closeout items in
`shopify-production-gap-matrix.md §9` are done** (legalName, mailbox
provisioning, brand assets, DNS). It does NOT cover those.

---

## How to use this runbook

1. **Save your terminal session.** Copy outputs into the capture
   fields verbatim — a copy with the timestamps + values is the
   submission evidence.
2. **Stop on the first failure.** Each step has explicit go/no-go
   criteria. Do NOT skip ahead.
3. **One operator at a time.** Don't parallelise the deploy across
   two people on the same Railway project.

---

## Step 0 — Pre-deploy verification (already executed by engineering)

Captured in `audits/shopify-final-production-report.md §2` and
re-validated locally on 2026-05-09:

| Check | Result |
|---|---|
| `apps/api` production-source typecheck (`tsc -p tsconfig.build.json --noEmit`) | ✅ clean |
| `apps/web` typecheck (`tsc --noEmit`) | ✅ clean |
| `apps/api` build | ✅ clean |
| `apps/web` Next.js build (45 routes; SSG + dynamic; middleware 47.7 kB) | ✅ clean |
| `.env` is gitignored, not tracked | ✅ |
| `.env.example` has 63 documented env vars | ✅ |
| No production env vars commented out (only doc-template lines) | ✅ |
| All `localhost` references are correctly-guarded `?? "http://localhost:..."` fallbacks (production env-validator REQUIRES `PUBLIC_API_URL`/`PUBLIC_WEB_URL` so fallbacks never fire) | ✅ |

---

## Step 1 — Push the branch and merge to main

```sh
# from the local working tree, branch claude/staging-deploy
git push origin claude/staging-deploy
```

Then either fast-forward main if the team is OK with it, or open a
PR per the team's policy:

```sh
git checkout main
git pull origin main
git merge --ff-only claude/staging-deploy
git push origin main
```

**Capture:**

- [ ] Branch pushed (commit hash on origin/main): `____________`
- [ ] Last 3 commits visible on `origin/main`:
  - [ ] `8c58110` docs(shopify): pre-submission audits + soften …
  - [ ] `5b3e815` docs(shopify): brand + reviewer + cutover …
  - [ ] `d09b7a4` feat(prod-readiness): /ready endpoint …

**Stop if:** any of the three commits is missing from main, OR the
push is rejected.

---

## Step 2 — Configure Railway env vars

### apps/api service

Per `shopify-go-live-checklist.md §1`. Set **all** of these in the
api service's Railway environment:

```sh
NODE_ENV=production

# Public origins (production-required by env.ts)
PUBLIC_API_URL=https://api.confirmx.ai
PUBLIC_WEB_URL=https://app.confirmx.ai
CORS_ORIGIN=https://app.confirmx.ai

# Connectivity
MONGODB_URI=<Atlas connection string>
REDIS_URL=<Railway-managed Redis URL>

# Authentication / encryption
JWT_SECRET=<random ≥16 chars; same value across api instances>
ADMIN_SECRET=<random ≥24 chars; rotated quarterly>
COURIER_ENC_KEY=<openssl rand -base64 32 — 32-byte key, base64-encoded>

# Trust proxy (Railway proxies)
TRUSTED_PROXIES=uniquelocal,linklocal

# Shopify Partner app
SHOPIFY_APP_API_KEY=<Partner Dashboard → Configuration → Client ID>
SHOPIFY_APP_API_SECRET=<Partner Dashboard → Configuration → Client secret>

# Telemetry (recommended, optional)
SENTRY_DSN=<from Sentry project>
SENTRY_RELEASE=<deploy commit SHA>

# SMS (BD)
SSL_WIRELESS_API_KEY=<from SMS Plus>
SSL_WIRELESS_USER=<from SMS Plus>
SSL_WIRELESS_SID=<approved alpha sender, ≤11 chars>
SMS_WEBHOOK_SHARED_SECRET=<your inbound-SMS HMAC secret>

# Manual payment rails (BD)
PAY_BKASH_NUMBER=<...>
PAY_NAGAD_NUMBER=<...>
PAY_BANK_INFO=<...>

# Stripe (USD card payments)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_GROWTH=price_...
STRIPE_PRICE_SCALE=price_...
STRIPE_PRICE_ENTERPRISE=price_...

# (BDCourier / external-delivery flags default OFF — leave unset until calibrated)
```

### apps/web service

Per `shopify-go-live-checklist.md §2`:

```sh
NODE_ENV=production
NEXT_PUBLIC_API_URL=https://api.confirmx.ai
NEXTAUTH_URL=https://app.confirmx.ai
NEXTAUTH_SECRET=<random ≥32 chars; same value across web instances>
```

**Capture:**

- [ ] api service has all required vars set (count = at minimum 16; SMS / payment / Stripe optional but recommended)
- [ ] web service has all 4 required vars set
- [ ] `PUBLIC_API_URL` and `NEXT_PUBLIC_API_URL` agree exactly: `____________`
- [ ] `PUBLIC_WEB_URL`, `NEXTAUTH_URL`, `CORS_ORIGIN` agree exactly: `____________`

**Stop if:** any required var is unset OR the host triple disagrees.

---

## Step 3 — Deploy

```sh
# Railway will auto-deploy on the next push to main if the project
# is wired to the GitHub repo. Otherwise trigger manually:
railway up --service api
railway up --service web
```

Watch the deploy logs in Railway dashboard.

**Expected api boot log (in order):**
```
[boot] env=production port=4000 telemetry=on
[db] connected to MongoDB (autoIndex=false)
[redis] ping ok
[boot] branding singleton seeded         (only on fresh DB)
[boot] gazetteer primed size=N version=...
[boot/syncIndexes] Order ok in <Nms>
[boot/syncIndexes] WebhookInbox ok in <Nms>
[boot/syncIndexes] Integration ok in <Nms>
[boot/syncIndexes] Merchant ok in <Nms>
[boot/syncIndexes] ImportJob ok in <Nms>
[boot/syncIndexes] CustomerReliability ok in <Nms>
[boot/syncIndexes] AddressReliability ok in <Nms>
[boot] pending-job-replay armed (worker concurrency=1, sweep every 30s)
[boot] order-sync polling fallback armed (worker concurrency=1, sweep every 5m)
[api] listening on http://localhost:4000
```

**Expected web boot log:**
```
   ▲ Next.js 14.x.x
   - Local:        http://localhost:3001
   - Network:      ...
 ✓ Ready
```

**Capture:**

- [ ] api deploy succeeded; no `[boot]` errors before `[api] listening`
- [ ] web deploy succeeded
- [ ] All 7 `[boot/syncIndexes]` lines present (Order, WebhookInbox, Integration, Merchant, ImportJob, CustomerReliability, AddressReliability)
- [ ] `[boot] pending-job-replay armed` and `[boot] order-sync polling fallback armed` both present

**Stop if:** any `[boot]` or `[boot/syncIndexes]` reports `failed`.
The `CustomerReliability` and `AddressReliability` index syncs are
hard prerequisites for `DELIVERY_RELIABILITY_WRITE_ENABLED=1` (see
`final-production-readiness-report.md §3.2`).

---

## Step 4 — Health + readiness probe verification

Run these from your laptop (not from inside the Railway pod):

```sh
# Liveness — should always return 200
curl -sS https://api.confirmx.ai/health
# Expected: {"ok":true}

# Readiness — checks Mongo + Redis
curl -sS https://api.confirmx.ai/ready
# Expected: {"ok":true,"checks":{"mongo":{"ok":true},"redis":{"ok":true}}}

# Readiness with HTTP code
curl -sS -o /dev/null -w "%{http_code}\n" https://api.confirmx.ai/ready
# Expected: 200
```

Configure Railway's health-check probe to point at `/ready` (not
`/health`). `/health` stays as the liveness probe — a transient
Redis blip must NOT restart the pod, only remove it from rotation.

**Capture:**

- [ ] `/health` → `{"ok":true}` and HTTP 200: `____________`
- [ ] `/ready` → `{"ok":true,...}` and HTTP 200: `____________`
- [ ] `/ready` mongo check: `____________`
- [ ] `/ready` redis check: `____________`
- [ ] Railway readiness probe path = `/ready`
- [ ] Railway liveness probe path = `/health`

**Stop if:** `/ready` returns 503 OR either dependency reports
unhealthy. Check Mongo Atlas firewall and Redis URL.

---

## Step 5 — Worker verification

Workers register at boot under `if (env.REDIS_URL)`. Verify they're
all live:

```sh
# From Railway: tail the api logs for ~60s during a normal load.
# You should see periodic structured-log lines from the workers.
# Quiet workers (consumer-only, no schedule) won't log unless
# they receive a job — that's normal.
```

The 16 workers per `apps/api/CLAUDE.md`:

1. trackingSync (scheduled)
2. riskRecompute (consumer)
3. webhookRetry (scheduled)
4. webhookProcess (consumer)
5. fraudWeightTuning (scheduled)
6. commerceImport (consumer)
7. automationBook (consumer)
8. automationSms (consumer)
9. automationStale (scheduled)
10. automationWatchdog (scheduled)
11. cartRecovery (scheduled)
12. trialReminder (scheduled)
13. subscriptionGrace (scheduled)
14. awbReconcile (scheduled)
15. orderSync (scheduled)
16. pendingJobReplay (scheduled)

Hit the admin observability surface to confirm queue health (use
the `ADMIN_SECRET` you set in Step 2):

```sh
curl -sS https://api.confirmx.ai/admin/sync-indexes \
  -X POST \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json"
# Expected: 200 with per-model index-sync results
```

**Capture:**

- [ ] No worker errors in api logs in the first 60s post-boot
- [ ] No `BullMQ` reconnect loops in api logs
- [ ] `POST /admin/sync-indexes` returns 200: `____________`
- [ ] No `safeEnqueue` `dead_lettered` events in the first hour (check `PendingJob` collection)
- [ ] Repeatable jobs visible in BullMQ — recommended sanity check via Railway's Redis CLI:
  ```sh
  redis-cli ZRANGEBYSCORE bull:tracking-sync:repeat 0 +inf | wc -l
  # Expected: 1 (one repeatable entry per scheduled queue)
  ```

**Stop if:** any worker logs a fatal error OR pendingJob accumulates
(>10 in the first hour suggests Redis connectivity issue).

---

## Step 6 — Shopify OAuth flow verification

This is the reviewer happy-path. Run it on a **fresh dev store**
(not a previously-used one — uninstall + 48h GDPR retention may
collide).

### 6a. Install via direct link

In a fresh browser session (no logged-in ConfirmX account, no
cached cookies):

1. Visit the Partner Dashboard install URL.
2. Approve the scope request: `read_orders`, `write_orders`,
   `read_customers`.
3. Land on `https://app.confirmx.ai/dashboard/settings/integrations`.

Watch api logs for the `[shopify-oauth]` block. Expected:
```
[shopify-oauth] start install { shop: '...', appKeyPrefix: '...', redirectUri: 'https://api.confirmx.ai/api/integrations/oauth/shopify/callback', scopes: ['read_orders','write_orders','read_customers'], statePrefix: '...', installStartedAt: '...' }
[shopify-oauth] callback received { shop: '...', elapsedMs: <under 15000>, slow: false }
```

**Capture:**

- [ ] Install URL launched correctly (Shopify approval screen rendered): YES / NO
- [ ] Approval succeeded (redirect to `/dashboard/settings/integrations?connected=shopify&shop=...`): YES / NO
- [ ] No `?error=` in the redirect URL: YES / NO
- [ ] If `?warning=`, which: `____________` (see `apps/web/src/components/integrations/...` for handling)
- [ ] api log shows `[shopify-oauth] callback received` with elapsedMs: `____________`
- [ ] api log shows `slow: false` (callback under 15s)
- [ ] Integration row in DB: `db.integrations.findOne({ provider: "shopify", "credentials.installNonce": null }, { status: 1, accountKey: 1, "webhookStatus.registered": 1, "health.ok": 1 })`
  - status=`connected`: YES / NO
  - webhookStatus.registered=true: YES / NO
  - health.ok=true: YES / NO

### 6b. Place a test order

In the dev store, place a test COD order. Within ~30 seconds:

```sh
# api log should emit the webhook ACK:
# {"evt":"webhook.acked","outcome":"queued","provider":"shopify","integrationId":"...","merchantId":"...","payloadBytes":...,"ackMs":<low>}
```

Visit `https://app.confirmx.ai/dashboard/orders` — the order should
appear with risk score, fraud signals, and operational
recommendation.

**Capture:**

- [ ] `webhook.acked` log line within 30s of order placement: YES / NO
- [ ] `ackMs` value (target <50): `____________`
- [ ] Order visible in `/dashboard/orders`: YES / NO
- [ ] Order detail drawer shows tracking timeline + intent panel + address quality: YES / NO

### 6c. Test uninstall

Uninstall the app from the Shopify dev-store admin.

**Expected:**
- api log emits `[shopify-webhook] app/uninstalled { ... flipped: true }`
- `/dashboard/settings/integrations` integration card flips to `Disconnected` within ~5s.
- Integration row in DB: `status=disconnected`, `health.lastError="Merchant uninstalled the app from Shopify."`

**Capture:**

- [ ] `app/uninstalled` log line: YES / NO
- [ ] Integration card flipped within 5s: YES / NO
- [ ] DB row updated: YES / NO

**Stop if:** any of 6a/6b/6c fails. The OAuth path is review-
critical; a failure here halts the cutover.

---

## Step 7 — Webhook HMAC verification

### 7a. Bad-HMAC probes (security)

Each of these MUST return 401:

```sh
# Order webhook with bogus integration id + body
curl -sS -X POST \
  https://api.confirmx.ai/api/integrations/webhook/shopify/000000000000000000000000 \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Hmac-SHA256: this-is-not-valid" \
  -H "X-Shopify-Topic: orders/create" \
  -H "X-Shopify-Webhook-Id: probe-1" \
  -d '{"id":12345}' \
  -o /dev/null -w "%{http_code}\n"
# Expected: 404 (integration not found) — bypass the HMAC check;
# 401 if you use a valid integrationId

# GDPR webhook unsigned
curl -sS -X POST \
  https://api.confirmx.ai/api/webhooks/shopify/gdpr/customers/redact \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Topic: customers/redact" \
  -d '{}' \
  -o /dev/null -w "%{http_code}\n"
# Expected: 401
```

Each 401 should also emit a structured `webhook.signature_invalid`
or `[shopify-gdpr] hmac_mismatch` log line for the security feed.

**Capture:**

- [ ] Bogus order-webhook HMAC: HTTP `____` (expected 401 or 404)
- [ ] Unsigned GDPR webhook: HTTP `____` (expected 401)
- [ ] api log shows the security log line for each: YES / NO

### 7b. Valid GDPR webhooks via Partner Dashboard

In Partner Dashboard, use "Test webhook" for each of:
- `customers/data_request`
- `customers/redact`
- `shop/redact`

Each should return 200 and produce TWO audit rows:
- `action: shopify.gdpr_webhook` (receipt)
- `action: shopify.gdpr_dispatch` (outcome)

**Capture:**

- [ ] `customers/data_request`: HTTP 200, 2 audit rows: YES / NO
- [ ] `customers/redact`: HTTP 200, 2 audit rows: YES / NO
- [ ] `shop/redact`: HTTP 200, 2 audit rows: YES / NO

### 7c. Idempotency probe (optional but recommended)

Re-send the same `webhook.acked` order webhook (with valid HMAC,
correct integrationId, same `X-Shopify-Webhook-Id`). The second
delivery should return 202 with `duplicate: true`.

**Capture:**

- [ ] Duplicate delivery: HTTP 202 with `duplicate: true`: YES / NO

**Stop if:** any HMAC check passes when it shouldn't, or any
legitimate webhook fails.

---

## Step 8 — Observability verification

### 8a. Sentry

Trigger a non-fatal capture intentionally:

```sh
# A bad admin endpoint POST that surfaces an error in the catch-all
curl -sS -X POST https://api.confirmx.ai/admin/sync-indexes \
  -H "X-Admin-Secret: WRONG_SECRET" \
  -H "Content-Type: application/json"
# Expected: 401 (no Sentry capture for auth failures)

# A bad path that hits the express error handler
curl -sS -X POST https://api.confirmx.ai/admin/nonexistent \
  -H "X-Admin-Secret: $ADMIN_SECRET"
# Expected: 404 (no Sentry capture for 404s, that's by design)
```

Better test: visit a deliberately-broken web route to fire the web
error boundary:

```
https://app.confirmx.ai/dashboard/some-bogus-path-that-does-not-exist
```

The web `not-found.tsx` should render. To test the runtime error
boundary, you'd need to trigger an actual exception — easier to
verify Sentry's `[boot] telemetry=on` log line was present in
Step 3 and trust the boundaries until a real error happens.

**Capture:**

- [ ] api boot log shows `[boot] env=production ... telemetry=on`: YES / NO
- [ ] Sentry project shows the api `release: <SENTRY_RELEASE>` for
      the deploy: YES / NO

### 8b. Structured logs

The webhook ack-latency observability target is sub-50ms. Sample
the first 100 `webhook.acked` log lines and confirm p95 < 50ms:

```sh
# In Railway log search:
#   evt:"webhook.acked"
# Eyeball or pipe through `jq` to compute p95 of the ackMs field
```

**Capture:**

- [ ] Sample of `webhook.acked` ackMs values (first 10 in production traffic): `____________`
- [ ] p95 of the first 100 deliveries: `____________ ms`

### 8c. Worker diagnostics

```sh
curl -sS https://api.confirmx.ai/admin/queue-stats \
  -H "X-Admin-Secret: $ADMIN_SECRET" | jq
# Expected: per-queue active/waiting/completed/failed counts
```

(If `/admin/queue-stats` doesn't exist, use the BullMQ Redis
inspection: `redis-cli KEYS bull:*` to confirm queues are
populated.)

**Capture:**

- [ ] Queue stats accessible: YES / NO
- [ ] No queue showing `failed > 0` in steady state: YES / NO

**Stop if:** Sentry isn't receiving events OR ackMs p95 > 100ms
sustained.

---

## Step 9 — Final pre-flip Cordon-residue + claim sweep

```sh
# In an authenticated browser session at https://app.confirmx.ai/dashboard,
# DevTools → Find in page (Cmd-F / Ctrl-F):
#   - "Cordon" / "cordon"  (rendered text only — class names OK)
#   - "AI fraud"
#   - "autonomous"
#   - "200+" (verify the trust-band softening landed)
#   - "৳45 Cr"
```

The `apps/web/public/` asset check:

```sh
curl -sSI https://app.confirmx.ai/brand/logo.svg | head -1
# Expected: HTTP/2 200 (post asset-drop) — broken-image during pre-asset window

curl -sSI https://app.confirmx.ai/og.png | head -1
curl -sSI https://app.confirmx.ai/favicon.ico | head -1
curl -sSI https://app.confirmx.ai/apple-touch-icon.png | head -1
```

**Capture:**

- [ ] No "Cordon" hits in DevTools find: YES / NO
- [ ] No "AI fraud" / "autonomous" / "200+" / "৳45 Cr" hits in rendered text: YES / NO
- [ ] Brand assets all return 200 (or document which are still 404): `____________`

---

## Step 10 — Distribution flip

ONLY after Steps 1–9 pass.

In `partners.shopify.com` → Apps → ConfirmX → Distribution:

1. "Update distribution method" → **Public Distribution / Unlisted**
2. Fill the submission form per `docs/shopify-listing-wording.md`.
3. Cross-check every URL against
   `docs/audits/shopify-url-alignment-verification.md §1`.
4. Reviewer notes: copy from
   `docs/shopify-listing-wording.md §Support copy for Partner Dashboard`
   AND link to `docs/shopify-reviewer-test-flow.md`.
5. Submit.

**Capture:**

- [ ] Distribution flipped to Public Distribution Unlisted at: `____________ UTC`
- [ ] Submission ID / reviewer queue position: `____________`

---

## Rollback

Per `shopify-go-live-checklist.md §9`:

- **Env-flag rollback** (no deploy): flip per-feature flags off
  (`DELIVERY_RELIABILITY_*`, `EXTERNAL_DELIVERY_ENABLED`,
  `BDCOURIER_ENABLED`, etc.). Effect immediate; verified at
  `delivery-reliability-rollout.test.ts:356`.
- **Code-revert rollback** (deploy): revert offending commits and
  redeploy. Branch is mostly additive; reverting individual commits
  does not break replay safety.
- **Distribution rollback** (LARGELY ONE-WAY): the Custom →
  Public-Unlisted flip cannot be reversed without losing every
  merchant install. Treat as the line in the sand.

If a show-stopping bug surfaces post-flip:

1. Revert the env-var change (`PUBLIC_API_URL` etc.) on Railway
   and re-deploy with the prior values — quickest, no merchant-
   facing impact since the OAuth callback now redirects to the
   prior environment.
2. Disconnect existing test merchant installs via
   `revokeShopifyAccessToken`.
3. Fix the bug, re-deploy, have merchants re-install.

---

## Done criteria

The cutover is complete when:

- [ ] Every "Capture" field in Steps 1–9 is filled with a green
      result.
- [ ] Step 10 is signed off and the submission ID is recorded.
- [ ] `audits/shopify-final-production-report.md` post-deploy
      fields are filled in by the operator.

The submission can then proceed to Shopify review.
