# BRANDING_DRIFT_AUDIT.md

Phase 1 of the Centralized SaaS Branding + Theme Control System initiative. This document is a read-only inventory of every place SaaS-level brand identity is hardcoded, inconsistent, or stale across the Cordon monorepo. It is the input to `BRANDING_ARCHITECTURE.md`; no code is changed in Phase 1.

Canonical brand for the rest of this document: **Cordon** (per repo `CLAUDE.md`). Anything labelled "Logistics" is treated as drift from a prior rebrand that was not finished.

## 0. Scope and what's deliberately out of scope

This audit covers SaaS-level identity — the chrome that says "this is Cordon": product name, sender name, support email, primary brand colour, logo mark, public meta, email shells, legal/footer copy.

A separate per-merchant tenant-branding feature already exists in `apps/web/src/components/branding/` (BrandingProvider + BrandingSection + `merchants.updateBranding` tRPC mutation). That subsystem lets each merchant upload their own logo and accent for their tracking page and their own dashboard chrome. It is correct and out of scope for the centralized work; the new architecture must coexist with it without conflict (see `BRANDING_ARCHITECTURE.md` § Coexistence).

## 1. Top-line summary

| Category | Count | Worst offender |
| --- | --- | --- |
| Critical trust leaks (visible to merchants/customers/3rd parties) | 7 distinct surfaces | `apps/web/public/sdk.js` — public storefront SDK still branded "Logistics" with `window.LogisticsTracker` global |
| Runtime-visible drift (visible inside the app shell) | 6 distinct surfaces | `apps/web/src/app/globals.css:31-33` — dashboard `--brand` token is the OLD blue `#0084D4` while marketing/auth render in lime `#C6F84F` |
| Hidden/internal leaks (logs, ops alerts, dev defaults) | 4 occurrences | `apps/api/src/lib/admin-alerts.ts:225` — admin SMS sender brand `"Logistics Ops"` |
| Stale copy/placeholder branding | 5 occurrences | `support@cordon.example` placeholder shipped to live legal pages and the global error boundary |
| Duplicated config / parallel sources of truth | 4 systems | Three independent palettes: `globals.css`, `landing.module.css`, `cordon-auth-shell.tsx` |

**Single most damaging finding.** `globals.css` defines the dashboard's `--brand` token as the old blue Logistics brand colour `#0084D4`, while the marketing landing and the auth shell define their own lime-Cordon palette inline. Result: a merchant sees a lime-Cordon landing page, signs in through a lime-Cordon auth shell, and lands on a blue-Logistics dashboard. That is the textbook theme drift this initiative is meant to eliminate.

## 2. Critical trust leaks

These are visible to merchants, their customers, or third-party platforms (Stripe, WooCommerce, mail clients). They erode trust the moment a buyer or admin sees them.

### 2.1 Storefront SDK still branded "Logistics" — `apps/web/public/sdk.js`

| Field | Value |
| --- | --- |
| File:line | `apps/web/public/sdk.js:3,6,8,10,28,50,382` |
| What leaks | JSDoc header says "Logistics behavior tracker", install snippet says `https://logistics.example.com/sdk.js`, `window.LogisticsTracker` is the documented public global, console warnings emit `[logistics]` |
| Who sees it | Every merchant who installs the script tag on their storefront. Every shopper who opens DevTools on a Cordon-monitored store. Every Cordon support agent helping a merchant debug. |
| Severity | **Critical** — directly breaks the rebrand promise; would have to change `window.LogisticsTracker` to `window.CordonTracker` carefully because merchants may reference it in their own scripts |

### 2.2 Stripe products created as "Logistics …" — `apps/api/src/server/routers/billing.ts:275`

| Field | Value |
| --- | --- |
| File:line | `apps/api/src/server/routers/billing.ts:275` (`productName: \`Logistics ${plan.name} plan\``) and `apps/api/src/scripts/seedStripe.ts:83` (`name: \`Logistics ${plan.name}\``) |
| What leaks | Stripe Checkout receipts, the customer portal, and the merchant's bank statement line all show "Logistics Pro plan" / "Logistics Team plan". Stripe `Product.name` is also visible to Stripe's anti-fraud and tax-jurisdiction tooling. |
| Who sees it | Every paying merchant, on every receipt and every renewal. |
| Severity | **Critical** — financial documents with the wrong brand are the highest-trust surface possible; also means the existing Stripe `product` records are mis-named in production |

