# Landing pages

Merchants build multiple landing pages from admin-managed templates, edit only the
fields a template exposes, preview drafts, and publish immutable revisions. Public
serving is host-based and ready for wildcard DNS, which is a later phase.

## Architecture

```
packages/landing          one template system, shared by every surface
  src/fields.ts           field types + value schemas (zod)
  src/sections.ts         section-type registry: type@version → fields
  src/spec.ts             template spec validation, content validate/resolve
  src/safe.ts, cta.ts     URL / colour / rich-text safety (deny by default)
  src/host.ts             host normalisation, slug rules, reserved names
  src/sections-commerce.ts e-commerce section types (shop header, promo hero,
                          categories, product grid, offer, trust, delivery…)
  src/locales.ts, localized.ts   locales (en, bn) and localized content
  src/format.ts           BDT / number formatting (৳, Bangla digits, lakh grouping)
  src/preview.ts          editor ↔ preview-frame message protocol
  src/templates*.ts       system templates: BD Modern Shop, BD Premium Brand,
                          BD Single Product, Launch, Showcase, Local Business
                          (+ Bangla copy)
  src/edit-target.ts      click-to-edit: element path → schema field (editor preview)
  src/analytics.ts        Meta Pixel event catalogue + Pixel ID validation (docs/landing-analytics.md)
  src/react/*             trusted section components, ProductCard, LandingRenderer

packages/db               LandingPageTemplate, LandingPageTemplateVersion,
                          LandingPage, LandingPageRevision, LandingPageHost,
                          LandingAsset
apps/api/src/lib/landing  pages.ts (lifecycle), templates.ts (seed/cache),
                          resolve.ts (host → published page), assets.ts
apps/api routers          landingPages (merchant), adminLandingTemplates
                          (super_admin), publicLanding (unauthenticated)
apps/web                  /dashboard/landing-pages (list, new, editor),
                          /admin/landing-templates, /preview/* (auth only)
apps/sites                public renderer: Host → /lp/<label>[/<locale>] → API → render
                          + preview frame on the preview host (editor/admin previews)
```

**Trust boundary:** section components are application code. Merchant content is
data. It is validated on write (`validateContent`) and again at render time
(`resolveContent`). It is rendered only through React text nodes, `ctaHref`,
`safeUrl`, validated `#rrggbb` theme tokens, and asset IDs mapped to a configured
base URL. There is no HTML, script, style or iframe input anywhere.

**Versioning:**
- A published `LandingPageTemplateVersion` is immutable: model hooks refuse
  updates. Admin edits always go to a new draft version.
- Pages pin `templateVersionId` and only move to a newer version when the owner
  runs "Update draft".
- System templates are reseeded at API boot. A new version is published only
  when the code spec's hash changes.

**Draft and publish:**
- `saveDraft` does a compare-and-set on `draftRevision`, so a stale editor gets
  `CONFLICT`.
- `publish` allocates a revision number, inserts an immutable
  `LandingPageRevision`, then flips `publishedRevisionId`. Each step is
  conditioned on the same `draftRevision`, so no multi-document transaction is
  needed.
- Only the published revision is ever served.

**Tenancy:** every merchant query filters on `merchantId` from the auth context.
Another tenant's page is indistinguishable from a missing one (`NOT_FOUND`). Images
referenced by content must belong to the page's merchant.

**Languages:** a page has `locales` (e.g. `["bn", "en"]`) and a `defaultLocale`.
Content is stored per locale in one record: `draftContent = { bn: {...}, en: {...} }`,
and revisions snapshot every locale. The default language is served at `/`, others at
`/en` or `/bn` with a language switch. Templates can ship per-locale default copy
(`spec.localeDefaults.bn`). Pages created before locales existed are read as English.

**Bangla typography:** apps/sites self-hosts Hind Siliguri (sans) and Noto Serif
Bengali (serif) via next/font. The renderer sets per-locale variables: Bangla gets
normal letter-spacing, taller line boxes (headings 1.4, body 1.8) and weight 700 (no
faux bold). The renderer root resets font-feature-settings, letter-spacing and
text-transform, so no host styles can leak in.

**Preview = published page:** the dashboard never renders a landing page. The editor,
the full draft preview and the admin template preview embed apps/sites' preview frame
in an iframe at the real device width (1440 / 768 / 390) and `postMessage` the draft
to it. The frame only accepts messages from `LANDING_EDITOR_ORIGINS`, can only be
framed by those origins (CSP frame-ancestors), is `noindex` and `no-store`, and
re-validates the spec and content before rendering.

