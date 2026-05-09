# Final production report — ConfirmX cutover

**Authored:** 2026-05-09 (pre-deploy section)
**Branch at authorship:** `claude/staging-deploy`
**Last commit at authorship:** `8c58110`
**Live deploy at:** `____________ UTC` *(filled by operator post-deploy)*

This report is **two-phase**:

- **§ 1–§ 5** are pre-deploy fields, filled by engineering on
  2026-05-09 from the local working tree. They are evidence the
  code is ready to deploy.
- **§ 6–§ 11** are post-deploy fields, filled by operator from
  the runbook in `docs/shopify-production-cutover-runbook.md`.
  Every field corresponds to a Capture entry in the runbook.

The submission verdict in §11 is held until §6–§10 are filled.

---

## § 1. Engineering completeness — PRE-DEPLOY (filled 2026-05-09)

| Item | Status | Evidence |
|---|---|---|
| Replay-safe webhooks | ✅ | `final-production-readiness-report.md` |
| Webhook idempotency (`WebhookInbox` unique index) | ✅ | `apps/api/src/server/ingest.ts` |
| OAuth hardening (HMAC pre-check, nonce CSRF, scope diff, hostname canonicalisation, orphan cleanup, audit logs) | ✅ | `apps/api/src/server/webhooks/integrations.ts:402` |
| GDPR webhooks (HMAC + real redaction + dual-audit pattern + fresh-install race guard) | ✅ | `apps/api/src/server/webhooks/shopify-gdpr.ts`, `apps/api/src/lib/gdpr/redaction.ts` |
| `app/uninstalled` short-circuit | ✅ | `integrations.ts:217` |
| Production env validation (REDIS_URL / ADMIN_SECRET / PUBLIC_API_URL / PUBLIC_WEB_URL prod-required) | ✅ | `apps/api/src/env.ts` `.refine()` blocks |
| `/health` (liveness, DB-independent) | ✅ | `apps/api/src/index.ts:283` |
| `/ready` (Mongo readyState + Redis PING with 1.5s timeout, 503 on red) | ✅ | landed in `d09b7a4` |
| Worker registration (16 workers wired) | ✅ | `apps/api/CLAUDE.md` |
| Boot-time index sync for 7 models | ✅ | `apps/api/src/index.ts:166` |
| Sentry-compatible telemetry (no-op when DSN unset) | ✅ | `apps/api/src/lib/telemetry.ts` |
| SSRF-safe outbound fetch (BDCourier routed) | ✅ | `apps/api/src/lib/integrations/safe-fetch.ts`, commit `550c2bf` |
| Reviewer-safe wording (no autonomous/AI fraud/no human touch) | ✅ | landed in `5b3e815` |
| Trust-band claims softened pending real-data verification | ✅ | landed in `8c58110` |
| Onboarding flow (`/dashboard/getting-started` + 5-step checklist + `NewMerchantRedirect`) | ✅ | `apps/web/src/app/dashboard/getting-started/page.tsx` |
| Error boundaries (3 levels) + Sentry capture | ✅ | `apps/web/src/app/{error,global-error,not-found}.tsx` |
| 45 routes resolve, marketing-graph clean | ✅ | `shopify-static-reviewer-simulation.md` |
| OAuth `?error=` (10) + `?warning=` (4) UI handling | ✅ | `dashboard/settings/integrations/page.tsx` |

## § 2. Build artefact verification — PRE-DEPLOY (filled 2026-05-09)

| Build | Result | Captured at |
|---|---|---|
| `npx tsc -p apps/api/tsconfig.build.json --noEmit` (production sources) | ✅ clean exit | 2026-05-09 |
| `npm --workspace apps/web run typecheck` | ✅ clean exit | 2026-05-09 |
| `npm --workspace apps/api run build` | ✅ clean | 2026-05-09 |
| `npm --workspace apps/web run build` | ✅ clean — 45 routes built (SSG + dynamic + middleware 47.7 kB) | 2026-05-09 |