### 2.3 WooCommerce webhook names registered as "Logistics …" — `apps/api/src/lib/integrations/woocommerce.ts:248`

| Field | Value |
| --- | --- |
| File:line | `apps/api/src/lib/integrations/woocommerce.ts:248` (`name: \`Logistics ${topic}\``) |
| What leaks | When a merchant lands on WooCommerce → Settings → Advanced → Webhooks, the rows that Cordon registered show as "Logistics order.created", "Logistics order.updated", etc. |
| Who sees it | Every WooCommerce merchant, every time they audit their integrations or get a question from their own developer. |
| Severity | **Critical** — appears inside the merchant's own admin, on a row attributed to us |

### 2.4 Two competing "Cordon" support-email domains — multiple files

| Field | Value |
| --- | --- |
| File:line | Real domain `cordon.app`: `apps/web/src/app/(marketing)/page.tsx:891,987`, `apps/web/src/app/payment-failed/page.tsx:91`. Placeholder domain `cordon.example`: `apps/web/src/app/global-error.tsx:84`, `apps/web/src/app/legal/layout.tsx:44`, `apps/web/src/app/legal/terms/page.tsx:52,118`, `apps/web/src/app/legal/privacy/page.tsx:161,228-229` |
| What leaks | Half the app tells the user to email `support@cordon.app` (real domain). The other half — including the privacy policy and the terms of service — tells them to email `support@cordon.example` (RFC 2606 reserved placeholder TLD; emails sent there go nowhere). |
| Who sees it | Every customer reading the privacy policy or terms (including Shopify Partner reviewers). Every user hitting the global error boundary. |
| Severity | **Critical** — Shopify's app-store reviewers explicitly check that the contact email "actually exists"; the privacy-policy page comment at `apps/web/src/app/legal/privacy/page.tsx:21-23` even acknowledges this is a placeholder that must be updated before go-live |

### 2.5 Admin alert SMS branded "Logistics Ops" — `apps/api/src/lib/admin-alerts.ts:225`

| Field | Value |
| --- | --- |
| File:line | `apps/api/src/lib/admin-alerts.ts:225` (`{ brand: "Logistics Ops", tag: \`admin_alert_${alert.kind}\` }`) |
| What leaks | The SMS sender label/brand on every critical platform alert sent to admin phones. |
| Who sees it | Internal admins (limited blast radius), but it is the brand on text messages that the company itself is sending. |
| Severity | **High** — internal-only, but signals that the rebrand was incomplete |

### 2.6 Email "From" default uses fake `cordon.local` TLD — `apps/api/src/lib/email.ts:37`

| Field | Value |
| --- | --- |
| File:line | `apps/api/src/lib/email.ts:37` (`return env.EMAIL_FROM ?? "Cordon <onboarding@cordon.local>";`) |
| What leaks | If `EMAIL_FROM` is not set in production, every transactional email goes out from `Cordon <onboarding@cordon.local>` — a non-routable TLD. Resend will likely reject or quarantine; replies will bounce. |
| Who sees it | Worst-case: every signup, password reset, trial-ending warning, payment-approved, payment-failed, suspension email. |
| Severity | **High** — guarded by an env var that must be set, but the default is unsafe and only one missed deploy away from being live |

### 2.7 Subscription/billing-failure email subjects hardcode "Cordon" — `apps/api/src/lib/email.ts`

| Field | Value |
| --- | --- |
| File:line | `apps/api/src/lib/email.ts:138, 153, 172, 217, 240` (subjects: "Welcome to Cordon — verify your email", "Reset your Cordon password", "Your Cordon trial ends in N days", "Action required — your Cordon payment failed", "Your Cordon workspace is suspended") |
| What leaks | Subject lines and body copy treat "Cordon" as a literal string, repeated across every transactional template. Every rebrand from now on requires touching the email template code. |
| Who sees it | Every merchant who receives any transactional email. |
| Severity | **High** today (correct brand); structural risk for any future rebrand or white-label |

## 3. Runtime-visible drift inside the authenticated app

These are the surfaces a logged-in merchant or admin sees every working day. They drift because three separate palettes exist and only two of them say "Cordon".

