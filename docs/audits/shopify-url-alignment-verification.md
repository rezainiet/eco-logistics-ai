# URL alignment verification (toml ↔ env ↔ Partner Dashboard)

**Generated:** 2026-05-09
**Scope:** every URL/value in `shopify.app.toml`, `.env.example`,
the OAuth callback, and the listing-wording doc cross-checked
against the documented Partner-Dashboard expectations.
**Use:** carry this table to the Partner Dashboard at submission
time. Every row should be a verbatim copy-paste from one column to
another.

---

## 0. TL;DR

**Three exact-match blocks** must agree:
1. `shopify.app.toml`
2. Production env (Railway)
3. Partner Dashboard form

**One pre-existing bug found** (not a submission-blocker):
`shopify.app.toml:90` declares an app-level webhook URL that
doesn't match the per-merchant route signature. Public Distribution
Unlisted installs are unaffected because the OAuth callback path
(`registerShopifyWebhooks`) does per-shop registration with the
correct URLs. Documented as PT-1 below; recommend addressing
before any future `shopify app deploy` of v2024+ app-managed
webhooks.

---

## 1. The exact-match cross-check table

| # | Field | `shopify.app.toml` | Production env | Partner Dashboard form |
|---|---|---|---|---|
| 1 | App identity (name) | `name = "ConfirmX"` (line 22) | n/a | App name = `ConfirmX` |
| 2 | Handle | `handle = "confirmx"` (line 23) | n/a | Handle = `confirmx` |
| 3 | Client ID | `# client_id = ""` **commented out** (line 28) | `SHOPIFY_APP_API_KEY=<value>` | Configuration → Client ID |
| 4 | Client secret | NOT in toml (correct) | `SHOPIFY_APP_API_SECRET=<value>` | Configuration → Client secret |
| 5 | App URL (post-OAuth merchant landing) | `application_url = "https://app.confirmx.ai/dashboard/settings/integrations"` (line 39) | `PUBLIC_WEB_URL=https://app.confirmx.ai` | Configuration → App URL = `https://app.confirmx.ai/dashboard/settings/integrations` |
| 6 | Embedded | `embedded = false` (line 44) | n/a | Configuration → Embedded = `false` |
| 7 | OAuth redirect URL | `redirect_urls = ["https://api.confirmx.ai/api/integrations/oauth/shopify/callback"]` (line 77) | `PUBLIC_API_URL=https://api.confirmx.ai` | Configuration → Allowed redirection URL(s) = `https://api.confirmx.ai/api/integrations/oauth/shopify/callback` |
| 8 | Scopes | `scopes = "read_orders,write_orders,read_customers"` (line 69) | n/a (passed by web client at install time) | Configuration → API access scopes |
| 9 | Webhook API version | `api_version = "2024-04"` (line 82) | n/a | Webhooks (per-shop, registered at OAuth) use the same version via `registerShopifyWebhooks` |
| 10 | App-level webhook subscription URI | `uri = "https://api.confirmx.ai/api/integrations/webhook/shopify"` (line 90) | n/a | Compliance webhook UI **(see PT-1 below)** |
| 11 | GDPR — `customers/data_request` | NOT in toml (Partner-Dashboard-only) | implicit (handler at `apps/api/src/server/webhooks/shopify-gdpr.ts`) | GDPR → Customer data request URL = `https://api.confirmx.ai/api/webhooks/shopify/gdpr/customers/data_request` |
| 12 | GDPR — `customers/redact` | NOT in toml | same handler | GDPR → Customer redact URL = `https://api.confirmx.ai/api/webhooks/shopify/gdpr/customers/redact` |
| 13 | GDPR — `shop/redact` | NOT in toml | same handler | GDPR → Shop redact URL = `https://api.confirmx.ai/api/webhooks/shopify/gdpr/shop/redact` |
| 14 | Privacy URL | n/a in toml | served at `${PUBLIC_WEB_URL}/legal/privacy` | Configuration → Privacy policy URL = `https://app.confirmx.ai/legal/privacy` |
| 15 | Terms URL | n/a in toml | served at `${PUBLIC_WEB_URL}/legal/terms` | Configuration → Terms of service URL = `https://app.confirmx.ai/legal/terms` |

