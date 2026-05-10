"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useShopifyAuthMutators } from "./shopify-auth-context";
import { setEmbeddedApiToken } from "@/lib/embedded-token-bus";

/**
 * SessionTokenBridge — the embedded-mode auth handshake.
 *
 * Mounted inside the (embedded) layout. On mount (and on every retry):
 *
 *   1. Wait for App Bridge to finish loading. The `useAppBridge()` hook
 *      returns a Proxy that queues calls until the underlying global is
 *      ready, but `shopify.idToken()` itself awaits the same readiness,
 *      so we just call it directly.
 *
 *   2. Ask App Bridge for an ID token (Shopify session token signed with
 *      our app secret). This is the proof-of-merchant we forward to our
 *      backend. The token's `dest` claim is the shop URL; everything
 *      downstream trusts that, not anything we attach here.
 *
 *   3. POST `{ sessionToken }` to `/auth/shopify/exchange`. The backend
 *      verifies the signature + claims, looks up the Integration row,
 *      and returns OUR JWT in the same shape `/auth/login` returns.
 *
 *   4. Push the JWT into <ShopifyAuthContext> so the rest of the React
 *      tree (including the tRPC client in providers.tsx) can read it.
 *
 * Failure modes — surfaced to the merchant via the auth context's error
 * state, never thrown:
 *   - App Bridge unavailable (script not loaded, embedded check failed).
 *   - `idToken()` itself rejects (shouldn't happen in iframe context,
 *     but App Bridge can refuse outside its expected environment).
 *   - `/auth/shopify/exchange` returns 401 / 404 / 503 / network error.
 *
 * Phase C scope: this component is the only consumer of the App Bridge
 * runtime in the codebase. No other file imports from
 * `@shopify/app-bridge-react`. Reverting Phase C cleanly removes App
 * Bridge from the bundle.
 *
 * Phase D consideration: the dependency on App Bridge means this
 * component MUST run inside the iframe. We assume the (embedded) route
 * group is only ever reached via the iframe; the Phase A-reserved
 * `isEmbedded()` utility is the runtime check used elsewhere. This
 * component itself doesn't call `isEmbedded()` because the layout that
 * mounts it should already have gated on context.
 */

const EXCHANGE_ENDPOINT = "/auth/shopify/exchange";

export function SessionTokenBridge() {
  const shopify = useAppBridge();
  const mutators = useShopifyAuthMutators();
  // Latest mutators on a ref so the run() callback captures stable
  // references and can be safely re-invoked from retry handlers
  // without re-rendering the whole bridge.
  const mutatorsRef = useRef(mutators);
  mutatorsRef.current = mutators;

  // The actual exchange. Defined as a stable callback so it can be
  // registered as the context's retry handler AND invoked once on
  // mount without React's strict-mode double-invoke pattern firing
  // two simultaneous exchanges.
  const run = useCallback(async () => {
    const m = mutatorsRef.current;
    m.setLoading();
    // Clear any stale token from a previous successful exchange
    // BEFORE attempting a new one — if this run fails, the tRPC
    // client must not keep using the dead token. Successful runs
    // overwrite this to the fresh value just before setReady().
    setEmbeddedApiToken(null);
    let sessionToken: string;
    try {
      sessionToken = await shopify.idToken();
    } catch (err) {
      // App Bridge throws when invoked outside its expected
      // environment — typically a developer hitting `/embedded` in a
      // non-iframe context. The merchant-facing version of this
      // doesn't happen in production but the diagnostic message helps
      // during development.
      m.setError(
        `app_bridge_unavailable: ${(err as Error).message?.slice(0, 120) ?? "unknown"}`,
      );
      return;
    }
    if (!sessionToken || typeof sessionToken !== "string") {
      m.setError("session_token_missing");
      return;
    }

    const apiBase =
      process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

    let res: Response;
    try {
      res = await fetch(`${apiBase}${EXCHANGE_ENDPOINT}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Cookies are NOT used for embedded auth — the JWT travels in
        // the response body. We still send credentials so the API's
        // CORS+credentials handshake succeeds; harmless inside the
        // iframe where strict-SameSite cookies wouldn't ride along
        // anyway.
        credentials: "include",
        body: JSON.stringify({ sessionToken }),
      });
    } catch (err) {
      m.setError(
        `exchange_network_failed: ${(err as Error).message?.slice(0, 120) ?? "unknown"}`,
      );
      return;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const payload = (body ?? {}) as Record<string, unknown>;

    if (!res.ok) {
      const code =
        typeof payload.error === "string"
          ? payload.error
          : `exchange_${res.status}`;
      m.setError(code);
      return;
    }

    const apiToken = typeof payload.token === "string" ? payload.token : null;
    const shop = typeof payload.shop === "string" ? payload.shop : null;
    const integrationId =
      typeof payload.integrationId === "string"
        ? payload.integrationId
        : null;
    if (!apiToken || !shop) {
      setEmbeddedApiToken(null);
      m.setError("exchange_response_malformed");
      return;
    }
    // Publish the apiToken to the module-level bus BEFORE setting the
    // React context — the tRPC client reads from the bus on its next
    // headers() call, and we want that call to pick up the new token
    // even if React hasn't yet flushed the context update.
    setEmbeddedApiToken(apiToken);
    m.setReady({ apiToken, shop, integrationId });
  }, [shopify]);

  // Register the retry handler so `<ShopifyAuthContext>` consumers can
  // call `auth.retry()` from error UI. Done via setState rather than
  // ref so React re-renders pick up the new callback identity.
  useEffect(() => {
    mutatorsRef.current.setRetryHandler(run);
  }, [run]);

  // Fire the exchange once on mount. React's strict mode in dev will
  // double-invoke this effect; the second invocation is harmless because
  // setLoading + the same fetch produces an idempotent result on the
  // server side (the audit log gets two entries — acceptable in dev,
  // does not duplicate in prod where strict-mode double-invoke is off).
  const didFireRef = useRef(false);
  useEffect(() => {
    if (didFireRef.current) return;
    didFireRef.current = true;
    void run();
  }, [run]);

  return null;
}
