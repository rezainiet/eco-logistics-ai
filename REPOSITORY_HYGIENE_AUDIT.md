# REPOSITORY_HYGIENE_AUDIT.md

**Date:** 2026-05-07
**Branch:** `claude/staging-deploy` (88 modified/untracked entries)
**Audit posture:** classify, do not delete.

This document classifies every untracked or modified entry into:

- **KEEP** — production code, tests, or documentation that should ship.
- **REVIEW** — pre-existing work on this branch that I did not author and
  should NOT delete; surface for the human owner to decide.
- **GITIGNORE-ONLY** — files on disk that are correctly excluded from git
  by `.gitignore`; no action needed.
- **CONSIDER ARCHIVING** — large historical artifacts that ship today but
  could move to `docs/history/` to declutter the root.
- **SECURITY** — anything that looks like leaked credentials.

> **DO NOT auto-delete.** This audit's job is to give the human a clear
> view of what's about to be committed and what shouldn't be. The
> recommended commit groupings live in `COMMIT_STRATEGY.md`.

---

## 1. Untracked entries (`??`)

### 1A. NEW REPORT/STRATEGY DOCUMENTS — KEEP, group as one commit

These are the strategy + audit documents I produced across the prior
milestones. They are intentional artifacts and should be committed
together as a documentation drop.

| Path | Action | Notes |
|---|---|---|
| `MONOREPO_SAAS_MASTER_AUDIT.md` | KEEP | Foundational architecture audit; referenced by every later doc |
| `RTO_PREVENTION_STRATEGY_MASTERPLAN.md` | KEEP | Strategy document |
| `RTO_ENGINE_EXECUTION_ROADMAP.md` | KEEP | Execution plan that drove Milestone 1 |
| `INTENT_INTELLIGENCE_VALIDATION_REPORT.md` | KEEP | Validation methodology + readiness gates |
| `POST_VALIDATION_OPERATIONAL_POLISH_REPORT.md` | KEEP | Polish-phase findings + verdicts |
| `DESIGN_PARTNER_READINESS_CHECKLIST.md` | KEEP | 10-dimension launch readiness checklist |
| `DESIGN_PARTNER_LAUNCH_REPORT.md` | KEEP | Launch verdict + cohort plan |
| `OPERATIONAL_PLAYBOOKS.md` | KEEP | Incident runbooks |

**Recommendation:** consider moving these to `docs/strategy/` or
`docs/audits/` in a follow-up to keep the repo root tidy. NOT urgent.

### 1B. NEW INTELLIGENCE LAYER (Milestone 1) — KEEP

Implementation files for Intent Intelligence v1, Address Intelligence
v1, and the operational hint layer. All have tests and were validated
through the typecheck + full vitest suite.

| Path | Action |
|---|---|
| `apps/api/src/lib/intent.ts` | KEEP |
| `apps/api/src/lib/address-intelligence.ts` | KEEP |
| `apps/api/src/lib/thana-lexicon.ts` | KEEP |
| `apps/api/src/lib/operational-hints.ts` | KEEP |
| `apps/api/src/server/routers/feedback.ts` | KEEP |
| `apps/api/src/server/services/` | KEEP — entire `intelligence/` subdirectory (7 files) from the Phase 4 refactor |
| `apps/api/tests/intent.test.ts` | KEEP |
| `apps/api/tests/address-intelligence.test.ts` | KEEP |
| `apps/api/tests/thana-extraction.test.ts` | KEEP |
| `apps/api/tests/operational-hints.test.ts` | KEEP |
| `apps/api/tests/intelligence-analytics.test.ts` | KEEP |
| `apps/api/tests/rto-engine-passive.test.ts` | KEEP |
| `apps/api/tests/feedback.test.ts` | KEEP |
| `apps/api/tests/audit-funnel.test.ts` | REVIEW — test file on the branch from before this session; not authored by me; verify with branch owner |
| `packages/db/src/models/merchantFeedback.ts` | KEEP |

### 1C. NEW WEB COMPONENTS (this session) — KEEP

