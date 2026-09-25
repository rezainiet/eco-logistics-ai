import { NextResponse, type NextRequest } from "next/server";
import { extractLandingLabel } from "@ecom/landing";
import { landingRootDomain } from "./lib/config";

/**
 * Host-based routing. The only thing this app serves is
 *   https://<label>.<LANDING_ROOT_DOMAIN>/  →  /lp/<label>
 *
 * - The Host header is normalised and validated by the same helper the API
 *   uses; anything malformed, reserved, nested or foreign is a 404.
 * - `X-Forwarded-Host` is ignored — tenant identity comes from Host only.
 * - `/lp/*` is internal and never directly addressable, so a visitor
 *   cannot ask one hostname to render another tenant's page.
 * - Pages are single-URL for now; other paths 404.
 */
const NOT_FOUND = "/lp/-";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const root = landingRootDomain();
  const label = root ? extractLandingLabel(req.headers.get("host"), root) : null;

  const url = req.nextUrl.clone();
  url.search = "";
  url.pathname = label && pathname === "/" ? `/lp/${label}` : NOT_FOUND;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|robots.txt).*)"],
};
