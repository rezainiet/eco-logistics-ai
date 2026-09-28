# Landing-page analytics (Meta Pixel, Google, TikTok) and attribution

Each **published** landing page can send browser events to **its own** Meta
Pixel. There is no server-side Conversions API (CAPI) yet — see "Not
implemented" below.

## Configuration — per landing page

**Where:** Dashboard → Landing pages → open a page → **Settings & publishing**
→ **Analytics & Tracking**.

> Use the Meta Pixel ID associated with the advertising account for this landing page.

Merchants usually run each campaign page from a different ad account, so the
pixel is a property of the page, not of the merchant. Two pages of the same
merchant load two different pixels; a page without one loads none.

| Setting | Stored as | Notes |
| --- | --- | --- |
| Meta Pixel ID | `LandingPage.tracking.metaPixelId` | 15–16 digits only (`META_PIXEL_ID_RE`). Pasted spaces/dashes are removed; anything else (`javascript:`, `<script>`, `fbq(...)`) is rejected by the UI **and** the API. |
| Send events to Meta | `LandingPage.tracking.enabled` | Can't be on without a valid ID. |

- Only the Pixel ID is collected. It is public by design (it appears in the
  page's HTML). **No Meta access token or secret is stored or sent to browsers.**
- Live config, not part of a published revision: changes take effect on the
  live page within seconds, without republishing (only that page's cached
  public payload is invalidated).
- Every change is audited (`landing.tracking_updated`, subject = the page,
  before/after).
- Tenant isolation: tracking is read and written only through the page's
  owner (`getOwnedPage`); another merchant gets NOT_FOUND.
- Platform kill switch: `LANDING_ANALYTICS=off` on apps/sites removes the pixel
  and Meta's origins from the CSP on every page.
- (Earlier builds of this branch had one merchant-wide pixel,
  `Merchant.landingTracking`. It was never released and has been removed.)

## Where events come from — production pages only

| Surface | Pixel loaded? | Why |
| --- | --- | --- |
| Published page (`<slug>.<landing domain>`, `/` and `/<locale>`) | **Yes**, when that page has a pixel | `LandingAnalytics` is mounted only by the public page route, with that page's own `analytics` config. |
| Editor device preview, full draft preview, admin template preview | **Never** | The preview frame never mounts analytics (or the cart), refuses to run inside frames, and the preview host's CSP does not allow Meta's origins. |
| Dashboard (apps/web) | Never | Not part of apps/web. |

## Architecture

```
apps/sites  lp/[label]/[[...locale]]/page.tsx
              ├─ <LandingCommerce …/>   cart + checkout (only on pages with linked products)
              │     └─ emitCommerceEvent()   lib/analytics/commerce-events.ts   (DOM CustomEvent, no pixel code)
              └─ <LandingAnalytics config page products/>        (client, renders nothing)
                   └─ startLandingAnalytics()   lib/analytics/landing-analytics.ts
                        ├─ PageView + ViewContent once per page load
                        ├─ ONE delegated click listener → classifies the link
                        ├─ ONE commerce listener → AddToCart / InitiateCheckout / Purchase
                        └─ metaPixel(pixelId)  lib/analytics/meta-pixel.ts   ← the only code that calls fbq
packages/landing  analytics.ts   event catalogue, Pixel-ID validation, link classifier, product catalogue
```

- Components never call `fbq`. Clicks are classified from the link destination
  (`linkKind`) and the section it sits in. Commerce events are announced by the
  cart as DOM events and translated here — the cart works identically with or
  without a pixel.
- `fbevents.js` is loaded `async` after hydration; a queueing stub means nothing
  throws if Meta is slow, blocked by an ad blocker, or down.
- Events use `trackSingle` / `trackSingleCustom` (only this page's pixel
  receives them) with an `eventID` on every event (ready for CAPI dedup).
- Meta's automatic features are off: `autoConfig=false` (no automatic
  button-click events) and `disablePushState=true` (no extra PageView when an
  in-page `#section` link changes the URL hash).

### Duplicate prevention
- PageView/ViewContent are keyed by pixel + path in a module-level set, so React
  StrictMode double effects, remounts and hydration cannot re-send them.
- Per click: at most one standard event (`Contact`) and one custom event.
- `AddToCart` fires only when the quantity actually increased (a click at the
  stock limit sends nothing).
