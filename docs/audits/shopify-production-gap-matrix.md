# Shopify production-readiness gap matrix

**Generated:** 2026-05-09
**Branch:** `claude/staging-deploy`
**Scope:** read-only discovery pass across all 8 production-readiness
phases. Classifies each area COMPLETE / PARTIAL / BLOCKING /
NEEDS POLISH / LOW PRIORITY.
**Method:** direct read of `apps/api/src/`, `apps/web/src/`,
`packages/`, `shopify.app.toml`, `.env.example`, plus the four
canonical Shopify docs already in the repo.

This audit deliberately does **not** redo work captured by the prior
audits — `final-production-readiness-report.md`,
`architecture-inventory.md`, `delivery-reliability-*` and the
landing-page series. It cross-checks against them and surfaces only
the deltas that matter for Shopify-submission readiness.

---

## 0. TL;DR

**Verdict: technically ready to submit, blocked on three organisational
items and one toml field.**

| Hard blockers (Shopify will fail review or install will hang) | Status |
|---|---|
| `shopify.app.toml` `client_id` set | NOT DONE — line 28 commented out |
| `packages/branding/src/defaults.ts` `legalName` not placeholder | NOT DONE — TODO[brand] line 26 |
| `support@confirmx.ai` + `privacy@confirmx.ai` deliverable | NOT VERIFIED — reviewers test |
| Logo assets in `apps/web/public/brand/` are ConfirmX (not Cordon) | NOT VERIFIED |
| Production deploy live at `app.confirmx.ai` / `api.confirmx.ai` | NOT DONE (no cutover yet) |

Everything in the production-stability and Shopify-protocol layers is
COMPLETE or NEEDS POLISH. The work in front of us is closeout +
deploy + Partner-Dashboard form, not engineering.

The low-risk remediations queued in §10 below land cleanly without
new dependencies, and are safe to apply in a single small PR before
flipping distribution.

---

## 1. Phase 1 — Deployment readiness

### 1.1 Production env validation

| Item | Status | Anchor |
|---|---|---|
| `MONGODB_URI` required, format-validated | COMPLETE | `apps/api/src/env.ts:13` |
| `REDIS_URL` required in production (refine) | COMPLETE | `env.ts:452` |
| `JWT_SECRET` min 16 | COMPLETE | `env.ts:15` |
| `ADMIN_SECRET` min 24, required in production | COMPLETE | `env.ts:16, 456` |
| `COURIER_ENC_KEY` required, base64 32-byte validated | COMPLETE | `env.ts:17–23` |
| `PUBLIC_API_URL` required in production | COMPLETE | `env.ts:460` (commit `fce3415`) |
| `PUBLIC_WEB_URL` required in production | COMPLETE | `env.ts:467` (commit `fce3415`) |
| `CORS_ORIGIN` trailing-slash defensively stripped | COMPLETE | `env.ts:33` |
| Loud warnings for unset SMS / payment rails | COMPLETE | `env.ts:485` |
| `NEXTAUTH_SECRET` strength enforcement | NEEDS POLISH | only on apps/web; no min-length refine |

### 1.2 Mongo replica-set assumptions

| Item | Status | Anchor |
|---|---|---|
| `autoIndex: false` in production | COMPLETE | `apps/api/src/lib/db.ts:14` |
| Boot-time `syncIndexes()` for 7 models including reliability | COMPLETE | `apps/api/src/index.ts:166` |
| Out-of-band `db:sync-indexes` CLI | COMPLETE | `apps/api/src/scripts/syncIndexes.ts` |
| `POST /admin/sync-indexes` admin endpoint | COMPLETE | `apps/api/src/server/admin.ts:162` |

### 1.3 Worker startup

All 16 workers wired with `register*Worker` + `schedule*` per
`apps/api/CLAUDE.md` worker checklist. Boot order: connect DB →
init queues → register workers → start schedules → bind HTTP. Verified
2026-05-07 in CLAUDE.md, lines unchanged in this branch.

| Item | Status |
|---|---|
| 16 BullMQ workers registered | COMPLETE |
| Repeatable schedules ensured per boot (idempotent BullMQ keys) | COMPLETE |
| Order-sync polling fallback wired | COMPLETE |
| Pending-job-replay DLQ sweeper armed | COMPLETE |
| `if (env.REDIS_URL)` guard so dev without Redis still boots | COMPLETE |

