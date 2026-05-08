# COMMIT_STRATEGY.md

**Date:** 2026-05-07
**Branch:** `claude/staging-deploy`
**Goal:** turn the 88 untracked / modified entries currently in
`git status` into a small number of clean, reviewable commits that
make sense in the GitHub UI six months from now.

> ⚠️ **Read `PRE_PUSH_SECURITY_CHECKLIST.md` BEFORE running any commit
> below.** No secret has been committed historically; the checklist
> verifies that's still true after staging.

---

## 1. Constraints

- **Add specific files only.** Never `git add -A` or `git add .` —
  the master `CLAUDE.md` explicitly forbids this and the working tree
  contains pre-existing branch work + this session's work mixed
  together.
- **Do not skip hooks.** No `--no-verify`. If a hook fails, fix the
  underlying issue.
- **Do not amend / force-push.** Branch is shared (`origin/claude/staging-deploy`).
  Stack new commits on top.
- **Do not commit `.claude/settings.local.json`.** Local harness state.

---

## 2. Pre-existing branch work — owner decision

`git log` shows the most recent baseline commit (`0c006c3 baseline
hardening`). Everything in `git status` after that includes:

- This session's work (intelligence layer, operational hints, support
  snapshot, observability logs, feedback capture, onboarding copy
  refinement, refactor into `services/intelligence/`, all the
  documentation).
- **Pre-existing branch work** that was already on `claude/staging-deploy`
  before this session started: marketing/legal pages, billing UI,
  CSP-report endpoint, several dashboard pages, sidebar, topbar
  pre-changes, several integrations / feedback / onboarding
  components, audit-log + email + auth library tweaks.

**Action required from the branch owner BEFORE I commit:**

> Confirm whether the pre-existing branch work should:
> (a) ship in the same push as this session's work, or
> (b) be split into earlier commits before this session's commits land.

This document's commit plan **assumes (a)** — group pre-existing
branch work into one or two thematic commits, then stack this
session's work on top. If (b) is preferred, the human commits the
pre-existing files first then re-runs this strategy from "Commit B".

---

## 3. Recommended commit sequence

Each commit below is **reviewable in isolation** — no commit depends on
files added by a later commit. The order matters: docs go last so
review can read the code first and the docs second.

### Commit A — Pre-existing branch work: marketing + legal + dashboard chrome

**Stage:**
```
git add apps/web/src/app/forgot-password/page.tsx
git add apps/web/src/app/layout.tsx
git add apps/web/src/app/legal/layout.tsx
git add apps/web/src/app/legal/privacy/page.tsx
git add apps/web/src/app/legal/terms/page.tsx
git add apps/web/src/app/pricing/page.tsx
git add apps/web/src/app/verify-email/layout.tsx
git add apps/web/src/app/verify-email/page.tsx
git add apps/web/src/app/global-error.tsx
git add apps/web/src/app/icon.svg
git add apps/web/src/app/not-found.tsx
git add apps/web/src/app/robots.ts
git add apps/web/src/app/sitemap.ts
git add apps/web/src/app/api/csp-report/
git add apps/web/next.config.mjs
```

**Commit message:**
```
chore(web): marketing + legal + SEO surfaces

- forgot-password / verify-email layout polish
- legal/{privacy,terms} content pages
- pricing page
- global-error + not-found App Router boundaries
- robots.ts + sitemap.ts for SEO
- icon.svg favicon
- /api/csp-report violation receiver (matches next.config.mjs Report-Only header)
- next.config.mjs CSP + security-header hardening
```

### Commit B — Pre-existing branch work: billing + integrations + onboarding chrome