## 2. Cross-references with `.env.example`

| Variable | Production value | Anchor |
|---|---|---|
| `PUBLIC_API_URL` | `https://api.confirmx.ai` | `.env.example` Going-to-PRODUCTION block |
| `PUBLIC_WEB_URL` | `https://app.confirmx.ai` | same |
| `CORS_ORIGIN` | `https://app.confirmx.ai` | `shopify-go-live-checklist.md §1` |
| `NEXT_PUBLIC_API_URL` | `https://api.confirmx.ai` | `shopify-go-live-checklist.md §2` |
| `NEXTAUTH_URL` | `https://app.confirmx.ai` | same |
| `SHOPIFY_APP_API_KEY` | from Partner Dashboard Client ID | line 47 of `.env.example` |
| `SHOPIFY_APP_API_SECRET` | from Partner Dashboard Client secret | line 48 |
| `SENTRY_DSN` (optional) | from Sentry project | newly documented in `.env.example` |
| `SENTRY_RELEASE` (optional) | deploy commit SHA | same |

## 3. Listing-wording doc cross-check

`docs/shopify-listing-wording.md §Mandatory privacy webhook
endpoints` lists three URLs. Cross-check:

| Listing-wording URL | Matches toml/env? |
|---|---|
| `https://api.confirmx.ai/api/webhooks/shopify/gdpr/customers/data_request` | ✓ matches `PUBLIC_API_URL + handler path` |
| `https://api.confirmx.ai/api/webhooks/shopify/gdpr/customers/redact` | ✓ |
| `https://api.confirmx.ai/api/webhooks/shopify/gdpr/shop/redact` | ✓ |

`shopify-listing-wording.md §Install consent screen`:
- App name = `ConfirmX` ✓ matches `shopify.app.toml:22`
- Privacy policy = `https://app.confirmx.ai/legal/privacy` ✓
- Terms of service = `https://app.confirmx.ai/legal/terms` ✓
- Scopes shown = `read_orders, write_orders, read_customers` ✓ matches `shopify.app.toml:69`
- Developer name = `ConfirmX Technologies Ltd. *(TODO[brand])*`
  → DEPENDS on F2 in the gap matrix (legalName)

## 4. Code-side OAuth redirect URL builder

`apps/api/src/server/webhooks/integrations.ts:412` builds the
post-install redirect:

```ts
const dashboard = `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3001"}/dashboard/settings/integrations`;
```

This must equal the toml `application_url`. Verified:
- toml: `https://app.confirmx.ai/dashboard/settings/integrations`
- code: `${PUBLIC_WEB_URL}/dashboard/settings/integrations`

When `PUBLIC_WEB_URL=https://app.confirmx.ai` (production), they
agree. ✓

`apps/api/src/server/webhooks/integrations.ts:644` builds the
per-shop webhook callback URL passed to `registerShopifyWebhooks`:

```ts
const callbackUrl = `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/integrations/webhook/shopify/${String(integration._id)}`;
```

This is the actual webhook URL Shopify uses for live deliveries
(`orders/create`, `orders/updated`, `app/uninstalled`). The route
signature `/:provider/:integrationId` matches. ✓

## 5. Findings

### PT-1 (NEEDS POLISH, not submission-blocker) — toml app-level webhook URL doesn't match route

`shopify.app.toml:88-90`:
```toml
[[webhooks.subscriptions]]
topics = ["orders/create", "orders/updated", "app/uninstalled"]
uri = "https://api.confirmx.ai/api/integrations/webhook/shopify"
```

**Problem:** the Express route at
`apps/api/src/index.ts:275` mounts `integrationsWebhookRouter` at
`/api/integrations/webhook`, and the router's POST handler matches
`/:provider/:integrationId` — i.e. the full path is
`/api/integrations/webhook/shopify/<integrationId>`. The toml URL
omits `<integrationId>`.

**Effect for Public Distribution Unlisted:** ZERO. Per-shop
webhooks are registered at OAuth-callback time via
`registerShopifyWebhooks` using the correct per-shop URL with
`integrationId` substituted. Reviewers test the OAuth happy-path,
not the toml-declared app-level subscription. The OAuth-time path
is what runs in production.

