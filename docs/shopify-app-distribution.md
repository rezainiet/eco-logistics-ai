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
  - `customers/data_request` — audit-logged for merchant fulfilment (we are the processor; the merchant is the controller).
  - `customers/redact` — calls `redactCustomer({ merchantId, identifiers })` from `apps/api/src/lib/gdpr/redaction.ts`. Pseudonymises customer PII across `Order` and `CallLog` (kept rows, redacted fields), hard-deletes identity-pivoted rows in `RecoveryTask`, `TrackingSession`, and the corresponding `WebhookInbox` entries. Audit-logged with a per-collection summary.
  - `shop/redact` — calls `redactShop({ merchantId })` which hard-deletes every collection scoped to the merchant. Belt-and-braces: also flips Shopify integrations to `disconnected` in case a parallel webhook delivery is racing.
- [x] **Privacy policy + Terms of Service pages.** `apps/web/src/app/legal/privacy/page.tsx` + `apps/web/src/app/legal/terms/page.tsx`, mounted under `apps/web/src/app/legal/layout.tsx` (plain marketing chrome, no auth). Reachable at `/legal/privacy` and `/legal/terms`. Update the placeholder support email + legal entity name before submitting.
- [x] **App uninstalled webhook (`app/uninstalled`).** Subscribed by default in `registerShopifyWebhooks` (`apps/api/src/lib/integrations/shopify.ts`). Handler in `apps/api/src/server/webhooks/integrations.ts` short-circuits the inbox/ingestion path for the control-plane event and flips the integration row to `status: "disconnected"` with a clear `health.lastError` so the dashboard reflects merchant-side reality immediately.
- [x] **`shopify.app.toml` `[access_scopes].scopes`** matches what the web client requests in `connectShopifySchema.scopes` default. Drift here causes silent install failures (Shopify bounces the merchant back to `app_url` with no `?code`, integration stays `pending` forever). Currently aligned to `read_orders`, `read_products`, `read_customers`, `read_fulfillments`.
- [ ] **Production `app_url` and `redirect_urls`.** Currently set to `http://localhost:4000/...` for dev. Must point at the production API host. See `.env.example` for the full Partner-Dashboard-field-to-env-var mapping.

### Recommended (not blockers but smooth the review)

- [ ] **App Bridge integration.** Lets the merchant launch our dashboard from inside Shopify's admin nav. Optional for unlisted; mandatory for App Store listed.
- [ ] **Billing API.** Only needed if we want Shopify to bill merchants on our behalf. Skip for now — we use Stripe + manual approval.
- [ ] **Embedded app session tokens.** Required if we use App Bridge. Skip until we add App Bridge.

## Open work tracked separately

The only remaining gating item is the production deploy:

1. **Move `app_url` + `redirect_urls`** off localhost to the production API host. Coordinate with the deploy. See the "Going to PRODUCTION" block in `.env.example` for the env-var → Partner-Dashboard-field mapping.

Optional polish (not blockers):

- Wire App Bridge so the dashboard can launch from inside Shopify's admin nav. Recommended once the unlisted submission is approved.
- Hook a transactional-email surface to `customers/data_request` so the merchant gets an in-product alert instead of needing to read the audit log. The audit row is sufficient for compliance; this is UX polish.

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