**Click-to-edit:** in the editor preview, clicking any text, image, button, product,
category, testimonial or footer opens exactly that field in the form (current language
only), scrolls to it, flashes it and focuses its input. Hovering outlines the element and
names it ("Promotional hero → Headline"); the selection stays outlined across edits,
device switches and frame reloads, and focusing a form field outlines it in the preview.

```
renderer (editor preview only)      <section data-lp-section="hero"> … <h1 data-lp-field="headline">
                                     products: data-lp-field="items.2" (card) / "items.2.price" …
preview frame (edit-overlay.tsx)    hover outline · click → postMessage {type:"select", path, locale}
                                     (only to the origin whose draft it renders)
editor (landing-editor.tsx)         resolveEditTarget(spec, locale, path)  ← schema decides
                                     field → open section, focus [data-field-path="hero.headline"]
                                     locked / unknown → "Template element — not editable"
```

- Paths are schema keys (`sectionId.fieldKey[.index.subKey]`), emitted by the section
  components through one helper (`ed(env, …)`), never DOM selectors — they follow the
  template. A test renders every system template in every language and fails if any
  tagged element does not resolve to an editable field.
- The schema stays the source of truth: the path is re-validated syntactically in the
  frame and editor (`isEditPath`) and resolved against the template; locked fields are
  never tagged and never opened. Clicking selects — it never navigates or runs anything.
- Public pages render with `editable` off, so their HTML carries no editor attributes.
- Stale clicks from a frame rendering another language are ignored, so a click can never
  open the wrong language's field.

**Scroll animation (opt-in):** `theme@2` is `theme@1` plus `motion` (`none` / `subtle` /
`lively`, default `none`). Templates and pages on `theme@1` (every system template except
BD Single Product) never see the setting and render exactly as before. With motion on, the renderer only adds
markers (`data-lp-motion` on the root, `data-lp-reveal` on sections other than the header,
announcement and order bar); the server HTML hides nothing. apps/sites' `lib/motion.ts`
(bundled, no library, CSP `'self'`) then holds back only the sections that start below the
fold and fades/slides each in (opacity + transform) as it scrolls into view. It does nothing
for visitors who prefer reduced motion or browsers without IntersectionObserver, and focus,
printing or switching to reduced motion reveal everything. The editor's click-to-edit preview
never animates (no markers when `editable`, script not mounted); plain previews do.

**Mobile order bar (`mobileActionBar@1`):** fixed to the bottom of phone screens (hidden from
768px): a wide order button plus optional WhatsApp and call icon buttons, with safe-area
padding. Its `cta` fields declare `actions` — the order button may only scroll to a section of
the page, WhatsApp only opens a chat, call only dials — enforced on write by the field schema
and offered that way in the editor. When a template has the bar, the page gets bottom padding
on phones and the floating cart button sits above the bar
(`apps/sites/src/lib/commerce/cart-button.ts`); without it both are unchanged. Pointed at a
Product spotlight whose product can be bought, the order button becomes Buy now for that
product (it keeps `href="#<section>"`, so it still scrolls without JavaScript).

**Product spotlight (`productSpotlight@1`) and Buy now:** one product, large. The section
stores only the merchant's words (eyebrow, supporting text, up to 4 highlights, button text,
note, show-description toggle, image side) — never the product, its name, price or stock. The
product is the page's first catalog entry (`spotlightProduct`: the product starred on the
Products tab, else the first linked one), read live like every catalog product: name, image,
price ("From" for variant products), old price and discount, stock (in / low / out) and option
values, with values no available variant has shown disabled (`optionValueAvailable`). Button
text falls back to the product's Products-tab button text, then "Order now". Without a linked
product the public page shows nothing and the editor shows a how-to placeholder; a product that
can't be bought shows a disabled "Out of stock" button and no Buy now.
Buttons carry `data-lp-cart-buy="<productId>"` (option chips also `data-lp-buy-option` /
`data-lp-buy-value`). apps/sites' existing delegated cart listener (`landing-commerce.tsx`)
handles them before add-to-cart: only products of this page's catalog that are available; a
product with options opens the existing variant picker (`initialPicks` pre-selects a clicked
value with the first *available* variant having it; the choice stays explicit), a simple
product is added at once. `buyNowLines` adds the item without ever doubling it (pressing Buy
now twice checks out one, not two), then the existing checkout drawer opens at its details
step — the same transition as the cart's own "Order now", with the same `checkout_start` /
`initiate_checkout` events. The order is placed by the existing `/api/checkout` →
`placeLandingOrder`, which re-checks the product, variant, price and stock on the server.
Several spotlights on one page show the same product.