### 1.4 Webhook surfaces

All five webhook routers mount BEFORE the global JSON parser so
HMAC verification sees raw bytes:

| Surface | Mount | HMAC | Idempotency |
|---|---|---|---|
| `/api/webhooks/courier` | webhookLimiter + raw | per-courier secret | inbox unique index |
| `/api/webhooks/sms-inbound` | webhookLimiter + raw | `SMS_WEBHOOK_SHARED_SECRET` | n/a (not order events) |
| `/api/webhooks/sms-dlr` | webhookLimiter + raw | same | n/a |
| `/api/integrations/webhook/:provider/:integrationId` | webhookLimiter + raw | platform secret | inbox unique index |
| `/api/webhooks/shopify/gdpr/*` | webhookLimiter + raw | `SHOPIFY_APP_API_SECRET` | dual audit log |

| Hardening | Status |
|---|---|
| HMAC over raw body, timing-safe compare | COMPLETE |
| Freshness gate (5min window, 1min future skew) | COMPLETE |
| Inbox unique index `(merchantId, provider, externalId)` | COMPLETE |
| Signature-failure structured log for security ops feed | COMPLETE |
| ACK-latency structured log (`webhook.acked` with `ackMs`) | COMPLETE |
| `Buffer.isBuffer(req.body)` defence-in-depth | COMPLETE |

### 1.5 SSL / proxy / CORS

| Item | Status | Anchor |
|---|---|---|
| `helmet()` mounted | COMPLETE | `apps/api/src/index.ts:263` |
| CORS single-origin, credentialed | COMPLETE | `index.ts:264` |
| `TRUSTED_PROXIES` parser supports CIDR / int / keywords | COMPLETE | `index.ts:82` |
| Production warning when TRUSTED_PROXIES unset | COMPLETE | `index.ts:256` |
| Express `trust proxy` defaults to `false` (no header trust) | COMPLETE | `index.ts:255` |

### 1.6 Health checks

| Item | Status | Anchor |
|---|---|---|
| `GET /health → {ok:true}` (liveness) | COMPLETE | `index.ts:283` |
| Readiness check (DB + Redis reachable) | NEEDS POLISH | not implemented |
| `/health` checked before binding port | N/A | port-bind happens after DB + queue init |

**Recommendation (§10 P-1):** add `GET /ready` that pings Mongo +
Redis. Use it for Railway readiness probe; keep `/health` for
liveness so a transient Redis blip doesn't restart the pod.

### 1.7 Graceful shutdown

| Item | Status |
|---|---|
| SIGINT + SIGTERM handler | COMPLETE |
| `server.close` → `shutdownQueues` → `disconnectDb` → exit | COMPLETE |
| 25s watchdog inside Railway's 30s drain window | COMPLETE |
| Idempotent on duplicate signal | COMPLETE |

### 1.8 Deployment scripts

No npm scripts target Railway/CI explicitly; deploy is assumed to be
Railway-native. The runbook in `shopify-go-live-checklist.md §1–2`
documents the required env vars for both services. No
`scripts/deploy.sh` exists; that's intentional for Railway. NOT a
gap.

### 1.9 Rollback safety

`shopify-go-live-checklist.md §9` documents the rollback play. The
delivery-reliability layer has three rollback tiers
(`final-production-readiness-report.md §6`). No new code paths in
this branch are non-additive — every flag flips back instantly.

**Phase 1 verdict:** COMPLETE except for `/ready` polish (§10 P-1)
and `NEXTAUTH_SECRET` strength refine (§10 P-3).

---

## 2. Phase 2 — Shopify install / OAuth

### 2.1 OAuth flow

`apps/api/src/server/webhooks/integrations.ts:402` (`shopifyOauthRouter`)
implements:

