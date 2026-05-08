# BRANDING_ARCHITECTURE.md

Phase 1 architecture proposal for the Centralized SaaS Branding + Theme Control System. This document is the design Claude will implement once you sign off; nothing is built yet. Companion to `BRANDING_DRIFT_AUDIT.md`.

Decisions already locked (from the kickoff Q&A):

- Canonical brand name: **Cordon**.
- Storage: **MongoDB via Mongoose**, with **baked-in defaults** as a fallback if the DB is briefly unavailable.
- Phasing: audit + architecture first; pause for sign-off; implement after.
- Admin auth: **reuse the existing `apps/api/src/lib/admin-rbac.ts` system**; we add a new `branding_admin` permission instead of inventing a parallel guard.

## 1. Goals and non-goals

**Goals**
1. One source of truth for SaaS-level identity: name, taglines, colour palette, logo, favicon, OG image, support contacts, sender identity, legal-page company name, dashboard chrome, email shells.
2. Editable from `/admin/branding` without redeploy, by an admin with the right scope.
3. SSR-safe, email-safe, worker-safe, browser-safe; no hydration mismatch; no DB outage takes down the marketing landing.
4. Forwards-compatible with future white-label / multi-brand (we ship a stable `BrandSelector` seam now even though we only have one brand record today).
5. Coexists with the existing per-merchant tenant-branding subsystem (`apps/web/src/components/branding/`) without conflict.

**Non-goals**
- This system does **not** replace per-merchant branding. Merchants keep uploading their own logo and accent for their tracking page and their own dashboard chrome.
- This system does not own design-system layout tokens (`--surface-*`, `--fg-*`, spacing). Those stay in `globals.css`.
- This system does not handle internationalisation copy beyond a single short tagline. Long-form marketing copy stays in JSX.
- No user-facing customisation: only admins can change SaaS branding.

## 2. Data model

A new collection in `packages/db`: `BrandingConfig`. Singleton today — exactly one document, identified by `key: "saas"`. Storing as a document (not env vars) is the call we made in the kickoff.

### 2.1 Schema (target file: `packages/db/src/models/brandingConfig.ts`)