**Stage:**
```
git add apps/web/src/app/dashboard/billing/page.tsx
git add apps/web/src/app/dashboard/fraud-review/page.tsx
git add apps/web/src/app/dashboard/integrations/issues/page.tsx
git add apps/web/src/app/dashboard/integrations/page.tsx
git add apps/web/src/app/dashboard/layout.tsx
git add apps/web/src/app/dashboard/orders/page.tsx
git add apps/web/src/app/dashboard/page.tsx
git add apps/web/src/app/dashboard/recovery/page.tsx
git add apps/web/src/app/dashboard/integrations/_components/
git add apps/web/src/components/billing/dashboard-banners.tsx
git add apps/web/src/components/billing/subscription-banner.tsx
git add apps/web/src/components/billing/usage-overview.tsx
git add apps/web/src/components/billing/trial-savings-banner.tsx
git add apps/web/src/components/dashboard/operational-banner.tsx
git add apps/web/src/components/dashboard/incident-banner.tsx
git add apps/web/src/components/feedback/system-status-pill.tsx
git add apps/web/src/components/integrations/system-status-panel.tsx
git add apps/web/src/components/integrations/webhook-health-card.tsx
git add apps/web/src/components/onboarding/activation-moments.tsx
git add apps/web/src/components/orders/sample-orders-preview.tsx
git add apps/web/src/components/shell/cordon-auth-shell.tsx
git add apps/web/src/components/shell/notifications-drawer.tsx
git add apps/web/src/components/sidebar/Sidebar.tsx
git add apps/web/src/lib/use-visibility-interval.ts
git rm apps/web/src/components/shell/account-shell.tsx
```

**Commit message:**
```
feat(web): billing/integrations/onboarding dashboard chrome

- billing: subscription banner, dashboard banners, usage overview, trial-savings banner
- integrations: status panel, webhook health card, issues page, connect-flow components
- onboarding: activation-moments toaster, sample-orders-preview
- dashboard: operational banner, incident banner, system-status pill
- shell: cordon-auth-shell + notifications-drawer polish
- sidebar refresh
- delete deprecated components/shell/account-shell.tsx (per apps/web/CLAUDE.md:18-19)
- visibility-interval hook for polling-pause behaviour
```

### Commit C — API library work (auth / audit / email / webhook test)

**Stage:**
```
git add apps/api/src/lib/audit.ts
git add apps/api/src/lib/email.ts
git add apps/api/src/server/auth.ts
git add apps/api/tests/webhookIdempotencyDurability.test.ts
git add packages/db/src/models/auditLog.ts
```

**Commit message:**
```
chore(api): auth / audit / email refinements + webhook test polish

- auth: incremental hardening (per branch baseline)
- audit lib: minor robustness
- email lib: dev fallback adjustments
- webhookIdempotencyDurability test refinements
- AuditLog model action enum / hash chain refinement
```

### Commit D — RTO Engine v1: Intent + Address + Thana + observation pipeline

**Stage:**
```
git add packages/db/src/models/order.ts
git add packages/db/src/models/trackingSession.ts
git add packages/db/src/index.ts
git add apps/api/src/lib/intent.ts
git add apps/api/src/lib/address-intelligence.ts
git add apps/api/src/lib/thana-lexicon.ts
git add apps/api/src/env.ts
git add apps/api/src/index.ts
git add apps/api/src/server/ingest.ts
git add apps/api/tests/intent.test.ts
git add apps/api/tests/address-intelligence.test.ts
git add apps/api/tests/thana-extraction.test.ts
git add apps/api/tests/rto-engine-passive.test.ts
git add apps/api/tests/audit-funnel.test.ts
```

**Commit message:**
```
feat(rto): observation-only Intent + Address + Thana intelligence

Milestone 1 of the RTO Prevention Engine. Pure-function classifiers
+ schema additions; never feeds computeRisk in v1.

- packages/db/src/models/order.ts: additive Order.intent + Order.address
  + Order.customer.thana subdocs; partial-filter indexes for analytics
  cohort joins
- packages/db/src/models/trackingSession.ts: (merchantId, resolvedOrderId)
  partial index for the post-identity-resolution intent lookup
- apps/api/src/lib/intent.ts: computeIntentScore (pure) + scoreIntentForOrder
  (fire-and-forget DB write)
- apps/api/src/lib/address-intelligence.ts: computeAddressQuality —
  landmark + script-mix detection in Latin + Bangla
- apps/api/src/lib/thana-lexicon.ts: 150+ thana seed with Bangla
  aliases + suffix-aware extractor
- apps/api/src/env.ts: INTENT_SCORING_ENABLED, ADDRESS_QUALITY_ENABLED
  kill-switches (default 1)
- apps/api/src/server/ingest.ts: synchronous address quality stamp +
  chained intent scoring after resolveIdentityForOrder
- apps/api/src/index.ts: TrackingSession added to boot syncIndexes
- 5 vitest files (intent / address / thana / passive ingestion / audit
  funnel)
```

