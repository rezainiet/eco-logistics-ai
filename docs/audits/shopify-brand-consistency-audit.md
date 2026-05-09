# Brand consistency audit (Shopify-submission scope)

**Generated:** 2026-05-09
**Branch:** `claude/staging-deploy`
**Scope:** sweep for legacy "Cordon" residue, missing brand assets,
inconsistent ConfirmX naming. Read-only audit; user-visible fixes
applied inline.
**Method:** grep across the live app surfaces (`apps/web/src/`,
`apps/api/src/`, `packages/`), inspection of `apps/web/public/`,
cross-reference against `packages/branding/src/defaults.ts`.

---

## 0. TL;DR

**Three classes of "Cordon" residue exist:**

1. **User-visible rendered text.** Three instances; **all three
   fixed in this pass.** Marketing-page SVG label, two doc-comments
   that operators may copy out of (`email.ts`, `admin-alerts.ts`).
2. **Internal CSS class names + storage keys + file names**
   (`.cordon-card`, `cordon:incident:dismissed`, `cordon-auth-shell.tsx`).
   Not visible to users or reviewers in normal use; rename is high-
   touch and out of submission scope. Defer.
3. **Doc-comments and historical audit markdowns.** Documentation
   only. Not rendered. Safe to leave; serves as historical context
   for the rebrand.

**One critical brand-asset gap remains** (already documented in
prior audits, not engineering territory): `apps/web/public/brand/`
is missing all images. See §3.

---

## 1. User-visible Cordon residue (FIXED in this pass)

| # | Location | What was visible | Fix |
|---|---|---|---|
| 1 | `apps/web/src/app/(marketing)/page.tsx:612` | Literal `cordon` text inside the network-graph SVG on the marketing landing page (centre node of the cross-merchant signal viz). Visible to every visitor on the homepage. | Changed to `confirmx`. |
| 2 | `apps/api/src/lib/email.ts:27` | Doc-comment example `"Cordon · STAGING"`. Operators may copy the literal into a staging `EMAIL_FROM`. | Updated comment to `"ConfirmX · STAGING"`. |
| 3 | `apps/api/src/lib/admin-alerts.ts:225` | Doc-comment claim that the default SMS brand is `"Cordon Ops"`. Actual code reads `branding.operational.smsBrand`, which `defaults.ts` defines as `"ConfirmX Ops"` — comment was stale. | Updated comment to match the actual default. |

All three are simple text edits. No semantic / runtime changes.

## 2. Internal "Cordon" residue (DEFERRED — not user-facing)

These show up in grep but are not visible to users or Shopify
reviewers in normal app use. Renaming is high-mechanical-risk and
provides no review benefit.

### 2.1 CSS class names

The auth shell and marketing landing use a `cordon-` class prefix
for visual styling tokens. Renaming would touch:
- `apps/web/src/components/shell/cordon-auth-shell.tsx` — the
  injected `<style dangerouslySetInnerHTML>` block defines
  `.cordon-auth`, `.cordon-card`, `.cordon-serif`, `.cordon-pulse`,
  `.cordon-arrow`, `.cordon-logo-dot`, `.cordon-eyebrow`.
- `apps/web/src/app/(auth)/{login,signup}/page.tsx`,
  `verify-email{,-sent}/page.tsx`, `reset-password/page.tsx` — all
  apply `cordon-card`, `cordon-serif`, `cordon-arrow`, `cordon-pulse`.
- `apps/web/src/app/(marketing)/landing.module.css` — `.cordonPage`
  wrapper + `:global()` rules.
- `apps/web/src/app/(marketing)/page.tsx` — `id="cordon-nav"`
  targeted by inline JS (`document.getElementById('cordon-nav')`).
- `apps/web/src/app/(marketing)/page.tsx` — `<footer
  className="cordon-footer">`.

**Risk of rename:** four files coupled, JS DOM-targeting, CSS-module
hashing semantics. **Reviewer impact:** zero — DevTools class names
are not part of any review checklist.

### 2.2 LocalStorage keys

`apps/web/src/components/dashboard/incident-banner.tsx:51` —
`cordon:incident:dismissed:<hash>`. Internal localStorage key for
banner-dismissal state. Visible only via DevTools Application tab.
Renaming would invalidate every existing merchant's dismissed-banner
state, surfacing dismissed banners again. **Defer.**

### 2.3 File names + identifiers

- `apps/web/src/components/shell/cordon-auth-shell.tsx` (file).
- Component name `CordonAuthShell`.
- Multiple `import { CordonAuthShell }` statements across auth/legal
  layouts.

