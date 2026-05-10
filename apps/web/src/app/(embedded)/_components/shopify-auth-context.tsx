"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * ShopifyAuthContext — embedded-mode auth surface.
 *
 * The dashboard's tRPC client needs an access token. In direct (non-iframe)
 * mode the token comes from the NextAuth session (`session.apiToken`,
 * minted by `/auth/login`). In embedded (Shopify iframe) mode there is no
 * NextAuth session — Shopify already authenticated the merchant outside
 * our domain, so we exchange a Shopify-signed session token for our own
 * JWT via `POST /auth/shopify/exchange`. The result is the same JWT shape
 * either way.
 *
 * This context exposes the embedded-path token + status to the rest of
 * the React tree. `apps/web/src/app/providers.tsx` reads from EITHER
 * NextAuth OR this context to populate the tRPC `Authorization` header,
 * so individual pages don't need to know which auth path they're on.
 *
 * Phase C scope: the context is mounted only inside the (embedded) route
 * group's layout. Pages outside that group never see it; their tRPC
 * client falls back to NextAuth as today. Direct login is unaffected.
 *
 * Lifecycle states:
 *   - `idle`     — context mounted, exchange not yet attempted (briefly,
 *                  before the bridge fires).
 *   - `loading`  — exchange in flight; the dashboard renders a loading
 *                  shell rather than calling tRPC with a bearer of `null`.
 *   - `ready`    — apiToken populated; tRPC calls flow normally.
 *   - `error`    — exchange failed; the bridge surfaces a retry CTA.
 *                  The error message is whatever the API returned (e.g.
 *                  `invalid_session_token`, `no_integration_for_shop`,
 *                  `embedded_auth_not_configured`).
 *
 * Reversibility note: this whole module is unreferenced outside the
 * (embedded) route group. Deleting the (embedded) folder uninstalls
 * embedded auth without affecting any other surface.
 */

export type ShopifyAuthStatus = "idle" | "loading" | "ready" | "error";

export interface ShopifyAuthContextValue {
  /** OUR JWT, ready to attach as `Authorization: Bearer <token>`. */
  apiToken: string | null;
  /** Mirror of the JWT's status. */
  status: ShopifyAuthStatus;
  /**
   * Last exchange error (server-supplied code or network failure).
   * Cleared on the next successful exchange. Mostly for diagnostic UI;
   * the SPA should never show raw codes to merchants without translation.
   */
  error: string | null;
  /**
   * Shopify shop the session token was minted for (`shop.myshopify.com`).
   * Available once the exchange has succeeded at least once. Useful for
   * surfacing "you're signed in as test-shop.myshopify.com" diagnostic UI.
   */
  shop: string | null;
  /** Optional: opaque integration id, if returned by the exchange. */
  integrationId: string | null;
  /**
   * Imperative re-run of the exchange. Called by:
   *   - the "Try again" CTA on the error state
   *   - the tRPC client when a 401 surfaces (mid-session token expiry)
   *   - any future App-Bridge hook that wants to refresh proactively
   */
  retry: () => void;
}

/**
 * Internal mutator interface — used by <SessionTokenBridge> to push
 * exchange results into the context. Exposed via a separate provider
 * pattern so consumers cannot accidentally overwrite the apiToken.
 */
export interface ShopifyAuthMutators {
  setLoading: () => void;
  setReady: (data: {
    apiToken: string;
    shop: string;
    integrationId: string | null;
  }) => void;
  setError: (message: string) => void;
  setRetryHandler: (fn: () => void) => void;
}

const ShopifyAuthContext = createContext<ShopifyAuthContextValue | null>(null);
const ShopifyAuthMutatorsContext = createContext<ShopifyAuthMutators | null>(
  null,
);

/**
 * Mounted by the (embedded) layout. Holds the auth state and exposes
 * both a read-only context (for consumers) and a mutator context (for
 * the bridge component). Must be a client component because it owns
 * React state; SSR-safe in the sense that the initial state is "idle"
 * and matches whatever the server would have rendered.
 */
export function ShopifyAuthContextProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [apiToken, setApiToken] = useState<string | null>(null);
  const [status, setStatus] = useState<ShopifyAuthStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [shop, setShop] = useState<string | null>(null);
  const [integrationId, setIntegrationId] = useState<string | null>(null);
  const [retryHandler, setRetryHandler] = useState<(() => void) | null>(null);

  const mutators = useMemo<ShopifyAuthMutators>(
    () => ({
      setLoading: () => {
        setStatus("loading");
        setError(null);
      },
      setReady: ({ apiToken, shop, integrationId }) => {
        setApiToken(apiToken);
        setShop(shop);
        setIntegrationId(integrationId);
        setError(null);
        setStatus("ready");
      },
      setError: (message: string) => {
        setError(message);
        setStatus("error");
      },
      setRetryHandler: (fn: () => void) => {
        setRetryHandler(() => fn);
      },
    }),
    [],
  );

  const value = useMemo<ShopifyAuthContextValue>(
    () => ({
      apiToken,
      status,
      error,
      shop,
      integrationId,
      retry: () => {
        retryHandler?.();
      },
    }),
    [apiToken, status, error, shop, integrationId, retryHandler],
  );

  return (
    <ShopifyAuthContext.Provider value={value}>
      <ShopifyAuthMutatorsContext.Provider value={mutators}>
        {children}
      </ShopifyAuthMutatorsContext.Provider>
    </ShopifyAuthContext.Provider>
  );
}

/**
 * Read-only consumer hook. Returns `null` when called from outside the
 * (embedded) route group — direct-login code paths get `null` and fall
 * back to NextAuth for the apiToken. Don't throw; the absence of context
 * is the dual-auth signal.
 */
export function useShopifyAuth(): ShopifyAuthContextValue | null {
  return useContext(ShopifyAuthContext);
}

/**
 * Mutator hook — only called by <SessionTokenBridge>. Throws if used
 * outside the provider, which is intentional: any consumer that thinks
 * it can overwrite the apiToken is buggy.
 */
export function useShopifyAuthMutators(): ShopifyAuthMutators {
  const ctx = useContext(ShopifyAuthMutatorsContext);
  if (!ctx) {
    throw new Error(
      "useShopifyAuthMutators must be used within ShopifyAuthContextProvider",
    );
  }
  return ctx;
}