### Commit E — Intelligence dashboard analytics + service refactor

**Stage:**
```
git add apps/api/src/server/services/
git add apps/api/src/server/routers/analytics.ts
git add apps/api/tests/intelligence-analytics.test.ts
git add apps/web/src/components/intelligence/
git add apps/web/src/components/orders/intelligence-panels.tsx
git add apps/web/src/app/dashboard/analytics/page.tsx
git add apps/web/src/components/orders/tracking-timeline-drawer.tsx
```

**Commit message:**
```
feat(intelligence): observation dashboard + service-layer extraction

- apps/api/src/server/services/intelligence/: 7-file extraction
  (intelligenceBuckets / outcomeMetrics / campaignClassification /
  sessionCorrelation / intelligenceSchemas / intelligenceTypes /
  intelligenceHandlers)
- apps/api/src/server/routers/analytics.ts: 5 new procedures
  (intentDistribution, addressQualityDistribution, topThanas,
  campaignSourceOutcomes, repeatVisitorOutcomes)
- apps/web/src/components/intelligence/rto-intelligence-section.tsx:
  4-card RTO observation surface mounted on /dashboard/analytics
- apps/web/src/components/orders/intelligence-panels.tsx: per-order
  intent + address quality drawer panels
- apps/web/src/components/orders/tracking-timeline-drawer.tsx: mount
  intelligence panels in the order detail drawer
- intelligence-analytics.test.ts: 16 aggregation tests
```

### Commit F — Operational hints + per-merchant support snapshot + observability

**Stage:**
```
git add apps/api/src/lib/operational-hints.ts
git add apps/api/src/server/routers/orders.ts
git add apps/api/src/server/routers/adminObservability.ts
git add apps/api/src/server/webhooks/integrations.ts
git add apps/api/tests/operational-hints.test.ts
git add apps/web/src/components/orders/operational-hint-panel.tsx
```

**Commit message:**
```
feat(ops): operational hints + merchant support snapshot + structured logs

- apps/api/src/lib/operational-hints.ts: pure-function classifier for
  8 NDR-style states (visibility-only; no automation)
- apps/api/src/server/routers/orders.ts: surface operationalHint +
  intent + addressQuality + thana on getOrder
- apps/api/src/server/routers/adminObservability.ts: per-merchant
  merchantSupportSnapshot procedure
- apps/api/src/server/webhooks/integrations.ts: structured logs —
  evt: webhook.signature_invalid, evt: webhook.acked (with ackMs)
- apps/web/src/components/orders/operational-hint-panel.tsx: matching
  UI panel; null-safe (renders nothing on healthy orders)
- 21 operational-hints unit tests
```

### Commit G — Merchant feedback capture + onboarding polish

**Stage:**
```
git add packages/db/src/models/merchantFeedback.ts
git add apps/api/src/server/routers/feedback.ts
git add apps/api/src/server/routers/index.ts
git add apps/api/tests/feedback.test.ts
git add apps/web/src/components/feedback/feedback-button.tsx
git add apps/web/src/components/shell/topbar.tsx
git add apps/web/src/components/onboarding/onboarding-checklist.tsx
```

**Commit message:**
```
feat(feedback): merchant feedback capture + onboarding copy refinement

- packages/db/src/models/merchantFeedback.ts: lightweight feedback ledger
  (kind / severity / status / message / pagePath / userAgent)
- apps/api/src/server/routers/feedback.ts: feedback.submit mutation
  with structured log emit (no message body in logs — PII-safe)
- apps/api/src/server/routers/index.ts: mount feedbackRouter on appRouter
- apps/api/src/server/routers/adminObservability.ts: recentFeedback +
  triageFeedback admin procedures (already in commit F)
- apps/web/src/components/feedback/feedback-button.tsx: topbar button
  with 6-kind sheet
- apps/web/src/components/shell/topbar.tsx: mount FeedbackButton
- apps/web/src/components/onboarding/onboarding-checklist.tsx:
  benefit-framed STEP_HINTS (replaces tech-list copy)
- 10 feedback tests
```

> Note: `adminObservability.ts` is staged in commit F; commit G doesn't
> re-touch it. Order matters.