| Step | Status |
|---|---|
| Detect `error=` param (access_denied / invalid_request) early | COMPLETE |
| Required-param check (`code`, `state`, `shop`) | COMPLETE |
| Shop hostname normalisation (managed-install handles missing suffix) | COMPLETE |
| Shop hostname regex validation | COMPLETE |
| **Platform-secret HMAC pre-check** (closes enumeration oracle) | COMPLETE |
| Pending-integration lookup by install nonce (CSRF-safe) | COMPLETE |
| Belt-and-braces `safeStringEqual` nonce check | COMPLETE |
| Install-elapsed-time logging (debugs "install hangs forever") | COMPLETE |
| Canonical-hostname rewrite (vanity → canonical) | COMPLETE |
| Stale `disconnected` orphan cleanup before save | COMPLETE |
| Custom-app fallback HMAC (when no platform secret) | COMPLETE |
| Token exchange with audit on failure | COMPLETE |
| Shop-info smoke test (auth/transient discrimination) | COMPLETE |
| Scope-subset detection (closes 403-days-later trap) | COMPLETE |
| Auto-register webhooks (failure → warning banner, not block) | COMPLETE |
| Health composition (token > scope > webhook) | COMPLETE |
| Audit log on success + failure with full meta | COMPLETE |
| Friendly redirect with `connected=`, `shop=`, `warning=` | COMPLETE |

### 2.2 Embedded admin / App Bridge

Deferred per architectural decision (`shopify-listing-wording.md
§What we deliberately are NOT submitting`). External app posture
(`embedded = false` in `shopify.app.toml`) is the chosen path for
Unlisted launch. Not a gap; LOW PRIORITY post-approval.

### 2.3 Auth / session persistence

NextAuth on `apps/web` (`apps/web/src/app/(auth)/`). Provider scope
follows `apps/web/CLAUDE.md` rules — `<Providers>` mounts at the
route-group layout level, not the root. Marketing route group ships
zero auth weight.

| Item | Status |
|---|---|
| Session middleware on `dashboard/*` and `admin/*` | COMPLETE |
| Auth shell (`CordonAuthShell`) deduplicated | COMPLETE |
| `(marketing)` ships zero tRPC weight | COMPLETE |
| `NEXTAUTH_SECRET` enforced (min length) | NEEDS POLISH (per §1.1) |

### 2.4 Post-install onboarding

| Item | Status | Anchor |
|---|---|---|
| `/dashboard/getting-started` page with hero + checklist | COMPLETE | `apps/web/src/app/dashboard/getting-started/page.tsx` |
| Onboarding checklist with 5 steps + time estimates | COMPLETE | `components/onboarding/onboarding-checklist.tsx` |
| `NewMerchantRedirect` so first-load lands on getting-started | COMPLETE | `components/onboarding/new-merchant-redirect.tsx` |
| `FirstFlagBanner` activation moment | COMPLETE | `components/onboarding/activation-moments.tsx` |
| `NextStepBanner` on dashboard | COMPLETE | dashboard page |
| Per-step progression queries (couriers, orders, automation, integrations) | COMPLETE | onboarding-checklist.tsx |

### 2.5 App reconnect / uninstall

| Item | Status | Anchor |
|---|---|---|
| `app/uninstalled` short-circuit (no inbox / no order queue pollution) | COMPLETE | `integrations.ts:217` |
| Integration row → `disconnected` with health.lastError on uninstall | COMPLETE | same |
| `customers/redact` real PII pseudonymisation | COMPLETE | `gdpr/redaction.ts` |
| `shop/redact` 13-collection hard-delete in dependency order | COMPLETE | same |
| `shop/redact` fresh-install race guard | COMPLETE | `shopify-gdpr.ts:242` |
| `customers/data_request` audit-logged for merchant fulfilment | COMPLETE | `shopify-gdpr.ts:219` |

### 2.6 Scope alignment

| Surface | Scopes |
|---|---|
| `shopify.app.toml` `[access_scopes]` | `read_orders, write_orders, read_customers` |
| Web client `connectShopifySchema.scopes` default (`integrations.ts:98`) | `read_orders, write_orders, read_customers` |
| Listing wording per-scope justifications | three scopes, matching |