### 3.1 Dashboard `--brand` token still set to old blue Logistics colour — `apps/web/src/app/globals.css:31-33`

| Field | Value |
| --- | --- |
| File:line | `apps/web/src/app/globals.css:31-33` (`--brand: 202 100% 41%; /* #0084D4 */`, `--brand-hover: 204 100% 37%; /* #0072BB */`, `--brand-active: 207 100% 32%; /* #0059A3 */`) |
| What's wrong | This is the global token consumed by every `bg-brand`, `text-brand`, focus ring, badge, and primary button on `/dashboard/*` and `/admin/*`. It is the **OLD blue Logistics colour**, not Cordon lime `#C6F84F`. The CLAUDE.md note about the rebrand explicitly says the blue palette was deleted, but the CSS token survived. |
| Conflict | `apps/web/src/components/shell/cordon-auth-shell.tsx:55-58` overrides `--brand` to lime under `.cordon-auth`. `apps/web/src/app/(marketing)/landing.module.css:22` uses lime `#C6F84F` under `.cordonPage`. The dashboard and admin have neither override and inherit blue. |
| Who sees it | Every merchant on `/dashboard`, every admin on `/admin`. Every working day. |
| Severity | **Critical runtime** — this is the single change that would re-unify the SaaS visual identity |

### 3.2 Three independent palettes for the same brand

| Surface | Source of truth | Brand colour |
| --- | --- | --- |
| Dashboard / admin | `apps/web/src/app/globals.css:11-65` | Blue `#0084D4` (drift) |
| Marketing landing | `apps/web/src/app/(marketing)/landing.module.css:12-26` | Lime `#C6F84F` |
| Auth (login/signup/forgot/reset/verify) | `apps/web/src/components/shell/cordon-auth-shell.tsx:34-71` | Lime `#C6F84F` |
| Email templates | `apps/api/src/lib/email.ts:106,115` | Lime `#C6F84F` (inline hex) |
| Global error boundary | `apps/web/src/app/global-error.tsx:35,71-72,84,102-103` | Lime `#C6F84F` (inline hex) |

There are at least 25 occurrences of the literal hex `#C6F84F` across `apps/web` and `apps/api`. Any future colour change requires hunting them all down by hand.

### 3.3 Sidebar fallback initial is hardcoded `"L"` (for "Logistics") — `apps/web/src/components/sidebar/Sidebar.tsx:132`

| Field | Value |
| --- | --- |
| File:line | `apps/web/src/components/sidebar/Sidebar.tsx:132` (`.join("") || "L"`) and `apps/web/src/components/branding/branding-section.tsx:320` (`"L"`) |
| What's wrong | When no merchant business name is available, the sidebar tile and branding preview render the letter "L" — a relic of "Logistics". Should fall back to "C" for Cordon, or better, the centralized `nameInitials`. |
| Severity | **Visible** to every new merchant before they fill in their business name |

### 3.4 Sidebar wordmark fallback is `"Cordon"` literal — `apps/web/src/components/sidebar/Sidebar.tsx:154`

| Field | Value |
| --- | --- |
| File:line | `apps/web/src/components/sidebar/Sidebar.tsx:154` (`{businessName ?? "Cordon"}`) |
| What's wrong | Hardcoded; correct today, but the SaaS name should come from a single config source so a rebrand or white-label only touches one place. |
| Severity | **Latent** drift risk |

### 3.5 Auth shell tagline "Built for Bangladesh's COD economy" — `apps/web/src/components/shell/cordon-auth-shell.tsx`

The tagline is hardcoded inside the shell across the value-column markup (lines around 192). Same story for the verify-email and verify-email-sent body copy.

### 3.6 Marketing landing footer "© Cordon. Built in Dhaka." — `apps/web/src/app/(marketing)/page.tsx:1038`

Hardcoded company-line; not editable from anywhere.

## 4. Hidden/internal leaks (logs, ops, dev defaults)

These don't reach a merchant, but they make ops harder and are part of the SaaS identity surface.