Pre-existing test-file typecheck errors in
`tests/external-delivery-{providers,pure,validation-summary}.test.ts`
are inherited from `main` and out of scope; they do not appear in
the build-target tsconfig and do not affect the production
artefact.

## § 3. Hygiene verification — PRE-DEPLOY (filled 2026-05-09)

| Check | Result |
|---|---|
| `git ls-files | grep .env` returns only `.env.example` and `apps/web/.env.local.example` | ✅ no committed secrets |
| `.gitignore` includes `.env`, `.env.local`, `.env.*.local`, `.env.env.*`, `.env.*backup*`, `.env.*-backup-*`, `.claude-staging/` | ✅ |
| `.env.example` documents 63 env vars | ✅ |
| No production env vars commented out (only doc-template lines for prod-host examples) | ✅ |
| All `localhost` references in `apps/api/src` are correctly-guarded `?? "http://localhost:..."` fallbacks | ✅ — never fire in production because `env.ts` `.refine()` requires `PUBLIC_API_URL`/`PUBLIC_WEB_URL` |
| `[Cc]ordon` rendered-text grep | ✅ 0 hits in user-visible surfaces |
| Review-trigger wording grep (`autonomous`, `no human touch`, `fraud detection`, `AI screen`, `machine learning`, `black box`, `surveillance`) | ✅ 0 hits in rendered text |
| `TODO[brand]` grep | three documented entries remain (legalName, optional physical-address, optional jurisdiction clause) — F2 in gap matrix |

## § 4. Production-blocker hand-off — PRE-DEPLOY (filled 2026-05-09)

| # | Blocker | Owner | Cleared? |
|---|---|---|---|
| F1 | `shopify.app.toml:28` `client_id` commented out | brand/ops | NO |
| F2 | `legalName` placeholder | brand/legal | NO |
| F3 | `support@`/`privacy@confirmx.ai` mailbox deliverability | ops | NO |
| F4 | `apps/web/public/brand/` directory missing 6 files | brand/design | NO |
| F5 | Production deploy + Railway env cutover | ops | NO (this report tracks it) |
| L4 | SPF/DKIM/DMARC on `confirmx.ai` | ops | NO |
| L5 | `confirmx.ai` homepage resolves coherently | ops | NO |
| M1–M4 | Real-data verification of softened claims | brand/ops | optional |
| PT-1 | toml app-level webhook URI bug | engineering deferred | NO (not submission-blocker) |

## § 5. Engineering verdict — PRE-DEPLOY (filled 2026-05-09)

**GREEN.** No engineering blockers remain for Public Distribution
Unlisted submission. Branch is 3 commits ahead of
`origin/claude/staging-deploy`; last commit `8c58110`. All builds
clean. All hygiene checks clean. The remaining 9 blockers in §4
are all organisational closeout items.

---

## § 6. Deployment status — POST-DEPLOY (operator fills)

| Field | Value |
|---|---|
| Deploy started at | `____________ UTC` |
| Deploy completed at | `____________ UTC` |
| Commit deployed | `____________` |
| Railway api service URL | `____________` |
| Railway web service URL | `____________` |
| Production api URL (DNS) | `____________` (expected `https://api.confirmx.ai`) |
| Production web URL (DNS) | `____________` (expected `https://app.confirmx.ai`) |
| TLS certificate valid | YES / NO |
| Boot log: all 7 `[boot/syncIndexes]` lines present | YES / NO |
| Boot log: `[boot] pending-job-replay armed` and `[boot] order-sync polling fallback armed` | YES / NO |
| Boot log: `[boot] env=production ... telemetry=on` | YES / NO |

## § 7. Health probe status — POST-DEPLOY

