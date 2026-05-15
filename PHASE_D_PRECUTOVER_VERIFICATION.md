# Phase D — Pre-Cutover Runtime Verification

**Status: BLOCKED on deploy.** Phase C was reported as deployed but is **not actually on `main`** — the working tree has the changes but they were never committed/pushed. Production today is running Phase A + Phase B + the audit-log fix, nothing more.

This is the single most important finding before Phase D. Surfacing it first because every other verification point depends on it.

---

## CRITICAL #1 — Phase C frontend + polish patches are NOT deployed

### Evidence

```
$ git log --oneline -8 main
4bb616f  fix(audit): register auth.shopify_exchange in AuditLog schema enum
2fd05f2  feat(shopify): Phase B — Token Exchange infrastructure for embedded auth
a1a7375  prep(shopify): phase A embedded migration scaffolding
a590795  fix(integrations): tighten testConnection auto-disconnect heuristic
8b95626  fix(shopify): round-trip refresh token through install claim + use accountKey for shop domain
118d83c  fix(integrations): surface connection-health failures on Issues page
19d2210  feat(shopify): expiring offline tokens + auto-refresh on Admin API calls
59096f0  fix(shopify): diagnostic hmac_mismatch logging + honest merchant copy
```

There is no Phase C commit. There is no polish-patches commit (H1+H3+M3).

### What's missing from `main` but present in the local working tree

**New files (not in main):**
```
apps/web/src/lib/embedded-token-bus.ts
apps/web/src/app/(embedded)/layout.tsx
apps/web/src/app/(embedded)/embedded/page.tsx
apps/web/src/app/(embedded)/_components/shopify-auth-context.tsx
apps/web/src/app/(embedded)/_components/session-token-bridge.tsx
```

**Modified files with uncommitted changes:**
```
apps/web/src/app/providers.tsx                        (Phase C dual-auth headers)
apps/web/src/app/dashboard/settings/integrations/page.tsx  (Phase C window.open gate + H?)
apps/web/src/components/shell/topbar.tsx              (Phase C signOut gate)
apps/web/src/components/shell/command-palette.tsx     (Phase C signOut gate)
apps/web/src/components/onboarding/onboarding-checklist.tsx   (H1 polish — health.ok check)
apps/web/src/components/onboarding/activation-moments.tsx     (H3 polish — risky <= 0 guard)
apps/web/src/app/dashboard/orders/page.tsx            (M3 polish — skeleton-vs-empty branch)
apps/api/src/server/auth.ts                           (Phase C C7 auto-provision branch)
```

### Live evidence corroborating the gap

**Test 1 — /embedded route:**
```
GET https://confirmx.ai/embedded
→ 404 Not Found (Next.js)
→ x-vercel-cache: null  (i.e. not a CDN cache miss; the route itself doesn't exist on the deployed build)
```

**Test 2 — /auth/shopify/exchange behavior:**
```
POST https://api.confirmx.ai/auth/shopify/exchange
Body: { "sessionToken": "<bogus 80-char string>" }
→ 401 { "error": "invalid_session_token" }
```
Phase B's verifier IS live and working correctly. This is the expected response for a forged token.

**Test 3 — what's deployed in main's `/auth/shopify/exchange`:**
The `no_integration_for_shop` 404 branch is still in main. The auto-provision (Phase C C7) is NOT deployed:
```
$ git show main:apps/api/src/server/auth.ts | grep "no_integration_for_shop"
...
return res.status(404).json({
  error: "no_integration_for_shop",
  ...
});
```

**Test 4 — H1 polish patch deployment status:**
```
$ git show main:apps/web/src/components/onboarding/onboarding-checklist.tsx | grep "i.health?.ok !== false"
$  (no match — patch not deployed)
```

H3 polish: same — not deployed.
M3 polish: same — not deployed.

### Why this matters for Phase D

Phase D's cutover assumes:
- The `/embedded` route serves the App Bridge shell.
- The `<SessionTokenBridge>` is mounted and ready to call `/auth/shopify/exchange`.
- The auto-provision branch creates the merchant + integration on first launch.
- The dashboard's `window.open` and `signOut` paths are iframe-safe.

**None of those assumptions hold today.** Flipping `embedded = true` in `shopify.app.toml` and updating CSP without first deploying Phase C would result in:
- Shopify iframes us to `application_url` → blank page (404).
- Even if a merchant somehow reached the dashboard via direct path, clicking Connect on the integrations page would open `window.open()` (popup blocked in iframe).
- Sign Out would redirect the iframe to `/login` (CSP `frame-ancestors 'none'` would refuse the iframe load).

**Phase D cannot proceed until Phase C and the polish patches are committed, pushed, and verified live.**

---

## What CAN be verified about the runtime (limited to what's on Phase A + B)

