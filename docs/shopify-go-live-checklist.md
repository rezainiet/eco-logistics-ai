# Shopify go-live checklist — ConfirmX

Operational checklist for flipping the Shopify app from Custom
Distribution to **Public Distribution / Unlisted**. Each section is
the actual sequence to follow on the day-of submission.

Companion docs:
- `docs/shopify-app-distribution.md` — distribution-mode rationale and the path that brought us here
- `docs/shopify-listing-wording.md` — copy that goes into Partner Dashboard fields

---

## 1. Railway env (apps/api service)

```sh
PUBLIC_API_URL=https://api.confirmx.ai
PUBLIC_WEB_URL=https://app.confirmx.ai
CORS_ORIGIN=https://app.confirmx.ai
SHOPIFY_APP_API_KEY=<from Partner Dashboard → ConfirmX → Configuration → Client ID>
SHOPIFY_APP_API_SECRET=<from same panel → Client secret — NEVER commit>
NODE_ENV=production
TRUSTED_PROXIES=<Railway proxy CIDR or "uniquelocal,linklocal">
```

Plus the production-required vars already documented in `.env.example`:
`REDIS_URL`, `MONGODB_URI`, `ADMIN_SECRET`, `COURIER_ENC_KEY`,
`JWT_SECRET`, `NEXTAUTH_SECRET`.

`COURIER_ENC_KEY` rotation note: this key is the AES-256-GCM key
used to encrypt every Shopify access token at rest. Rotating it
invalidates every stored token; merchants would need to reconnect.
Don't rotate without a planned reconnect campaign.

## 2. Railway env (apps/web service)

```sh
NEXT_PUBLIC_API_URL=https://api.confirmx.ai
NEXTAUTH_URL=https://app.confirmx.ai
NEXTAUTH_SECRET=<random ≥32 chars; same value across all web instances>
```

If web and api share a Railway project, the api's `PUBLIC_*` vars
and the web's `NEXT_PUBLIC_API_URL` must agree on the canonical
hostnames. Mismatch shows up as silent install failures (the OAuth
callback redirects to a host the user isn't on, looks like a hung
install screen).

## 3. Partner Dashboard configuration

In `partners.shopify.com` → Apps → ConfirmX → Configuration:

| Field | Value |
|---|---|
| App URL | `https://app.confirmx.ai/dashboard/integrations` |
| Allowed redirection URL(s) | `https://api.confirmx.ai/api/integrations/oauth/shopify/callback` |
| Privacy policy URL | `https://app.confirmx.ai/legal/privacy` |
| Terms of service URL | `https://app.confirmx.ai/legal/terms` |
| GDPR — customers/data_request | `https://api.confirmx.ai/api/webhooks/shopify/gdpr/customers/data_request` |
| GDPR — customers/redact | `https://api.confirmx.ai/api/webhooks/shopify/gdpr/customers/redact` |
| GDPR — shop/redact | `https://api.confirmx.ai/api/webhooks/shopify/gdpr/shop/redact` |
| Embedded | `false` (external app, no App Bridge) |

These must match the values in `shopify.app.toml` exactly. Drift
between toml and dashboard causes silent install failures
(merchant lands on `app_url` with no `?code` and the integration
row stays `pending` forever).

App description / scope justifications: copy from
`docs/shopify-listing-wording.md`.

## 4. Pre-submission grep checklist

```sh
grep -r "TODO\[brand\]" packages apps
```

Currently flags:
- `packages/branding/src/defaults.ts` — `legalName` + 5 emails
- `apps/web/src/app/legal/privacy/page.tsx` — optional physical-address line
- `apps/web/src/app/legal/terms/page.tsx` — optional jurisdiction clause

All must be resolved before flipping to Public Distribution.

## 5. Other pre-submission work

- [ ] Replace logo asset files in `apps/web/public/brand/`
  (`logo.svg`, `logo-mono.svg`, `email-logo.png`, `og.png`,
  `apple-touch-icon.png`, `favicon.ico`). Branding package
  references the URLs; the artwork at those URLs needs to be
  ConfirmX, not Cordon.
- [ ] Verify `support@confirmx.ai` + `privacy@confirmx.ai` accept
  mail. Reviewers test delivery.
- [ ] Spot-check the dashboard on `app.confirmx.ai` in an
  authenticated browser session — no CORS errors in DevTools, no
  references to "Cordon" anywhere in rendered surfaces (run a
  fresh sweep right before submit).
- [ ] Run the OAuth flow end-to-end on a fresh Shopify dev store
  to confirm: install → callback → webhooks register → first
  order webhook arrives → operator review queue surfaces it.

## 6. Distribution flip

In Partners → Apps → ConfirmX → Distribution:

1. "Update distribution method" → **Public Distribution / Unlisted**
2. Fill the submission form. Use the copy from
   `docs/shopify-listing-wording.md`.
3. Submit for review.
4. Expect 3–7 day turnaround for an unlisted-only first submission.

## 7. Post-approval

- [ ] Publish the install link Shopify generates on the marketing
  site (replace any current "Connect Shopify" CTAs that point at
  a custom-app flow).
- [ ] Bulk-retry webhook registrations for any test merchants
  connected during dev — their callback URL still points at the
  old API host until they reconnect or we trigger
  `retryShopifyWebhooks` per merchant. The simplest path is to
  reconnect ONE pilot merchant via the Shopify-side approval flow
  (verifies the production OAuth callback works end-to-end), then
  bulk-retry the rest.
- [ ] Remove the "Custom Distribution" fallback from any merchant-
  facing copy if we no longer need it. The Advanced-panel custom-
  app path stays as a power-user escape hatch.

## 8. What we are deliberately NOT doing for this submission

- App Bridge / embedded experience — deferred. Architectural
  decision per the operational-tone direction; revisit
  post-approval.
- Shopify Billing API — skipped. Stripe + manual bKash/Nagad
  remains primary.
- App Store listed (vs unlisted) — separate review with marketing
  copy + screenshots. Pursue later if/when we want top-of-funnel
  discovery via App Store search.
- App Bridge session tokens — N/A without App Bridge.

## 9. Rollback plan

If the production deploy goes wrong AFTER flipping the Partner-app
to Public Distribution:

1. Revert the env-var changes on Railway (re-deploy with previous
   `PUBLIC_API_URL` etc).
2. The Partner-app distribution mode CANNOT be flipped back to
   Custom without losing every merchant install. So if a
   show-stopping bug surfaces in production:
   - Disconnect existing test installs via the merchant-side
     uninstall flow (or `revokeShopifyAccessToken` per merchant).
   - Fix the bug.
   - Re-deploy.
   - Have merchants re-install via the same install URL.

The Custom Distribution → Public Distribution flip is largely
one-way; treat it as a serious cutover, not a soft launch.