```ts
export interface BrandingConfigDoc {
  _id: ObjectId;
  // Primary key. Always "saas" today; future white-label brands could be
  // "saas:tenant-xyz". Keep it indexed and unique so the resolver can
  // always do a single getOrCreate-by-key.
  key: "saas" | string;

  // Core identity ----------------------------------------------------------
  name: string;                       // "Cordon"
  legalName: string;                  // "Cordon Technologies Ltd."
  tagline: string;                    // "Stop bleeding RTO"
  shortTagline?: string;              // Used in email <h1> footer line
  productCategory?: string;           // "the order operations OS for…"
  defaultLocale: string;              // "en_BD" — feeds OG locale, robots
  homeUrl: string;                    // canonical https URL
  statusPageUrl?: string;
  termsUrl: string;                   // /legal/terms by default
  privacyUrl: string;
  supportUrl?: string;                // helpdesk URL, distinct from email

  // Contacts ---------------------------------------------------------------
  supportEmail: string;               // "support@cordon.app"
  privacyEmail: string;               // "privacy@cordon.app"
  salesEmail?: string;
  helloEmail?: string;
  noReplyEmail: string;               // sender for transactional mail

  // Visual ---------------------------------------------------------------
  // Colours stored as 6-digit hex; the resolver converts to HSL/RGB.
  colors: {
    brand: string;                    // "#C6F84F" (lime)
    brandHover: string;               // "#8AE619"
    brandActive?: string;             // optional; derive when missing
    brandFg: string;                  // foreground on brand bg ("#0A0A0B")
    accent?: string;                  // secondary accent
    surfaceBase: string;              // "#0A0A0B"
    fg: string;                       // "#FAFAFA"
  };

  // Asset references — Mongo stores URLs; the asset bytes live wherever the
  // app already stores user-uploaded assets (data-URL on first launch, then
  // S3/Cloudflare R2 once provisioned). Keep both shapes so the admin panel
  // can either upload bytes (small files only, embedded as data URL) or set
  // a URL directly.
  assets: {
    logo: { url: string; widthPx?: number; heightPx?: number; alt?: string };
    logoDark?: { url: string };       // optional dark-bg variant
    logoMono?: { url: string };       // monochrome lockup for emails
    favicon: { url: string };         // .ico or .png 32x32
    appleTouchIcon?: { url: string };
    ogImage: { url: string; width: number; height: number };
    twitterImage?: { url: string };
    emailLogo?: { url: string };      // typically same as logoMono for email
  };

  // Email branding -------------------------------------------------------
  email: {
    senderName: string;               // "Cordon"
    senderAddress: string;            // alias of noReplyEmail; expressed for clarity
    replyTo?: string;
    footer: string;                   // "© Cordon · Built for Bangladesh's COD economy"
    accentColor?: string;             // override of colors.brand for emails
    ctaTextDefault: string;           // "Get started"
    supportLine: string;              // "Need a hand? Reply to this email."
  };

  // SEO / social --------------------------------------------------------
  seo: {
    metaTitleTemplate: string;        // "%s · Cordon"
    metaTitleDefault: string;         // "Cordon — stop bleeding RTO"
    metaDescription: string;
    keywords: string[];
    twitterHandle?: string;           // "@cordonhq"
    ogSiteName: string;               // "Cordon"
  };

  // Operational --------------------------------------------------------
  operational: {
    onboardingWelcomeCopy: string;    // dashboard hero copy
    dashboardWelcomeCopy: string;     // empty-orders state, etc.
    sdkGlobalName: string;            // "CordonTracker" (renamed from LogisticsTracker)
    sdkConsolePrefix: string;         // "[cordon]"
    smsBrand: string;                 // "Cordon Ops"
    stripeProductPrefix: string;      // "Cordon"
    woocommerceWebhookPrefix: string; // "Cordon"
  };

  // Audit / housekeeping ---------------------------------------------
  version: number;                    // monotonically incremented on every write
  updatedBy?: ObjectId;               // Merchant._id of the admin
  updatedAt: Date;
  createdAt: Date;
  // Optional environment-override: a single ENV with the JSON of overrides
  // takes precedence at runtime. Set to true if at least one ENV override
  // was applied at boot — surfaced in /admin/branding so admins know the
  // panel is read-only for those fields.
  envOverridesApplied?: string[];     // names of overridden fields
}
```

Notes:
- All fields are *required at runtime* via merge with the baked-in defaults; the schema doesn't make them all `required: true` so partial updates from the admin panel are valid.
- Adding `brandingConfig` to the existing `packages/db/src/index.ts` `export * from` list keeps the import contract unchanged.

### 2.2 Audit-log integration

Every successful write to `BrandingConfig` enqueues an entry in the existing `AuditLog` collection (`packages/db/src/models/auditLog.ts`) with `action: "branding.update"`, `actor: <admin user id>`, `meta: { changedFields: [...], previousVersion, nextVersion }`. We do **not** store the full diff (could include base64 logos); just the field names. This rides on the existing super-admin audit chain so the existing `/admin/audit` page surfaces it for free.

### 2.3 Migration

A single seed runs at startup: if no document with `key: "saas"` exists, insert one populated entirely from the baked-in defaults. The seed is idempotent and ships in `apps/api/src/scripts/seedBranding.ts` plus a one-line call from the existing boot path.

## 3. Runtime architecture

### 3.1 Resolver stack (one diagram, in text)

```
┌──────────────────────────┐
│ apps/web SSR / Email     │     env-var override JSON
│ render / Worker process  │     (BRANDING_OVERRIDES)
└──────────┬───────────────┘                │
           │                                ▼
           │              ┌───────────────────────────────┐
           ├─────────────►│ getBranding()                 │
           │              │ packages/branding/src/index.ts│
           │              └───────────┬───────────────────┘
           │                          │
           │           cache hit      │       cache miss
           │             ◄────────────┤────────────►
           │                          │
           │                          ▼
           │              ┌─────────────────────────┐
           │              │ Mongo BrandingConfig    │
           │              │ findOne({ key:"saas" }) │
           │              └─────────────────────────┘
           │                          │
           │                          ▼ on read failure
           │              ┌─────────────────────────────────┐
           │              │ Baked-in defaults               │
           │              │ packages/branding/src/defaults  │
           │              └─────────────────────────────────┘
           │
           ▼
       resolved
       BrandingConfig
       (deep-merged: defaults → DB → env overrides)
```

