import { extractLandingLabel, isLocale, normalizeHost } from "@ecom/landing";

/**
 * Host + path → what this app serves. Pure so it can be unit-tested and
 * shared by the middleware:
 *
 *   <label>.<root>/          → published page, default language
 *   <label>.<root>/<locale>  → published page in another enabled language
 *   <preview host>/          → editor preview frame (renders posted drafts)
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
}

const LOCALE_PATH = /^\/([a-z]{2})\/?$/;

export function routeFor(rawHost: string | null | undefined, pathname: string, cfg: RoutingConfig): Route {
  const host = normalizeHost(rawHost ?? null);
  if (!host) return { kind: "not_found" };

  const previewHost = normalizeHost(cfg.previewHost);
  if (previewHost && host === previewHost) {
    return pathname === "/" ? { kind: "preview" } : { kind: "not_found" };
  }

  if (!cfg.rootDomain) return { kind: "not_found" };
  const label = extractLandingLabel(host, cfg.rootDomain);
  if (!label) return { kind: "not_found" };

  if (pathname === "/") return { kind: "page", label, locale: null };
  const m = LOCALE_PATH.exec(pathname);
  if (m && isLocale(m[1])) return { kind: "page", label, locale: m[1] };
  return { kind: "not_found" };
}
