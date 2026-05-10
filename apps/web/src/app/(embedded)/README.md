# `(embedded)` route group — reserved for the Shopify embedded shell

This route group is empty by design (Phase A of the embedded-app migration).

## Why it exists now

Next.js route groups (`(name)` folders) are URL-invisible — adding this folder while empty has zero effect on routing. Reserving it during Phase A:

- Locks in the layout decision for the migration plan: embedded routes will live under `(embedded)/`, direct routes under `(direct)/`.
- Lets future PRs land scoped, predictable file paths without arguing about location.
- Makes it obvious to anyone exploring the codebase that an embedded mode is planned.

## Phase B+ contents (do not add yet)

- `layout.tsx` — mounts `<AppBridgeProvider>` and `<ShopifyAuthContext>`. Required for any page in this group to render.
- `_components/app-bridge-provider.tsx` — wraps `@shopify/app-bridge-react` with our config (apiKey, host param).
- `_components/session-token-bridge.tsx` — calls `getSessionToken()`, exchanges it via `/auth/shopify/exchange`, populates the auth context.
- `_components/shopify-auth-context.tsx` — React context exposing `{ apiToken, isLoading, error }` for the embedded tRPC client to consume.
- `dashboard/...` — same dashboard pages, mounted under this group's layout. Either re-imported from the canonical `app/dashboard/*` tree or copied as thin wrappers.

## Rules for files inside this group

- **Never import from `(direct)/`**. Cross-group imports defeat the isolation the migration plan depends on.
- **Always client-side detect embed context** before calling App Bridge primitives. Use `apps/web/src/lib/embedded.ts:isEmbedded()`.
- **Don't redirect to `/login`**. Inside the iframe Shopify already authenticated the merchant; the auth flow is App Bridge → session token exchange.
- **No `window.open`**. Use App Bridge's `Redirect.dispatch(Redirect.Action.REMOTE, url)` for top-level navigation.

## Migration phase tracker

| Phase | Status | Owner |
|---|---|---|
| A — directory reserved | done | — |
| B — backend exchange endpoint | pending | — |
| C — fill in layout + auth context + first page | pending | — |
| D — flip `embedded = true` in `shopify.app.toml` | pending | — |
| E — legacy-install migration banner | pending | — |
| F — collapse `(embedded)` and `(direct)` if appropriate | pending | — |