| Probe | Status |
|---|---|
| `GET /health` HTTP code | `____` |
| `GET /health` body | `____________` |
| `GET /ready` HTTP code | `____` |
| `GET /ready` mongo check | `____________` |
| `GET /ready` redis check | `____________` |
| `GET /ready` p95 latency | `____ ms` |
| Railway readiness probe configured to `/ready` | YES / NO |
| Railway liveness probe configured to `/health` | YES / NO |

## § 8. Worker + queue status — POST-DEPLOY

| Field | Value |
|---|---|
| Worker registration errors in first 60s post-boot | NONE / `____________` |
| BullMQ reconnect-loop count | `____` |
| Repeatable schedules confirmed (count) | `____` (expected 9: trackingSync, webhookRetry, fraudWeightTuning, automationStale, automationWatchdog, cartRecovery, trialReminder, subscriptionGrace, awbReconcile, orderSync, pendingJobReplay sweep) |
| `POST /admin/sync-indexes` HTTP code | `____` |
| `PendingJob` count after first hour | `____` (expected 0; <10 acceptable; >10 indicates Redis or worker issue) |

## § 9. OAuth + install flow status — POST-DEPLOY

| Field | Value |
|---|---|
| Test dev store domain | `____________` |
| Install URL launched | YES / NO |
| Approval succeeded | YES / NO |
| Redirect URL contained `?error=` | NO / `____________` |
| Redirect URL contained `?warning=` | NO / `____________` |
| `[shopify-oauth] callback received` elapsedMs | `____` (expected <15000) |
| Integration row status | `connected` / OTHER (`____________`) |
| Integration row webhookStatus.registered | `true` / `false` |
| Integration row health.ok | `true` / `false` |
| First test order webhook ackMs | `____` (target <50) |
| Test order visible in `/dashboard/orders` | YES / NO |
| Order detail drawer rendered correctly | YES / NO |
| Uninstall: `app/uninstalled` log line emitted | YES / NO |
| Uninstall: integration card flipped to `Disconnected` within 5s | YES / NO |
| Uninstall: DB row updated correctly | YES / NO |

## § 10. Webhook + observability status — POST-DEPLOY

| Field | Value |
|---|---|
| Bogus order-webhook HMAC: HTTP code | `____` (expected 401 or 404) |
| Unsigned GDPR webhook: HTTP code | `____` (expected 401) |
| Security log lines emitted on bad HMAC | YES / NO |
| Partner Dashboard "Test webhook" `customers/data_request` | HTTP `____`, 2 audit rows: YES / NO |
| Partner Dashboard "Test webhook" `customers/redact` | HTTP `____`, 2 audit rows: YES / NO |
| Partner Dashboard "Test webhook" `shop/redact` | HTTP `____`, 2 audit rows: YES / NO |
| Idempotency probe (duplicate delivery) | HTTP `____` with `duplicate: true`: YES / NO |
| Sentry receiving events | YES / NO |
| Sentry release tag matches deploy commit | YES / NO |
| `webhook.acked` ackMs p95 over first 100 deliveries | `____ ms` (target <50) |

## § 11. Submission readiness verdict — POST-DEPLOY

After §6–§10 are filled, populate one of these:

### GREEN — submit
**Conditions for GREEN:**
- §6 deployment all rows green
- §7 both probes 200, mongo + redis ok
- §8 worker boot clean, no PendingJob accumulation
- §9 OAuth happy-path completes without `?error=` and the integration row is `connected` with healthy webhook subscription
- §10 all bad-HMAC probes return 401, all 3 GDPR Partner-Dashboard tests pass, Sentry receiving

### YELLOW — submit with caveat
**Conditions for YELLOW:**
- §6–§9 green
- §10 has one minor issue (e.g. ackMs p95 between 50-100ms, or one warning banner during install) that doesn't affect the reviewer happy-path

### RED — halt; remediate
**Conditions for RED:**
- Any of §6–§10 has a hard failure
- OAuth happy-path produces a `?error=` redirect
- Any GDPR webhook fails HMAC verification
- Any worker is in a reconnect loop
- `/ready` is 503 sustained

