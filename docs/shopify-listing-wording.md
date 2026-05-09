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
- Drop logo + brand assets into `apps/web/public/brand/` (the
  directory does NOT currently exist; six files are missing —
  `logo.svg`, `logo-mono.svg`, `email-logo.png`, `og.png`,
  `apple-touch-icon.png`, `favicon.ico`). See
  `docs/audits/shopify-brand-consistency-audit.md §3` for the full
  spec.
- Verify `support@confirmx.ai` and `privacy@confirmx.ai` are
  working inboxes; verify SPF/DKIM/DMARC on `confirmx.ai`. See
  `docs/audits/shopify-legal-contact-readiness.md` for the full
  external-infra checklist.

---

## Merchant value framing (one paragraph each)

For copy that needs to lead with the merchant's actual problem, not
ours:

**The COD problem in Bangladesh.** Cash-on-delivery is 70%+ of
Bangladesh's online retail volume — and 30%+ of those orders return
to the merchant unsold (RTO). Every RTO is the merchant eating the
courier round-trip cost. Most RTOs are preventable at confirmation
time: wrong address, fake number, repeat returner, courier-area
mismatch. ConfirmX is the operational layer that surfaces those
signals before the package leaves the warehouse.

**What ConfirmX actually does.** For each new order, route it into
one of three buckets — auto-confirm (low risk, ship), confirmation
call (operator dials the customer), or human review (operator
decides). Every threshold is tunable; every action is audit-logged.
Couriers (Pathao, Steadfast, RedX) get booked automatically once
the order is confirmed, with tracking events flowing back to the
dashboard.

**What ConfirmX is NOT.** Not an autonomous fraud detector, not a
black-box AI, not customer surveillance. We surface signals; the
operator decides. No order is cancelled, blocked, or charged
without a human action.

**Who it's for.** BD-based Shopify merchants doing 50+ COD orders
a day, where one operator can't manually verify each order before
it ships.

---

## Onboarding screenshots needed (for App Store listed submission)

Unlisted submission does NOT require screenshots. If/when we pursue
App Store Listed (post-Unlisted approval), we'll need 5+ screenshots
at 1600×1200 minimum:

| # | Surface | Captures |
|---|---|---|
| 1 | `/dashboard/getting-started` | Onboarding hero + checklist after first install |
| 2 | `/dashboard` | KPI cards + 7-day chart after 1+ week of data |
| 3 | `/dashboard/orders` | Order list with risk-aware sample preview |
| 4 | Order drawer (click row from #3) | Tracking timeline + intent panel + address quality |
| 5 | `/dashboard/fraud-review` | Operator review queue with one flagged order open |
| 6 | `/dashboard/settings/integrations` | Connected Shopify card with health badge |

Capture against a demo store with seeded data. Use the staging
environment's branding (post-asset-drop) to ensure logos render.

---

## FAQ — for Partner Dashboard listing (Listed submission)

Reviewers and merchants both consult the FAQ. Answers stay short
(2–3 lines each) and avoid AI / fraud / autonomous vocabulary.

**Q: Does ConfirmX cancel orders automatically?**
No. ConfirmX surfaces signals; the operator decides every action.
The "Reject" action in our review queue is a human button click,
not an autonomous rule. Cancellations are audit-logged with the
operator's identity.

**Q: How does ConfirmX use my customer data?**
We act as a data processor for the personal data you push to us
through Shopify. Customer phone is shown to operators on the
review queue for the optional confirmation-call workflow; we never
exfiltrate or retain customer data beyond what's needed for the
active order. Full detail in our privacy policy.

**Q: What happens to my data when I uninstall?**
Within ~5 seconds, your integration row flips to "disconnected".
48 hours later, Shopify sends `shop/redact` to our endpoint and we
hard-delete every record tied to your shop in dependency order.
This is real redaction (`apps/api/src/lib/gdpr/redaction.ts`),
not a stub.

**Q: Is ConfirmX an AI fraud detector?**
No. ConfirmX is operator tooling for COD confirmation workflows.
Every threshold the system uses is tunable by the merchant; every
risk score is a deterministic computation, not a black-box model.
The operational vocabulary is by design — we're an operations
platform, not a fraud-screening platform.

**Q: Which couriers does ConfirmX integrate with?**
Pathao, Steadfast, RedX (the three primary BD couriers). Per-
merchant credentials are AES-256-GCM-encrypted at rest; rotation
is supported. Adding a courier is a settings-page action.

**Q: How do I bill my merchants?**
We bill the merchant directly via Stripe (USD or BDT) or via manual
bKash/Nagad approval. Shopify Billing API is not used; no Shopify
revenue share applies for off-platform billing on Public
Distribution Unlisted.

**Q: What region does ConfirmX serve?**
Bangladesh-first by design — bKash/Nagad payment rails, BTRC-
compliant SMS, BDT pricing, BD courier APIs, BD address gazetteer
(thana → district resolution).

**Q: How do I get help during a review or production issue?**
Email `support@confirmx.ai` (24h response during review windows;
~4h business-hours response for paying merchants). For privacy or
data-handling questions, email `privacy@confirmx.ai`.

**Q: Can I install ConfirmX on multiple stores?**
Yes. Each store creates its own integration row with its own access
token; merchants with multi-store accounts can operate them from
the same ConfirmX dashboard.

**Q: What if Shopify changes the GDPR webhook spec?**
We monitor Shopify's deprecation notices and update the handler at
`apps/api/src/server/webhooks/shopify-gdpr.ts`. Existing handlers
remain replay-safe and HMAC-verified across spec revisions because
the receiver is structured to accept any of the three current GDPR
topics on either a single URL or per-topic URLs.

---

## Support copy for Partner Dashboard

Two text fields most submissions need:

**Support / contact details (for Partner Dashboard "Support" field):**

> ConfirmX support is reachable at support@confirmx.ai. We respond
> within 24 hours during review windows and within 4 business hours
> for paying merchants. Privacy / data-handling questions:
> privacy@confirmx.ai. Status updates and incident history:
> status.confirmx.ai.

**Reviewer-facing instructions (for Partner Dashboard "Reviewer
notes" field):**

> Demo store credentials and the suggested review path are in
> docs/shopify-reviewer-test-flow.md (linked from our GitHub repo).
> The five-step happy-path takes ~2 minutes:
>
> 1. Install via the link above
> 2. Approve scopes (read_orders, write_orders, read_customers)
> 3. Land on /dashboard/settings/integrations — verify connection
> 4. Place a test order on the dev store — verify it appears in
>    /dashboard/orders within 30 seconds
> 5. Uninstall — verify the integration card flips to disconnected
>    within 5 seconds
>
> Happy to drop write_orders on review request; the alternative is
> to redirect operators into Shopify admin to perform cancel
> actions manually (a click cost, not a feature loss).
