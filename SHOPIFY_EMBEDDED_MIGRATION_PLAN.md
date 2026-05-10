# ConfirmX → Shopify Embedded App Migration Plan

**Goal:** Convert ConfirmX from a non-embedded Shopify app to an embedded app with App Bridge + Token Exchange, **without** rewriting the product. Unlock Shopify's expiring offline tokens to fix the live `403 Non-expiring access tokens are no longer accepted` error.

**Constraint:** Preserve all working surfaces — onboarding, dashboard UX, tRPC, NextAuth, workers, webhooks, integrations, billing.

---

## 1. SAFE TO KEEP AS-IS

These survive embedded mode unchanged. **Do not touch.**

| Surface | File / Path | Why it survives |
|---|---|---|
| API server (Express + tRPC) | `apps/api/**` | API runs out-of-frame at `api.confirmx.ai`. Embedded mode is a frontend concern. |
| All Mongoose models | `packages/db/**` | DB schema unaffected. |
| BullMQ workers | `apps/api/src/workers/**` | Background jobs are server-side. |
| Webhook ingestion (`/api/integrations/webhook/shopify/...`) | `apps/api/src/server/webhooks/integrations.ts` | HMAC-verified inbound webhooks; not user-facing. |
| `registerShopifyWebhooks()` topics + idempotency logic | `apps/api/src/lib/integrations/shopify.ts` | Topic registration uses Admin API with the merchant's access token — works the same once tokens are valid. |
| `ensureFreshShopifyAccessToken()` rotation helper | `apps/api/src/lib/integrations/shopify-token-refresh.ts` | This is the *whole point* of the migration — embedded mode finally feeds it expiring tokens to rotate. |
| `completeShopifyInstall` Mongo upsert + claim Redis flow | `apps/api/src/server/routers/integrations.ts` | Already round-trips `expiresIn`/`refreshToken` correctly. Embedded mode just guarantees Shopify sends them. |
| Public install entry endpoint (HMAC validation, nonce, Redis stash) | `apps/api/src/server/webhooks/shopify-install.ts` | Still the entry point Shopify hits on install initiation — the redirect target changes (see §6). |
| Issues page / listIssues integration-health surfacing | `apps/api/src/server/routers/integrations.ts` + `apps/web/src/app/dashboard/settings/integrations/issues/page.tsx` | Dashboard is dashboard, embedded or not. |
| All dashboard pages (Orders, Order verification, Recovery, Couriers, Analytics, Behavior, Billing, Settings/*) | 24 routes under `apps/web/src/app/dashboard/` | Pages render the same; only the **auth wrapper around them** changes (see §3, §5). |
| tRPC schemas + routers | `apps/api/src/server/routers/**` + `packages/types/**` | Wire format unchanged. |
| Toast / Smart-error / Loading shell / shadcn primitives | `apps/web/src/components/**` | UI components are pure render. |
| Mongoose Integration model fields | `packages/db/src/models/Integration.ts` | `credentials.refreshToken` + `accessTokenExpiresAt` already there. |
| Workers / cron / replay logic | `apps/api/src/workers/orderSync.worker.ts`, `apps/api/src/workers/commerceImport.ts`, `apps/api/src/server/ingest.ts` | Server-side; unaffected. |
| Brand assets, marketing site, pricing | `apps/web/src/app/(marketing)/**`, `apps/web/public/**` | Outside `/dashboard` and `/install` routes. |

---

## 2. MUST CHANGE

| # | What | Where | Why |
|---|---|---|---|
| M1 | `embedded = true` + scopes shape | `shopify.app.toml` lines 44, 53 | Tells Shopify to issue session tokens / accept Token Exchange. Without it, you stay on legacy non-expiring tokens. |
| M2 | OAuth code-grant → **Token Exchange** for the install path | `apps/api/src/lib/integrations/shopify.ts` (new function) + `apps/api/src/server/webhooks/integrations.ts` callback | Token Exchange is what unlocks expiring offline access tokens with `refresh_token`. |
| M3 | App Bridge mounted in app shell | New: `apps/web/src/app/(embedded)/layout.tsx` + small client component | Required for session-token minting inside the iframe. |
| M4 | CSP `frame-ancestors` + drop `X-Frame-Options: DENY` | `apps/web/next.config.mjs` lines 106–149 | Shopify must be allowed to iframe us. Currently blocked outright. |
| M5 | All `signOut({ callbackUrl: '/login' })` redirects | `apps/web/src/components/shell/topbar.tsx:266`, `command-palette.tsx:249`, `auth/token-refresh-keeper.tsx:59-60` | Inside iframe, these reload Shopify Admin's iframe to `/login` — the frame goes blank from Shopify's perspective. Replace with `signOut({ redirect: false })` plus a Shopify-aware re-auth nudge. |
| M6 | `router.push("/login")` after auth fail in `signup/page.tsx:71` and `login/page.tsx:51`, plus `router.replace(...)` in `install/shopify/complete/finalize-client.tsx:40,94` | Same files | App Router pushes inside iframe re-render the iframe; safe IF target stays inside our origin and inside the embedded layout. Mostly OK after M3 lands, but we should audit the redirect targets. |
| M7 | `window.open(installUrl, '_blank')` | `apps/web/src/app/dashboard/settings/integrations/page.tsx:396` | Popups blocked in iframe context. Must use `window.parent.location.assign()` for **top-level** redirect to Shopify authorize, or App Bridge `Redirect.create()`. |
| M8 | NextAuth credentials login flow as the *primary* auth on `/dashboard/*` | Whole `(auth)/login`, `(auth)/signup`, NextAuth config | Inside Shopify Admin iframe, the merchant is *already authenticated by Shopify*. We should accept App Bridge session tokens and exchange them for our own JWT, not ask the merchant to type their email + password again. The existing NextAuth login still serves *direct* (non-iframe) access. |
| M9 | The `/install/shopify/complete` claim page | `apps/web/src/app/install/shopify/complete/*` | Today this page assumes a NextAuth session. After M8, the embedded path should auto-claim via App Bridge session token; the legacy path remains for direct installs. |
| M10 | `app/uninstalled` webhook signal handling | `apps/api/src/server/webhooks/integrations.ts` (already exists, verify) | Confirm it deactivates the row (not just disconnects, which keeps the slot). Embedded mode makes uninstall the canonical "merchant left" signal. |
| M11 | `application_url` in `shopify.app.toml` | line 39 | Currently points at `app.confirmx.ai/dashboard/settings/integrations`. For embedded, this URL is what Shopify renders inside the iframe **and** is the App Bridge config root. Should still resolve to a page that mounts App Bridge. Keep the path; just make sure it works inside iframe. |
| M12 | CORS allowlist for the API | `apps/api/src/index.ts:283` | Add Shopify Admin origin (`https://admin.shopify.com`) to `CORS_ORIGIN` for Token Exchange requests if any frontend code talks to api directly with cookies under the iframe. (Most calls remain bearer-token, so this is double-checking.) |

---

## 3. HIGH-RISK AREAS

Areas where a wrong move silently breaks production.

| Risk | What goes wrong | Mitigation |
|---|---|---|
| **R1 — CSP / `X-Frame-Options`** | Shopify renders us in an iframe; `X-Frame-Options: DENY` (currently in `next.config.mjs:149`) makes the iframe blank. Browser console shows a one-line refusal; merchant just sees nothing. | Drop `X-Frame-Options` for `/dashboard/*`, `/install/*`, `/embedded/*`. Add `Content-Security-Policy: frame-ancestors https://admin.shopify.com https://*.myshopify.com`. Keep `frame-ancestors 'none'` on `/login`, `/signup`, marketing pages. |
| **R2 — Cookie SameSite / partitioned cookies** | `access_token` cookie is `sameSite: strict`. Inside Shopify's iframe (different top-level origin), browsers won't send strict cookies on cross-site embedded requests. Result: every API call 401s, refresh storm. | Don't rely on cookies inside the iframe. In embedded mode, **carry the bearer token only**. Either (a) make the API stateless when called from embedded, using `Authorization: Bearer <jwt>` only, or (b) switch cookies to `sameSite: 'none'` + `secure: true` + `partitioned: true` (Chrome's CHIPS) for the embedded path. Path (a) is safer. |
| **R3 — NextAuth session cookie in iframe** | Same problem: NextAuth's session cookie is HttpOnly and SameSite-restricted. Inside iframe, the session cookie may not be readable on every request. | In embedded mode, **don't use NextAuth on dashboard pages**. Use App Bridge session token → exchange for our JWT → stash in memory (React state / Zustand). NextAuth stays for the direct (non-iframe) login route. |
| **R4 — Two parallel auth systems** | M8 introduces a second auth path. If routing logic accidentally trips both, sessions can desync. | Decide *at the layout level* which path is in use. `(embedded)` layout uses App Bridge; `(dashboard-direct)` layout uses NextAuth. No code path checks both. The merchant's installed-shop status determines which they hit. |
| **R5 — Webhook `app/uninstalled` arriving late** | Merchant uninstalls on Shopify, our row stays "connected" because uninstall webhook is delayed/dropped. They hit Connect, capacity check 1/1 blocks them. | Already partially handled by the testConnection auto-disconnect, plus listIssues now surfaces it. Verify the `app/uninstalled` handler hard-deletes the row OR the capacity check excludes `disconnected`. Currently: capacity check excludes `disconnected` ✓ (entitlements.ts:106). |
| **R6 — In-iframe Shopify OAuth popup blocked** | The `window.open(installUrl)` in `dashboard/settings/integrations/page.tsx:396` opens a popup that browsers will block inside iframe. Merchant clicks Connect, nothing happens. | Replace with App Bridge `Redirect.create({}).dispatch(Redirect.Action.REMOTE, installUrl)` — this asks Shopify Admin (the parent frame) to perform the navigation safely. |
| **R7 — `next-auth/react` `signOut()` redirect** | Inside iframe, `signOut({ callbackUrl: '/login' })` reloads the iframe to `/login`. Shopify Admin sees a blank ConfirmX panel. | Add `redirect: false` and instead message the user via App Bridge toast that they should reinstall, or force a parent-frame redirect via App Bridge. |
| **R8 — Token Exchange clock skew** | Token Exchange JWT `exp` checks are strict. Server clock drift → exchange fails. | We already use 5s clock tolerance in `apps/api/src/server/trpc.ts`. Verify Railway containers are NTP-synced (they are, by default on Linux). Don't change anything unless you see drift errors. |
| **R9 — `embedded = true` is forward-only** | Once an existing merchant has installed the legacy non-embedded version, switching the app to embedded *for that merchant's grant* requires reinstall. Merchants don't see a polite migration banner. | Coordinate with merchants on a controlled cutover: send a "please reinstall" email, give them a one-click reinstall URL, and gate the dashboard with a "your install is on the legacy auth path — please reinstall" banner. The banner detects legacy by the absence of `credentials.refreshToken` on the Integration row. |
| **R10 — App Bridge version pin** | App Bridge has had breaking changes between v3 and v4. Pinning to a stale version breaks new Shopify policies. | Use `@shopify/app-bridge@latest` major (currently v4) and follow Shopify's "updates" RSS for breakages. Don't pin minor versions in `package.json`. |
| **R11 — Two install entry points** | Today: `/api/shopify/install` + Partner Dashboard "Test on store" both hit the same OAuth code grant. After Token Exchange migration, these need different handling. | Keep `/api/shopify/install` as the *entry* for both, but inside the iframe (post-install), the dashboard pages use App Bridge session tokens for ALL further communication with our API. The install endpoint itself doesn't change. |

---

## 4. LOW-RISK MIGRATIONS

Changes with small blast radius. Land these first to build confidence.

| # | Change | File | Effort |
|---|---|---|---|
| L1 | `embedded = true` in toml | `shopify.app.toml:44` | 1 line |
| L2 | Webhook API version bump (toml says 2024-04, Partners says 2026-04 — sync them) | `shopify.app.toml:82` | 1 line |
| L3 | CSP changes for `frame-ancestors` on dashboard / install routes | `apps/web/next.config.mjs:106-149` | ~20 lines, scoped to specific pathPatterns |
| L4 | Remove `X-Frame-Options: DENY` from dashboard / install routes | same file, line 149 | 5 lines |
| L5 | Add `@shopify/app-bridge-react` dependency | `apps/web/package.json` | npm install |
| L6 | Drop-in `<AppBridgeProvider>` at the root of `(embedded)` layout group | new file | ~30 lines |
| L7 | Replace `window.open(installUrl, '_blank')` with App Bridge `Redirect` | `apps/web/src/app/dashboard/settings/integrations/page.tsx:396` | ~5 lines, gated on `isEmbedded()` |
| L8 | Replace `signOut({ callbackUrl: '/login' })` with iframe-safe alternative in 3 sites | topbar, command-palette, token-refresh-keeper | ~30 lines |
| L9 | Tighten `target="_blank"` external links to also work in iframe (most already do; just verify) | `smart-error.tsx`, etc. | audit-only |
| L10 | Update `application_url` in toml + Partner Dashboard if URL changes | `shopify.app.toml:39` | 1 line + Partners click |

---

## 5. EMBEDDED AUTH PLAN

The shape of the new embedded auth, side by side with what stays.

```
┌────────────────────────────────────────────────────────────────────────┐
│  Direct (non-embedded) entry:  https://app.confirmx.ai/login           │
│    ↓                                                                   │
│  NextAuth credentials (email + password)                               │
│    ↓                                                                   │
│  Existing JWT with apiToken — UNCHANGED                                │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│  Embedded entry: Shopify Admin → ConfirmX panel iframe                 │
│    ↓                                                                   │
│  App Bridge mounts → getSessionToken() returns short-lived JWT          │
│    ↓                                                                   │
│  Frontend POSTs session token to /auth/shopify/exchange (NEW)          │
│    ↓                                                                   │
│  API verifies session token (Shopify JWKS) → resolves merchant         │
│    by `dest` claim (shop) → mints OUR access token (existing JWT       │
│    issuance, same shape, same secret)                                  │
│    ↓                                                                   │
│  Frontend stashes apiToken in memory (NOT in cookies, NOT in           │
│    NextAuth session inside iframe)                                     │
│    ↓                                                                   │
│  All subsequent tRPC calls: `Authorization: Bearer <apiToken>`         │
│    — exactly what providers.tsx already does                           │
└────────────────────────────────────────────────────────────────────────┘
```

**Key insight:** the API doesn't need to change much. Our existing JWT + protectedProcedure flow already accepts `Authorization: Bearer <token>`. We're adding ONE new endpoint (`/auth/shopify/exchange`) that exchanges Shopify session tokens for our own JWT. The dashboard tRPC pipe is unchanged.

**Files that change for M5:**
- `apps/api/src/server/routes/auth.ts` (new endpoint or extend existing) — verify Shopify session token, resolve merchant, return our JWT
- `apps/api/src/server/auth.ts` — add `verifyShopifyAppBridgeSessionToken()` using Shopify's JWKS (`https://shopify.dev/.well-known/jwks.json` — actually `https://<shop>/.well-known/jwks.json` per shop)
- `apps/web/src/app/(embedded)/layout.tsx` (new) — mounts App Bridge, exchanges session token, populates a React context with our JWT for the tRPC client to read
- `apps/web/src/app/providers.tsx` — extend to accept JWT from React context (embedded path) OR NextAuth session (direct path)

---

## 6. TOKEN EXCHANGE PLAN

Shopify's Token Exchange is what unlocks expiring offline tokens for non-popup install flows. Two distinct flows:

### 6a. Online session tokens (frontend → backend, every request)
- App Bridge `getSessionToken()` returns a short-lived (~1 min) JWT signed by Shopify
- Backend verifies signature against Shopify JWKS
- Backend either:
  - Issues OUR JWT for our session (merchant identification — this is what we'll do)
  - Uses Token Exchange API to mint an offline access token for the shop (only on first-time encounter)

### 6b. Offline access token via Token Exchange (server → Shopify, on install)
- After the App Bridge handshake, on first encounter of a new shop:
  1. Backend calls Shopify's Token Exchange endpoint: `POST https://<shop>/admin/oauth/access_token`
  2. Body: `client_id`, `client_secret`, `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<App Bridge session token>`, `subject_token_type=urn:ietf:params:oauth:token-type:id_token`, `requested_token_type=urn:shopify:params:oauth:token-type:offline-access-token`
  3. Response: `{ access_token, scope, expires_in (typically 86400), refresh_token }`
  4. Persist via the same path `completeShopifyInstall` already uses (refreshToken + accessTokenExpiresAt encrypted)

**Files that change:**
- `apps/api/src/lib/integrations/shopify.ts` — add `exchangeSessionTokenForOfflineToken({ shop, sessionToken, apiKey, apiSecret })`. Wraps the Token Exchange POST. Returns the same `ShopifyOAuthExchangeResult` shape as `exchangeShopifyCode` so the persist path is identical.
- `apps/api/src/server/routes/auth.ts` (or wherever the new exchange endpoint lives) — calls the offline exchange on first encounter, persists Integration row.

**Note:** the existing OAuth code-grant flow (`/api/shopify/install` → authorize → `/oauth/shopify/callback`) **stays** as a fallback for the unlisted public-distribution path. Token Exchange is the *embedded-app* path, used after App Bridge mounts.

---

## 7. APP BRIDGE INTEGRATION PLAN

```
apps/web/src/app/
├── (embedded)/                       ← NEW route group
│   ├── layout.tsx                    ← mounts <AppBridgeProvider>
│   ├── _components/
│   │   ├── app-bridge-provider.tsx   ← wraps Provider
│   │   ├── session-token-bridge.tsx  ← exchanges → our JWT, sets context
│   │   └── shopify-auth-context.tsx  ← React Context exposing { apiToken, isLoading, error }
│   └── (existing pages re-mounted under this group, OR a "shell" that
│       renders the existing /dashboard tree)
├── dashboard/                        ← existing routes UNCHANGED
└── (auth)/                           ← existing direct-login UNCHANGED
```

**Key decisions:**

1. **Don't fork the dashboard.** Have the `(embedded)` group's layout render a wrapping `<EmbeddedShell>` that mounts App Bridge + the auth context, and inside it `<DashboardShell>` and the existing pages render normally. That way, every dashboard page works in BOTH contexts.

2. **`isEmbedded()` detection** — a tiny utility that checks `window.top !== window.self` AND a Shopify host param (`?host=...`). Used in:
   - `topbar.tsx` to decide whether to show Sign Out vs no-op
   - `integrations/page.tsx` to decide whether to use App Bridge `Redirect` vs `window.open`
   - `token-refresh-keeper.tsx` to decide whether to redirect to `/login` on refresh failure

3. **App Bridge config:**
   ```
   apiKey: process.env.NEXT_PUBLIC_SHOPIFY_APP_API_KEY
   host:   from URL query param (Shopify always passes ?host=...)
   forceRedirect: true   (kicks the merchant out of a non-embedded view back to admin)
   ```

4. **Don't reinvent App Bridge UI primitives.** Keep using shadcn for everything. App Bridge gives us:
   - Session tokens
   - Cross-frame Redirect
   - Toast (optional; we have our own)
   - `Loading` indicator (optional; we have our own)
   We use App Bridge ONLY for the auth + redirect primitives.

---

## 8. IFRAME ROUTING PLAN

Inside the iframe, all navigation goes through one of three paths:

| Navigation type | Tool | Used for |
|---|---|---|
| **In-iframe, same origin** | `next/navigation` `router.push/replace` | Moving between dashboard pages — works as-is, the iframe re-renders our app. No change. |
| **Top-level redirect (out of iframe)** | App Bridge `Redirect.create().dispatch(Redirect.Action.REMOTE, url)` | Going to Shopify OAuth authorize, opening external help articles, "Reconnect" links to Partner Dashboard. Replaces `window.open(url, '_blank')` in the embedded path. |
| **Logout / session-end** | App Bridge `Redirect.dispatch(Redirect.Action.APP, '/login')` (loops back into iframe at our login) **OR** simply `setApiToken(null)` and let `<EmbeddedShell>` re-run the session token exchange | Today's `signOut({ callbackUrl: '/login' })` is wrong inside iframe. The cleanest replacement: drop our token in memory, App Bridge will re-mint a session token and we'll re-exchange it. The merchant never sees a login form inside the embedded experience because Shopify already authenticated them. |

**Routes inside `(embedded)` should NEVER contain:**
- `/login`, `/signup`, `/forgot-password` — embedded merchants don't authenticate via password
- Marketing routes (`/pricing`, `/`, etc.)
- The `(auth)` group's pages

---

## 9. SESSION STRATEGY

Two parallel auth surfaces, sharing the same backend JWT format. Decision tree at request time:

```
Request hits API protectedProcedure
  ↓
Has `Authorization: Bearer <token>` header?
  Yes → verify our JWT (existing path) → done
  No  → fall back to access_token cookie (existing path) → done

Request from web — how was the bearer obtained?
  ┌── Direct (non-iframe) path ──────────────────────────────┐
  │ 1. /login form posts email + password to NextAuth        │
  │ 2. NextAuth calls /auth/login → API issues JWT           │
  │ 3. JWT stored in NextAuth session                        │
  │ 4. providers.tsx reads session.apiToken into Bearer header
  └──────────────────────────────────────────────────────────┘

  ┌── Embedded (Shopify iframe) path ────────────────────────┐
  │ 1. Shopify iframes app.confirmx.ai/?host=...             │
  │ 2. <EmbeddedShell> mounts App Bridge                     │
  │ 3. App Bridge getSessionToken() → short-lived JWT        │
  │ 4. POST /auth/shopify/exchange { sessionToken } → API     │
  │ 5. API verifies Shopify JWT, resolves merchant by `dest` │
  │ 6. API returns { apiToken } (same JWT format)            │
  │ 7. Stash apiToken in React context                       │
  │ 8. providers.tsx reads context.apiToken into Bearer      │
  │ 9. Token expiring soon → re-fetch session token from App │
  │    Bridge → re-exchange. Never call /auth/refresh.       │
  └──────────────────────────────────────────────────────────┘
```

**Refresh strategy in embedded mode:**
- `<TokenRefreshKeeper>` is REPLACED inside `(embedded)` by a smaller component that re-runs `getSessionToken()` + `/auth/shopify/exchange` whenever a 401 is observed
- The existing `<TokenRefreshKeeper>` continues to work in direct mode

**Merchant identification:**
- Shopify session token's `dest` claim contains the shop URL (e.g. `https://eco-logistics-test-bd.myshopify.com`)
- The API `/auth/shopify/exchange` looks up the Integration by `accountKey == <shop>` and follows it back to the merchantId
- If no Integration exists, the API performs Token Exchange to mint an offline token, creates the Integration row, then issues our JWT

---

## 10. MIGRATION EXECUTION ORDER

Land changes in this order. Each step is independently shippable and reversible.

### Phase A — Defensive prep (1 day, zero behavior change)

1. **A1.** Update `shopify.app.toml` API version to match Partner Dashboard (`2026-04`). Sync Partner Dashboard via `shopify app deploy`. *Risk: low. Rollback: revert toml.*
2. **A2.** Add `@shopify/app-bridge-react` and `@shopify/shopify-api` (server-side JWT verify) to `apps/web/package.json` and `apps/api/package.json`. Don't import them yet. *Risk: zero — unused imports.*
3. **A3.** Add `isEmbedded()` utility in `apps/web/src/lib/embedded.ts`. Pure function, returns false unconditionally for now. *Risk: zero.*
4. **A4.** Add `<EmbeddedBanner>` component that renders nothing today, but in Phase D shows "Your installation needs to be migrated — click Reconnect" to legacy installs.

**Checkpoint:** run all existing flows. Nothing should change. Deploy.

### Phase B — Backend Token Exchange support (2 days)

5. **B1.** In `apps/api/src/lib/integrations/shopify.ts`, add `exchangeSessionTokenForOfflineToken({ shop, sessionToken, apiKey, apiSecret })`. Same return shape as `exchangeShopifyCode`. *Risk: low — new function, not called by existing code.*
6. **B2.** In `apps/api/src/server/auth.ts`, add `verifyShopifyAppBridgeSessionToken(token)` using `shopify-api`'s JWT helpers. Returns `{ shop, dest, sub, exp }` or throws. *Risk: low — new function.*
7. **B3.** Add `POST /auth/shopify/exchange` endpoint:
   - Verify Shopify session token (B2)
   - Look up Integration by shop → merchantId
   - If no Integration: call B1 to mint offline token, create Integration row (reuse existing upsert from `completeShopifyInstall`)
   - Issue our JWT for the merchant (reuse existing `issueAccessToken` / `setAuthCookies` minus the cookies — return just the JWT in the body)
   - Return `{ apiToken, csrfToken, merchantId, shop }`
   *Risk: medium — new endpoint, but doesn't touch existing auth paths.*
8. **B4.** Add API integration test: post a fake-but-valid session token (mocked verify), confirm the endpoint returns a JWT. *Test, not behavior change.*

**Checkpoint:** existing OAuth code-grant flow still works. Deploy.

### Phase C — Frontend embedded shell (2-3 days)

9. **C1.** Create `apps/web/src/app/(embedded)/layout.tsx` and `app-bridge-provider.tsx`. Initially: just renders children, mounts App Bridge, swallows session token errors silently. *Risk: low — route group is new and unrouted.*
10. **C2.** Create `<ShopifyAuthContext>` and the session-token-bridge component that exchanges and populates context. *Risk: low.*
11. **C3.** Mirror the existing `/dashboard/*` routes under `/(embedded)/dashboard/*` — but rather than copying, use Next.js parallel routes or a wrapper that imports the same page components. **Decision point:** decide whether to use route groups (`(embedded)` and `(direct)`) or a single tree with conditional layout. Prefer route groups for clarity. *Risk: medium — new route surface.*
12. **C4.** Update `apps/web/src/app/providers.tsx` to read the apiToken from EITHER NextAuth session OR ShopifyAuthContext. *Risk: medium — touches the tRPC client init.*
13. **C5.** Replace `window.open(installUrl, '_blank')` in `apps/web/src/app/dashboard/settings/integrations/page.tsx:396` with `Redirect.create()` when `isEmbedded()`. Keep `window.open` as fallback for non-embedded. *Risk: low — gated.*
14. **C6.** Replace the three `signOut({ callbackUrl: '/login' })` sites with `if (isEmbedded()) setApiToken(null) else signOut({ callbackUrl: '/login' })`. *Risk: low.*

**Checkpoint:** non-embedded direct dashboard still works exactly as today. Embedded route group renders inside iframe, exchanges session token, loads the dashboard. Deploy.

### Phase D — Iframe-safe headers + toml flip (1 day, the irreversible step)

15. **D1.** Update `apps/web/next.config.mjs`: drop `X-Frame-Options` for `/dashboard/*`, `/install/*`, `/(embedded)/*`. Add `frame-ancestors https://admin.shopify.com https://*.myshopify.com` for those paths. Keep tight CSP elsewhere. *Risk: medium — affects every web request. Test with browser security headers analyzer.*
16. **D2.** Set `embedded = true` in `shopify.app.toml`. *Risk: high — irreversible without a Partners-side toggle. Schedule cutover.*
17. **D3.** Run `shopify app deploy` and release the new app version. *Risk: high — Shopify starts issuing new install behavior to all NEW merchants. Existing merchants stay on legacy until they reinstall.*

**Checkpoint:** test fresh install on a clean dev store. Verify session token round-trip, integration row has `refreshToken` + `accessTokenExpiresAt`, Admin API call succeeds without 403.

### Phase E — Migration of existing merchants (ongoing, opt-in)

18. **E1.** In the dashboard, render `<EmbeddedBanner>` on rows where `credentials.refreshToken` is missing. Banner explains "Your install uses the legacy auth path. Reconnect to upgrade." Button: "Reconnect."
19. **E2.** "Reconnect" triggers the install URL again; merchant goes through Shopify consent; new install lands on the modern path.
20. **E3.** Email existing merchants once with the same message. Track migration progress via Mongo aggregation: `% of connected integrations with refreshToken set`.

### Phase F — Cleanup (1 day, after all merchants migrated)

21. **F1.** Remove the legacy OAuth code-grant fallback path from the OAuth callback (`apps/api/src/server/webhooks/integrations.ts`). Token Exchange becomes the only path.
22. **F2.** Remove the `<EmbeddedBanner>` component.
23. **F3.** Optionally collapse the `(embedded)` and `(direct)` route groups back into one, since the direct path is now a degenerate case.

---

## 11. ESTIMATED COMPLEXITY BY STEP

| Phase | Step | Code lines (rough) | Risk | Wall clock |
|---|---|---|---|---|
| A | Defensive prep | ~50 | Low | 0.5 days |
| B1 | `exchangeSessionTokenForOfflineToken` | ~80 | Low | 0.5 days |
| B2 | `verifyShopifyAppBridgeSessionToken` | ~40 | Low | 0.5 days |
| B3 | `POST /auth/shopify/exchange` | ~120 | Medium | 1 day |
| B4 | API test for B3 | ~60 | Low | 0.5 days |
| C1 | `(embedded)/layout.tsx` | ~80 | Low | 0.5 days |
| C2 | Auth context + session-token-bridge | ~150 | Medium | 1 day |
| C3 | Route group structure | ~varies | Medium-high | 1 day |
| C4 | Update `providers.tsx` to consume both auth sources | ~40 | Medium | 0.5 days |
| C5 | Replace `window.open` with Redirect | ~30 | Low | 0.25 days |
| C6 | Replace 3× `signOut` redirects | ~30 | Low | 0.25 days |
| D1 | CSP + X-Frame-Options changes | ~40 | Medium | 0.5 days |
| D2 | `embedded = true` in toml | 1 line | High (cutover) | scheduled |
| D3 | `shopify app deploy` + release | — | High | scheduled |
| E1-E3 | Legacy migration banner + email | ~80 | Low | 1 day |
| F1-F3 | Cleanup | ~varies | Low | 1 day |

**Total estimated effort:** ~8-10 working days for Phases A-D (the actual cutover). Phases E-F are operational tail.

**Critical path:** B3 → C2 → C4 → D1 → D2.

**Reversibility:**
- Phases A, B, C are fully reversible (no production behavior change until D).
- D2 (`embedded = true`) is reversible only by setting back to `false` and re-deploying. Existing embedded installs will break until they reinstall.
- E and F are operational; no rollback considerations beyond standard release reverts.

---

## RECOMMENDED DECISION CHECKPOINTS BEFORE CODING STARTS

1. **Confirm the App Store distribution intent.** Public Distribution / Listed → embedded is required. Custom Distribution → embedded is optional but recommended. Unlisted (current) → embedded fixes the 403.
2. **Decide route structure for embedded vs direct.** Route groups (`(embedded)` / `(direct)`) is the cleanest. Single tree with conditional layout is faster but messier. Recommendation: route groups.
3. **Decide whether to keep direct (non-iframe) login.** Direct login is useful for ops, debugging, and merchants who want a non-iframe experience. Recommendation: keep it.
4. **Cutover scheduling.** Phase D should be done at low-traffic time with the migration banner ready in advance.
5. **Existing-merchant migration tolerance.** How many merchants are on legacy installs today? The smaller the number, the more aggressive the cutover can be.

---

## OUT OF SCOPE FOR THIS PLAN

- Replacing tRPC. Not necessary; tRPC works fine inside iframe with bearer tokens.
- Replacing NextAuth entirely. Direct login still uses it; embedded path bypasses it.
- Rewriting onboarding. The new merchant flow inside iframe just skips the email/password form because Shopify already authenticated them.
- Any UI redesign. Embedded mode is a routing + auth concern, not a design concern.
- Worker / cron / webhook changes. Server-side logic is unaffected.
- Mongoose schema changes. Already has `refreshToken` + `accessTokenExpiresAt`.

---

## BIBLIOGRAPHY OF KEY FILES (FOR CODING REFERENCE)

- `apps/web/src/middleware.ts` — currently gates `/dashboard/*`, may need to skip `/(embedded)/*`
- `apps/web/src/app/dashboard/layout.tsx` — uses `getServerSession`; in embedded path, skip
- `apps/web/src/app/providers.tsx:71-95` — tRPC client init, needs to read auth from context OR session
- `apps/web/src/components/auth/token-refresh-keeper.tsx:53-62` — `signOut` redirect; gate on `isEmbedded()`
- `apps/web/src/components/shell/topbar.tsx:266` — Sign Out button; conditional behavior
- `apps/web/src/components/shell/command-palette.tsx:249` — Sign Out from cmd+K; conditional
- `apps/web/next.config.mjs:106-149` — CSP and `X-Frame-Options`; scoped relaxation needed
- `apps/web/src/app/dashboard/settings/integrations/page.tsx:396` — `window.open(installUrl)` to fix
- `apps/api/src/server/auth.ts:280-299` — login handler; reference for new exchange endpoint shape
- `apps/api/src/server/trpc.ts:101-161` — bearer token verification; unchanged
- `apps/api/src/lib/integrations/shopify.ts:345` — `exchangeShopifyCode`; sibling for new Token Exchange function
- `apps/api/src/server/webhooks/integrations.ts:533-634` — public install OAuth callback; legacy path retained
- `apps/api/src/server/routers/integrations.ts:2578` — `completeShopifyInstall`; reusable upsert logic
- `shopify.app.toml` — central config; the `embedded = true` flip happens here
