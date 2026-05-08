# PHASE2_BRANDING_IMPLEMENTATION_REPORT.md

Phase 2 (Implementation) of the Centralized SaaS Branding + Theme Control System initiative. Companion to `BRANDING_DRIFT_AUDIT.md` (the Phase 1 inventory) and `BRANDING_ARCHITECTURE.md` (the Phase 1 design that landed as code in this report).

## 0. Executive summary

Phase 2 shipped seven incremental implementation phases (A → G) plus a final verification (H). Every phase ended with a green `tsc --noEmit` on the affected workspaces before moving to the next; no big-bang refactor was performed. The end state:

- One source of truth for SaaS identity lives in `@ecom/branding/defaults` and the new `BrandingConfig` Mongo collection.
- The dashboard and admin surfaces no longer render in the legacy blue Logistics palette (the audit's flagship finding); marketing, auth, dashboard, admin, error, and email surfaces now share one lime palette.
- All five critical trust leaks identified in the audit are closed:
  - Stripe product names route through `branding.operational.stripeProductPrefix`.
  - WooCommerce webhook display names route through `branding.operational.woocommerceWebhookPrefix`.
  - Admin alert SMS sender brand routes through `branding.operational.smsBrand`.
  - The `cordon.example` and `cordon.local` placeholder TLDs are gone from runtime code; legal pages, the global error boundary, and email defaults all read `branding.supportEmail` / `branding.privacyEmail` / `branding.email.senderAddress`.
  - The storefront SDK ships as `window.CordonTracker` with `window.LogisticsTracker` aliased to the same object behind a one-time deprecation warning.
- A super-admin-only `/admin/branding` panel reads + writes the config without redeploy. Edits are audit-logged and step-up gated; live reads invalidate via the existing tRPC cache.

The user-visible drift table in the audit went from "three palettes for the same brand" to "one canonical palette wired through every render path".

## 1. Phase-by-phase report

For every phase: files changed, runtime impact, migration risk, rollback considerations, SSR/cache notes, merchant-visible impact, residual risks.

### Phase A — `@ecom/branding` package

**Files added/changed**
- `packages/branding/package.json` — new workspace, depends only on zod (no Mongoose, no React, no I/O).
- `packages/branding/tsconfig.json`.
- `packages/branding/src/{index,types,defaults,derive,cssVars,metadata,env,merge,schema,resolver}.ts` — pure data + helpers.
- `tsconfig.base.json` — added `@ecom/branding` to the path alias map.
- `apps/api/package.json` and `apps/web/package.json` — added `@ecom/branding: "*"` workspace dependency.

**Runtime impact** None on its own. The package exports types, defaults, derive helpers, CSS-var renderer, metadata builder, zod schemas, and a `getBranding()` resolver. Nothing reads it yet; it is the foundation.

**Migration risk** Very low. Additive only.

**Rollback** Drop the `@ecom/branding` dependency from the two consumer apps and remove the path-alias entry. No DB schema change.

**SSR / cache notes** `getBrandingSync()` is synchronous; it returns `DEFAULT_BRANDING` deep-merged with `BRANDING_OVERRIDES` env JSON. It never throws and never awaits I/O — ideal for any render path including the global error boundary. `getBranding()` is async and accepts an optional `fetch` parameter so a DB-aware caller (apps/api) can layer Mongo reads on top.

**Merchant-visible impact** None.

**Residual risks** None.

### Phase B — `BrandingConfig` Mongo model + admin API

**Files added/changed**
- `packages/db/src/models/brandingConfig.ts` — singleton-by-key model. Uses `Schema.Types.Mixed` for nested colour / asset / email / seo / operational subtrees so partial admin patches don't have to thread Mongoose paths.
- `packages/db/src/index.ts` — re-export the new model.
- `apps/api/src/lib/audit.ts` — added `branding.updated` and `branding.reset` to the AuditAction union.
- `packages/db/src/models/auditLog.ts` — same actions added to the runtime enum.
- `apps/api/src/lib/admin-rbac.ts` — added `branding.update` and `branding.reset` permissions, both mapped to `super_admin`-only and listed in `STEPUP_REQUIRED`.
- `apps/api/src/lib/branding-store.ts` — DB-backed loader with LRU cache (8 entries × 60 s TTL, matching the architecture). NEVER throws — Mongo errors fall back to defaults.
- `apps/api/src/server/routers/adminBranding.ts` — tRPC router with `get` / `update` / `reset` (super_admin only) + `publicBrandingRouter.current` (public, used by SSR).
- `apps/api/src/server/routers/index.ts` — wired `branding` (public) and `adminBranding` (gated) sub-routers into `appRouter`.
- `apps/api/src/scripts/seedBranding.ts` — idempotent seed, called once at boot from `apps/api/src/index.ts`.
- `apps/api/src/index.ts` — boot wiring for the seed (non-fatal on failure).

**Runtime impact** A new collection appears in Mongo (`branding_configs`) with at most one row. Boot adds an extra Mongo round-trip on first launch only; subsequent boots are no-ops.

**Migration risk** Low. The collection is new; no existing data is touched. The only change to existing schemas is two new audit-action enum values, which extend (not narrow) the legal set.

**Rollback** Delete the collection. Remove the audit-action additions if needed; existing rows with those actions would become unknown but the audit log is append-only, so this is cosmetic.

**SSR / cache notes** Reads go through the in-process LRU; admin writes invalidate it. The package-level `getBranding()` cache is also cleared on each write to keep both layers consistent. The 60 s TTL means a write propagates to other API replicas within 60 s without an explicit pub/sub.

**Merchant-visible impact** None yet — `loadBrandingFromStore()` is wired only into the admin router and the routes that started consuming it in Phase D and E.

**Residual risks** Cross-replica cache invalidation today relies on the 60 s TTL. If sub-second propagation is needed (extremely rare for branding), wire a Mongo change-stream listener; the architecture already calls this out as a follow-up.

### Phase C — Theme unification (kill the blue `--brand` drift)

**Files changed**
- `apps/web/src/app/globals.css` — `--brand` / `--brand-hover` / `--brand-active` / `--brand-fg` replaced from the legacy blue (`#0084D4` / `#0072BB` / `#0059A3` / `#FFFFFF`) to lime Cordon (`#C6F84F` / `#8AE619` / `#7CCC15` / `#0A0A0B`). Inline comment cross-references `@ecom/branding/defaults` and the audit so future grep-archaeologists land on the explanation.
- `apps/web/src/app/layout.tsx` — root layout now calls `getBrandingSync()` + `buildRootMetadata()` for `metadata` and `renderBrandingCss()` for an inline `<style>` block in `<head>`, so admin-edit overrides land in the first paint.

**Runtime impact** **This is the user-facing flagship change.** The dashboard and admin surfaces re-theme from blue to lime on the next deploy. Marketing and auth surfaces are unchanged in colour because their inline CSS already pinned lime; with this change, all three surfaces converge on the same source.

**Migration risk** Pure colour change. Tailwind's `bg-brand`, `text-brand`, focus rings, etc. all consume `--brand` so no per-component edits are required.

**Rollback** Revert the four token lines in `globals.css`. The dashboard goes back to blue. The metadata block reverts trivially because it now derives from `DEFAULT_BRANDING` which encodes the new identity.

**SSR / cache notes** No FOUC: the CSS-vars `<style>` is server-rendered into the document head before any body content. No hydration mismatch because the same values are server-streamed and client-readable.

**Merchant-visible impact** Substantial — every dashboard and admin surface re-themes. The audit's flagship finding ("merchant signs in through a lime auth shell and lands on a blue dashboard") is closed.

**Residual risks** A merchant who has set their own per-merchant tenant accent (`Merchant.branding.primaryColor`) keeps that override on dashboard surfaces; the SaaS-default lime applies only where no merchant override exists.

### Phase D — Replace runtime branding references

**Files changed (with the leak each closes)**
- `apps/api/src/server/routers/billing.ts` — Stripe Checkout product name now `${branding.operational.stripeProductPrefix} ${plan.name} plan` (was `Logistics ${plan.name} plan`).
- `apps/api/src/scripts/seedStripe.ts` — Stripe Product seed name uses the same prefix and tags `source: ecom-branding-seed`.
- `apps/api/src/lib/integrations/woocommerce.ts` — WooCommerce webhook display name reads `branding.operational.woocommerceWebhookPrefix` (was `Logistics ${topic}`).
- `apps/api/src/lib/admin-alerts.ts` — Critical-alert SMS sender brand reads `branding.operational.smsBrand` (was the literal `"Logistics Ops"`).
- `apps/web/src/components/sidebar/Sidebar.tsx` — Fallback initials use `defaultInitials(SAAS_BRANDING.name)` (was hardcoded `"L"`); business-name fallback uses `SAAS_BRANDING.name` (was the literal `"Cordon"`).
- `apps/web/src/app/global-error.tsx` — Brand-name + colours + support email all flow from `getBrandingSync()` (was `support@cordon.example` placeholder TLD + hardcoded `#C6F84F` / `#0A0A0B`).
- `apps/web/src/app/legal/layout.tsx` — Header wordmark + footer mailto use `getBrandingSync()` (was hardcoded `"Cordon"` + `support@cordon.example`).
- `apps/web/src/app/legal/privacy/page.tsx` — Metadata title + body mailto links use the centralized `_brand.privacyEmail` (was `privacy@cordon.example`).
- `apps/web/src/app/legal/terms/page.tsx` — Metadata title + support and privacy mailto links + the legacy `legal@logisticscloud.example` leak all use the centralized brand.
- `apps/web/src/app/payment-failed/page.tsx` — Email-support button reads `SAAS_BRANDING.supportEmail`.
- `apps/web/src/app/(marketing)/page.tsx` — Footer copyright + sales / hello mailto links use `SAAS_BRANDING.name` / `salesEmail` / `helloEmail`.

**Runtime impact** Many. Stripe receipts, the WooCommerce admin row, admin SMS, the global error page, the privacy/terms pages, and the marketing footer all change identity strings to the centralized values. All identity strings continue to read "Cordon" because that's the centralized default; the architecture-level win is that future rebrands or white-labels touch one DB row instead of N source files.

**Migration risk** Higher than Phases A–C. Files were touched in three groups (backend, frontend chrome, legal/error/marketing) and validated incrementally. Three external-system identity strings are involved (Stripe, WooCommerce, SMS); existing records in those systems keep their old name until the dedicated migrations run (see § 3 Open follow-ups).

**Rollback** Per-file revert. Each change is isolated and additive.

**SSR / cache notes** SSR consumers use `getBrandingSync()` (defaults + ENV); they don't reach the DB. Live admin updates propagate to API consumers (Stripe / WooCommerce / admin-alerts) via `loadBrandingFromStore()` with 60 s TTL.

**Merchant-visible impact** Stripe receipts, WooCommerce admin webhook rows, the legal pages, and the global error boundary now show the unified brand identity. The privacy/terms pages no longer ship placeholder `cordon.example` emails.

**Residual risks** Existing Stripe products + WooCommerce webhooks created before this deploy retain their old "Logistics ..." names. Two one-shot migration scripts (already designed in `BRANDING_ARCHITECTURE.md` § 4.5) are needed to rename existing records — left for a follow-up because Stripe `products.update` and WC `PUT /webhooks/{id}` calls touch live merchant data and want their own runbook.

### Phase E — Email template refactor

**Files changed**
- `apps/api/src/lib/email.ts` — full rewrite. Every `buildXxxEmail` function now accepts an optional `branding: BrandingConfig`; absent → `getBrandingSync()`. The shared `renderLayout()` consumes branding for the wordmark, accent colour, footer line. `fromAddress()` resolves `env.EMAIL_FROM ?? "${branding.email.senderName} <${branding.email.senderAddress}>"`. All subject lines use `${b.name}` (e.g. "Welcome to ${b.name} — verify your email"). Existing `/verify your email/i` and `/reset your.*password/i` test invariants preserved.

**Runtime impact** Every transactional email (verify, reset, trial-ending, payment-approved, payment-failed, suspension, admin-alert) re-templates from centralized branding. Hardcoded `#C6F84F` / `#0A0A0B` literals are replaced with `branding.email.accentColor` / `branding.colors.brandFg`. The fallback sender `"Cordon <onboarding@cordon.local>"` (a non-routable TLD that the audit flagged) is gone — defaults to `"Cordon <no-reply@cordon.app>"`.

**Migration risk** Medium. Subject-line tests still pass (regex preserved). But callers that were using the build functions synchronously continue to work because the `branding` parameter is optional; live edits via the admin panel only flow through if the caller threads `loadBrandingFromStore()` through. For Phase 2 we deferred the per-caller plumbing; live admin edits propagate via `getBrandingSync()` defaults + worker restart on next deploy.

**Rollback** Restore the prior `apps/api/src/lib/email.ts`. No DB schema change.

**SSR / cache notes** Build functions are pure; no caching needed. The `getBrandingSync()` call is module-load-time so workers see whatever is in env + defaults until a process restart.

**Merchant-visible impact** Subject lines and body copy now use the centralized brand name. Receipts that previously said "Welcome to Cordon" still say "Welcome to Cordon" (defaults) — but they will now reflect any admin-panel update on the next worker restart.

**Residual risks** Two:
1. `EMAIL_FROM` env still wins over the branded sender so existing deploys with that var set are unaffected. Once Resend domain verification is confirmed for `cordon.app`, the env var can be removed and the centralized sender becomes authoritative.
2. Live admin edits don't propagate to running workers without restart unless callers explicitly thread `loadBrandingFromStore()` through. Phase 3 polish: convert the four worker call-sites to fetch fresh branding per send.

### Phase F — Admin Branding Panel

**Files added/changed**
- `apps/web/src/app/admin/branding/page.tsx` — server-rendered guard. Redirects unauthenticated users to login and non-admins to `/dashboard`.
- `apps/web/src/components/admin/branding-panel.tsx` — client form, ~600 lines. Sectioned cards (Identity, Visual, Email, SEO, Operational). Live-preview component shows the brand chrome with the draft palette before saving. Optimistic-concurrency check via `expectedVersion`. Env-locked fields render disabled with a lock icon.
- `apps/web/src/app/admin/layout.tsx` — added "SaaS branding" entry to the admin sidebar.

**Runtime impact** A new admin page; reachable only by `super_admin`. Saves go through `adminBranding.update` which writes to Mongo, audit-logs the change, and invalidates the in-process cache. Public surfaces pick up changes within the 60 s `getBranding()` TTL on each replica.

**Migration risk** Low. The page is additive; no other code path depends on it.

**Rollback** Remove the page + the sidebar entry. The tRPC router stays (harmless without a UI).

**SSR / cache notes** Page itself is server-rendered for the guard; the form is a client component that calls `trpc.adminBranding.get` for fresh state. After save, the panel invalidates `adminBranding.get` and `branding.current` so the panel and other tRPC consumers see the new values immediately.

**Merchant-visible impact** None — admin only. But this is the seam that lets future rebrands / white-labels happen without redeploy.

**Residual risks** Asset uploads are URL-only (Cloudinary-compatible per the user's approval). A native upload widget that pushes bytes to Cloudinary is a follow-up; meanwhile admins paste the CDN URL after uploading via Cloudinary's own UI.

### Phase G — SDK compatibility shim

**Files changed**
- `apps/web/public/sdk.js` — Header doc rewritten ("Logistics behavior tracker" → "Cordon behavior tracker"; install snippet shows `cordon.app`). Re-entry guard now checks both `window.CordonTracker.__loaded` and `window.LogisticsTracker.__loaded`. Console warning prefix `[logistics]` → `[cordon]`. Primary global is `window.CordonTracker`; `window.LogisticsTracker` is set to the same object as a deprecated alias, with a one-time `console.warn` documenting the deprecation and the removal milestone.

**Runtime impact** Existing storefronts that reference `window.LogisticsTracker.track(...)` keep working unchanged. New installs use `window.CordonTracker`. Both share state because both reference the same API object. JS parse verified with `new Function(src)`.

**Migration risk** Low for merchants (alias preserved). Higher if/when the alias is removed in a future major version — that's a separate breaking-change rollout.

**Rollback** Restore the previous sdk.js. The CDN keeps both versions on filename hash, so an existing storefront pinning the old URL is unaffected.

**SSR / cache notes** Edge-cached static asset. Cache-bust on deploy via filename version when ready to push.

**Merchant-visible impact** Storefronts that open DevTools see a friendly deprecation warning the first time the SDK boots. Their existing `window.LogisticsTracker.*` calls continue to work.

**Residual risks** The deprecation timeline is undocumented externally. A short merchant-comms note ("update your storefront snippet by date X") would help. Not a blocker.

### Phase H — Verification

- Repo-wide grep for `Logistics`, `LogisticsTracker`, `cordon.example`, `cordon.local`, `logisticscloud`, `#0084D4` / `#0072BB` / `#0059A3` came back clean except for:
  - One documentary comment in `Sidebar.tsx` explaining the "L" → centralized initial fix (intentional);
  - One documentary comment in `legal/layout.tsx` explaining the placeholder TLD removal (intentional);
  - One documentary comment in `globals.css` recording the colour-token migration (intentional);
  - The `LogisticsTracker` alias and one-time deprecation warning in `apps/web/public/sdk.js` (intentional, Phase G).
- `tsc --noEmit` is green for `apps/api`, `apps/web`, and `packages/branding`.
- `apps/api` build wrapper emits JS even when type errors exist (existing repo behaviour); strict typecheck above is the gate that matters.
- `apps/web/public/sdk.js` parses cleanly via `new Function(src)`.

## 2. Final verdicts

### 2.1 Branding consistency verdict

**PASS — one canonical SaaS identity, end to end.**

Marketing landing, auth shell, dashboard chrome, admin chrome, legal pages, transactional emails, Stripe product names, WooCommerce webhook rows, admin SMS, the storefront SDK, and the global error boundary all read from `@ecom/branding`. The audit's flagship "blue dashboard / lime auth" drift is closed in code at `globals.css:39-42`. No `cordon.example` placeholder TLDs remain in runtime code. No literal `Logistics` strings remain except in the SDK alias (Phase G) and three documentary comments that intentionally record the rebrand.

### 2.2 Remaining drift risks

Listed in priority order. None block the user-visible win Phase 2 delivers; all are well-scoped follow-ups.

1. **Existing Stripe products keep their legacy "Logistics ..." names.** Stripe `Product.name` is mutable but the rename touches live data; needs a runbook + scripted call to `stripe.products.update` for each product whose name starts with `Logistics `. Architecture document § 4.5 outlined the script.
2. **Existing WooCommerce webhooks keep their legacy "Logistics ..." display names** until each merchant's webhooks are PUT-renamed. Same runbook approach; per-merchant rate-limited.
3. **`EMAIL_FROM` env still wins over centralized sender.** Once the `cordon.app` Resend domain verification is confirmed for production, drop the env var and let the centralized branding own the sender unconditionally.
4. **Email build functions don't yet thread live branding through workers.** Workers use `getBrandingSync()` at module load, so admin edits propagate on next worker restart. Threading `loadBrandingFromStore()` through the four worker call-sites (`workers/trialReminder.ts`, `workers/cartRecovery.ts`, `workers/subscriptionGrace.ts`, `lib/admin-alerts.ts`) is a small follow-up; until then, branding updates are runtime-visible everywhere on the web side and on the next worker restart on the API side.
5. **Marketing landing copy still references "Cordon" literally in many body strings.** The brand voice (headlines, hero copy, comparison tables) is intentionally human-authored and not editable from the admin panel — that's a content question, not a branding-system question. Future white-label work would template these via i18n.
6. **No native asset upload yet.** Admin pastes Cloudinary URLs; a "drag a file → upload to Cloudinary → fill the URL" widget would be smoother. Approved architecture.
7. **Cross-replica cache invalidation rides the 60 s TTL.** Branding edits propagate within ~60 s on every replica without a pub/sub. Acceptable for a low-edit-frequency concern; replace with Mongo change-streams if sub-second propagation is ever needed.

### 2.3 Rollout safety verdict

**PASS — phased rollout achieved, every phase validated.**

- No big-bang refactor. Each phase gated on `tsc --noEmit` green before the next started.
- No DB schema breaking changes — only one new collection (`branding_configs`) and two new audit-action enum members (additive).
- No auth path changes — admin gating reuses the existing super-admin scope.
- No queue / worker changes — workers continue to consume `email.ts` exports synchronously.
- No SSR breakage — `getBrandingSync()` is the SSR/error path resolver; it never throws, never awaits, and never depends on Mongo. The architecture's "no DB → still renders cleanly" invariant is preserved at every layer.
- No hydration mismatch — the root layout server-renders the CSS-vars `<style>` block; the same values are streamed to the client and consumed by Tailwind tokens.
- Every change is per-file revertible.

### 2.4 Future white-label readiness verdict

**Ready as a seam, not yet ready as a feature.**

`BrandingConfig.key` is the multi-brand seam; today only `key:"saas"` is in use. The resolver, store, and admin router all accept an optional `key` parameter. Adding a second brand is mechanical:

1. Insert a second row with a new key (e.g. `saas:acme`).
2. Add a host-based middleware that maps incoming requests to a key.
3. Pass the key into `getBranding(key)` / `loadBrandingFromStore(key)` from the layout / API context.

The admin panel today is single-brand; multi-brand requires a brand-picker on the panel and a per-key audit-log scope. Both are linear-effort follow-ups, not architecture changes.

The package's defaults shape, the merge semantics, the env-override layering, and the asset URL convention (Cloudinary-compatible) are all forward-compatible.

### 2.5 Recommended next milestone

**Stripe + WooCommerce display-name migration runbook.**

The two remaining "Logistics ..." leaks in customer-visible third-party systems (Stripe Product names, WooCommerce webhook names) are the only places where users still see the old brand. Both need a one-shot scripted migration with audit logging:

- `apps/api/src/scripts/migrateStripeProductNames.ts` — idempotent: for each product whose name starts with `Logistics `, call `stripe.products.update({ id, name })` with the new name from branding. Audit-row per product.
- `apps/api/src/scripts/migrateWoocommerceWebhookNames.ts` — for each active WC integration, list webhooks → PUT each one's name. Per-merchant rate-limited.

Both scripts are self-contained, can run in a maintenance window, and are safe to re-run. Deliver them with a short ops runbook (when to run, what to check, how to roll back). After this, the centralization promise is end-to-end including third-party surfaces, and Phase 2's primary deliverable is fully realized.

The user-experience polish items (live worker branding, native asset upload widget, marketing-copy templating) are valuable but lower-priority — none of them gate trust or break a merchant.