These tests passed on the actually-deployed code. Useful as a baseline for what Phase D will need to re-verify after Phase C ships.

### V1 — Direct login coexistence

| Check | Result |
|---|---|
| `/login` page renders, sign-in flow works | ✅ Tested live |
| `/dashboard` loads after sign-in | ✅ Tested live |
| KPI cards populate within ~10s (cold) / ~1s (warm) | ✅ |
| tRPC headers reach API with `Authorization: Bearer <our JWT>` | ✅ Network trace confirmed |

### V2 — Phase B `/auth/shopify/exchange` verifier behavior

| Check | Result |
|---|---|
| Empty body → 400 `invalid_session_token_request` | ✅ |
| Bogus session token → 401 `invalid_session_token` | ✅ Tested live |
| Token signed with wrong secret → 401 (covered by Phase B's vitest suite) | ⚠️ Local tests only — sandbox can't run vitest with Mongo memory server |
| Valid token, no Integration row → 404 `no_integration_for_shop` (legacy behaviour, will be replaced by auto-provision once Phase C ships) | ✅ Confirmed via main's source |

### V3 — `/embedded` diagnostic page

Cannot verify against deployed code (route is 404). The page exists in the working tree and was structurally reviewed:

- `(embedded)/layout.tsx` mounts App Bridge v4 script + `<meta name="shopify-api-key">` + `<ShopifyAuthContextProvider>` + `<SessionTokenBridge>`.
- `embedded/page.tsx` renders the diagnostic UI (status pill, shop, masked token, error message + retry button + escape link to `/dashboard`).

**Concrete pre-Phase-D verification needed once committed:**

1. Visit `/embedded` directly (not in iframe) → status flips to `error` with code `app_bridge_unavailable: ...` after ~500ms (App Bridge throws when `window.top === window.self`).
2. The "Try again" button is clickable and re-runs the exchange (same error in non-iframe context, but proves the retry handler is wired).
3. The "Open the direct dashboard instead" link routes to `/dashboard` (the escape hatch for users who land on `/embedded` outside the iframe).

### V4 — App Bridge availability outside iframe

**Risk to verify post-deploy:** `useAppBridge()` returns a Proxy in App Bridge v4. The Proxy throws on access when invoked outside the iframe. The bridge is wrapped in try/catch, so the exception flips the auth context to the `error` state instead of crashing.

**What to confirm:**
- Console error pattern matches `app_bridge_unavailable: ...` (not raw stack trace).
- React error boundary doesn't trigger.
- The page doesn't loop the exchange (the `didFireRef` ref prevents this — but worth eyeballing the Network tab to confirm only ONE POST to `/auth/shopify/exchange` fires per page mount).

### V5 — Session-token acquisition timing

**Cannot test without iframe context.** Phase D's smoke test on a real dev store will be the first real validation. Things to watch:

1. **Time-to-token.** App Bridge's `shopify.idToken()` should resolve within ~200ms of script load. If it takes >2s, the merchant sees "Setting up your embedded session…" for an awkward duration.
2. **Token expiry**. Shopify session tokens have ~1 minute TTL. If our exchange takes >50s (network slow + cold start), the token expires before we POST it. Mitigation: re-fetch via `auth.retry()`.
3. **Race with React strict mode**. Dev double-invoke fires `run()` twice — produces two audit log entries on the API side. Acceptable in dev; production strict mode is off.

### V6 — `/auth/shopify/exchange` runtime behavior (auto-provision branch)

**Cannot test without Phase C committed.** Once it's live:

- Hitting it with a valid session token for a NEW shop should auto-provision a `Merchant` + `Integration` row instead of returning 404.
- Mongo verification: `db.merchants.findOne({ email: /^embedded-/ })` should show the synthetic merchant.
- `db.integrations.findOne({ accountKey: <shop> })` should show `credentials.refreshToken` (encrypted) + `credentials.accessTokenExpiresAt` (~24h future).

Race-protection paths to verify:
- Two concurrent exchange requests for the same fresh shop → only ONE merchant created (the unique-email index protects).
- Two concurrent requests for the same EXISTING merchant → both succeed and return the same `merchantId`.

### V7 — Iframe-safe redirects (`window.top.location`)

Cannot test without the iframe gate being deployed. Once Phase C ships:

- In the integrations page connect flow, when running inside an iframe (Phase D), clicking "Connect Shopify" should call `window.top?.location.assign(installUrl)` instead of `window.open(...)`. Verify the navigation actually targets the parent frame, not the iframe itself.
- Inline "Open Shopify install" button still works as fallback if `window.top` access is denied.

### V8 — signOut behavior in embedded-prep paths

Cannot test until deployed. Once Phase C ships, in iframe context:

- Sign Out from the topbar → `setEmbeddedApiToken(null)` + `signOut({ redirect: false })` + toast. **NO** redirect to `/login`. Iframe stays on the dashboard but tRPC calls start 401-ing.
- Same behavior from cmd+K → "Sign out" command.

Direct path (non-iframe) sign out is unchanged — verified live during V1.

### V9 — Auth hydration stability

**Risk:** the embedded layout mounts `<ShopifyAuthContextProvider>` at the route-group level. The dashboard pages currently exist at `/dashboard/*` (NOT inside the embedded group). For Phase D, the embedded shell needs to render dashboard content at `/embedded/...`.

**Decision pending:** does Phase D mirror dashboard pages under `/embedded/dashboard/*`, or does the embedded shell wrap the existing `/dashboard/*` tree somehow?

Currently the `/embedded` page is just a diagnostic. Phase D will need to either:
- Add `(embedded)/embedded/dashboard/page.tsx` etc. that import the same content components from `/dashboard/*`. The dashboard layout (`/dashboard/layout.tsx`) currently `getServerSession`-gates rendering — that gate would BLOCK embedded merchants who don't have a NextAuth session. So the embedded versions can't reuse `/dashboard/layout.tsx` without modification.
- OR have the embedded shell render the dashboard pages via dynamic import + a different layout.

This is a Phase D design decision that needs to be made before any code lands.

### V10 — tRPC auth header switching

The new `providers.tsx` reads `apiToken` from EITHER NextAuth session OR the embedded token bus. Cannot test embedded fallback path without Phase C deployed.

**Once Phase C is live, verify:**
1. Open dashboard via direct path (NextAuth) → tRPC calls carry `Authorization: Bearer <NextAuth apiToken>`.
2. Open `/embedded` (App Bridge) → tRPC calls carry `Authorization: Bearer <embedded apiToken>`.
3. Open both in different tabs simultaneously → each tab's tRPC client uses the right token (NextAuth's `getSession()` is per-request; the bus is per-tab via module-level state).