**Effect for `shopify app dev` / `shopify app deploy`:** BROKEN.
Shopify CLI uses the toml declaration to subscribe app-level
webhooks. Those POSTs would arrive at
`/api/integrations/webhook/shopify` (no integrationId), match no
route, and 404 (or 400 if Express routes through a catch-all).

**Recommended fix (deferred — needs broader review):** either
- (a) remove the `[[webhooks.subscriptions]]` block entirely;
  rely on OAuth-time per-shop registration for everything,
  including `app/uninstalled` (which `registerShopifyWebhooks`
  already subscribes via API).
- (b) add a no-integrationId route at
  `/api/integrations/webhook/shopify` that resolves the merchant
  via `x-shopify-shop-domain` header and dispatches identically
  to the existing handler.

Option (a) is safer for the submission window. Option (b) is
necessary if we want to ship truly app-managed webhooks (which is
the v2024-04+ Shopify pattern). Neither is a Public Distribution
Unlisted submission requirement.

**Action this round:** document only. The OAuth-time per-shop
registration is the production path; the toml block is essentially
dead code for the submission.

### PT-2 (PENDING — F1 from gap matrix) — `client_id` not yet set

`shopify.app.toml:28`: `# client_id = ""` (commented out).

Action: brand/ops fills the Client ID once Partner Dashboard
issues the app credentials. 1-line edit, safe to commit (Client ID
is public).

### PT-3 (CLEAN) — direct routing of `application_url`

The `application_url` change to
`/dashboard/settings/integrations` (committed as
`d09b7a4`) means:
- Partner Dashboard's "App URL" field must be exactly this value.
- The legacy `/dashboard/integrations` route still exists as a
  query-string-preserving redirect for any external links pinned
  to the old URL.
- Reviewers will land on the canonical settings path on first
  install with no extra hop.

## 6. Submission-day checklist (from this audit)

When filling the Partner Dashboard form, the values from §1
column 4 are the source of truth. Required fields:

- [ ] App name: `ConfirmX`
- [ ] Handle: `confirmx`
- [ ] App URL: `https://app.confirmx.ai/dashboard/settings/integrations`
- [ ] Allowed redirection URL(s): `https://api.confirmx.ai/api/integrations/oauth/shopify/callback`
- [ ] Embedded: `false`
- [ ] API access scopes: `read_orders, write_orders, read_customers`
- [ ] Privacy policy URL: `https://app.confirmx.ai/legal/privacy`
- [ ] Terms of service URL: `https://app.confirmx.ai/legal/terms`
- [ ] GDPR — Customer data request: `https://api.confirmx.ai/api/webhooks/shopify/gdpr/customers/data_request`
- [ ] GDPR — Customer redact: `https://api.confirmx.ai/api/webhooks/shopify/gdpr/customers/redact`
- [ ] GDPR — Shop redact: `https://api.confirmx.ai/api/webhooks/shopify/gdpr/shop/redact`
- [ ] Developer name: registered legal entity (NOT the placeholder)
- [ ] Support contact: `support@confirmx.ai`
- [ ] App description / scope justifications: copy from
      `docs/shopify-listing-wording.md`
- [ ] Reviewer notes: copy from `docs/shopify-listing-wording.md
      §Support copy for Partner Dashboard` and link to
      `docs/shopify-reviewer-test-flow.md`

## 7. Verification

`grep -rn "confirmx.ai\|app.confirmx\|api.confirmx" shopify.app.toml .env.example apps/api/src apps/web/src docs`
returns:

- All production URLs use `confirmx.ai` (web) and `api.confirmx.ai`
  (api). No drift.
- Localhost fallbacks (`http://localhost:3001`, `http://localhost:4000`)
  are dev-only env-var defaults; they never fire when production
  env vars are set.

`grep -rn "/dashboard/integrations" shopify.app.toml apps/api/src/server/webhooks/integrations.ts apps/web/src` →

- toml: `/dashboard/settings/integrations` (canonical) ✓
- api callback redirect: `/dashboard/settings/integrations` ✓
- web legacy redirect file: `/dashboard/integrations/page.tsx`
  still exists and forwards to `/dashboard/settings/integrations`
  with query strings preserved ✓

All URL alignment verified.