| File:line | Leak |
| --- | --- |
| `apps/api/src/lib/email.ts:60-63` | Dev fallback log line is correct (`[email:dev]`); no brand drift, but it's the place to thread a centralized brand short-name through for log searchability |
| `apps/web/public/sdk.js:50` | `console.warn("[logistics] tracking key or collector missing")` — internal but visible in any merchant's browser console |
| `apps/api/src/lib/intent.ts:218` | Helpful-error string says "where the Cordon SDK is not installed" — hardcoded SDK product name |
| `apps/api/src/server/services/intelligence/campaignClassification.ts:3` | Code comment says "Cordon's four user-facing campaign …"; comment-only but reflects the lack of a single source of truth |

## 5. Stale copy and placeholders

| File:line | Issue |
| --- | --- |
| `apps/web/src/app/legal/privacy/page.tsx:21-23` | Comment explicitly says "Update the placeholder values (company legal name, support email, physical address …) before flipping the app to production." — never done |
| `apps/web/src/app/legal/privacy/page.tsx:161,228-229` | `privacy@cordon.example` (placeholder TLD) — see § 2.4 |
| `apps/web/src/app/legal/terms/page.tsx:52,118` | `support@cordon.example`, `privacy@cordon.example` — same |
| `apps/web/src/app/legal/layout.tsx:44` | Footer prints `support@cordon.example` with the year |
| `apps/web/src/app/global-error.tsx:84` | Global crash page tells the user to email `support@cordon.example` |
| `apps/web/public/sdk.js:6,8` | Install snippet uses example domains `https://logistics.example.com/sdk.js` and `api.logistics.example.com` — needs a real CDN domain or at minimum `cordon.app`/`cordon.example.com` consistency |

## 6. Duplicated config / parallel sources of truth

1. **Three palettes** for the same brand (`globals.css` vs `landing.module.css` vs `cordon-auth-shell.tsx`). See § 3.2.
2. **No centralized SaaS-name constant.** The string "Cordon" appears 143 times across `apps/web/src` + `apps/api/src` (and reaches into `metadata.title`, every email subject, the legal pages, the marketing landing, the sidebar, and a defensive comment block in the intelligence package).
3. **No centralized support-email constant.** Two distinct domains (`cordon.app`, `cordon.example`) are used interchangeably across at least 11 separate locations (§ 2.4).
4. **OpenGraph / Twitter / metadata.** `apps/web/src/app/layout.tsx:55-87` defines the canonical SaaS metadata (title template `%s · Cordon`, applicationName `Cordon`, OG/Twitter title, description, siteName `Cordon`). Per-page metadata (e.g. `apps/web/src/app/legal/privacy/page.tsx:3-7`) re-hardcodes the brand. There is no helper that composes "page title" + "centralized SaaS name".
5. **No centralized public asset.** `apps/web/public/` contains only `sdk.js` — no `favicon.ico`, no `og.png`, no Apple touch icon, no PWA manifest. The metadata block doesn't even reference a `metadata.icons` or `metadata.openGraph.images` array.

## 7. Inventory by surface

For the architecture phase, here is the canonical list of touchpoints that the centralized branding system must serve.

### Frontend — public marketing
- Landing page hero, headlines, body copy, CTA emails, footer (`apps/web/src/app/(marketing)/page.tsx`)
- Marketing palette (`apps/web/src/app/(marketing)/landing.module.css`)
- Pricing page (`apps/web/src/app/pricing/page.tsx`)
- Legal pages (`apps/web/src/app/legal/{privacy,terms}/page.tsx`)
- Legal shell header + footer (`apps/web/src/app/legal/layout.tsx`)
- Marketing-side exit-intent + ROI calculator components reference brand voice (`apps/web/src/app/(marketing)/_components/*.tsx`)
- Robots / sitemap / `metadataBase` (`apps/web/src/app/layout.tsx`, `robots.ts`, `sitemap.ts`)

### Frontend — auth surfaces
- `(auth)/login`, `(auth)/signup`, `forgot-password`, `reset-password`, `verify-email`, `verify-email-sent`, `payment-success`, `payment-failed` — all wear `CordonAuthShell` (`apps/web/src/components/shell/cordon-auth-shell.tsx`) plus per-page copy