**BD Single Product (`bd-single-product`):** the built-in template for selling one product to
mobile visitors from Facebook ads with cash on delivery — a composition of existing section
types, no new section or checkout. theme@2 (`motion: subtle`); offer bar (`announcement`) →
banner hero (`promoHero`) → `productSpotlight` → `benefits` → `trustFeatures` → how to order
(`features`, 3 steps) → `offerBanner` → `testimonials` → `faq` → `deliveryInfo` →
`mobileActionBar` → `shopFooter`. The hero, benefits and offer buttons scroll to the spotlight;
the order bar's button points at it, so on phones it is Buy now. The product, its price,
discount, stock and options are only ever the live spotlight: the offer banner's price fields
are locked empty. Its delivery zones are the checkout's delivery options (`deliveryOptions`),
so their charges are what orders are charged — they start at ৳60 inside / ৳120 outside Dhaka
(BD Modern Shop's baseline) for the merchant to edit; an empty charge would mean ৳0. Payment
is COD. Reviews start as bracketed prompts with no stars, to be replaced with real
customer reviews — the template never invents customers or ratings. Its defaults pass
publish validation as they are; the spotlight (and the bar's Buy now) appears once a product
is linked — star it on the Products tab when the page links several.

**Prices:** `price` fields hold numbers; `formatBDT` renders `৳ ১,২৯০` (bn) or
`৳ 1,290` (en), switchable per page (`theme.numerals`: auto / 123 / ১২৩). Discount %
is computed from old and current price. Payment methods (COD, bKash, Nagad, …) are
display-only content — there is no payment integration.

**Slugs:** `LandingPageHost.hostname` is globally unique and stores the label only,
so the root domain can change without a migration. Released slugs are held for
`LANDING_SLUG_HOLD_DAYS` (default 90) against other merchants.

## Local development

```bash
npm run dev:api
npm run dev:web
npm run dev:sites
```

Browsers resolve `*.localhost` to loopback, so after publishing a page with slug
`mybrand` you can open `http://mybrand.localhost:3002` (and `/en` or `/bn` for other
languages). The editor preview uses `http://preview.localhost:3002`. No DNS or
hosts-file change is needed.

Outside production, `LANDING_ROOT_DOMAIN` defaults to `localhost`. In production
it has no default, so every host returns 404 until the domain phase sets it.

## Environment

| Var | Where | Default |
| --- | --- | --- |
| `LANDING_ROOT_DOMAIN` | api, sites | `localhost` (non-prod), unset (prod → all 404) |
| `LANDING_PUBLIC_URL_PATTERN` | api | `http://{slug}.localhost:3002` (non-prod) |
| `LANDING_SLUG_HOLD_DAYS` | api | `90` |
| `LANDING_MAX_PAGES_PER_MERCHANT` | api | `50` |
| `LANDING_API_URL` | sites | `http://localhost:4000` |
| `LANDING_ASSET_ORIGIN` | sites (CSP `img-src`) | origin of `LANDING_API_URL` |
| `LANDING_ALLOW_INDEXING` | sites | unset → robots.txt disallows everything |
| `LANDING_PREVIEW_HOST` | sites (build + runtime) | `preview.localhost` (non-prod), unset (prod → preview off) |
| `LANDING_EDITOR_ORIGINS` | sites (build + runtime) | `http://localhost:3001` (non-prod) |
| `NEXT_PUBLIC_LANDING_PREVIEW_URL` | web (build; also added to CSP `frame-src`) | `http://preview.localhost:3002` (non-prod) |

## Deferred to the domain / infrastructure phase

- Buy and choose the landing domain. A separate registrable domain is recommended:
  cookie isolation from `confirmx.ai`, blocklist blast radius, and Meta domain
  verification via the Public Suffix List.
- Wildcard DNS `*.<domain>` and a wildcard TLS certificate.
- Railway `sites` service with the wildcard custom domain and private networking
  to the API.
- Set `LANDING_ROOT_DOMAIN`, `LANDING_PUBLIC_URL_PATTERN`, `LANDING_API_URL`,
  `LANDING_ASSET_ORIGIN`, and optionally `LANDING_ALLOW_INDEXING`.
- Give the preview frame a production host (e.g. `preview.<domain>`) and set
  `LANDING_PREVIEW_HOST`, `LANDING_EDITOR_ORIGINS` and `NEXT_PUBLIC_LANDING_PREVIEW_URL`.
  Until then the dashboard shows "Live preview is not configured" in production.
- `hreflang` alternates between language versions once absolute URLs exist.
- Per-host canonical URL, sitemap and final robots policy.
- CDN caching: add `s-maxage` once a CDN keys on Host, then wire purge on
  publish.
- Object storage (S3/R2) for assets, plus image re-encoding and EXIF stripping.
  Content already references assets by ID.
- Custom domains (`LandingPageHost.kind = "custom_domain"`), admin
  moderation/takedown, and CSP nonces.
