# Shopify Partner Dashboard — listing wording

Canonical copy for the ConfirmX Shopify app. Pre-approved for the
Public Distribution / Unlisted submission. Per-scope justifications
are review-critical — Shopify reviewers read these line-by-line.

Positioning constraint: **COD operational intelligence and order
confirmation infrastructure.** NOT "AI fraud detector" / "customer
surveillance" / "predictive behavioral AI" / "aggressive fraud
enforcement". Merchant operational assistance + verification
workflows is the correct posture.

---

## App identity

| Field | Value |
|---|---|
| App name | **ConfirmX** |
| Handle | `confirmx` |
| Tagline (50 char limit) | **Confirm every COD order before it ships.** *(41 chars)* |
| Short description (≤160 chars) | COD order confirmation infrastructure for Shopify merchants in Bangladesh. Real-time order verification, courier booking, idempotent webhooks. *(140 chars)* |
| Categories | Order management; Operations |

---

## Long description (~830 chars — for App Store listing if/when listed)

> ConfirmX is COD operational infrastructure for Bangladesh-based
> Shopify merchants. It sits between your store and your courier
> (Pathao, Steadfast, RedX), giving your operations team a single
> confirmation surface for every order before it ships.
>
> For each new order, ConfirmX verifies customer details, routes the
> order into one of three operator buckets — auto-confirm,
> confirmation call, or human review — books the courier when
> confirmed, and surfaces tracking events back to your dashboard.
>
> What ConfirmX is NOT: an autonomous fraud detector. The system
> surfaces signals; your operator decides. Every threshold is
> tunable; every action is audit-logged; every webhook is
> HMAC-verified and replay-safe.
>
> Built for the operational realities of Bangladesh COD: bKash/Nagad
> payment rails, BD courier APIs, BTRC-compliant SMS, BDT pricing.

---

## Key benefits (5 bullets)

- Confirm every COD order before it ships — auto-confirm, confirmation call, or operator review queue
- Real-time courier booking with Pathao, Steadfast, RedX
- Idempotent webhook delivery — replay-safe, HMAC-verified, no double-booking
- Audit-logged operations — every action traceable, every threshold tunable
- Bangladesh-first: bKash/Nagad payment rails, BDT pricing, BD courier APIs

---

## Per-scope justifications (REVIEW-CRITICAL)

Reviewers read these per scope. Frame each as `[why we need it]` +
`[what we don't do with it]`.

### `read_orders`

> Required to receive new orders + sync fulfilment status. ConfirmX
> subscribes to `orders/create` and `orders/updated` webhooks via
> the API; without this scope, the connection has no order data to
> operate on. We do not read historical orders unless the merchant
> explicitly triggers a backfill.

### `write_orders`

> Required for operator-driven actions from the merchant's review
> queue: cancelling a flagged order the operator declined, marking
> fulfilment status when the merchant confirms a COD pickup. The
> operator decides every action; ConfirmX never mutates an order
> without explicit operator confirmation. Every mutation is
> audit-logged on the merchant's side.
>
> *Reviewer note: if approval would be smoother by dropping this
> scope, the alternative is to redirect operators into the Shopify
> admin to perform cancel actions manually — a click cost, not a
> feature loss. Happy to drop on review request.*

### `read_customers`

> Required to surface the customer's phone to the operator at point
> of confirmation, for the optional confirmation-call workflow on
> flagged orders. Phone is shown only on the operator's
> confirmation surface; ConfirmX does not exfiltrate or retain
> customer data beyond what's needed for the active order.
> Customer data is redacted on `customers/redact` per Shopify's
> mandatory privacy webhook (verified HMAC, audit-logged
> dispatch, real per-collection redaction in
> `apps/api/src/lib/gdpr/redaction.ts`).

---

## Mandatory privacy webhook endpoints (Partner Dashboard form)

| Topic | URL |
|---|---|
| Customer data request | `https://api.confirmx.ai/api/webhooks/shopify/gdpr/customers/data_request` |
| Customer redact | `https://api.confirmx.ai/api/webhooks/shopify/gdpr/customers/redact` |
| Shop redact | `https://api.confirmx.ai/api/webhooks/shopify/gdpr/shop/redact` |

All three:
- Verify HMAC against `SHOPIFY_APP_API_SECRET` over raw request bytes (timing-safe).
- Audit-log receipt + dispatch outcome separately so reviewers see (a) the webhook arrived and verified, (b) what the redaction actually did.
- Dispatch to real redaction (`apps/api/src/lib/gdpr/redaction.ts`) — not stubs. `customers/redact` pseudonymises 5 collections and hard-deletes 3; `shop/redact` hard-deletes 13 collections in dependency order. The shop/redact path also includes a fresh-install race guard: if the merchant uninstalled then reconnected within Shopify's 48h retention window, the redact is declined with an audit row instead of wiping a live install.

---

## Install consent screen — what the merchant sees

| Field | Value |
|---|---|
| App name shown | ConfirmX |
| Developer name | ConfirmX Technologies Ltd. *(TODO[brand]: confirm registered legal entity before submit)* |
| Privacy policy link | https://app.confirmx.ai/legal/privacy |
| Terms of service link | https://app.confirmx.ai/legal/terms |
| Scopes shown | `read_orders`, `write_orders`, `read_customers` (each rendered with Shopify's standard "[App] is asking to read/write…" framing — our per-scope text above is what reviewers read, not the merchant) |

---

## What we deliberately are NOT submitting

- **App Bridge integration.** Deferred per architectural decision to keep ConfirmX external for the unlisted launch. App Bridge becomes valuable when we want admin-nav launch / embedded experience; revisit post-approval.
- **Embedded session tokens.** N/A without App Bridge.
- **Shopify Billing API.** ConfirmX bills via Stripe + manual bKash/Nagad approval (BD merchant preference). No Shopify revenue share applies for off-platform billing on Public Distribution Unlisted.
- **App Store listing.** Unlisted-only first submission. App Store listing is a separate review (marketing copy, screenshots) we may pursue later for top-of-funnel discovery.

---

## TODO[brand] — fill before submitting

Search the codebase: `grep -r "TODO\[brand\]" packages apps`

- `packages/branding/src/defaults.ts` — `legalName` + 5 email addresses (support@, privacy@, hello@, sales@, no-reply@confirmx.ai). Reviewers test email delivery.
- `apps/web/src/app/legal/privacy/page.tsx` — physical-address line if jurisdiction requires it (BD/EU/CA).
- `apps/web/src/app/legal/terms/page.tsx` — § 9 limitation-of-liability uses `_brand.legalName.toUpperCase()` (auto-tracks the registered entity once filled). Optional: add governing-law / jurisdiction clause if counsel wants one.

Also pre-submit:
- Replace logo asset files in `apps/web/public/brand/` (currently still Cordon artwork).
- Verify `support@confirmx.ai` and `privacy@confirmx.ai` are working inboxes.