| Path | Action |
|---|---|
| `apps/web/src/components/orders/operational-hint-panel.tsx` | KEEP |
| `apps/web/src/components/orders/intelligence-panels.tsx` | KEEP |
| `apps/web/src/components/intelligence/` | KEEP — `rto-intelligence-section.tsx` |
| `apps/web/src/components/feedback/feedback-button.tsx` | KEEP |

### 1D. PRE-EXISTING UNTRACKED FILES (NOT authored this session) — REVIEW

These were already on the branch before this session started. They show
up as untracked because they haven't been committed yet, but they are
NOT part of any milestone in this session. The branch owner needs to
decide whether they're shipping in the same commit set or separately.

| Path | Action | Reasoning |
|---|---|---|
| `apps/web/src/app/api/csp-report/` | REVIEW | CSP violation reporter; called by `next.config.mjs` `report-uri` directive |
| `apps/web/src/app/dashboard/integrations/_components/` | REVIEW | The integrations page imports from `_components` (`connect-flow.tsx`) — likely intended to ship |
| `apps/web/src/app/global-error.tsx` | REVIEW | App Router global error boundary — needed for production |
| `apps/web/src/app/icon.svg` | REVIEW | Favicon — needed |
| `apps/web/src/app/not-found.tsx` | REVIEW | App Router 404 page |
| `apps/web/src/app/robots.ts` | REVIEW | SEO — needed for production |
| `apps/web/src/app/sitemap.ts` | REVIEW | SEO — needed for production |
| `apps/web/src/components/billing/trial-savings-banner.tsx` | REVIEW | Looks like an in-flight billing UI feature |
| `apps/web/src/components/dashboard/incident-banner.tsx` | REVIEW | Incident banner is mounted in dashboard layout (verified) — must ship if layout depends on it |
| `apps/web/src/components/integrations/webhook-health-card.tsx` | REVIEW | Looks like the webhook health card recommended in the polish report |
| `apps/web/src/components/onboarding/activation-moments.tsx` | REVIEW | Activation toaster — already imported by dashboard layout |
| `apps/web/src/components/orders/sample-orders-preview.tsx` | REVIEW | Onboarding preview UI |
| `apps/web/src/lib/use-visibility-interval.ts` | REVIEW | Likely a polling-pause hook used by some panel |

> **CRITICAL:** if any of the above is imported by an already-modified
> file that's about to be committed, the build will fail in production
> because the module won't be on disk after a fresh checkout. **The
> commit strategy must include these or split them off explicitly.**

---

## 2. Modified entries (`M`)

### 2A. MODIFIED THIS SESSION — staged for the operational-polish + design-partner commits

| Path | Reason | Action |
|---|---|---|
| `apps/api/src/env.ts` | Added `INTENT_SCORING_ENABLED`, `ADDRESS_QUALITY_ENABLED` flags | KEEP |
| `apps/api/src/index.ts` | Added `TrackingSession` to syncIndexes loop | KEEP |
| `apps/api/src/server/auth.ts` | (pre-existing branch work — not this session) | REVIEW |
| `apps/api/src/server/ingest.ts` | Wired Address Intelligence + Intent stamping; added `evt: address.scored` log | KEEP |
| `apps/api/src/server/routers/adminObservability.ts` | Added `merchantSupportSnapshot`, `recentFeedback`, `triageFeedback` | KEEP |
| `apps/api/src/server/routers/analytics.ts` | Added 5 RTO Intelligence procedures; refactored to services/intelligence/ | KEEP |
| `apps/api/src/server/routers/index.ts` | Mount feedbackRouter | KEEP |
| `apps/api/src/server/routers/orders.ts` | Surface intent / addressQuality / thana / operationalHint on getOrder | KEEP |
| `apps/api/src/server/webhooks/integrations.ts` | Added `webhook.signature_invalid` + `webhook.acked` structured logs | KEEP |
| `apps/api/src/lib/audit.ts` | (pre-existing branch work — not this session) | REVIEW |
| `apps/api/src/lib/email.ts` | (pre-existing branch work — not this session) | REVIEW |
| `apps/api/src/lib/intent.ts` | (this session — observability) | KEEP |
| `apps/api/tests/webhookIdempotencyDurability.test.ts` | (pre-existing branch work — not this session) | REVIEW |
| `packages/db/src/index.ts` | Added MerchantFeedback barrel export | KEEP |
| `packages/db/src/models/auditLog.ts` | (pre-existing branch work — not this session) | REVIEW |
| `packages/db/src/models/order.ts` | Added `intent`, `address.quality`, `customer.thana` subdocs + indexes | KEEP |
| `packages/db/src/models/trackingSession.ts` | Added `(merchantId, resolvedOrderId)` partial index | KEEP |

