# Shopify app distribution — decision + go-live checklist

## TL;DR

The `devreza` app in our Shopify Partner org is currently a **Custom Distribution** app, which is why "this app can't be installed on this store" appears when you try to install it on a store outside the org. To onboard real merchants we need to convert it to **Public Distribution, unlisted** — same one-click connect UX as today, but installable by any merchant with a direct link, no App Store revenue share if billing happens off-platform.

This doc captures *why we picked that path* and *what has to be true before we can flip the switch*.

## The three options we evaluated

### 1. Custom Distribution (current state)

Apps live inside one Partner organization. Only stores attached to that organization can install them. Zero Shopify review.

| Pros | Cons |
|---|---|
| No review process | **Cannot onboard merchants outside our org** — fatal for SaaS |
| Fastest to iterate locally | Custom-app installs from inside the merchant's admin (the "Develop apps → Create app" flow) are the only fallback, and they have terrible UX |

**Verdict:** ship-blocker. Fine for our own dev stores; impossible for production.

### 2. Public Distribution, App Store listed

Apps go through Shopify's full review. Once approved they appear in the App Store; merchants can find them via search, install via a button.

| Pros | Cons |
|---|---|
| Built-in distribution channel | First-time review is 1–3 weeks |
| Installs are one-click for any merchant | **Shopify takes a revenue share** on in-app purchases (currently 0% on the first $1M annual gross, then 15%) |
| Public credibility ("on the App Store") | Marketing scrutiny: screenshots, copy, support URL all reviewed |

**Verdict:** the right path eventually if we want top-of-funnel from the App Store. Not the best fit *first* — too much marketing surface to lock down for a private beta.

### 3. Public Distribution, **unlisted** ← **chosen**

Same Public Distribution mode in Partners, but you opt out of the App Store listing. Shopify still reviews for technical compliance (HMAC, GDPR webhooks, billing API conformance if used) but doesn't audit marketing copy. We share a direct install link from our own marketing site.

| Pros | Cons |
|---|---|
| Same one-click connect UX as today, works for any merchant | Still requires Shopify review (faster than full App Store, usually <1 week) |
| **No revenue share** if billing happens off-platform (matches our current Stripe + manual payment flow) | No App Store discovery — we own the funnel |
| No marketing review — we control all merchant-facing copy | Slightly more work on our side to maintain the install link & docs |
| Faster path from "code-complete" to "first paying merchant" | |

**Verdict:** best fit for this product right now. Keeps the existing one-click flow, sidesteps the App Store revenue share (we already bill via Stripe + manual approval), gets us merchant-installable in days not weeks.

## What has to be true before we submit for review

Shopify's reviewers check the following on every Public Distribution submission. Each item links to the file/route in this repo where the work lives (or the gap that still needs closing).

### Mandatory — review will fail without these

- [x] **OAuth install flow works end-to-end.** `apps/api/src/server/routers/integrations.ts` (connect mutation) + `apps/api/src/server/webhooks/integrations.ts` (`/api/integrations/oauth/shopify/callback`). Validated manually with `devs-9807.myshopify.com`.
- [x] **HMAC verification on inbound order webhooks.** `apps/api/src/lib/integrations/shopify.ts` `verifyWebhookSignature` — uses `x-shopify-hmac-sha256` over raw body with the per-merchant `apiSecret`.
- [x] **HMAC verification on OAuth callback.** Same file, `verifyShopifyOAuthHmac`. Runs FIRST when the platform secret is configured (closes a small enumeration oracle).
- [x] **Three GDPR / privacy webhooks.** `apps/api/src/server/webhooks/shopify-gdpr.ts` — POST handler at `/api/webhooks/shopify/gdpr/*` that verifies HMAC against `SHOPIFY_APP_API_SECRET` and dispatches on `x-shopify-topic`:
  - `customers/data_request`
  - `customers/redact`
  - `shop/redact`

  **Receiver is in. Actual data redaction is currently audit-logged + stubbed with a TODO** — must be implemented end-to-end before flipping to production. See "Open work" below.
- [ ] **Privacy policy URL.** Hosted on a stable domain (NOT localhost). Required field on the Partner-app config page.
- [ ] **Production `app_url` and `redirect_urls`.** Currently set to `http://localhost:4000/...` for dev. Must point at the production API host.
- [ ] **`shopify.app.toml` `[access_scopes].scopes`** matches what the web client requests in `connectShopifySchema.scopes` default. Drift here causes silent install failures (Shopify bounces the merchant back to `app_url` with no `?code`, integration stays `pending` forever). Currently aligned to `read_orders`, `read_products`, `read_customers`, `read_fulfillments`.
- [ ] **App uninstalled webhook (`app/uninstalled`).** Shopify sends this when a merchant clicks Uninstall in their admin. We need to mark the integration `status: "disconnected"` so the dashboard reflects reality. Without this, a merchant who uninstalls on Shopify-side keeps seeing `connected` in our dashboard until they manually click trash.

### Recommended (not blockers but smooth the review)

- [ ] **App Bridge integration.** Lets the merchant launch our dashboard from inside Shopify's admin nav. Optional for unlisted; mandatory for App Store listed.
- [ ] **Billing API.** Only needed if we want Shopify to bill merchants on our behalf. Skip for now — we use Stripe + manual approval.
- [ ] **Embedded app session tokens.** Required if we use App Bridge. Skip until we add App Bridge.

## Open work tracked separately

These are listed in the project task tracker and gating the Public Distribution submission:

1. **Implement the actual data redaction sweep** for `customers/redact` and `shop/redact`. Today the receiver audit-logs and emits `console.log` with a TODO. Need to enumerate every collection that holds customer PII (`Order`, `CallLog`, future `CustomerProfile`) and write a redaction worker.
2. **Wire `app/uninstalled` webhook.** Subscribe in `registerShopifyWebhooks` and add a handler that flips integration status.
3. **Stand up the privacy policy + terms pages** on the marketing site and copy the URLs into the Partner app config.
4. **Move `app_url` + `redirect_urls`** off localhost to the production API host. Coordinate with the deploy.

## Migration play-by-play (when we're ready)

1. Implement the four open-work items above. Land them in main.
2. In Shopify Partners → Apps → `devreza` → Distribution, click "Update distribution method" → choose **Public Distribution → Unlisted**.
3. Fill in the Partner-app form: privacy URL, support email, GDPR webhook URLs (`/api/webhooks/shopify/gdpr/*`).
4. Submit for review. Expect 3–7 day turnaround for an unlisted-only first submission.
5. On approval: update marketing site with the install link `https://[devreza.shopify.com](http://devreza.shopify.com)/apps/install` (Shopify generates this).
6. The existing one-click connect flow in our dashboard keeps working unchanged — same `/admin/oauth/authorize` redirect, same callback handler.

## Fallback that always exists

The "Advanced (for developers)" disclosure in our connect dialog (`apps/web/src/app/dashboard/integrations/page.tsx`) lets a technical merchant paste their own custom-app credentials (apiKey + apiSecret + accessToken) — bypasses Shopify distribution entirely. Useful for:

- Internal pilot merchants pre-review
- Air-gapped or compliance-restricted merchants who can't install from a public URL
- Test stores during development

This stays in the product permanently as a power-user escape hatch.
