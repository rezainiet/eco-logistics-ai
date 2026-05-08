---
title: Local Git State Audit (Pre-Redesign Stabilization)
generated_at: 2026-05-08
repo: ecommerce-logistics (monorepo)
---

# 1) Current branch / upstream

- Repo root: `ecommerce-logistics`
- Current branch: `claude/staging-deploy`
- Upstream: `origin/claude/staging-deploy`
- Divergence (per `git status --porcelain=v2 --branch`): `ahead +0 / behind -0` (no local commits pending push yet)

> Note: this means the local working tree has changes, but nothing has been committed locally in this branch since last sync.

# 2) Working tree summary

## Tracked changes (modified)

### Claude/local tooling
- `M .claude/settings.local.json` *(likely local-only; should not be pushed unless intentionally part of repo policy)*

### API (apps/api)
- `M apps/api/src/env.ts`
- `M apps/api/src/index.ts`
- `M apps/api/src/lib/admin-alerts.ts`
- `M apps/api/src/lib/audit.ts`
- `M apps/api/src/lib/email.ts`
- `M apps/api/src/lib/integrations/woocommerce.ts`
- `M apps/api/src/scripts/seedStripe.ts`
- `M apps/api/src/server/auth.ts`
- `M apps/api/src/server/ingest.ts`
- `M apps/api/src/server/routers/adminObservability.ts`
- `M apps/api/src/server/routers/analytics.ts`
- `M apps/api/src/server/routers/billing.ts`
- `M apps/api/src/server/routers/index.ts`
- `M apps/api/src/server/routers/orders.ts`
- `M apps/api/src/server/webhooks/integrations.ts`
- `M apps/api/tests/webhookIdempotencyDurability.test.ts`

### Web (apps/web)
- `M apps/web/next.config.mjs`
- `M apps/web/public/sdk.js`
- `M apps/web/src/app/(marketing)/page.tsx`
- `M apps/web/src/app/admin/layout.tsx`
- `M apps/web/src/app/dashboard/analytics/page.tsx`
- `M apps/web/src/app/dashboard/api/page.tsx`
- `M apps/web/src/app/dashboard/billing/page.tsx`
- `M apps/web/src/app/dashboard/fraud-review/page.tsx`
- `M apps/web/src/app/dashboard/integrations/issues/page.tsx`
- `M apps/web/src/app/dashboard/integrations/page.tsx`
- `M apps/web/src/app/dashboard/layout.tsx`
- `M apps/web/src/app/dashboard/orders/page.tsx`
- `M apps/web/src/app/dashboard/page.tsx`
- `M apps/web/src/app/dashboard/recovery/page.tsx`
- `M apps/web/src/app/dashboard/settings/page.tsx`
- `M apps/web/src/app/forgot-password/page.tsx`
- `M apps/web/src/app/globals.css`
- `M apps/web/src/app/layout.tsx`
- `M apps/web/src/app/legal/layout.tsx`
- `M apps/web/src/app/legal/privacy/page.tsx`
- `M apps/web/src/app/legal/terms/page.tsx`
- `M apps/web/src/app/payment-failed/page.tsx`
- `M apps/web/src/app/pricing/page.tsx`
- `M apps/web/src/app/verify-email/layout.tsx`
- `M apps/web/src/app/verify-email/page.tsx`
- `M apps/web/src/components/billing/dashboard-banners.tsx`
- `M apps/web/src/components/billing/subscription-banner.tsx`
- `M apps/web/src/components/billing/usage-overview.tsx`
- `M apps/web/src/components/dashboard/operational-banner.tsx`
- `M apps/web/src/components/feedback/system-status-pill.tsx`
- `M apps/web/src/components/integrations/system-status-panel.tsx`
- `M apps/web/src/components/onboarding/onboarding-checklist.tsx`
- `M apps/web/src/components/orders/book-shipment-dialog.tsx`
- `M apps/web/src/components/orders/tracking-timeline-drawer.tsx`
- `M apps/web/src/components/shell/cordon-auth-shell.tsx`
- `M apps/web/src/components/shell/notifications-drawer.tsx`
- `M apps/web/src/components/shell/topbar.tsx`
- `M apps/web/src/components/sidebar/Sidebar.tsx`

### DB package (packages/db)
- `M packages/db/src/index.ts`
- `M packages/db/src/models/auditLog.ts`
- `M packages/db/src/models/order.ts`
- `M packages/db/src/models/trackingSession.ts`

## Tracked deletions

- `D apps/web/src/app/dashboard/integrations/error.tsx`
- `D apps/web/src/app/dashboard/integrations/loading.tsx`
- `D apps/web/src/components/shell/account-shell.tsx`

## Untracked files (not yet versioned)

### DANGEROUS (credentials found)
- `?? .env.env.prod-backup-20260507-104950`
  - Contains MongoDB URI credentials, JWT secret, Shopify secrets, and Redis URL credentials.
  - **Must never be committed.** Keys/secrets should be treated as compromised if ever pushed.