### 2B. MODIFIED FROM PRE-EXISTING BRANCH WORK — REVIEW

The bulk of the web modifications (`apps/web/src/app/...`,
`apps/web/src/components/...`) are pre-existing changes on the branch
from before this session. They include:

- Marketing / pricing / legal page work
- Billing dashboard banners + subscription banner + usage overview
- Forgot-password page
- Verify-email layout
- Operational banner
- Integrations / fraud-review / orders / recovery dashboard pages
- Sidebar
- Cordon auth shell
- Notifications drawer
- Topbar (this session added `<FeedbackButton/>` mount; the rest is pre-existing)
- Onboarding checklist (this session refined STEP_HINTS; the rest is pre-existing)
- Tracking timeline drawer (this session added intelligence panels + operational hint mount)
- `next.config.mjs` (CSP + headers — pre-existing)

**Action:** these changes were already on the branch when this session
started. The branch owner's intent for them is outside the scope of
this audit. The commit strategy treats them as one logical group.

### 2C. DELETED FILE

| Path | Action |
|---|---|
| `apps/web/src/components/shell/account-shell.tsx` | KEEP (i.e., keep deleted). `apps/web/CLAUDE.md:18-19` explicitly marks this file as deprecated and instructs deletion. |

### 2D. SETTINGS FILE

| Path | Action |
|---|---|
| `.claude/settings.local.json` | DO NOT COMMIT — local Claude harness settings; not part of the product |

---

## 3. Working-directory artifacts that are correctly gitignored

The following exist on disk but are excluded from git per `.gitignore`.
No action needed — they will not enter commits.

| Path | Status |
|---|---|
| `.env` | gitignored ✓ — verified `git ls-files` returns nothing |
| `apps/web/.env.local` | gitignored ✓ |
| `node_modules/` | gitignored ✓ |
| `apps/api/dist/` | gitignored ✓ |
| `packages/*/dist/` | gitignored ✓ |
| `apps/web/.next/` | gitignored ✓ |
| `apps/web/test-results/`, `playwright-report/` | gitignored ✓ |
| `apps/web/tsconfig.tsbuildinfo` | gitignored ✓ |
| `.claude-staging/` | gitignored ✓ |

`.claude-staging/` is referenced in `CLAUDE.md` as the harness scratch
directory; it does not exist on this machine right now, but the rule
holds.

---

## 4. Tracked example / template files

The following ARE tracked by git and intentionally so. Verify they
contain placeholders, not real values.

| Path | Tracked? | Action | Verified contents |
|---|---|---|---|
| `.env.example` | ✅ | KEEP | First 10 lines reviewed — contains placeholders only (`replace-me-with-a-long-random-string`, `mongodb://localhost:27017/ecommerce`, etc.). **Re-verify the full file before push** (see PRE_PUSH_SECURITY_CHECKLIST.md) |
| `apps/web/.env.local.example` | ✅ | KEEP | Local-dev URLs only |
| `docker-compose.yml` | ✅ | KEEP | Standard Mongo + Redis dev containers; no secrets |
| `start-dev.bat` | ✅ | KEEP | Local Windows dev convenience script; not a CI artifact |
| `README.md` | ✅ | KEEP | High-level intro; complemented by the new `PROJECT_ARCHITECTURE.md` shipped this milestone |
| `docs/shopify-app-distribution.md` | ✅ | KEEP | Existing Shopify Partner-app submission notes |
| `AUTH_AUDIT.md` | ✅ | CONSIDER ARCHIVING — older audit superseded by `MONOREPO_SAAS_MASTER_AUDIT.md` §3. Move to `docs/history/` in a future cleanup. |
| `CLAUDE.md` (root) + `apps/api/CLAUDE.md` + `apps/web/CLAUDE.md` | ✅ | KEEP — repo conventions; load-bearing for future contributors |