- `Purchase` fires only after the server returned a created order, once per
  order: its eventID is `Purchase.<order number>` and the order number is
  remembered for the browser session, so a retried request (which returns the
  same order) or a remount cannot send it twice.

## Event catalogue

Common parameters on every event: `lp_slug` (public subdomain label),
`lp_template` (template key), `lp_locale` (`bn` / `en`).
Never sent: customer names, phone numbers, addresses, emails, notes, WhatsApp
message text, link URLs, merchant or page database ids. (Meta's pixel itself
adds the page URL `dl` and referrer.)

| Event | Type | When | Extra parameters |
| --- | --- | --- | --- |
| `PageView` | standard | Page load (once) | — |
| `ViewContent` | standard | Page load (once) — the offer/products were shown | `content_name` (page title), `content_type: "product"`, `content_ids` (≤20), `num_items`, `currency: "BDT"` |
| `AddToCart` | standard | A catalog product went into the cart | `content_ids: [productId]`, `content_type: "product"`, `content_name`, `contents: [{id, quantity, item_price}]`, `num_items`, `value`, `currency` |
| `InitiateCheckout` | standard | Customer continued from the cart to checkout | `content_ids`, `contents`, `num_items`, `value` (subtotal), `currency` |
| `Purchase` | standard | **The server created the order** (never on opening the form) | `content_ids`, `contents`, `num_items`, `value` (order total incl. delivery), `currency`, `payment_method: "cod"` |
| `Contact` | standard | Click on a WhatsApp / phone / email / Messenger link | `lp_contact_method`, `lp_location` (section id), `content_ids` when inside a product card |
| `whatsapp_click` / `phone_click` / `email_click` / `messenger_click` | custom | Contact link outside a product card | `lp_location` |
| `product_click` | custom | A link inside a (non-catalog) product card or the offer banner | `content_ids: ["products-0"]`, `content_name`, `content_type: "product"`, `value`, `currency`, `lp_cta_type`, `lp_location` |
| `cta_click` | custom | Any other link (section scroll, external link) | `lp_cta_type` (`section`/`link`), `lp_location` |
| `language_switch` | custom | Visitor switches language | `lp_from`, `lp_to` |

**Cash on delivery.** Landing-page orders are COD: `Purchase` means *an order
was placed and accepted*, not that money was received. `payment_method: "cod"`
says so explicitly. Delivery outcomes (delivered / returned) are tracked in
ConfirmX, not reported to Meta.

**Product identifiers.** Catalog products (linked from the merchant's product
catalog) are identified by their product id, which is also what order items
reference. Custom display-only product cards keep positional keys
(`<sectionId>-<index>`, e.g. `products-0`).

## Google (GA4 / Google Ads) and TikTok

Configured per landing page next to the Meta Pixel (Settings & publishing →
Analytics & Tracking), each with its own switch. Only public IDs are stored:

| Setting | Stored as | Format |
| --- | --- | --- |
| GA4 measurement ID | `LandingPage.tracking.ga4MeasurementId` | `G-` + 6–14 letters/digits |
| Google Ads tag ID | `tracking.googleAdsId` | `AW-` + digits |
| Google Ads purchase conversion label | `tracking.googleAdsPurchaseLabel` | the part after `/` (optional; without it no conversion is sent) |
| Send events to Google | `tracking.googleEnabled` | needs a GA4 or Ads ID |
| TikTok Pixel ID | `tracking.tiktokPixelId` | ~20 upper-case letters/digits |
| Send events to TikTok | `tracking.tiktokEnabled` | needs the Pixel ID |

The Google/TikTok fields are written only once configured. The public page
payload (`analytics`) contains only the switched-on, valid IDs, and the
renderer re-validates them before anything reaches the browser. Loaders:
`lib/analytics/google-tag.ts` (gtag.js, automatic page views off, every event
has `send_to`) and `lib/analytics/tiktok-pixel.ts` (events.js, calls via
`ttq.instance(id)`). Both are siblings of `meta-pixel.ts` behind the same
`startLandingAnalytics` layer, so they share its guarantees (once-per-load
page view, one Purchase per order, nothing in the preview or in frames).

