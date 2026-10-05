import { createLimiter, proxyLandingJson } from "@/lib/landing-proxy";

/**
 * Same-origin cart-activity proxy (abandoned-cart recovery). Forwards only
 * the fields the API reads; the API re-derives page and merchant from the
 * Host and checks every product against the published page.
 */
export const dynamic = "force-dynamic";

const limited = createLimiter(120);

export async function POST(req: Request): Promise<Response> {
  return proxyLandingJson(req, {
    apiPath: "/api/landing/activity",
    maxBytes: 16 * 1024,
    limited,
    pick: (b) => ({
      locale: typeof b.locale === "string" ? b.locale : null,
      sessionId: b.sessionId,
      type: b.type,
      clientEventId: b.clientEventId,
      cart: b.cart,
      item: b.item,
      phone: b.phone,
      email: b.email,
      touch: b.touch,
    }),
  });
}
