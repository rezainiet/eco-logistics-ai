# Landing-page analytics (Meta Pixel)

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

## Not implemented (on purpose)

| Meta event | Why not |
| --- | --- |
| `AddPaymentInfo` | No online payment is taken (cash on delivery). |
| `Lead` / `CompleteRegistration` | No on-page form or sign-up exists yet. |
| Conversions API (server-side) | Needs a per-page access token (a secret) and a server event pipeline; browser events already carry deterministic/unique `eventID`s for future de-duplication. |
| Google Analytics / TikTok | Not requested yet; the event layer is provider-neutral (`landing-analytics.ts` → one adapter per provider). |

## How to verify with a real pixel

1. Meta Events Manager → the ad account's dataset → **Test events** → copy the Pixel ID.
2. Dashboard → Landing pages → the page → Settings & publishing → Analytics & Tracking → paste ID → enable → Save.
3. Open the published page; *Test events* shows `PageView` and `ViewContent`.
   Add a product to the cart (`AddToCart`), continue (`InitiateCheckout`) and
   place a test order (`Purchase`, once).
4. Browser devtools → Network → filter `facebook.com/tr` shows each beacon with
   `ev=` and `cd[...]` parameters. The editor preview and dashboard must show none.