**Operator's verdict:** `____________`

**Operator's signature + timestamp:** `____________`

---

## § 12. Rollback readiness — STATIC

Per `shopify-go-live-checklist.md §9` and the
`final-production-readiness-report.md §6` three-tier rollback:

| Tier | Path | Effect |
|---|---|---|
| 1. Env-flag flip | Toggle `DELIVERY_RELIABILITY_*`, `EXTERNAL_DELIVERY_*`, `BDCOURIER_*` to `0` in Railway env | Immediate on next request; no deploy |
| 2. Code revert | Revert offending commit(s) on `main`; redeploy | ~5 min on Railway; additive-only branch makes individual reverts safe |
| 3. Schema drop (last resort) | `db.customer_reliabilities.drop()` + `db.address_reliabilities.drop()` | Aggregates are observations, not authoritative state — safe to drop |

The Custom → Public Distribution Unlisted flip is **largely one-
way** (Step 10 of the runbook). If a show-stopping bug surfaces
post-flip, the play is documented in the runbook's `Rollback`
section: revert env vars on Railway, disconnect test merchants via
`revokeShopifyAccessToken`, fix, redeploy.

## § 13. Out-of-scope deferred items

| # | Item | Notes |
|---|---|---|
| PT-1 | `shopify.app.toml:90` app-level webhook URI omits `:integrationId` | OAuth-time per-shop registration is unaffected; only `shopify app dev`/`deploy` would hit it. Address post-approval. |
| App Bridge | Embedded experience deferred per architectural decision | Revisit when admin-nav launch is desired |
| App Store Listed | Marketing review separate from Unlisted | Pursue post-Unlisted approval if top-of-funnel discovery is wanted |
| Shopify Billing API | Stripe + manual bKash/Nagad remains primary | No revenue share applies for off-platform billing on Unlisted |
| Mobile dashboard density audit | Not blocking for an external (non-embedded) app | Post-approval polish |
| CSS class names `.cordon-*` rename | DevTools-only; not user-visible | Post-approval refactor |
| LocalStorage key `cordon:incident:dismissed:*` migration | Renaming would invalidate dismissed-banner state | Post-approval if at all |

## § 14. References

Pre-deploy work in this branch:
- `docs/audits/shopify-production-gap-matrix.md` — global readiness
- `docs/context/shopify-production-context.md` — canonical session brief
- `docs/audits/shopify-brand-consistency-audit.md`
- `docs/audits/shopify-legal-contact-readiness.md`
- `docs/audits/shopify-final-reviewer-risk-audit.md`
- `docs/audits/shopify-marketing-claim-audit.md`
- `docs/audits/shopify-url-alignment-verification.md`
- `docs/audits/shopify-static-reviewer-simulation.md`
- `docs/shopify-reviewer-test-flow.md`

Cutover execution:
- `docs/shopify-production-cutover-runbook.md`

Pre-existing reference:
- `docs/audits/final-production-readiness-report.md`
- `docs/audits/architecture-inventory.md`
- `docs/audits/delivery-reliability-rollout-runbook.md`
- `docs/shopify-app-distribution.md`
- `docs/shopify-listing-wording.md`
- `docs/shopify-go-live-checklist.md`

---

## § 15. Commit history (this submission cycle)

| Commit | Title |
|---|---|
| `d09b7a4` | feat(prod-readiness): /ready endpoint, Sentry env discoverability, install-flow polish + Shopify production context |
| `5b3e815` | docs(shopify): brand + reviewer + cutover closeout pass |
| `8c58110` | docs(shopify): pre-submission audits + soften unverified trust-band claims |
| (pending commit on `<this-turn>`) | docs(shopify): production cutover runbook + final report template |

All four commits are additive and rollback-safe; no architecture
changes. Branch `claude/staging-deploy` is 3-or-4 commits ahead
of origin at the time of authorship.