**No drift.** A claim in `shopify-app-distribution.md:62` (and
echoed in this matrix's first revision) referenced an older fourth
scope `read_fulfillments`; the code does not request it. P-2 in §10
is therefore retracted — no remediation needed. If we ever want
fulfilment-status sync, the change is to add the scope to all three
surfaces in lock-step, not to fix drift.

**Phase 2 verdict:** OAuth + reconnect + uninstall + onboarding all
COMPLETE. Scope-list alignment is the only NEEDS POLISH.

---

## 3. Phase 3 — Merchant onboarding UX

| Item | Status | Anchor |
|---|---|---|
| First-run experience (`/dashboard/getting-started`) | COMPLETE | as §2.4 |
| Empty states on dashboard charts | COMPLETE | dashboard page `EmptyState` |
| Empty state on order list / fraud queue | COMPLETE (sampled) | `dashboard/orders/page.tsx` |
| Setup checklist with deep-link CTAs | COMPLETE | onboarding-checklist.tsx |
| Courier connection guidance | COMPLETE | per-step hint copy |
| Order confirmation setup hint | COMPLETE | per-step hint copy |
| Operational intelligence explanation | COMPLETE | dashboard hero + banners |
| Feature discoverability (sidebar, settings sub-nav) | COMPLETE | `components/sidebar/`, `components/shell/` |
| Operator-tone copy (no fraud / AI vocabulary) | COMPLETE | `defaults.ts` doc-comment, listing-wording doc |

**Phase 3 verdict:** COMPLETE. The onboarding surface is mature; no
remediation queued.

---

## 4. Phase 4 — Shopify-review safety

| Item | Status | Anchor |
|---|---|---|
| Listing tagline / short-description / long-description copy | COMPLETE | `shopify-listing-wording.md` |
| Per-scope justification (read_orders / write_orders / read_customers) | COMPLETE | same |
| `write_orders` "happy to drop on review request" preempt | COMPLETE | same §write_orders |
| Privacy posture (replay-safe, audit-logged, threshold-tunable) | COMPLETE | listing copy + branding doc-comment |
| networkEvidence operational phrasing (not "fraud accusation") | COMPLETE | `delivery-reliability-panel.tsx:27` ("Calm, operational, trustworthy. No 'fraud' / 'AI' / 'threat' language.") |
| Permission scopes minimised | COMPLETE | three scopes; `read_fulfillments` is the open question (§2.6) |
| GDPR webhook URLs match Partner-Dashboard form | COMPLETE | `shopify-go-live-checklist.md §3` |
| Custom-app escape hatch documented as power-user path | COMPLETE | `shopify-app-distribution.md §Fallback` |

**Phase 4 verdict:** COMPLETE. Positioning audited 2026-05-09 in
the branding defaults file.

---

## 5. Phase 5 — Listing assets readiness

Status of every Partner-Dashboard form field per `shopify-listing-wording.md`:

| Field | Status |
|---|---|
| App name `ConfirmX` | COMPLETE |
| Handle `confirmx` | COMPLETE |
| Tagline (41 chars) | COMPLETE |
| Short description (140 chars) | COMPLETE |
| Long description (~830 chars) | COMPLETE |
| 5 key-benefit bullets | COMPLETE |
| Per-scope justifications | COMPLETE |
| Privacy policy URL | COMPLETE (`/legal/privacy`) |
| Terms of service URL | COMPLETE (`/legal/terms`) |
| 3 GDPR webhook URLs | COMPLETE |
| Categories | COMPLETE (Order management, Operations) |
| **Developer name** (registered legal entity) | BLOCKING — TODO[brand] |
| **App listing screenshots** | NOT DONE — UNLISTED submission doesn't require them, but App Store listed will |
| **Logo assets in `apps/web/public/brand/`** | NEEDS VERIFICATION |
| **Email inboxes accept mail** | NEEDS VERIFICATION |
| FAQ draft | LOW PRIORITY (Unlisted doesn't need it) |
| Support / contact requirements | COMPLETE — `support@confirmx.ai` documented |

**Phase 5 verdict:** copy is complete; closeout work is
organisational (legal entity, email infra, logo files).

---

## 6. Phase 6 — Runtime + UX polish

### 6.1 Loading + empty states

| Item | Status |
|---|---|
| Loading skeletons on dashboard charts | COMPLETE |
| Loading state in onboarding-checklist | COMPLETE |
| `<EmptyState>` primitive used consistently | COMPLETE |

### 6.2 Error boundaries

| Boundary | Status | Anchor |
|---|---|---|
| `app/error.tsx` (segment-level boundary with telemetry capture + reset) | COMPLETE | `apps/web/src/app/error.tsx` |
| `app/global-error.tsx` (root-layout-fail boundary, dependency-free) | COMPLETE | `apps/web/src/app/global-error.tsx` |
| `app/not-found.tsx` | COMPLETE | exists |
| Reusable `<ErrorBoundary>` component for opt-in client guards | COMPLETE | `components/error-boundary.tsx` |
| Stack-trace leakage to merchants | NONE — both boundaries show friendly UI | |

### 6.3 Mobile responsiveness

The landing-page audit series (`landing-page-phase3-responsiveness-report.md`)
has already covered marketing. Dashboard density on mobile is NOT
in those reports — most analytics views assume desktop. NEEDS
POLISH but not BLOCKING for an external (non-embedded) app since
merchants typically use the dashboard at a desk.

### 6.4 Hydration + suspense

| Item | Status |
|---|---|
| Server-side `initialName` hand-off in dashboard hero (avoids "hi → hi, Reza" flicker) | COMPLETE |
| Providers placed at route-group level, not root layout | COMPLETE |
| `useSession()` outside `SessionProvider` traps documented | COMPLETE in `apps/web/CLAUDE.md` |

### 6.5 Console errors

NOT MEASURED in this audit. NEEDS VERIFICATION before submit per
`shopify-go-live-checklist.md §5` ("no CORS errors in DevTools, no
references to 'Cordon' anywhere in rendered surfaces"). LOW
PRIORITY for the gap matrix; high priority on submission day.

**Phase 6 verdict:** mostly COMPLETE. Mobile dashboard density and
console-error sweep are NEEDS POLISH / pre-submit verification.

---

## 7. Phase 7 — Observability + support readiness

### 7.1 Production logs

| Source | Status |
|---|---|
| Structured `webhook.acked` with `ackMs` | COMPLETE |
| Structured `webhook.signature_invalid` for security ops feed | COMPLETE |
| Structured `[boot/syncIndexes]` per-model timing | COMPLETE |
| Structured `[boot]` env / TRUSTED_PROXIES warning | COMPLETE |
| Structured `[shopify-oauth]` per-step diagnostics (canonicalize, hmac, install-elapsed) | COMPLETE |
| Express final error handler (no unstructured stack leaks) | COMPLETE |
| Delivery-reliability JSON-line emitter (S5) | COMPLETE |

### 7.2 Sentry coverage

`apps/api/src/lib/telemetry.ts` ships a Sentry-compatible HTTP capture
that no-ops when `SENTRY_DSN` is unset. Bound to `installProcessHooks`
for unhandled rejections. Surface points: every error.tsx /
global-error.tsx boundary calls `captureException`; the Express
final error handler captures with `tags.source = "express"`.

| Item | Status |
|---|---|
| API `captureException` mounted on Express error handler | COMPLETE |
| API `installProcessHooks` for unhandled rejection / uncaught exception | COMPLETE |
| Web `captureException` on both error boundaries | COMPLETE |
| `SENTRY_DSN` documented in `.env.example` | NEEDS POLISH — not present |
| `SENTRY_RELEASE` set per deploy | LOW PRIORITY (deploy concern) |

### 7.3 Webhook + queue failure observability

| Signal | Source | Status |
|---|---|---|
| Webhook signature failures | structured log | COMPLETE |
| Webhook integrationFirstEvent audit | `integration.first_event` audit row | COMPLETE |
| Webhook last error / failure count on Integration | `webhookStatus.failures, lastError` | COMPLETE |
| Queue failure handling | BullMQ default + `safeEnqueue` DLQ | COMPLETE |
| `pending-job-replay` repeatable sweep | every 30s | COMPLETE |
| Order-sync polling fallback (silent revenue hole guard) | every 5min | COMPLETE |
| Admin tRPC observability surfaces (delivery-reliability rollout state) | three procedures | COMPLETE |

### 7.4 Merchant support / debugging

| Item | Status |
|---|---|
| `support@confirmx.ai` documented | COMPLETE in branding |
| Admin dashboard for ops (`apps/web/src/app/admin/*`) | COMPLETE |
| Admin audit log surface | COMPLETE — `apps/web/src/app/admin/audit/page.tsx` |
| Admin alerts surface | COMPLETE |
| Admin fraud / billing / branding / system / access surfaces | COMPLETE |
| Merchant-side webhook status visibility | PARTIAL — `dashboard/integrations/issues/page.tsx` and `settings/integrations/issues/page.tsx` exist; reachable from connect dialog but discoverability is implicit |

**Phase 7 verdict:** observability is COMPLETE in the API; Sentry
DSN should be documented in `.env.example` for operator
discoverability (§10 P-3).

---

## 8. Phase 8 — Final Shopify submission checklist

The submission checklist is already authored in
`docs/shopify-go-live-checklist.md` and the migration play in
`docs/shopify-app-distribution.md §Migration play-by-play`. This
matrix doesn't reproduce them; it cross-references the gaps still
open as of 2026-05-09:

| Submission requirement | Status |
|---|---|
| Required URLs (app_url, redirect, privacy, terms, 3× GDPR) | COMPLETE in toml + listing doc |
| Webhook endpoints (live + reachable) | DEPENDS ON DEPLOY |
| Review instructions | NOT DRAFTED — Unlisted doesn't strictly require it but reviewers ask |
| Demo merchant | NEEDS DECISION — pilot dev store OR pilot real store with real COD orders |
| Reviewer test flow | NEEDS A SHORT WRITEUP — "log in with X, click Y, expected Z" |
| Permissions justification | COMPLETE |
| App listing assets (logo, screenshots if listed) | NEEDS VERIFICATION (§5) |
| Deployment assumptions | DOCUMENTED in this matrix + checklist |
| Rollback plan | DOCUMENTED in `shopify-go-live-checklist.md §9` |

**Phase 8 verdict:** the submission process is well-documented; the
gaps are operational closeout items rather than missing artefacts.

---

## 9. Cross-cutting findings (severity + owner)

| # | Finding | Severity | Owner | File |
|---|---|---|---|---|
| F1 | `shopify.app.toml` `client_id` commented out | BLOCKING (review) | brand/ops | `shopify.app.toml:28` |
| F2 | `legalName` placeholder in branding defaults | BLOCKING (review) | brand/ops | `packages/branding/src/defaults.ts:26` |
| F3 | Email inboxes (`support@`, `privacy@`) deliverability | BLOCKING (review) | brand/ops | external infra |
| F4 | Logo assets in `apps/web/public/brand/` may still be Cordon | NEEDS VERIFICATION | brand/ops | `apps/web/public/brand/` |
| F5 | Production deploy + Railway env vars not yet cut over | BLOCKING (review) | ops | Railway |
| F6 | ~~`read_fulfillments` scope drift~~ — verified, no actual drift | RETRACTED | — | `shopify.app.toml` and `connectShopifySchema` both request the same three scopes |
| F7 | `/health` is liveness-only; no `/ready` for DB+Redis | NEEDS POLISH | engineering | `apps/api/src/index.ts:283` |
| F8 | `SENTRY_DSN` not documented in `.env.example` | NEEDS POLISH | engineering | `.env.example` |
| F9 | `NEXTAUTH_SECRET` strength not enforced | NEEDS POLISH | engineering | `apps/web/src/lib/...` (env hand-off) |
| F10 | App Bridge / embedded experience deferred | LOW PRIORITY | engineering | `shopify.app.toml:38` |
| F11 | App Store listed (vs Unlisted) deferred | LOW PRIORITY | brand/ops | distribution decision |
| F12 | Mobile dashboard density not audited | LOW PRIORITY | design | `apps/web/src/components/dashboard/*` |
| F13 | Console-error / Cordon-residue sweep not done | PRE-SUBMIT VERIFICATION | ops | live `app.confirmx.ai` |
| F14 | Reviewer test-flow writeup not drafted | NEEDS POLISH | brand/ops | new doc |
| F15 | `customers/data_request` no in-product merchant alert | LOW PRIORITY | engineering | `shopify-gdpr.ts:219` |

F1–F5 are the hard blockers for distribution flip. Engineering owns
F6–F9 and F14 (a writeup); F10–F15 are LOW PRIORITY for this
submission.

---

## 10. Recommended remediations (engineering only)

These are the **rollback-safe, additive, low-risk** items engineering
can land before the distribution flip. Each fits in a single small
PR.

### P-1. Add `/ready` readiness endpoint

**Status:** NEW
**Risk:** zero — additive endpoint, no existing call site
**Where:** `apps/api/src/index.ts` near the existing `/health`
**What:** ping Mongo (`mongoose.connection.readyState`) + Redis
(`redis.ping()`); return 200 with the per-dependency state on green,
503 on red. Use as Railway readiness probe; keep `/health` for
liveness.

### P-2. ~~Align `read_fulfillments` between toml and web client~~ — RETRACTED

Verified during implementation: the web client default in
`connectShopifySchema` (`integrations.ts:98`) requests
`["read_orders", "write_orders", "read_customers"]` — exactly the
three the toml advertises. The "drift" was a stale claim in
`shopify-app-distribution.md:62`. No remediation needed. The stale
doc is captured here so future audits don't re-discover and re-flag.

### P-3. Document `SENTRY_DSN`, tighten env discoverability

**Status:** NEW
**Risk:** zero
**Where:** `.env.example`
**What:** add a `# --- Telemetry ---` block listing `SENTRY_DSN`
+ `SENTRY_RELEASE` with their no-op semantics. Already in
`apps/api/src/env.ts`; just not surfaced in the example file.

### P-4. Direct `application_url` to `/dashboard/settings/integrations`

**Status:** NEW
**Risk:** low — currently lands on `/dashboard/integrations` which
**redirects** to the canonical settings path. Both are in the
Partner Dashboard / toml. Direct routing saves one client-side
redirect on every install.
**Where:** `shopify.app.toml:33` and the OAuth callback's
`dashboard` URL builder (`integrations.ts:405`).
**What:** point both at `/dashboard/settings/integrations`. Verify
the legacy redirect at `/dashboard/integrations/page.tsx` still
exists for any external links pinned to the old URL.

### P-5. Pre-submit Cordon-residue sweep

**Status:** NEW (script)
**Risk:** zero — read-only grep
**Where:** new `apps/api/src/scripts/preSubmitSweep.ts` OR plain shell
**What:** grep for `Cordon`, `cordon`, `TODO[brand]`, `localhost`,
old API hosts in rendered web surfaces and api JSON responses. CI-
addable. The brand audit already documented the manual version;
codifying it as a script makes day-of submission less error-prone.

### P-6. NEXTAUTH_SECRET strength enforcement

**Status:** OPEN — needs review of `apps/web/src/lib/...`
**Risk:** medium — refining a production-required env can break dev
boot if not handled carefully. Not landing in this round; flagged
for follow-up.

---

## 11. Recommended execution order

1. **P-3** + **P-1** + **P-2** + **P-4** as a single PR titled
   `prod-readiness: ready endpoint, scope alignment, env docs,
   integrations url directness`. ~30 lines net. No semantics change
   on existing call paths.
2. **P-5** as an optional follow-up if we want CI-enforced sweeps.
3. Brand/ops parallel track:
   a. Replace `legalName` and confirm legal entity (F2).
   b. Provision email inboxes; verify delivery (F3).
   c. Replace logo assets in `apps/web/public/brand/`; one-shot
      visual diff against `shopify-go-live-checklist.md §5` list (F4).
   d. Set `client_id` in `shopify.app.toml` (F1).
4. Ops track:
   a. Cut Railway env vars per `shopify-go-live-checklist.md §1–2`.
   b. Deploy api + web to `api.confirmx.ai` / `app.confirmx.ai`.
   c. Run OAuth E2E against a fresh dev store.
   d. Console-error / Cordon-residue sweep on the live site.
5. Submission day:
   a. Flip distribution Custom → Public Distribution Unlisted.
   b. Fill the Partner-Dashboard form per `shopify-listing-wording.md`.
   c. Submit.

After approval: bulk-retry webhook registrations for any test
merchants connected during dev (their `callback_url` still points at
the old API host); see `shopify-go-live-checklist.md §7`.

---

## 12. Out-of-scope for this matrix (already audited)

- Delivery reliability rollout sequencing →
  `delivery-reliability-rollout-runbook.md`.
- Architecture inventory →
  `architecture-inventory.md`.
- Landing page UX polish series → `landing-page-phase{1..7}-*.md`.
- Reconciliation race investigation →
  `reconciliation-window-race-{investigation,resolution}-report.md`.
- Fraud reliability remediation → `fraud-reliability-remediation-plan.md`.

These are referenced when relevant but not re-audited here.

## 13. References

- `docs/context/shopify-production-context.md` — canonical session
  brief (consolidates the four Shopify docs)
- `docs/shopify-app-distribution.md`
- `docs/shopify-listing-wording.md`
- `docs/shopify-go-live-checklist.md`
- `docs/audits/final-production-readiness-report.md`
- `apps/api/CLAUDE.md`
- `apps/web/CLAUDE.md`