The resolver always returns a complete, valid `BrandingConfig`. It cannot throw on a render path. The resolver is the single import everything else uses.

### 3.2 New package: `packages/branding`

A new sibling to `packages/db` and `packages/types`:

```
packages/branding/
  package.json                  # @ecom/branding
  tsconfig.json
  src/
    index.ts                    # export everything below
    defaults.ts                 # baked-in default Cordon palette + copy
    resolver.ts                 # getBranding(), invalidate(), warmCache()
    derive.ts                   # hex→HSL, brandActive auto-derive, etc.
    cssVars.ts                  # render <style> blob from a Branding doc
    metadata.ts                 # build Next.js Metadata from a Branding doc
    email.ts                    # render the email <header><footer> shell
    schema.ts                   # zod schemas for admin updates
    env.ts                      # ENV-override parser
```

Why a dedicated package: this code is consumed by **both** `apps/web` (SSR + RSC + client components) and `apps/api` (workers, email templates, scripts). The existing `@ecom/db` package is the shared seam for cross-app code, but branding has no Mongoose dependency at the consumer level — only the resolver does. Keeping it separate keeps the marketing bundle from importing all of Mongoose just to read the brand name.

Build/install: matches `packages/db` and `packages/types` shape (built to `dist/`, gitignored, npm workspace consumer pattern).

### 3.3 Caching

- In-process LRU keyed by `key: "saas"`, TTL 60s, max 32 entries (room for future white-label).
- Cache writes go through `invalidate(key)` so the admin panel's mutation can wipe the entry on every server in the cluster.
- Cross-process invalidation: a Mongo change-stream listener is attached at boot in `apps/api/src/index.ts`. On any change to `BrandingConfig`, every `apps/api` worker calls `invalidate("saas")`. For `apps/web` (Next.js SSR), the simpler approach is a 60s TTL plus a tRPC `invalidate` call from the admin panel's mutation — accepted because branding edits are rare and 60s of stale lime in a dashboard doesn't break trust.
- `warmCache()` is called once at boot so the first SSR request doesn't pay a Mongo round-trip.

### 3.4 Env overrides

A single ENV: `BRANDING_OVERRIDES` (JSON). Useful for staging environments that want to flag themselves visibly ("Cordon · STAGING"), or emergency rollbacks if a bad branding write breaks the page.

Precedence (lowest to highest): baked-in defaults → DB document → `BRANDING_OVERRIDES` env. `envOverridesApplied` is surfaced in the admin panel so admins know which fields are env-locked.

## 4. Consumers — how each surface reads branding

### 4.1 SSR `Metadata` (Next.js App Router)

`apps/web/src/app/layout.tsx` (and any per-route `metadata`) imports `buildRootMetadata` from `@ecom/branding/metadata`:

```ts
// apps/web/src/app/layout.tsx (target shape)
import { getBranding } from "@ecom/branding";
import { buildRootMetadata } from "@ecom/branding/metadata";

export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBranding();
  return buildRootMetadata(brand, { publicWebUrl: process.env.NEXT_PUBLIC_WEB_URL });
}
```

`buildRootMetadata` produces `metadataBase`, title template, OG, Twitter, icons, applicationName, authors, keywords. Per-route `generateMetadata` calls compose page title with the centralized template.

### 4.2 Global CSS variables

`getCssVars(brand)` returns a string blob `:root { --brand: ...; --brand-fg: ...; --surface-base: ...; }`. Injected once by a server component near the top of the dashboard, admin, auth, and marketing layouts. **The blue `--brand` in `globals.css:31-33` is removed** (or replaced with an obviously-broken sentinel) so any layout that forgets to wrap in the SaaS branding provider fails loudly instead of silently rendering blue.