---

## Other findings

### Polish patches

The H1, H3, M3 polish patches are documented in `PATCHES_H1_H3_M3_REPORT.md` and should ship as a separate commit. Once they land:

- **H1** Onboarding "Connect your store" stops marking ✅ Done when `health.ok === false`.
- **H3** Dashboard banner stops contradicting itself ("first order flagged · 0 flagged in 30 days").
- **M3** Orders page anchors loading state on `list.data` presence, not just `isLoading`.

### `/embedded` route conflict risk

Route group `(embedded)` is URL-invisible, so the URL is `/embedded`. The folder structure `(embedded)/embedded/page.tsx` is intentional but visually unusual. **No actual conflict with `/dashboard/*` since the URL paths don't overlap.**

### `next/script` `beforeInteractive` strategy in nested layout

The `(embedded)/layout.tsx` uses `<Script src="..." strategy="beforeInteractive" />`. Per Next.js 14.2 docs: "beforeInteractive should only be used in app/layout.tsx (root layout)." In nested layouts it's a warning, not an error — the script still loads but with effective `afterInteractive` semantics. App Bridge v4 tolerates this (the script queues calls until `window.shopify` is ready).

**Optional fix before Phase D:** change to `strategy="afterInteractive"` to silence the build warning. Not a blocker, just a polish item.

---

## Cutover blockers (must clear before Phase D)

| # | Blocker | Owner action |
|---|---|---|
| **B1** | Phase C frontend (`(embedded)/` route group + token bus + 4 helper files) not on main | Commit + push + verify Vercel deploy |
| **B2** | Phase C iframe gates (`window.open`, `signOut x2`) not on main | Same commit |
| **B3** | Phase C auto-provision branch in `/auth/shopify/exchange` not on main | Same commit (api side) |
| **B4** | H1+H3+M3 polish patches not on main | Optional companion commit before Phase D |
| **B5** | After deploy: re-run V3, V4, V5, V7, V8, V10 verifications above | Manual smoke test against the deployed `/embedded` |
| **B6** | Phase D-specific design decision: how the embedded shell renders dashboard content (mirror routes vs. wrapper layout vs. shared components) | Architecture call before any code lands |

### Suggested commit groups (clean PR sequence)

**PR 1 — Polish patches (H1+H3+M3)**
```
fix(dashboard): pre-Phase-C UX polish — H1+H3+M3
```
Three files. ~50 lines. Safe to land independently.

**PR 2 — Phase C — frontend embedded bridge**
```
feat(shopify): Phase C — frontend embedded bridge + auto-provision
```
9 files (4 new + 5 modified). ~315 lines. Includes the auto-provision branch in /auth/shopify/exchange. Test files NOT in this PR (separate cleanup).

**PR 3 (optional, recommended) — Test cleanup**
```
test(shopify): update auth.shopify-exchange tests for auto-provision
```
Updates the 2 stale `no_integration_for_shop` test cases to assert auto-provision behavior instead.