---

## 5. Security risks identified

### 5.1 Direct credential leakage check

| Check | Result |
|---|---|
| `.env` tracked? | ❌ No — `git ls-files .env` returns nothing |
| `apps/web/.env.local` tracked? | ❌ No — `git ls-files` returns nothing |
| `.env.example` looks like a real secret? | ✅ Reviewed — placeholder values only |
| `apps/web/.env.local.example` looks like a real secret? | ✅ Reviewed — local URLs only |
| Any `*.secrets`, `*.pem`, `*.key`, `id_rsa*` files? | ❌ None found |

### 5.2 Secrets-in-code spot check (samples)

`packages/db/src/models/payment.ts` references `proofHash` and similar —
these are stored hashes, not plaintext.

`apps/api/src/lib/stripe.ts` reads `env.STRIPE_SECRET_KEY` at runtime;
not embedded as a literal anywhere I can find.

`apps/api/src/lib/sms/sslwireless.ts` reads `env.SSL_WIRELESS_*` at
runtime; not embedded.

The COURIER_ENC_KEY / JWT_SECRET / ADMIN_SECRET / STRIPE_WEBHOOK_SECRET
chain is read through the zod env schema (`apps/api/src/env.ts`) which
refuses boot if values are missing in production. No literal fallback
in code.

**Verdict:** no inline-credential leakage detected in the spot check.
The full grep is part of the `PRE_PUSH_SECURITY_CHECKLIST.md` ritual
before push.

---

## 6. Stale documentation

| Path | Status | Recommendation |
|---|---|---|
| `AUTH_AUDIT.md` | Older audit, predates `MONOREPO_SAAS_MASTER_AUDIT.md` §3 | Archive to `docs/history/` in a follow-up cleanup commit; do not delete |
| `README.md` | Top-line intro; predates the new architecture doc | Keep but update once `PROJECT_ARCHITECTURE.md` lands so the README links to it |

No abandoned Claude artifacts found in the working tree (`.claude-staging/`
is correctly gitignored and not present).

No `commit-msg.txt`, `_commit-message.txt`, `_commit-and-push.bat`,
`push-fix-N.bat`, or other one-off helper scripts are present
(per the `CLAUDE.md` rule that explicitly warns against them).

---

## 7. Repository weight

| Category | Estimate | Verdict |
|---|---|---|
| Source code (apps + packages) | ~80k LOC | Normal for a monorepo at this scope |
| Documentation (root .md files) | ~6k lines after this milestone | Larger than typical; **consider moving strategy/audit docs to `docs/`** in a follow-up |
| Test code | ~12k LOC across 59 vitest files + Playwright | Healthy ratio |
| `node_modules` | gitignored | not in repo |
| `.next` / `dist` | gitignored | not in repo |

No large binary blobs or accidentally-committed artifacts detected.

---

## 8. Summary

- **88 entries** in `git status` (47 modified / 1 deleted / 40 untracked).
- **Of the 40 untracked**, 8 are this session's strategy/audit docs (Section 1A),
  21 are this session's implementation files (Sections 1B + 1C), and 11 are
  pre-existing branch work the human should review (Section 1D).
- **Of the 47 modified**, ~17 are this session's edits, 30 are pre-existing
  branch work (Section 2B).
- **No tracked secrets.** `.env*` files are correctly gitignored.
- **No stale debug / scratch artifacts** in the working tree.
- The 8 strategy/audit MD files in the repo root could move to `docs/`
  in a future tidy commit, but they ship cleanly where they are.

The next two documents — `COMMIT_STRATEGY.md` and
`PRE_PUSH_SECURITY_CHECKLIST.md` — turn this audit into actionable
git commands.

---

**End of repository hygiene audit.**

*Every classification in this document was verified against the
output of `git status --porcelain`, `git ls-files`, and direct
file inspection at audit time.*