| Landing event | GA4 | Google Ads | TikTok |
| --- | --- | --- | --- |
| PageView | `page_view` | `page_view` | `page()` |
| ViewContent | `view_item_list` | — | `ViewContent` |
| AddToCart | `add_to_cart` | — | `AddToCart` |
| InitiateCheckout | `begin_checkout` | — | `InitiateCheckout` |
| Purchase (server-created order) | `purchase`, `transaction_id` = order number | `conversion` to `AW-…/label`, same `transaction_id` | `PlaceAnOrder`, `event_id` = `Purchase.<order number>` |
| Contact | `contact` | — | `Contact` |

Meta-only custom click events (`cta_click`, `product_click`, `*_click`,
`language_switch`) are not sent to Google or TikTok. TikTok gets
`PlaceAnOrder`, not `CompletePayment`: orders are cash on delivery (placed,
not paid).

CSP (apps/sites `next.config.mjs`): with `LANDING_ANALYTICS` on, published
pages also allow `*.googletagmanager.com`, the GA4/Ads collect hosts
(`*.google-analytics.com`, `*.analytics.google.com`, `*.g.doubleclick.net`,
`*.google.com`, `*.google.com.bd`), frames `td.doubleclick.net` /
`www.googletagmanager.com`, and `analytics.tiktok.com` / `*.tiktok.com`.
`LANDING_ANALYTICS=off` removes every analytics origin. The preview host
never allows them.

## Marketing attribution (first / last touch)

`@ecom/landing` `attribution.ts` + `apps/sites` `lib/analytics/attribution-store.ts`.

- On each load of a published commerce page the browser reads the visit's
  `utm_source/medium/campaign/term/content`, which ad-click id was present
  (`fbclid`, `gclid`, `gbraid`, `wbraid`, `ttclid`, `msclkid` — the TYPE
  only, never the id value), the external referrer's host (never the full
  URL) and the path (never the query string).
- Stored in that page origin's `localStorage`: `firstTouch` is set by the
  first attributable visit and never replaced; `lastTouch` moves to each
  later attributable visit. A direct visit changes nothing. Works with every
  pixel switched off; no personal data.
- The checkout sends the pair; the sites proxy and the API both sanitise it
  (allow-listed keys, clamped lengths, control characters/markup removed,
  touches older than ~400 days or in the future dropped). The API classifies
  each touch into a channel (`meta`, `google`, `tiktok`, `organic`,
  `referral`, `other`) and stores `Order.attribution` once, at creation.
  Invalid or missing attribution never blocks an order. Attribution is never
  used for tenant, price, stock or revenue decisions.

Reports (Dashboard → Marketing): orders placed per channel / source /
medium / campaign, and revenue by Accounting's exact rule (delivered orders
only). Ad spend is only what was entered in Accounting (Meta / Google /
TikTok ads categories); cost per order and ROAS are shown only when spend
exists. Orders without attribution are "direct" (landing page, no signal) or
"not tracked" (other channels / before attribution).

## Not implemented (on purpose)

| Meta event | Why not |
| --- | --- |
| `AddPaymentInfo` | No online payment is taken (cash on delivery). |
| `Lead` / `CompleteRegistration` | No on-page form or sign-up exists yet. |
| Conversions API (server-side) | Needs a per-page access token (a secret) and a server event pipeline; browser events already carry deterministic/unique `eventID`s for future de-duplication. |
| Google / TikTok server-side events | Same reason as CAPI: they need secrets and a server pipeline. Browser Purchase events already carry the order number for future de-duplication. |
| Google Analytics / TikTok | Not requested yet; the event layer is provider-neutral (`landing-analytics.ts` → one adapter per provider). |

## How to verify with a real pixel

1. Meta Events Manager → the ad account's dataset → **Test events** → copy the Pixel ID.
2. Dashboard → Landing pages → the page → Settings & publishing → Analytics & Tracking → paste ID → enable → Save.
3. Open the published page; *Test events* shows `PageView` and `ViewContent`.
   Add a product to the cart (`AddToCart`), continue (`InitiateCheckout`) and
   place a test order (`Purchase`, once).
4. Browser devtools → Network → filter `facebook.com/tr` shows each beacon with
   `ev=` and `cd[...]` parameters. The editor preview and dashboard must show none.