---

## Migration risks (post-deploy, pre-Phase-D)

These are concerns to monitor BETWEEN landing Phase C and flipping `embedded = true`.

### R1 — Auto-provision creates orphan Merchants

**Scenario:** Someone (developer, test) hits `/auth/shopify/exchange` with a valid Shopify session token for a shop that we don't actually have an integration with. Auto-provision creates a synthetic Merchant.

**Mitigation already in code:** the synthetic Merchant has a un-routable email (`embedded-<shop>@confirmx.shop`) and a locked password. Cannot log in via credentials.

**Residual risk:** these rows accumulate in the DB. Phase E should include a cleanup pass that flags Merchants with `email LIKE 'embedded-%@confirmx.shop'` AND no live Integration as candidates for deletion.

### R2 — `setEmbeddedApiToken(null)` in token-refresh-keeper

The current `<TokenRefreshKeeper>` doesn't know about embedded mode. If an embedded session's token expires, the keeper might attempt a `/auth/refresh` (using cookies the iframe doesn't have) → fail → call `signOut({ callbackUrl: '/login' })` → blank iframe.

**Mitigation needed before Phase D:** add an `isEmbedded()` short-circuit at the top of `TokenRefreshKeeper` that returns null. Let the embedded retry path (`auth.retry()` from the auth context) handle re-exchange. This is documented in `PHASE_C_EMBEDDED_BRIDGE_REPORT.md` as a Phase D-or-later follow-up.

**Recommendation:** include this fix in PR 2 above. It's ~5 lines and closes a real gap.

### R3 — `/embedded` is publicly reachable post-deploy

Once Phase C is live, anyone can navigate to `https://confirmx.ai/embedded` directly (not in iframe). The page handles this case (App Bridge fails → error state → escape link to `/dashboard`). Acceptable but worth eyeballing once.

**No action needed unless** the error-state copy reveals internal details that shouldn't be public. Reviewed: the error code `app_bridge_unavailable: ...` is fine to expose.

### R4 — Audit log spam from auto-provision

Each successful exchange writes an audit row (`action: "auth.shopify_exchange"`). If the iframe re-mounts (page reload, React strict mode dev double-invoke), multiple audit rows per session.

**Mitigation:** the audit row is idempotent on Mongo's side (no harm), but cluttery. Phase D should consider adding a debounce — only audit once per (merchantId, jti) combination within a 1-min window. Out of scope for Phase C; revisit if logs get noisy.

### R5 — `application_url` in `shopify.app.toml`

Currently set to `https://app.confirmx.ai/dashboard/settings/integrations`. Phase D will need to update to `https://app.confirmx.ai/embedded` (or wherever Phase D's design decision lands). Until then, Shopify Admin doesn't know about the embedded entry point.

---

## Recommended action sequence

### Immediately (before Phase D scheduling)

1. **Commit + push the polish patches (H1+H3+M3)** as PR 1.
2. **Commit + push Phase C** as PR 2 (frontend bridge + auto-provision branch + iframe gates + the R2 token-refresh-keeper guard).
3. **Wait for Vercel + Railway deploys** to complete on `main`.
4. **Re-run this verification pass** end-to-end. Specifically: V3, V4, V7, V8, V10. If everything is green, Phase D can be scheduled.

### Before Phase D

5. **Make the V9 design call:** how the embedded shell renders dashboard content. This is the only architecture decision Phase D needs upfront.
6. **Stage the Phase D commits:**
   - `next.config.mjs` CSP relaxation for `/embedded/*` and `/dashboard/*` (under iframe).
   - `shopify.app.toml`: `embedded = true` + `application_url = https://app.confirmx.ai/embedded` (or chosen path).
   - `shopify app deploy` to push to Partners.
7. **Schedule a low-traffic window** for the cutover. The `embedded = true` flip is irreversible without a Partners reset.

### After Phase D

8. Watch Railway + Vercel logs for a fresh install on the dev store. Confirm:
   - Iframe loads `/embedded` cleanly.
   - Session-token exchange completes within 2s.
   - Mongo `Integration` row has `refreshToken` + `accessTokenExpiresAt` populated.
   - Order import succeeds (no 403).

---

## Summary

The Phase D cutover plan is sound, the runtime tests we **could** run pass cleanly, but **Phase C and the polish patches were never actually committed to main**. The user's understanding of "deployed" was mistaken; only Phase A + Phase B + the audit fix are live today.

The fix is a clean two-PR sequence (or one combined commit if preferred). After deploy, the verification pass needs to re-run for the points that depend on `/embedded` being routable.

**Phase D is BLOCKED on the deploy gap.** Once cleared, the cutover becomes the controlled config flip we've been planning all along.
