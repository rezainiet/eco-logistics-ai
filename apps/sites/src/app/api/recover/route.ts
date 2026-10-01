import { createLimiter, proxyLandingJson } from "@/lib/landing-proxy";

/**
 * Same-origin recovery-link proxy: token → this page's saved cart (product
 * ids and quantities only). Never creates an order.
 */
export const dynamic = "force-dynamic";

const limited = createLimiter(20);

export async function POST(req: Request): Promise<Response> {
  return proxyLandingJson(req, {
    apiPath: "/api/landing/recover",
    maxBytes: 2 * 1024,
    limited,
    pick: (b) => ({ locale: typeof b.locale === "string" ? b.locale : null, token: b.token }),
  });
}