### Frontend — dashboard / admin chrome
- Dashboard topbar, sidebar wordmark + logo tile (`apps/web/src/components/sidebar/Sidebar.tsx`, `apps/web/src/components/shell/topbar.tsx`)
- Mobile bottom nav (`apps/web/src/components/dashboard/mobile-bottom-nav.tsx`)
- Empty states ("Welcome to Cordon" copy in `apps/web/src/components/onboarding/*`)
- Notifications drawer header (`apps/web/src/components/shell/notifications-drawer.tsx`)
- Help button copy (`apps/web/src/components/shell/help-button.tsx`)
- Onboarding checklist + activation moments (`apps/web/src/components/onboarding/*`)
- Global error boundary (`apps/web/src/app/global-error.tsx`)
- Not-found page (`apps/web/src/app/not-found.tsx`)
- Per-route `metadata` (every layout)
- Trust strip + dashboard hero copy (`apps/web/src/components/dashboard/trust-strip.tsx`, `apps/web/src/components/onboarding/dashboard-hero.tsx`)

### Frontend — public tracking page
- Tracking page (`apps/web/src/app/track/[code]/...`) is per-merchant branded today — leaves the centralized SaaS branding only on the very small "powered by Cordon" surface. Confirm in Phase 2 whether to surface a centralized "powered by" line.

### Backend — emails
- All transactional templates in `apps/api/src/lib/email.ts:99-296` (layout, verify, password reset, trial-ending, payment-approved, payment-failed, subscription-suspended, admin-alert)
- The `fromAddress()` default at `apps/api/src/lib/email.ts:37`

### Backend — third-party integrations
- Stripe product names (`apps/api/src/server/routers/billing.ts:275`, `apps/api/src/scripts/seedStripe.ts:83`)
- WooCommerce webhook display names (`apps/api/src/lib/integrations/woocommerce.ts:248`)
- Stripe Checkout success/cancel URLs are already env-driven; OK
- SMS sender brand for admin alerts (`apps/api/src/lib/admin-alerts.ts:225`)
- Future: Twilio "from" identity, Resend "From" name, OG image hosted asset

### Backend — public surfaces
- Storefront SDK (`apps/web/public/sdk.js`) — global name, install snippet, console-prefix, header
- Helpful-error strings that name "Cordon SDK" (`apps/api/src/lib/intent.ts:218`)

### Backend — logs and operational copy
- `[logistics]` console-warn prefix in the SDK
- Log lines / SMS bodies / email subjects that prefix with the brand short-name

## 8. Risk callouts that the architecture must answer

Items the next phase has to address — not findings per se, but constraints discovered during the audit.

1. **`window.LogisticsTracker` is a public-API name change.** Existing merchant storefronts may reference `window.LogisticsTracker.track(...)` directly. The rename to `window.CordonTracker` needs an alias period and release notes; it is not a silent change.
2. **Stripe `Product.name` is mutable but historical.** Renaming the product in Stripe updates all future receipts but does not retroactively rename old invoices. The fix should include a one-shot migration script that calls `stripe.products.update`.
3. **Resend domain verification.** Switching `EMAIL_FROM` to a verified `cordon.app` sender requires DNS (SPF, DKIM, DMARC) at the same time. Don't ship the sender change without confirming the domain is verified in Resend.
4. **WooCommerce webhook names are immutable from our side.** WooCommerce's `PUT /webhooks/{id}` accepts a `name` change; existing merchants need a one-pass rename worker, not just a code change for new merchants.
5. **Tenant branding must keep working.** The merchant-level branding (`apps/web/src/components/branding/`) injects `--brand` overrides on top of the global token. The new centralized SaaS palette has to be the global default, AND merchant overrides must still cascade on top of it without conflict. Architecture must specify the cascade order (SaaS default → merchant override → component-level override).
6. **No favicon, no OG image.** The metadata block at `apps/web/src/app/layout.tsx:55-87` does not declare `metadata.icons` or `metadata.openGraph.images`. Centralizing branding has to include shipping default assets and a path for admin uploads to override them.
7. **SSR considerations.** Most of the surfaces are server-rendered (metadata.ts, email templates run on the API, legal pages are RSC). The branding source must be reachable at SSR time without a tRPC round-trip, which the architecture document covers under "Server-side resolver".
8. **Cache considerations.** `BrandingProvider` already uses a 60s `staleTime`. The centralized SaaS branding will be much hotter (every SSR); the architecture proposes a per-process LRU + a Mongo change-stream / pub-sub invalidation channel.
9. **Email rendering is synchronous.** `apps/api/src/lib/email.ts:99-126` builds inline HTML at call time. The branding lookup path used in workers must be cached and SSR-safe (a worker process boot must not crash if Mongo is briefly unreachable; a baked-in fallback is mandatory).
10. **Admin RBAC already exists.** `apps/api/src/lib/admin-rbac.ts` defines `super_admin | finance_admin | support_admin` scopes. Branding edits should be gated behind a dedicated `branding_admin` scope (or simply `super_admin`); the architecture chooses the right granularity.