The `apps/web/CLAUDE.md` § Auth shell calls out `CordonAuthShell` as
the canonical shell. File-name + symbol rename is mechanical but
high-touch. **Defer.**

### 2.4 Doc-comments

Many `// Cordon ...` comments across:
`trial-savings-banner.tsx` (×3), `dashboard/page.tsx` (×1),
`dashboard/orders/page.tsx` (×1), `dashboard/layout.tsx` (×1),
`dashboard-banners.tsx` (×1), `cordon-auth-shell.tsx` (×3),
`packages/branding/src/{metadata,schema,env}.ts` (×3),
`apps/api/src/lib/thana-lexicon.ts` (×1),
`apps/api/src/server/services/intelligence/campaignClassification.ts` (×1).

Internal documentation. **Defer.** Cosmetic.

### 2.5 Root-level historical markdowns

50+ markdown files at the repo root (`MONOREPO_SAAS_MASTER_AUDIT.md`,
`RTO_PREVENTION_STRATEGY_MASTERPLAN.md`,
`BRANDING_ARCHITECTURE.md`, etc.) reference "Cordon" as the
historical product name. These are pre-existing strategy docs not
read by reviewers. **Out of scope.**

## 3. Brand assets — `apps/web/public/`

**Critical gap, already documented in prior audits, requires
design/ops work.**

### 3.1 What exists

```
apps/web/public/
└── sdk.js                      ← only file in /public
apps/web/src/app/
├── icon.svg                    ← Next.js auto-favicon (32×32 SVG)
└── ... (no apple-icon, no opengraph-image)
```

The Next.js `icon.svg` convention auto-serves a basic favicon. That
covers the `<link rel="icon">` slot but nothing else.

### 3.2 What `packages/branding/src/defaults.ts` references