### Likely intentional docs (high-volume)
- `?? AGENTS.md`
- `?? BRANDING_ARCHITECTURE.md`
- `?? BRANDING_DRIFT_AUDIT.md`
- `?? CANONICAL_PRODUCT_INTELLIGENCE_SUMMARY.md`
- `?? COMMIT_STRATEGY.md`
- `?? DATABASE_SCHEMA_MASTER.md`
- `?? DEPENDENCY_AND_RISK_MAP.md`
- `?? DESIGN_PARTNER_LAUNCH_REPORT.md`
- `?? DESIGN_PARTNER_READINESS_CHECKLIST.md`
- `?? ENTERPRISE_SETTINGS_REDESIGN_REPORT.md`
- `?? FEATURE_LOGIC_MASTER.md`
- `?? FRAUD_AND_INTELLIGENCE_ENGINE_MASTER.md`
- `?? FUTURE_EVOLUTION_GUIDE.md`
- `?? INFRASTRUCTURE_OVERVIEW.md`
- `?? INTEGRATION_ARCHITECTURE_MASTER.md`
- `?? INTEGRATION_WEBHOOK_MAP.md`
- `?? INTENT_INTELLIGENCE_VALIDATION_REPORT.md`
- `?? MERCHANT_FEATURES.md`
- `?? MONOREPO_SAAS_MASTER_AUDIT.md`
- `?? OPERATIONAL_PLAYBOOKS.md`
- `?? OPERATIONAL_RUNTIME_MASTER.md`
- `?? PHASE2_BRANDING_IMPLEMENTATION_REPORT.md`
- `?? POST_VALIDATION_OPERATIONAL_POLISH_REPORT.md`
- `?? PRE_PUSH_SECURITY_CHECKLIST.md`
- `?? PROJECT_ARCHITECTURE.md`
- `?? QUEUE_AND_WORKER_MASTER.md`
- `?? REPOSITORY_HYGIENE_AUDIT.md`
- `?? RTO_ENGINE_EXECUTION_ROADMAP.md`
- `?? RTO_PREVENTION_STRATEGY_MASTERPLAN.md`
- `?? SETTINGS_UX_AUDIT.md`
- `?? SYSTEM_ARCHITECTURE_MASTER.md`
- `?? USER_FLOW_MASTER.md`
- `?? WEB_APP_SURFACE_MAP.md`

### Likely noise / local backups (should NOT be committed unless explicitly desired)
- `?? apps/api/src/index.ts.new`
- `?? apps/api/src/lib/admin-rbac.ts.new`
- `?? apps/api/src/lib/audit.ts.new`
- `?? apps/web/src/components/sidebar/Sidebar.tsx.clean`

### Likely intentional new API modules/tests
- `?? apps/api/src/lib/address-intelligence.ts`
- `?? apps/api/src/lib/intent.ts`
- `?? apps/api/src/lib/operational-hints.ts`
- `?? apps/api/src/lib/thana-lexicon.ts`
- `?? apps/api/src/scripts/seedBranding.ts`
- `?? apps/api/src/server/routers/feedback.ts`
- `?? apps/api/src/server/services/intelligence/*`
- `?? apps/api/tests/address-intelligence.test.ts`
- `?? apps/api/tests/audit-funnel.test.ts`
- `?? apps/api/tests/feedback.test.ts`
- `?? apps/api/tests/intelligence-analytics.test.ts`
- `?? apps/api/tests/intent.test.ts`
- `?? apps/api/tests/operational-hints.test.ts`
- `?? apps/api/tests/rto-engine-passive.test.ts`
- `?? apps/api/tests/thana-extraction.test.ts`

### Likely intentional new Web routes/components (settings + misc)
- `?? apps/web/src/app/admin/branding/page.tsx`
- `?? apps/web/src/app/api/csp-report/route.ts`
- `?? apps/web/src/app/dashboard/settings/**`
- `?? apps/web/src/app/global-error.tsx`
- `?? apps/web/src/app/icon.svg`
- `?? apps/web/src/app/not-found.tsx`
- `?? apps/web/src/app/robots.ts`
- `?? apps/web/src/app/sitemap.ts`
- `?? apps/web/src/components/admin/branding-panel.tsx`
- `?? apps/web/src/components/billing/trial-savings-banner.tsx`
- `?? apps/web/src/components/dashboard/incident-banner.tsx`
- `?? apps/web/src/components/feedback/feedback-button.tsx`
- `?? apps/web/src/components/integrations/webhook-health-card.tsx`
- `?? apps/web/src/components/intelligence/rto-intelligence-section.tsx`
- `?? apps/web/src/components/onboarding/activation-moments.tsx`
- `?? apps/web/src/components/orders/intelligence-panels.tsx`
- `?? apps/web/src/components/orders/operational-hint-panel.tsx`
- `?? apps/web/src/components/orders/sample-orders-preview.tsx`
- `?? apps/web/src/components/settings/*`
- `?? apps/web/src/lib/use-visibility-interval.ts`

### Likely intentional new DB model
- `?? packages/db/src/models/merchantFeedback.ts`

# 3) Generated artifacts / build outputs

- No build outputs (`dist/`, `build/`, `.next/`, `coverage/`, `node_modules/`) are currently listed by `git status`, indicating they are either absent or correctly ignored.

# 4) Line ending / EOL risk

- Git emits repeated warnings of the form: `LF will be replaced by CRLF the next time Git touches it`
- Local setting observed: `core.autocrlf=true`
- Risk: cross-platform churn / noisy diffs if EOL policy isn’t consistent across contributors.

# 5) Safety findings (action required before any commit/push)

1. **Secrets present in untracked `.env.env.prod-backup-20260507-104950`**
   - Must be ignored immediately (and never staged).
2. **Local agent config file appears tracked and modified (`.claude/settings.local.json`)**
   - Must decide: revert to HEAD (preferred) vs intentionally commit changes.
3. **Local backup artifacts (`*.new`, `*.clean`) present**
   - Must either delete or add ignore rules so they never get staged accidentally.