## 9. What's NOT in this audit

- Per-merchant branding (`apps/web/src/components/branding/*`) — already centralized for that scope.
- Tailwind utility tokens (`bg-fg-muted`, `text-fg-faint` etc.) that are not brand-colour but design-system layout tokens. Those are fine.
- Test fixtures in `apps/api/tests/` that use placeholder emails (`admin@a.com`, `help@acme.test`) — test-only, no runtime impact.
- ADR / docs / `*_REPORT.md` files at the repo root that mention "Logistics" historically. They are historical artefacts; updating them is documentation hygiene, not a runtime concern.

## 10. Cross-reference: every file with hardcoded SaaS branding

For Phase 2 traceability. 46 distinct files in `apps/web/src` and `apps/api/src` contain at least one hardcoded "Cordon" / brand-colour / brand-email / brand-domain literal. The full list is enumerated under the categories above; the most-referenced files are:

| File | Brand-related occurrences |
| --- | --- |
| `apps/api/src/lib/email.ts` | ~30 (layout, every template, sender default) |
| `apps/web/src/app/(marketing)/page.tsx` | ~20 (every section header, mailto links, footer) |
| `apps/web/src/components/shell/cordon-auth-shell.tsx` | ~15 (palette CSS + JSX wordmark) |
| `apps/web/src/app/global-error.tsx` | 8 (palette + mailto) |
| `apps/web/src/app/legal/{layout,privacy,terms}.tsx` | 11 (mailto, footer, body) |
| `apps/web/src/app/(marketing)/landing.module.css` | ~25 (palette + brand voice) |
| `apps/web/public/sdk.js` | 7 ("Logistics" leftover) |
| `apps/api/src/server/routers/billing.ts` | 1 (`Logistics ${plan.name} plan`) |
| `apps/api/src/scripts/seedStripe.ts` | 1 (`Logistics ${plan.name}`) |
| `apps/api/src/lib/integrations/woocommerce.ts` | 1 (`Logistics ${topic}`) |
| `apps/api/src/lib/admin-alerts.ts` | 1 (`Logistics Ops`) |

The full set is enumerated in § 2 / § 3 / § 5 / § 7 above and ready to be converted into a refactor checklist in Phase 2.

## 11. Severity-ranked top-10 fix list (input to Phase 2)

1. Add `BrandingConfig` Mongo model + server resolver + safe baked-in defaults (architecture doc).
2. Replace `globals.css:31-33` blue tokens with a centralized lime palette (unifies dashboard with marketing/auth).
3. Rename Stripe products from "Logistics …" to centralized SaaS-name + run a one-shot `stripe.products.update` migration.
4. Rebrand the storefront SDK: rename `window.LogisticsTracker` → `window.CordonTracker` with a 1-release alias, fix install snippet domains and the JSDoc header.
5. Fix the WooCommerce webhook display name and add a one-shot worker that PUTs the new name on every existing webhook.
6. Resolve the `cordon.app` vs `cordon.example` split — centralized `supportEmail`, `privacyEmail`, etc., wired through legal pages, error boundary, and email layouts.
7. Replace the `EMAIL_FROM` default `Cordon <onboarding@cordon.local>` with the centralized `senderFromAddress` and require Resend domain verification before shipping.
8. Replace the three palettes with one source of truth (CSS variables fed from BrandingConfig or its baked-in defaults).
9. Ship default favicon + OG image + apple touch icon + manifest under `apps/web/public/`, wired into root metadata.
10. Add the admin Branding Panel under `/admin/branding` gated by RBAC, with image upload, colour pickers, live preview.

End of audit. Architecture in `BRANDING_ARCHITECTURE.md`. Phase-2 verification report `POST_BRANDING_UNIFICATION_REPORT.md` is intentionally **not** generated yet — it requires Phase-2 implementation work to verify against.
