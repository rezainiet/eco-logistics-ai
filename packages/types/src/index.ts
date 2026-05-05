import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "./router.js";

export type { AppRouter } from "./router.js";

/** All-router output map - handy on the web client for type-safe selectors. */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export type UserRole = "merchant" | "admin" | "agent";

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
  role: UserRole;
}

// Single source of truth for phone number validation. Mirrors PHONE_RE in
// the @ecom/db package so the web app (which can't pull in mongoose) shares
// the exact same shape as the API routes and Mongoose schemas.
export const PHONE_RE = /^\+?[0-9]{7,15}$/;

// Country and language code lists - must stay in lock-step with the
// COUNTRIES and LANGUAGES enums in the @ecom/db merchant model. The web
// app can't pull in mongoose, so the codes live here and the DB package
// mirrors them. If you add a code to one place, add it to the other; the
// TypeScript types in dependent files will surface the drift at compile
// time once that file imports from here.
export const MERCHANT_COUNTRIES = [
  "BD",
  "PK",
  "IN",
  "LK",
  "NP",
  "ID",
  "PH",
  "VN",
  "MY",
  "TH",
] as const;
export type MerchantCountry = (typeof MERCHANT_COUNTRIES)[number];

export const MERCHANT_LANGUAGES = [
  "en",
  "bn",
  "ur",
  "hi",
  "ta",
  "id",
  "th",
  "vi",
  "ms",
] as const;
export type MerchantLanguage = (typeof MERCHANT_LANGUAGES)[number];

export * from "./plans.js";

// ---------------------------------------------------------------------------
// WooCommerce site URL validation
// ---------------------------------------------------------------------------
// Single source of truth shared by the web form, the tRPC `connect` mutation,
// and any future CLI tooling. Rule:
//   - https for any PUBLIC host
//   - http (and https with private IPs) only allowed for local-dev hosts:
//     localhost, 127.0.0.1, ::1, *.local / *.test / *.localhost
//     AND only when not running in production
//   - SSRF defense: reject IPv4 in RFC1918 ranges, link-local 169.254.x.x,
//     loopback 127.x.x.x, multicast, and broadcast — even over https. A
//     valid TLS handshake against an internal IP doesn't change the fact
//     that an attacker is asking us to dial an internal service.
//   - Anything else (other schemes, missing host) rejects.
// Implementation kept dependency-free; this module is shared with the
// web client. Production-mode detection uses globalThis to avoid leaking
// `process` into the web bundle.

export const WOO_SITE_URL_ERROR =
  "Site URL must be a publicly-reachable https:// host (private IPs and localhost are blocked outside dev).";

const WOO_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function wooIsLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (WOO_LOCAL_HOSTS.has(h)) return true;
  return (
    h.endsWith(".local") ||
    h.endsWith(".test") ||
    h.endsWith(".localhost")
  );
}

/**
 * Returns true when the validator is running in production. Reads the
 * env in a bundle-safe way: server side, `process.env.NODE_ENV` is the
 * classic answer; in the browser bundle, Webpack/Vite typically inline
 * `process.env.NODE_ENV` at build time. The `try/catch` guards browsers
 * that don't define `process` at all.
 */
function wooIsProduction(): boolean {
  try {
    const env =
      typeof process !== "undefined" && process.env
        ? process.env.NODE_ENV
        : undefined;
    return env === "production";
  } catch {
    return false;
  }
}

/**
 * Recognise a hostname that resolves DIRECTLY to a private/loopback/
 * link-local address WITHOUT a DNS lookup. This is a string-only check
 * (no DNS) because the validator runs on both server and client;
 * server-side a follow-up resolve-and-recheck happens in the connector
 * before the first outbound call. Coverage:
 *   - 127.0.0.0/8       (loopback)
 *   - 10.0.0.0/8        (RFC1918)
 *   - 192.168.0.0/16    (RFC1918)
 *   - 172.16.0.0/12     (RFC1918, 172.16-172.31)
 *   - 169.254.0.0/16    (link-local; AWS metadata is here at .169.254)
 *   - 0.0.0.0/8         (this-network)
 *   - 224.0.0.0/4       (multicast)
 *   - 255.255.255.255   (limited broadcast)
 *   - IPv6 ::, ::1, fc00::/7 (unique-local), fe80::/10 (link-local)
 */
function wooIsPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4 dotted-quad?
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a >= 224) return true; // 224+ covers multicast + reserved
    if (a === 255 && b === 255) return true;
    return false;
  }
  // IPv6 — covers explicit loopback + ULA + link-local.
  if (h === "::" || h === "::1") return true;
  // Unique-local fc00::/7 — first byte is 0xfc or 0xfd (i.e. starts "fc" or "fd").
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  // Link-local fe80::/10 — first 10 bits are 1111111010.
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

/**
 * Public re-export of the private/loopback predicate. The validator
 * itself only uses it for the static URL check — but the API needs the
 * same routine after a DNS lookup to defeat DNS-rebinding-style SSRF
 * (a public hostname whose A record resolves to 169.254.169.254 etc).
 *
 * Pure string check; no DNS. Safe to call from both the web bundle and
 * the API.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  return wooIsPrivateOrLoopbackHost(hostname);
}

export function isAllowedWooSiteUrl(input: unknown): boolean {
  if (typeof input !== "string" || input.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return false;
  }
  if (!parsed.hostname) return false;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const isLocal = wooIsLocalHost(parsed.hostname);
  const isPrivateIp = wooIsPrivateOrLoopbackHost(parsed.hostname);
  const inProd = wooIsProduction();

  // Production: reject every form of internal address — http, https, IP
  // literal, localhost. The merchant has to point at a public host.
  if (inProd) {
    if (isLocal || isPrivateIp) return false;
    return parsed.protocol === "https:";
  }

  // Dev/test: keep the historical generous rules for offline workflows.
  //   - https for anything (including private IPs — useful for self-
  //     signed dev clusters)
  //   - http only for the local-dev hostnames whitelist
  if (parsed.protocol === "https:") return true;
  return isLocal;
}