The auth shell's local override block (`cordon-auth-shell.tsx:34-71`) becomes a no-op delete: `getCssVars()` already produces the same lime palette, so the override is redundant.

`landing.module.css`'s `.cordonPage { --c-bg: ... }` block stays scoped to the landing page (it's the only place where module-scoped CSS makes sense for marketing-only animations), but the colour values are filled in by a build-time tag-replace using the same source — so the marketing palette can never drift from the global one.

### 4.3 Auth shell, sidebar, topbar

A new `<SaasBrandingProvider>` is mounted in:
- `apps/web/src/app/dashboard/layout.tsx`
- `apps/web/src/app/admin/layout.tsx`
- `apps/web/src/app/(auth)/layout.tsx`
- Each of the standalone auth-flavoured layouts (`forgot-password/layout.tsx`, `reset-password/layout.tsx`, `verify-email/layout.tsx`, etc.)
- `apps/web/src/app/(marketing)/layout.tsx`
- `apps/web/src/app/legal/layout.tsx`

The provider is a server component that calls `getBranding()` once and renders `<style>{getCssVars(brand)}</style>` plus a React context with `name`, `tagline`, `supportEmail`, `assets.logo`, etc. The existing client `BrandingProvider` (per-merchant) sits inside it and overrides `--brand` only for merchants who set their own.

Every wordmark — `Sidebar.tsx:154` "Cordon", `cordon-auth-shell.tsx:163` "Cordon", `legal/layout.tsx:21,44` — reads from `useSaasBranding().name` instead.

### 4.4 Email templates

`apps/api/src/lib/email.ts` is rewritten so `renderLayout()` accepts a `BrandingConfig` and pulls accent/footer/sender from it. `fromAddress()` reads `branding.email.senderName + branding.email.senderAddress`. Subjects keep their human voice but pull the SaaS name from the branding doc:

```ts
const brand = await getBranding();
const subject = `Welcome to ${brand.name} — verify your email`;
```

Workers that send mail (`trialReminder`, `cartRecovery`, `subscriptionGrace`) all already call `sendEmail`; once `email.ts` consumes branding, every worker downstream is automatically branded correctly.

### 4.5 Stripe & WooCommerce

- `apps/api/src/server/routers/billing.ts:275`: `productName: \`${brand.operational.stripeProductPrefix} ${plan.name} plan\``.
- `apps/api/src/scripts/seedStripe.ts:83`: same.
- `apps/api/src/lib/integrations/woocommerce.ts:248`: `name: \`${brand.operational.woocommerceWebhookPrefix} ${topic}\``.

Plus two one-shot migration scripts in `apps/api/src/scripts/`:

- `migrateStripeProductNames.ts` — calls `stripe.products.update({ id, name })` for every product whose name starts with `Logistics `.
- `migrateWoocommerceWebhookNames.ts` — for every active WooCommerce integration, PUTs `/wp-json/wc/v3/webhooks/{id}` with the new name.

Both write audit entries and are safe to re-run.

### 4.6 Storefront SDK (`apps/web/public/sdk.js`)

The script gets a templating step at build-time: a small `apps/web/scripts/buildSdk.ts` reads `getBranding()` (or the baked-in defaults at SSR-disabled build time) and emits the actual `public/sdk.js` from a `public/sdk.template.js`. Tokens replaced: `{{SDK_GLOBAL}}`, `{{CONSOLE_PREFIX}}`, `{{INSTALL_DOMAIN}}`.

Public API rename: `window.LogisticsTracker` → `window.CordonTracker`, with a one-release alias:

```js
window.CordonTracker = api;
window.LogisticsTracker = api; // deprecated alias, removed in next major
```

Surface this in the integrations page so existing merchants know to update their snippets within N days.

### 4.7 Admin alerts SMS

`apps/api/src/lib/admin-alerts.ts:225` reads `brand.operational.smsBrand`.