| URL | File | Status |
|---|---|---|
| `/brand/logo.svg` | `apps/web/public/brand/logo.svg` | MISSING |
| `/brand/logo-mono.svg` | `apps/web/public/brand/logo-mono.svg` | MISSING |
| `/favicon.ico` | `apps/web/public/favicon.ico` | MISSING (covered partially by `icon.svg` auto-route) |
| `/apple-touch-icon.png` | `apps/web/public/apple-touch-icon.png` | MISSING |
| `/og.png` | `apps/web/public/og.png` | MISSING |
| `https://confirmx.ai/brand/email-logo.png` | external CDN | MISSING (URL doesn't resolve until ConfirmX site ships) |

### 3.3 Where the assets render

| Asset | Renders at | Failure mode if missing |
|---|---|---|
| `/brand/logo.svg` | Anywhere `<Image src={branding.assets.logo.url}>` is used | Broken-image icon. Currently the auth shell + sidebar use a CSS dot + wordmark instead — so the logo URL is referenced in branding config but not actually used in any rendered image element. Risk: low. |
| `/favicon.ico` | Browser tab icon. Most browsers fall back to `/icon.svg` from Next.js auto-route when `.ico` is absent. | Tab uses `icon.svg` (works) — but a few legacy crawlers still poll `/favicon.ico` and would 404. |
| `/apple-touch-icon.png` | iOS home-screen pin | iOS uses a generic web preview placeholder. |
| `/og.png` | Social-share preview (Slack, LinkedIn, Twitter, Facebook) | Preview shows title + description but no image. |
| `email-logo.png` | Header of every transactional email | Broken image in inbox; subject + content still readable. |

### 3.4 Severity

**SHOPIFY-REVIEW IMPACT:** medium. Reviewers test the install flow
and look at the rendered dashboard; broken images in transactional
emails (signup verification, password reset) leave a sloppy
impression. The OG image only matters for social sharing — outside
the review path.

**OPS IMPACT:** higher. First-impression for every new merchant.

**RECOMMENDATION:** ship six asset files before the distribution
flip. None require code changes — this is a design/ops drop into
`apps/web/public/`.

| File | Spec | Priority |
|---|---|---|
| `apps/web/public/brand/logo.svg` | Vector wordmark, dark-bg compatible | P1 |
| `apps/web/public/brand/logo-mono.svg` | Single-colour fallback | P2 |
| `apps/web/public/favicon.ico` | 16×16, 32×32 multi-size .ico | P2 (covered by `icon.svg` for modern browsers) |
| `apps/web/public/apple-touch-icon.png` | 180×180 PNG | P2 |
| `apps/web/public/og.png` | 1200×630 PNG, brand wordmark + tagline | P1 |
| `apps/web/public/brand/email-logo.png` | 240×60 PNG, white-bg compatible (email clients darken-mode invert it badly otherwise) | P1 |

Once the `email-logo.png` ships at the ConfirmX domain (`https://confirmx.ai/brand/email-logo.png`), the `defaults.ts` URL resolves; no code change.

## 4. Coverage check — ConfirmX naming consistency

| Surface | Renders "ConfirmX" correctly? | Anchor |
|---|---|---|
| Marketing landing wordmark | Yes (post-fix on §1.1) | `(marketing)/page.tsx:612` (now `confirmx`) and elsewhere |
| Auth shell wordmark | Yes — explicit `<span>ConfirmX</span>` | `cordon-auth-shell.tsx:163,183` |
| Trial-savings banner copy | Yes — `"ConfirmX has saved you ৳…"` | `trial-savings-banner.tsx:83` |
| Onboarding hero / checklist | Yes — derives from `branding.operational.dashboardWelcomeCopy` which defaults to `"ConfirmX confirms every COD order before it ships..."` | `defaults.ts:99` |
| Email templates | Yes — `branding.email.senderName = "ConfirmX"`, `replyTo = "support@confirmx.ai"` | `defaults.ts:71-73` |
| SDK console prefix | `[confirmx]` | `defaults.ts:101` |
| SMS sender brand | `"ConfirmX Ops"` | `defaults.ts:103` |
| Stripe product prefix | `"ConfirmX"` | `defaults.ts:104` |
| WooCommerce webhook prefix | `"ConfirmX"` | `defaults.ts:105` |
| Tagline | `"Confirm every COD order before it ships"` | `defaults.ts:27` |
| OG image alt | `"ConfirmX — confirm every COD order before it ships"` | `defaults.ts:63` |
| Privacy / Terms pages | Use `branding.legalName` placeholder (`"ConfirmX Technologies Ltd."` until brand-ops replaces) | `defaults.ts:26` |
| Page metadata template | `"%s · ConfirmX"` | `defaults.ts:81` |

**Net: ConfirmX naming is consistent across all merchant-facing
copy and metadata. The only remaining rendered placeholder is
`legalName`, captured as F2 in `shopify-production-gap-matrix.md`.**

## 5. Manifest / PWA / metadata posture

`apps/web/src/app/layout.tsx` builds Next Metadata via
`buildRootMetadata(_branding, ...)` from `@ecom/branding`. The
metadata.icons array, openGraph.images, and per-page title template
all flow from `defaults.ts`.

Not currently shipped:
- Web app manifest (`/site.webmanifest` or `/manifest.webmanifest`)
- PWA assets

Web app manifest is **NOT** required for Shopify review (we're an
external app). Defer post-approval.

## 6. Findings table

| # | Finding | Severity | Action | Status |
|---|---|---|---|---|
| B1 | Marketing page literal `cordon` SVG label | HIGH (visible to every visitor) | Replace with `confirmx` | FIXED |
| B2 | `email.ts:27` doc-comment `"Cordon · STAGING"` | LOW (operator-copy risk) | Update comment | FIXED |
| B3 | `admin-alerts.ts:225` stale-default comment | LOW (operator-copy risk) | Update comment | FIXED |
| B4 | `apps/web/public/brand/` directory missing six asset files | MEDIUM (review impression) | Brand/ops drop-in (no code) | OPEN — see §3.4 |
| B5 | `legalName` placeholder | BLOCKING | Brand/ops replace | OPEN — F2 in gap matrix |
| B6 | CSS class names `.cordon-*` (~10 distinct) | LOW (DevTools-only) | Rename post-approval | DEFERRED |
| B7 | LocalStorage key `cordon:incident:dismissed:*` | LOW (DevTools-only) | Migration planned post-approval | DEFERRED |
| B8 | `cordon-auth-shell.tsx` filename + `CordonAuthShell` symbol | LOW (internal) | Rename post-approval | DEFERRED |
| B9 | Multi-file doc-comments referencing "Cordon" | LOW (not rendered) | Sweep post-approval | DEFERRED |
| B10 | Web app manifest absent | LOW (not required) | Post-approval polish | DEFERRED |

## 7. Verification

- `grep -r "[Cc]ordon" apps/web/src apps/api/src packages` after
  fix: only internal CSS class names, file names, and doc-comments
  remain. No rendered text references "Cordon".
- `apps/web` typecheck: clean (no symbol rename was applied).
- `apps/api` build typecheck: clean.

The rendered-text fixes are pure string replacements; no rebuild
of any compiled artifact needed. Hot-reload picks up the marketing
SVG change immediately.
