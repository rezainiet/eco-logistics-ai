# Landing-page analytics (Meta Pixel)

Merchants can send browser events from their **published** landing pages to
their own Meta Pixel. There is no server-side Conversions API (CAPI) yet — see
"Not implemented" below.

## Configuration

**Where:** Dashboard → Landing pages → **Analytics & tracking** (also shown in
each page's editor → *Settings & publishing*). One setting per merchant; it
applies to every published page of that merchant.

| Setting | Stored as | Notes |
| --- | --- | --- |
| Meta Pixel ID | `Merchant.landingTracking.metaPixelId` | 15–16 digits only (`META_PIXEL_ID_RE`). Pasted spaces/dashes are removed; anything else (`javascript:`, `<script>`, `fbq(...)`) is rejected by the UI **and** the API. |
| Send events to Meta | `Merchant.landingTracking.enabled` | Can't be on without a valid ID. |

- Only the Pixel ID is collected. It is public by design (it appears in every
  page's HTML). **No Meta access token or secret is stored or sent to browsers.**
- Changes take effect on live pages within seconds, without republishing
  (the public-page cache for all of the merchant's hosts is invalidated).
- Every change is audited (`landing.tracking_updated`, before/after).
- Platform kill switch: `LANDING_ANALYTICS=off` on apps/sites removes the pixel
  and Meta's origins from the CSP on every page.

## Where events come from — production pages only

| Surface | Pixel loaded? | Why |
| --- | --- | --- |
| Published page (`<slug>.<landing domain>`, `/` and `/<locale>`) | **Yes**, when configured | `LandingAnalytics` is mounted only by the public page route. |
| Editor device preview, full draft preview, admin template preview | **Never** | The preview frame never mounts analytics, refuses to run inside frames, and the preview host's CSP does not allow Meta's origins at all. |
| Dashboard (apps/web) | Never | Not part of apps/web. |

## Architecture

```
apps/sites  lp/[label]/[[...locale]]/page.tsx
              └─ <LandingAnalytics config page products/>        (client, renders nothing)
                   └─ startLandingAnalytics()   lib/analytics/landing-analytics.ts
                        ├─ PageView + ViewContent once per page load
                        └─ ONE delegated click listener → classifies the link
                             └─ metaPixel(pixelId)  lib/analytics/meta-pixel.ts   ← the only code that calls fbq
packages/landing  analytics.ts   event catalogue, Pixel-ID validation, link classifier, product catalogue
```

- Components never call `fbq`. Clicks are classified from the link destination
  (`linkKind`) and the section it sits in; product clicks use the card's
  `data-lp-product` key, and product names/prices come from server-validated
  content (`productCatalog`), never from reading the DOM.
- `fbevents.js` is loaded `async` after hydration; a queueing stub means nothing
  throws if Meta is slow, blocked by an ad blocker, or down.
- Events use `trackSingle` / `trackSingleCustom` (only the configured pixel
  receives them) with an `eventID` on every event (ready for CAPI dedup).
- Meta's automatic features are off: `autoConfig=false` (no automatic
  button-click events) and `disablePushState=true` (no extra PageView when an
  in-page `#section` link changes the URL hash — this was a real duplicate
  found in browser QA and fixed).

### Duplicate prevention
- PageView/ViewContent are keyed by pixel + path in a module-level set, so React
  StrictMode double effects, remounts and hydration cannot re-send them.
- A real navigation (e.g. the language switch to `/en`) is a new page load and
  correctly sends one new PageView.
- Per click: at most one standard event (`Contact`) and one custom event.

## Event catalogue

Common parameters on every event: `lp_slug` (public subdomain label),
`lp_template` (template key), `lp_locale` (`bn` / `en`).
Never sent: phone numbers, emails, WhatsApp message text, link URLs, merchant
or page database ids. (Meta's pixel itself adds the page URL `dl` and referrer.)

| Event | Type | When | Extra parameters |
| --- | --- | --- | --- |
| `PageView` | standard | Page load (once) | — |
| `ViewContent` | standard | Page load (once) — the offer/products were shown | `content_name` (page title), `content_type: "product"`, `content_ids` (product keys, ≤20), `num_items`, `currency: "BDT"` |
| `Contact` | standard | Click on a WhatsApp / phone / email / Messenger link | `lp_contact_method` (`whatsapp`/`phone`/`email`/`messenger`), `lp_location` (section id), `content_ids` when inside a product card |
| `whatsapp_click` | custom | WhatsApp link outside a product card | `lp_location` |
| `phone_click` | custom | `tel:` link outside a product card | `lp_location` |
| `email_click` | custom | `mailto:` link outside a product card | `lp_location` |
| `messenger_click` | custom | `m.me` / Messenger link outside a product card | `lp_location` |
| `product_click` | custom | Any link/button inside a product card or the offer banner | `content_ids: ["products-0"]`, `content_name`, `content_type: "product"`, `value` (BDT price), `currency: "BDT"`, `lp_cta_type`, `lp_location` |
| `cta_click` | custom | Any other link/button (section scroll, external link) | `lp_cta_type` (`section`/`link`), `lp_location` |
| `language_switch` | custom | Visitor switches language | `lp_from`, `lp_to` |

Product keys are positional and non-personal: `<sectionId>-<index>`
(`products-0`, `offer-0`). Landing pages have no product database ids.

### Example payloads (captured in browser QA)

Real Chrome, real `fbevents.js` from `connect.facebook.net`; the `/tr` beacons
were captured at the network layer (`ev`, `cd[...]` query parameters):

```text
PageView        {"lp_slug":"pixel-shop","lp_template":"bd-modern-shop","lp_locale":"bn"}
ViewContent     {…,"content_name":"বাংলাদেশে অনলাইন শপিং | বাজার মার্ট","content_type":"product",
                 "content_ids":["offer-0","products-0",…,"products-7"],"num_items":"9","currency":"BDT"}
cta_click       {…,"lp_cta_type":"section","lp_location":"hero"}
product_click   {…,"content_ids":["products-0"],"content_name":"প্রিমিয়াম কটন শার্ট","content_type":"product",
                 "value":"1290","currency":"BDT","lp_cta_type":"section","lp_location":"products"}
Contact         {…,"lp_contact_method":"phone","lp_location":"header"}
phone_click     {…,"lp_location":"header"}
Contact         {…,"lp_contact_method":"whatsapp","lp_location":"order"}
whatsapp_click  {…,"lp_location":"order"}
Contact         {…,"lp_contact_method":"email","lp_location":"footer"}
email_click     {…,"lp_location":"footer"}
language_switch {…,"lp_from":"bn","lp_to":"en"}
PageView        {"lp_slug":"pixel-shop","lp_template":"bd-modern-shop","lp_locale":"en"}   ← new page load (/en)
```

## Not implemented (on purpose)

| Meta event | Why not |
| --- | --- |
| `AddToCart` | Landing pages have no cart. Product buttons are links → `product_click`. |
| `InitiateCheckout` | There is no checkout. Ordering happens in WhatsApp/phone → `Contact`. |
| `Purchase` | ConfirmX does not see the sale on the landing page. A WhatsApp click is **not** a purchase. |
| `Lead` | Reserved for a future on-page form submission. |
| Conversions API (server-side) | Needs a per-merchant access token (a secret) and a server event pipeline; browser events already carry `eventID` for future de-duplication. |
| Google Analytics / TikTok | Not requested yet; the event layer is provider-neutral (`landing-analytics.ts` → one adapter per provider). |

## How to verify with a real pixel

1. Meta Events Manager → your dataset → **Test events** → copy the Pixel ID.
2. Dashboard → Landing pages → Analytics & tracking → paste ID → enable → Save.
3. Open the published page; within ~30 s *Test events* shows `PageView` and
   `ViewContent`; click WhatsApp/phone/product buttons and watch `Contact`,
   `whatsapp_click`, `product_click`.
4. Browser devtools → Network → filter `facebook.com/tr` shows each beacon with
   `ev=` and `cd[...]` parameters. The editor preview must show none.