## 5. The admin Branding Panel — `/admin/branding`

### 5.1 Routing & guard

- New page: `apps/web/src/app/admin/branding/page.tsx`.
- Sits inside the existing `apps/web/src/app/admin/layout.tsx` so it inherits the admin chrome.
- Authorization: a new permission `branding.update` added to `apps/api/src/lib/admin-rbac.ts` mapped to a new scope `branding_admin`. Or, to avoid a new scope, gate it on `super_admin` only — the architecture proposes a new `branding_admin` scope so it can be delegated separately.

### 5.2 tRPC router

A new tRPC router `adminBranding` (mounted in `apps/api/src/server/routers/index.ts`):

| Procedure | Auth | Purpose |
| --- | --- | --- |
| `adminBranding.get` | `branding_admin` | Returns the resolved `BrandingConfig` (DB → defaults merge), plus the list of env-overridden fields |
| `adminBranding.update` | `branding_admin` + step-up | Validates with zod, deep-merges with current doc, writes, emits audit row, invalidates cache |
| `adminBranding.uploadAsset` | `branding_admin` + step-up | Accepts a small image (≤ 200 KB inline, larger via signed S3 URL future), returns the URL to store under `assets.<key>` |
| `adminBranding.preview` | `branding_admin` | Server-rendered preview of the proposed doc — generates an HTML email + a screenshot of `/dashboard` chrome — without writing |
| `adminBranding.reset` | `super_admin` only | Wipes the doc back to baked-in defaults |

Step-up is the existing `apps/api/src/lib/admin-stepup.ts` flow — branding changes touch every public surface, so they need the same friction as a manual subscription extension.

### 5.3 UI

A single-page editor under three tabs:

1. **Identity** — name, legal name, tagline, support email, sales email, privacy email, status URL, terms URL.
2. **Visual** — colour pickers (re-use the existing `apps/web/src/components/branding/branding-section.tsx` pickers and validation), logo upload (drag-drop, accepts PNG/JPG/SVG/WebP, ≤ 200 KB inline; larger files surface "configure S3 first"), favicon upload, OG image upload, accent picker, optional dark-mode logo. Live preview pane on the right shows: dashboard sidebar tile, a "Verify email" email shell, the auth shell wordmark, an OG preview card, and a favicon preview in a fake browser tab.
3. **Email & operational** — email sender name, email footer text, CTA defaults, email logo, SMS brand, Stripe product prefix, WooCommerce webhook prefix, SDK global name, SDK console prefix.

Save flow: form → diff against server → step-up → mutation → toast. On success, the page invalidates its own `getBranding` cache and refetches; the rest of the app picks the new values up at the next request after its 60s TTL elapses (or immediately on a Cmd+R).

The existing per-merchant `BrandingSection` component (`apps/web/src/components/branding/branding-section.tsx`) is **untouched**; its colour-picker and image-extraction helpers are extracted upward into `@ecom/branding/derive` and re-used by both the merchant tab and the admin panel.

## 6. Coexistence with per-merchant tenant branding

The existing per-merchant branding system layers on top of the SaaS palette. Cascade order:

1. SaaS defaults baked into `@ecom/branding/defaults` — always available.
2. SaaS DB overrides — the doc edited by the admin panel.
3. Merchant-level branding (`Merchant.branding.{logoDataUrl, primaryColor}`) — only for that merchant's session, only inside the dashboard.
4. Component-level inline overrides (today: the BrandingPreview in `branding-section.tsx`).

In CSS terms: the SaaS provider sets `--brand` on the layout root; the merchant `BrandingProvider` (today at `apps/web/src/components/branding/branding-provider.tsx`) sets `--brand` on a wrapping `<div>` *inside* the layout. Cascade resolves merchant > SaaS automatically.

Public surfaces (marketing landing, auth, legal, errors, emails) ignore merchant branding entirely and always render in SaaS branding.

## 7. SSR, hydration, and edge cases