### Commit H — Documentation drop

**Stage:**
```
git add MONOREPO_SAAS_MASTER_AUDIT.md
git add RTO_PREVENTION_STRATEGY_MASTERPLAN.md
git add RTO_ENGINE_EXECUTION_ROADMAP.md
git add INTENT_INTELLIGENCE_VALIDATION_REPORT.md
git add POST_VALIDATION_OPERATIONAL_POLISH_REPORT.md
git add DESIGN_PARTNER_READINESS_CHECKLIST.md
git add DESIGN_PARTNER_LAUNCH_REPORT.md
git add OPERATIONAL_PLAYBOOKS.md
git add REPOSITORY_HYGIENE_AUDIT.md
git add PROJECT_ARCHITECTURE.md
git add MERCHANT_FEATURES.md
git add INFRASTRUCTURE_OVERVIEW.md
git add COMMIT_STRATEGY.md
git add PRE_PUSH_SECURITY_CHECKLIST.md
```

**Commit message:**
```
docs: comprehensive architecture, strategy, runbook, and launch documentation

Adds the documentation set produced across the validation + design-
partner phases. None of these change platform behaviour.

- MONOREPO_SAAS_MASTER_AUDIT.md — full architecture audit
- RTO_PREVENTION_STRATEGY_MASTERPLAN.md — product strategy + BD-market
  insights
- RTO_ENGINE_EXECUTION_ROADMAP.md — Milestone 1 execution plan
- INTENT_INTELLIGENCE_VALIDATION_REPORT.md — validation methodology +
  computeRisk readiness gates (NOT READY pending production data)
- POST_VALIDATION_OPERATIONAL_POLISH_REPORT.md — operational hints +
  support snapshot + observability ship-log
- DESIGN_PARTNER_READINESS_CHECKLIST.md — 10-dimension launch
  readiness (6 READY / 4 PARTIAL / 0 BLOCKED)
- DESIGN_PARTNER_LAUNCH_REPORT.md — GO for 5-merchant pilot
- OPERATIONAL_PLAYBOOKS.md — 8 incident runbooks
- REPOSITORY_HYGIENE_AUDIT.md — repo state at this commit
- PROJECT_ARCHITECTURE.md — engineer-facing architecture document
- MERCHANT_FEATURES.md — plain-English merchant feature catalogue
- INFRASTRUCTURE_OVERVIEW.md — runtime topology + operator-fill slots
- COMMIT_STRATEGY.md, PRE_PUSH_SECURITY_CHECKLIST.md — this commit's
  authoring discipline
```

---

## 4. Files explicitly NOT included in any commit

| Path | Reason |
|---|---|
| `.claude/settings.local.json` | Local harness state — not part of the product |
| `.env`, `apps/web/.env.local` | Already correctly gitignored — never staged |
| `node_modules/`, `dist/`, `.next/` | Already correctly gitignored |

---

## 5. Recommended tag

After commit H lands and the full suite passes on the deploy environment:

```bash
git tag -a v0.1.0-design-partner-pilot -m "Design partner pilot — RTO observation engine + operational polish + launch documentation"
git push origin v0.1.0-design-partner-pilot
```

**Why a tag now:** the GitHub UI shows tags in the release sidebar; a
named launch milestone gives the team a clean rollback point ("revert to
v0.1.0-design-partner-pilot") for the duration of the pilot.

---

## 6. Validation between commits

After **each** commit (especially commits D, E, F, G):

```bash
npm --workspace apps/api run typecheck
npm --workspace apps/web run typecheck
```

After commit H lands (before push):

```bash
npm --workspace apps/api test
npm run build
```

If any check fails on a particular commit, fix the issue with a NEW
commit (don't amend). Force-pushing on `origin/claude/staging-deploy`
breaks every other contributor's git tree.

---

## 7. Final push

After all 8 commits + the tag:

```bash
git push origin claude/staging-deploy
git push origin v0.1.0-design-partner-pilot
```

The push is **NOT a force push.** Branch grows linearly.

---

**End of commit strategy.**

*Run `git status --porcelain | wc -l` AFTER all 8 commits — should
return 1 (the modified `.claude/settings.local.json`, which we
deliberately leave unstaged).*
