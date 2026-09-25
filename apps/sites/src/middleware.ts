import { NextResponse, type NextRequest } from "next/server";
import { landingRootDomain, previewHost } from "./lib/config";
import { routeFor } from "./lib/routing";

/**
 * Host-based routing (see lib/routing.ts). Internal render paths
 * (`/lp/*`, `/preview-frame`) are never directly addressable: every request
 * is re-routed from its Host + path, so a visitor cannot ask one hostname
 * to render another tenant's page. `X-Forwarded-Host` is ignored.
 *
 * The resolved label/locale are forwarded as request headers so the root
 * layout can set <html lang> for the page it wraps.
 */
const NOT_FOUND = "/lp/-";

export function middleware(req: NextRequest) {
  const route = routeFor(req.headers.get("host"), req.nextUrl.pathname, {
    rootDomain: landingRootDomain(),
    previewHost: previewHost(),
  });
  const url = req.nextUrl.clone();
  url.search = "";
  const headers = new Headers(req.headers);
  headers.delete("x-lp-label");
  headers.delete("x-lp-locale");
  if (route.kind === "page") {
    url.pathname = route.locale ? `/lp/${route.label}/${route.locale}` : `/lp/${route.label}`;
    headers.set("x-lp-label", route.label);
    headers.set("x-lp-locale", route.locale ?? "");
  } else if (route.kind === "preview") {
    url.pathname = "/preview-frame";
  } else {
    url.pathname = NOT_FOUND;
  }
  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|robots.txt|icon.svg).*)"],
};