- `getBranding()` is `async` and called from server components. No client component does its own `getBranding()`; they consume the React context populated by the SaaS provider, which is hydrated from the server-rendered HTML. **No hydration mismatch is possible** because the same server-rendered values are streamed to the client.
- The CSS variables blob is rendered as `<style>` inline in the layout HTML, so the first paint already has the correct lime palette. No FOUC.
- Workers (`apps/api/src/workers/*`) use the same `getBranding()` import. Mongo connection drops fall back to baked-in defaults; emails go out branded correctly even during a brief outage.
- The dev fallback for emails at `apps/api/src/lib/email.ts:60-63` keeps logging to stdout when `RESEND_API_KEY` is unset; the brand-name in those logs comes from `getBranding()` as well.
- `apps/web/src/app/global-error.tsx` is the one surface where `getBranding()` cannot be awaited at render time — it's a client-side React error boundary that mounts on a JS crash. Solution: render it with the **baked-in defaults** synchronously (no DB read), so even if Mongo is down and the dashboard crashed, the error page is correctly branded.
- Cache safety: TTL is 60s. Admin panel mutation actively invalidates. Worst-case: a freshly written branding change takes 60s to appear on a single SSR worker and ~immediately on the panel that wrote it. Acceptable.

## 8. Migration plan and operational safety

Phase 2 work, summarised here so you can sign off on the approach.

| Step | Files changed | Runtime impact | Migration risk | Cache concerns | SSR concerns | Operational safety |
| --- | --- | --- | --- | --- | --- | --- |
| 1. Add `@ecom/branding` package + Mongo model + seed | `packages/branding/*`, `packages/db/src/models/brandingConfig.ts`, `apps/api/src/scripts/seedBranding.ts`, `apps/api/src/index.ts` (boot wiring) | None (read-only at this point) | Low — additive | Cache cold; no risk | None — code not yet wired into render path | Safe to deploy on its own; nothing reads from it yet |
| 2. Replace `globals.css:31-33` blue tokens with lime tokens injected from `getBranding()` | `apps/web/src/app/globals.css`, `apps/web/src/app/layout.tsx` (root `generateMetadata` + style block) | **Visible**: dashboard + admin re-themes from blue to lime | Low — colour change only; no semantic change | TTL 60s; first request after deploy pays a Mongo read | The CSS blob is server-rendered into the HTML head; no FOUC | Safe to roll back by reverting the layout import; dashboard goes back to blue |
| 3. Replace auth shell inline overrides | `apps/web/src/components/shell/cordon-auth-shell.tsx` | None visible (palette identical) | Low | Same | Same | Pure code-motion |
| 4. Re-point landing palette at central source via build-time replace | `apps/web/src/app/(marketing)/landing.module.css`, `apps/web/scripts/buildLandingTokens.ts` | None visible | Low | Build-time only | None | Safe |
| 5. Email templates consume branding | `apps/api/src/lib/email.ts`, every worker that imports `email.ts` | First-deploy: dev mode mails go through `getBranding()` (negligible) | Medium — verify subject lines unchanged so the test in `verify-email` still matches `/verify your email/i` | Cache shared with web; same TTL | None (server) | Resend domain must be verified before flipping `EMAIL_FROM` |
| 6. Stripe product names | `apps/api/src/server/routers/billing.ts`, `apps/api/src/scripts/seedStripe.ts`, new `apps/api/src/scripts/migrateStripeProductNames.ts` | New checkouts get correct name; existing receipts stay as-is until migration runs | High — one-shot migration touches live Stripe data | None | None | Run migration in a maintenance window; idempotent; audit-logged |
| 7. WooCommerce webhook names | `apps/api/src/lib/integrations/woocommerce.ts`, new `apps/api/src/scripts/migrateWoocommerceWebhookNames.ts` | Existing webhooks rename in merchants' WC admin | Medium — touches every merchant's WC store | None | None | Idempotent; rate-limited per merchant; audit-logged |
| 8. Storefront SDK rebrand + alias | `apps/web/public/sdk.template.js`, `apps/web/scripts/buildSdk.ts`, `apps/web/public/sdk.js` (regenerated) | New global available; old global aliased | Medium — public API change | Edge-cached; cache-bust on deploy via filename version | None | Comms to merchants required; alias keeps existing snippets working |
| 9. Admin SMS brand string | `apps/api/src/lib/admin-alerts.ts` | Internal | Low | None | None | Safe |
| 10. Legal pages, error boundary, footer, mailto's | `apps/web/src/app/legal/*`, `apps/web/src/app/global-error.tsx`, `apps/web/src/app/(marketing)/page.tsx`, `apps/web/src/app/payment-failed/page.tsx` | Visible: support email switches to `cordon.app` everywhere | Low — copy change | None | None | DNS for `cordon.app` mailbox must exist first |
| 11. Sidebar + onboarding copy + dashboard chrome | `apps/web/src/components/sidebar/Sidebar.tsx` (incl. `\|\| "L"` → `\|\| brand.nameInitials`), `apps/web/src/components/onboarding/*`, `apps/web/src/components/dashboard/*` | Visible: "L" fallback initial fixed, wordmark sourced from branding | Low | None | None | Safe |
| 12. Admin panel `/admin/branding` | `apps/web/src/app/admin/branding/page.tsx`, `apps/web/src/components/admin/branding/*`, `apps/api/src/server/routers/adminBranding.ts`, `apps/api/src/lib/admin-rbac.ts` (new permission) | Visible: new admin tool | Low | Mutation invalidates | None | Step-up gated; audit-logged |
| 13. Default favicon + OG image + Apple touch + manifest | `apps/web/public/{favicon.ico,apple-touch-icon.png,og.png,site.webmanifest}`, root `metadata.icons` | Visible: real favicon and link previews | Low | Long-cache assets via filename hash | Picked up by `metadata.icons`/`metadata.openGraph.images` | Safe |

