# Commerce: products, inventory, landing-page orders

ConfirmX landing pages can sell the merchant's own products: the page links
products from the catalog, customers add them to a cart and place a
cash-on-delivery order, stock is reserved atomically, and the order joins the
existing ConfirmX pipeline (fraud scoring, SMS confirmation automation,
courier booking, tracking).

Nothing here is a parallel system: landing orders are ordinary `Order`
documents (`source.channel = "landing_page"`), created with the same
building blocks as dashboard orders (`lib/order-create.ts`).

## Data model

| Model | Collection | Purpose |
| --- | --- | --- |
| `Product` | `products` | Catalog item: name, description, image (a `LandingAsset` of the same merchant), SKU (unique per merchant), `price`, `compareAtPrice`, `currency` (default BDT), `status` (`draft` / `active` / `inactive` / `archived`), `lowStockThreshold`, `inventory {onHand, reserved}`. |
| `InventoryMovement` | `inventory_movements` | Append-only stock ledger — one row per change, with before/after totals. Types: `INITIAL_STOCK`, `RESTOCK`, `ORDER_RESERVED`, `ORDER_CANCELLED`, `ORDER_FULFILLED`, `MANUAL_ADJUSTMENT`, `RETURNED`. Updates are refused by model hooks. |
| `LandingPage.draftProducts` / `LandingPageRevision.products` | — | Product **references** (`productId`) + display-only overrides (`ctaText`, `badge`, `featured`), in display order. Snapshotted into each published revision like content. Never a copy of price or stock. |
| `LandingPage.tracking` | — | The page's own Meta Pixel (see `docs/landing-analytics.md`). |
| `Order` (extended) | `orders` | `items[].productId` + price snapshot, `order.subtotal / deliveryCharge / deliveryArea / currency / customerNote`, `source.landingPageId / landingSlug / landingRevision / locale`, `inventory {state, cycle, …}`. |

Stock status is **derived**, never stored: `available = onHand − reserved`;
`out_of_stock` when available ≤ 0, `low_stock` when ≤ the product's
threshold.

## Inventory rules (`apps/api/src/lib/inventory.ts`)

- The only code that changes `Product.inventory`.
- Every change is one conditional atomic `findOneAndUpdate` whose filter
  re-checks the invariants on the live document
  (`onHand ≥ 0`, `reserved ≥ 0`, `onHand − reserved ≥ 0`), plus one ledger row,
  in the same transaction. There is no read-then-write of stock anywhere.
- Reservation for an order runs inside the transaction that inserts the order;
  any line that cannot be covered aborts the whole order (no partial holds).
- Two buyers racing for the last unit: the second update no longer matches (or
  hits a write conflict, is retried by the driver, and then no longer matches)
  → exactly one order succeeds. Tested with stock 1 and simultaneous orders.
- Order-driven movements carry a key `<orderId>:<cycle>:<type>:<productId>`,
  unique per merchant — a replayed webhook or double status write can never
  book the same movement twice.

### Order status → stock (`reconcileOrderInventory`)

| Order status | Stock state | Effect |
| --- | --- | --- |
| pending / confirmed / packed / shipped / in_transit | `reserved` | units held (`reserved += q`) |
| cancelled | `released` | `reserved −= q` (`ORDER_CANCELLED`) |
| rto | `released` | `reserved −= q` (`RETURNED`) — goods never left stock |
| delivered | `fulfilled` | `onHand −= q`, `reserved −= q` (`ORDER_FULFILLED`) — final |
| restored after cancel | `reserved` again (new cycle) | only if stock is still available; otherwise stays released with a note shown to the merchant |
| deleted | `released` first | stock given back before the order is removed |

The transition is a compare-and-set on `order.inventory.state` in the same
transaction as the stock updates, so concurrent callers apply it once. Called
after **every** writer of `order.status`: `updateOrder`, `rejectOrder`,
`restoreOrder`, `bulkRejectOrders`, CSV replace-mode cancels, `deleteOrder`,
fraud-review reject, integration cancel webhook, customer SMS "NO",
stale-confirmation expiry, and courier tracking (`applyTrackingEvents`).
Orders without catalog items (all non-landing orders) are untouched.

After delivery, a customer return is booked by the merchant as `RETURNED`
stock (Products → Stock) — never automatically, because only the merchant
knows whether the item is resellable.

## Landing page → products

- Dashboard: page editor → **Products** tab. Add / remove / reorder products,
  set button text and badge, mark featured (shown first). "Create product"
  opens the product form and returns to the selection with the new product
  added. Saved to the draft; customers see it after publishing.
- Only the merchant's own non-archived products can be linked (server-checked).
- Public payload (`publicLanding.resolveByHost` → `commerce`): products of the
  **published** revision joined with **live** product data on every request
  (price/stock are never cached with the page). Draft/archived products are
  hidden; inactive or out-of-stock ones are shown as unavailable
  ("এই পণ্যটি বর্তমানে স্টকে নেই") and cannot be added.
