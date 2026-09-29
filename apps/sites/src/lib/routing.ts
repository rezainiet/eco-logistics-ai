import { extractLandingLabel, isLocale, normalizeHost, validateCustomDomain } from "@ecom/landing";

/**
 * Host + path → what this app serves. Pure so it can be unit-tested and
 * shared by the middleware:
 *
 *   <label>.<root>/          → published page, default language
 *   <label>.<root>/<locale>  → published page in another enabled language
 *   <preview host>/          → editor preview frame (renders posted drafts)
 *   <custom domain>/[locale] → a merchant's own domain (when enabled); the
 *                              "label" is then the full hostname and the API
 *                              serves it only if that domain is live
 *   anything else            → not found
 *
 * Tenant identity comes from the Host header only; nothing in the path can
 * select another tenant's page.
 */
export type Route =
  | { kind: "page"; label: string; locale: string | null }
  | { kind: "preview" }
  | { kind: "not_found" };

export interface RoutingConfig {
  rootDomain: string | null;
  previewHost: string | null;
  /** Custom merchant domains enabled (and whether dev-only TLDs are accepted). */
  customDomains?: boolean;
  allowNonPublicDomains?: boolean;
}

const LOCALE_PATH = /^\/([a-z]{2})\/?$/;

export function routeFor(rawHost: string | null | undefined, pathname: string, cfg: RoutingConfig): Route {
  const host = normalizeHost(rawHost ?? null);
  if (!host) return { kind: "not_found" };

  const previewHost = normalizeHost(cfg.previewHost);
  if (previewHost && host === previewHost) {
    return pathname === "/" ? { kind: "preview" } : { kind: "not_found" };
  }

  let label = cfg.rootDomain ? extractLandingLabel(host, cfg.rootDomain) : null;
  if (!label && cfg.customDomains) {
    const custom = validateCustomDomain(host, { rootDomain: cfg.rootDomain, allowNonPublic: cfg.allowNonPublicDomains === true });
    if (custom.ok) label = custom.hostname;
  }
  if (!label) return { kind: "not_found" };

  if (pathname === "/") return { kind: "page", label, locale: null };
  const m = LOCALE_PATH.exec(pathname);
  if (m && isLocale(m[1])) return { kind: "page", label, locale: m[1] };
  return { kind: "not_found" };
}