## 9. Future white-label / multi-brand readiness

The schema's `key` field is the seam. Today only `key: "saas"` exists. A future tenanted deployment introduces:

- A request-time `BrandSelector` middleware (host-based, e.g. `cordon.app` → `key: "saas"`, `acme.cordon.app` → `key: "saas:acme"`).
- The resolver takes an optional `key` parameter (defaults to `"saas"`).
- Per-tenant overrides cascade: brand defaults → SaaS DB → tenant DB → request-scoped overrides.

Doing this now is over-engineering. Reserving the seam costs nothing.

## 10. What is **NOT** in this proposal

- We do not move design-system layout tokens (`--surface-*`, `--fg-*`, spacing/radii) into the branding system. Those stay in `globals.css`. Branding owns colour and copy; layout stays where it is.
- We do not add a UI for editing email **template structure**. Admins pick colours, sender, footer, CTA text; the template HTML scaffold stays in code.
- We do not add per-locale branding. The schema reserves `defaultLocale`; multi-locale branding is a Phase-3 conversation.
- We do not migrate the per-merchant tenant branding into the same admin panel. It stays in the merchant's own settings page.

## 11. Open questions for sign-off

These are decisions that affect Phase 2 and would be useful to settle before code lands. None are blockers; all have a reasonable default proposed above.

1. **`branding_admin` scope vs `super_admin`-only.** Default proposed: introduce `branding_admin` so the role can be delegated. Alternative: gate everything on `super_admin` for simplicity.
2. **Asset storage**. Default proposed: data-URL for ≤ 200 KB images today; reserve a path for S3/R2 once provisioned. Alternative: require S3 from day one.
3. **Storefront SDK alias window.** Default proposed: keep `window.LogisticsTracker` as a deprecated alias for one minor release, then remove. Alternative: hard rename with a one-time merchant comms blast.
4. **Email subject migrations.** Default proposed: subjects keep their current hardcoded human voice and replace only the SaaS name token. Alternative: subjects become fully editable from the admin panel.
5. **Phase-2 scope split.** Default proposed: ship Steps 1-5 + 9-13 first (everything except Stripe + WooCommerce + SDK migrations), then ship the three migration scripts behind a separate runbook. Alternative: one big change.

End of architecture.
