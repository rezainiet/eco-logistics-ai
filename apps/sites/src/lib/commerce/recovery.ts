import type { CartLine } from "./cart";

/**
 * Abandoned-cart recovery, browser side.
 *
 * Activity: the cart reports what really happened (add / remove / checkout
 * started / contact entered / order placed) to the page's own /api/activity.
 * Only product ids, variant ids and quantities are sent, plus the phone and
 * email the buyer typed into the checkout form. Prices and names are decided
 * by the server. Reporting is fire-and-forget: it can never block or break
 * the cart or checkout.
 *
 * Recovery link: the email links back with `#cx_recover=<token>` (fragment,
 * so it never reaches a server log or a Referer). The token is read once,
 * removed from the address bar immediately, exchanged for the saved cart and
 * kept for this tab only, so the order can be attributed to the recovery.
 */

const SESSION_IDLE_MS = 30 * 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const sessionKey = (slug: string) => `confirmx:lp-session:${slug}`;
const tokenKey = (slug: string) => `confirmx:lp-recovery:${slug}`;

function uuid(): string {
  const c: Crypto = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  // Older browsers without randomUUID (still have getRandomValues).
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** This visitor's activity session for the page: renewed after 30 idle minutes. */
export function activitySessionId(slug: string, now = Date.now()): string {
  try {
    const raw = window.localStorage.getItem(sessionKey(slug));
    const s = raw ? (JSON.parse(raw) as { id?: unknown; at?: unknown }) : null;
    const id = s && typeof s.id === "string" && typeof s.at === "number" && now - s.at < SESSION_IDLE_MS ? s.id : uuid();
    window.localStorage.setItem(sessionKey(slug), JSON.stringify({ id, at: now }));
    return id;
  } catch {
    return uuid();
  }
}

/** After an order: the next cart is a new session. */
export function endActivitySession(slug: string): void {
  try {
    window.localStorage.removeItem(sessionKey(slug));
  } catch {
    // ignore
  }
}

export type ActivityType = "add_to_cart" | "remove_from_cart" | "checkout_start" | "identify" | "checkout_submit";

export function reportActivity(
  slug: string,
  locale: string,
  type: ActivityType,
  cart: CartLine[],
  extra: { item?: CartLine; phone?: string; email?: string } = {},
): void {
  try {
    void fetch("/api/activity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        locale,
        sessionId: activitySessionId(slug),
        type,
        clientEventId: uuid(),
        cart: cart.map((l) => ({ productId: l.productId, ...(l.variantId ? { variantId: l.variantId } : {}), quantity: l.quantity })),
        ...(extra.item ? { item: { productId: extra.item.productId, ...(extra.item.variantId ? { variantId: extra.item.variantId } : {}), quantity: extra.item.quantity } } : {}),
        ...(extra.phone ? { phone: extra.phone } : {}),
        ...(extra.email ? { email: extra.email } : {}),
      }),
    }).catch(() => undefined);
  } catch {
    // Reporting must never break the cart.
  }
}

/** The recovery token in a URL fragment (`#cx_recover=…`), or null. */
export function tokenFromHash(hash: string): string | null {
  const m = /(?:^#|&)cx_recover=([^&]+)/.exec(hash);
  const t = m ? decodeURIComponent(m[1]!) : null;
  return t && TOKEN_RE.test(t) ? t : null;
}

/** Takes the token out of the address bar (and history) right away. */
export function consumeRecoveryToken(slug: string): string | null {
  if (typeof window === "undefined") return null;
  const token = tokenFromHash(window.location.hash);
  if (!token) return null;
  try {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  } catch {
    // ignore
  }
  rememberRecoveryToken(slug, token);
  return token;
}

export function rememberRecoveryToken(slug: string, token: string): void {
  try {
    window.sessionStorage.setItem(tokenKey(slug), token);
  } catch {
    // ignore
  }
}

export function storedRecoveryToken(slug: string): string | null {
  try {
    const t = window.sessionStorage.getItem(tokenKey(slug));
    return t && TOKEN_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

export function forgetRecoveryToken(slug: string): void {
  try {
    window.sessionStorage.removeItem(tokenKey(slug));
  } catch {
    // ignore
  }
}