- Renderer: a product grid set to "Your products" (the default) shows the
  linked products (`CatalogProductCard`); with no linked products it keeps
  showing its own custom cards, so existing pages are unchanged.
- Delivery options come from the page's own "Delivery & payment" section
  (area + charge), resolved on the server by id.

## Checkout (`POST /api/landing/orders`)

Browser → same-origin `apps/sites /api/checkout` → API. The request carries only
product ids + quantities, customer details, the delivery option id and an
idempotency key. The page and merchant come from the **Host** header.

Server checks, in `lib/commerce/landing-orders.ts`:

1. product exists · 2. belongs to the page's merchant · 3. is active ·
4. is in stock · 5. quantity available (then guarded again by the atomic
reservation) · 6. price = current price (a client price that differs →
`price_changed`, never used) · 7. one currency · 8. page belongs to that
merchant · 9. page is published and the merchant is online · 10. product is
linked on the published revision.

Also: Bangladeshi mobile number normalised to `+8801XXXXXXXXX` (Bangla digits
accepted); name/address/district/email/notes validated and stored as plain text
(control characters removed; rendered escaped by React); max 10 units per
product, 20 lines; per-phone limit (5 orders / 10 min per merchant); per-IP
limit on the API (10/min) and in the sites proxy (12/min).

Idempotency: the key becomes `source.clientRequestId`; the existing unique
index `(merchantId, source.clientRequestId)` plus an in-transaction re-check
collapse double clicks and retries into one order and one reservation. The
cart keeps the same key across retries of the same cart.

The transaction: idempotency re-check → plan quota → order insert (pending,
COD, price snapshot) → stock reservation. After commit: the shared post-create
pipeline (`afterOrderCreated`: fraud prediction ledger, automation decision /
SMS confirmation, auto-book, risk audit, fraud alert, identity stitching) and
an `order.landing_placed` audit entry.

The customer's IP reaches the API only from the sites proxy with the shared
`LANDING_PROXY_SECRET` (dev stack generates one locally); without it the
header is ignored.

## Courier

No new courier integration was added. The existing one already provides what
commerce needs:

- **Adapters**: Steadfast, Pathao, RedX (`apps/api/src/lib/couriers`), with
  booking from the dashboard / automation.
- **Webhook security** (`server/webhooks/courier.ts`): per-merchant URL
  `/api/webhooks/courier/<provider>/<merchantId>`; HMAC signature verified
  against the merchant's stored (encrypted) courier secret — missing secret or
  bad signature → 401; payload parsed per provider; the order is looked up by
  tracking code **within that merchant only**, with a tenant-mismatch guard;
  `WebhookInbox` dedupes deliveries; per-IP rate limit.
- **Courier → order status** (`STATUS_MAP` in `server/tracking.ts`):
  picked_up / in_transit / out_for_delivery → `in_transit`, delivered →
  `delivered`, rto / failed → `rto`; events are deduped by key and a status
  guard refuses stale regressions.
- **Order status → inventory**: the table above; `applyTrackingEvents` calls
  the idempotent reconcile after a status change. Tested end to end with a
  signed Steadfast webhook delivered twice → stock deducted once; a spoofed
  signature → 401, nothing changes.

## Dashboard

- **Products** (`/dashboard/products`): list with stock badges (in stock / low /
  out), filters (all / low / out), search; create/edit; archive; **Stock** dialog
  (restock, customer return, manual ± adjustment with note) and the movement
  history.
- **Orders**: landing orders show their source (`Landing page · <slug>`); the
  row's **View** button opens the order drawer, which shows products (price at order time), subtotal / delivery /
  total, customer details and note, landing page + revision + language, stock
  state, creation time, and the allowed status actions (cancel releases stock).

## Tests

`apps/api/tests/commerce-products.test.ts` (catalog, tenant isolation,
ledger, concurrency, idempotent transitions) and
`apps/api/tests/landing-orders.test.ts` (product links, live catalog, all
server checks and tampering cases, XSS-as-text, double submit, stock-1 race,
phone limit, cancel/reject/restore/delete, courier delivered/RTO, HTTP route,
signed courier webhook) and `apps/api/tests/landing-commerce-events.test.ts`
(AddToCart / InitiateCheckout / Purchase from the sites analytics layer with
stubbed browser globals — Purchase exactly once per order, nothing sent from a
frame or a page without a pixel).

## Known limitations

- Button text and badge overrides on a page's product link are merchant text
  and are shown as entered in every language of the page (they are not
  translated per locale). The built-in labels ("Add to cart" / "কার্টে যোগ
  করুন", stock labels, checkout) are localised.
- After delivery, customer returns are booked manually as `RETURNED` stock.
