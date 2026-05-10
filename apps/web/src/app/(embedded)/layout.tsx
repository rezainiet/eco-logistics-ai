import Script from "next/script";
import { type ReactNode } from "react";
import { ShopifyAuthContextProvider } from "./_components/shopify-auth-context";
import { SessionTokenBridge } from "./_components/session-token-bridge";

/**
 * Embedded route-group layout — mounts the App Bridge runtime + the
 * Shopify session-token bridge for any page rendered inside this group.
 *
 * Files under `app/(embedded)/` automatically inherit this layout. The
 * route group is URL-invisible: a page at `app/(embedded)/embedded/page.tsx`
 * resolves at the URL `/embedded`, and Shopify Admin will iframe us at
 * whatever path is set as `application_url` in `shopify.app.toml` once
 * Phase D updates it (currently still pointing at the legacy direct
 * dashboard path; Phase D will flip it to `/embedded/...`).
 *
 * What this layout does NOT do (intentional):
 *
 *   - Set `<html>` / `<body>` — that lives in the app root layout. This
 *     is a NESTED layout and only emits children + script tags.
 *   - Apply CSP changes — Phase A explicitly preserves the existing CSP
 *     (`frame-ancestors 'none'`). Phase D relaxes it for Shopify origins.
 *     Until then, anyone who tries to iframe `/embedded/...` will be
 *     refused at the browser level — which is the correct safeguard
 *     while embedded mode is still being built.
 *   - Run any backend logic — purely a client-side mount. Server
 *     components inside this group can still do their thing; the
 *     ShopifyAuthContext is client-only.
 *
 * App Bridge v4 mount strategy:
 *
 *   App Bridge v4 expects:
 *     1. A `<meta name="shopify-api-key" content="...">` tag in the
 *        document head.
 *     2. The CDN script at `https://cdn.shopify.com/shopifycloud/app-bridge.js`
 *        loaded synchronously (App Bridge installs `window.shopify`
 *        before any consumer runs).
 *
 *   We use Next.js's `<Script strategy="beforeInteractive">` for the CDN
 *   script — it injects into the head before hydration so `useAppBridge()`
 *   doesn't race against script load.
 *
 *   The api key is read from `NEXT_PUBLIC_SHOPIFY_APP_API_KEY`. This env
 *   value is the SAME `client_id` declared in shopify.app.toml + Partner
 *   Dashboard. Public by definition (it ships in the bundle); the
 *   secret never leaves the API server.
 *
 * Reversibility: deleting this folder removes embedded auth from the
 * bundle. No other route imports from `_components/`. Phase A's reserved
 * `(direct)/` group is the symmetric counterpart for the non-iframe
 * surface; Phase A's notes there explain the routing layout decision.
 */
export default function EmbeddedLayout({
  children,
}: {
  children: ReactNode;
}) {
  // The api key is public — bakes into the bundle. If it's missing in
  // dev we still render so a developer hitting /embedded sees the
  // SessionTokenBridge's error state ("session_token_missing" or
  // "app_bridge_unavailable") rather than a blank page.
  const apiKey = process.env.NEXT_PUBLIC_SHOPIFY_APP_API_KEY ?? "";
  return (
    <>
      {/*
        App Bridge v4 looks for this meta tag at script-init time. Must
        be present in the document head before app-bridge.js executes.
      */}
      {apiKey ? (
        <meta name="shopify-api-key" content={apiKey} />
      ) : null}
      <Script
        src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
        strategy="beforeInteractive"
      />
      <ShopifyAuthContextProvider>
        <SessionTokenBridge />
        {children}
      </ShopifyAuthContextProvider>
    </>
  );
}
