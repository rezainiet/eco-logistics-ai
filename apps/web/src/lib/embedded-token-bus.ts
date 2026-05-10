/**
 * Embedded-mode token bus.
 *
 * Module-level token store that lets non-React code (the tRPC HTTP
 * link's `headers()` callback in `apps/web/src/app/providers.tsx`)
 * read the current embedded-mode access token without subscribing to
 * the React context tree.
 *
 * Why a separate bus instead of reading the React context directly?
 *
 *   - tRPC's `httpBatchLink` builds a single client during component
 *     mount and reuses its closures forever. Reading the React context
 *     inside `headers()` would require either a useRef + ref forwarding
 *     pattern (fragile) or recreating the link on every context change
 *     (very fragile).
 *
 *   - The token only needs to flow ONE direction: the
 *     <SessionTokenBridge> writes, the tRPC client reads. A bus is the
 *     minimum primitive that supports this without leaking React
 *     internals.
 *
 *   - Direct (non-iframe) auth keeps using NextAuth's `getSession()`
 *     unchanged. The bus is consulted ONLY when no NextAuth session
 *     apiToken is available — embedded sessions deliberately skip
 *     NextAuth so we know a present bus value implies embedded mode.
 *
 * Phase C scope: this file is imported by exactly two consumers:
 *   1. `apps/web/src/app/(embedded)/_components/session-token-bridge.tsx`
 *      (writes via `setEmbeddedApiToken`)
 *   2. `apps/web/src/app/providers.tsx`
 *      (reads via `getEmbeddedApiToken` inside the tRPC headers callback)
 *
 * Reverting Phase C deletes consumer #1; consumer #2 stays harmless
 * because `getEmbeddedApiToken()` returns `null` and the tRPC client
 * falls back to NextAuth as today.
 */

// Module-level mutable state. Safe in the browser (single-threaded
// JavaScript) and on the server (the file is bundled into the client
// runtime; SSR never imports it because the consumers are
// "use client").
let embeddedApiToken: string | null = null;

/**
 * Update the in-memory embedded apiToken. Called by the
 * <SessionTokenBridge> after a successful exchange OR when the
 * ShopifyAuthContext clears the token (e.g. logout).
 */
export function setEmbeddedApiToken(token: string | null): void {
  embeddedApiToken = token;
}

/**
 * Read the current embedded apiToken. Returns `null` outside the
 * embedded flow, OR before the first successful exchange has fired.
 *
 * Callers should always check the NextAuth session FIRST and fall
 * back to this only if NextAuth has nothing — the dual-auth contract
 * is "NextAuth first, embedded second". This means a merchant who's
 * BOTH signed in via password AND opens the embedded surface in a
 * separate tab keeps using their NextAuth token (which is the
 * correct behaviour: the iframe in Shopify Admin is a separate
 * browsing context and would have its own embedded session).
 */
export function getEmbeddedApiToken(): string | null {
  return embeddedApiToken;
}
