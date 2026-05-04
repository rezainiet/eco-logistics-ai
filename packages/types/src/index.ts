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
//   - https for any host
//   - http only for local-dev hosts: localhost, 127.0.0.1, ::1, and
//     *.local / *.test / *.localhost
//   - Anything else (other schemes, IPs over plain http, missing host)
//     rejects.
// Implementation kept dependency-free; this module is shared with the
// web client.

export const WOO_SITE_URL_ERROR =
  "Site URL must use https (http only allowed for localhost / *.local / *.test)";

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

export function isAllowedWooSiteUrl(input: unknown): boolean {
  if (typeof input !== "string" || input.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return false;
  }
  if (!parsed.hostname) return false;
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") return wooIsLocalHost(parsed.hostname);
  return false;
}
