/**
 * Embedded-Shopify detection utility.
 *
 * Returns `true` when ConfirmX is rendered inside Shopify Admin's
 * iframe (post-migration) and `false` when running standalone at
 * app.confirmx.ai/dashboard.
 *
 * Phase A scaffolding: defined ahead of need, callers will start
 * importing this in Phase C. Phase A consumers must NOT import it
 * yet — leaving it inert keeps the bundle untouched.
 *
 * Detection rules (any one is sufficient):
 *
 *   1. We are in a frame whose top window is a different origin.
 *      `window.top !== window.self` is the classic check; any
 *      cross-origin top frame throws on direct access, which we
 *      treat as "embedded" because Shopify Admin renders us
 *      cross-origin from `admin.shopify.com`.
 *
 *   2. The current URL carries a `host=` query parameter, which is
 *      the canonical signal Shopify passes when launching an
 *      embedded app. Even if the iframe check is unreliable (some
 *      browser security models hide cross-origin frame ancestry),
 *      `?host=` is a strong second signal.
 *
 * SSR-safe: returns `false` on the server. Component code that
 * needs to branch on this should call from a client-only effect or
 * gate with `typeof window !== "undefined"`.
 *
 * Pure: no side effects, no DOM mutation, no cookie writes. Safe
 * to call from any render path.
 *
 * Phase D cutover note: when `embedded = true` lands in
 * shopify.app.toml and Shopify starts iframing us, this function's
 * return value will start flipping to `true` for installs reaching
 * us through Shopify. Until then it returns `false` for every
 * caller in production.
 */
export function isEmbedded(): boolean {
  if (typeof window === "undefined") return false;

  // Signal 1: cross-origin top frame. Wrapped in try/catch because
  // some browsers throw on cross-origin window.top access; the
  // throw itself is treated as confirmation of embedding.
  try {
    if (window.top !== window.self) return true;
  } catch {
    return true;
  }

  // Signal 2: Shopify-issued `host=` query parameter. Set by
  // Shopify Admin when launching the app; survives in-app
  // navigation when paired with the App Bridge router. We accept
  // any non-empty value; format validation is App Bridge's job.
  try {
    const params = new URLSearchParams(window.location.search);
    const host = params.get("host");
    if (host && host.length > 0) return true;
  } catch {
    // URLSearchParams should never throw on a well-formed URL, but
    // defensive: any parse failure falls through to "not embedded".
  }

  return false;
}

/**
 * SSR-stable companion: always returns `false`. Use when your code
 * needs a branchable value during render where reading `window`
 * would hydrate-mismatch. Replace with `isEmbedded()` inside
 * `useEffect` or after a `useState`-tracked mount flag flips.
 */
export function isEmbeddedSSR(): false {
  return false;
}
