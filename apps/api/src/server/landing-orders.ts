import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../env.js";
import { type PlaceOrderInput, placeLandingOrder } from "../lib/commerce/landing-orders.js";

/**
 * POST /api/landing/orders — checkout for published landing pages.
 *
 * Called by the public renderer's same-origin proxy (apps/sites
 * /api/checkout), not by browsers directly, so no CORS is opened here.
 * The body is validated field by field in `placeLandingOrder`; the page
 * and merchant come from the hostname, never from the body.
 */

const IP_RE = /^[0-9a-fA-F.:]{3,45}$/;

function sameSecret(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Customer IP: the proxy's header only when it proves the shared secret; otherwise the socket peer. */
export function customerIp(req: Request): string | null {
  const secret = env.LANDING_PROXY_SECRET;
  const presented = req.header("x-landing-proxy-secret");
  const forwarded = req.header("x-landing-client-ip")?.trim();
  if (secret && presented && sameSecret(presented, secret) && forwarded && IP_RE.test(forwarded)) return forwarded;
  return req.ip ?? null;
}

// Per customer IP: a person placing orders by hand never needs more.
const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => `lp-order:${ipKeyGenerator(customerIp(req) ?? "unknown")}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, code: "rate_limited" },
});

export const landingOrdersRouter = Router();

landingOrdersRouter.post("/", orderLimiter, async (req, res) => {
  const body = (req.body ?? {}) as Partial<PlaceOrderInput>;
  try {
    const result = await placeLandingOrder(
      {
        host: typeof body.host === "string" ? body.host.slice(0, 300) : "",
        locale: typeof body.locale === "string" ? body.locale.slice(0, 8) : null,
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
        items: Array.isArray(body.items) ? body.items.slice(0, 50) : [],
        customer: (body.customer ?? {}) as PlaceOrderInput["customer"],
        deliveryOptionId: typeof body.deliveryOptionId === "string" ? body.deliveryOptionId.slice(0, 80) : null,
      },
      { ip: customerIp(req), userAgent: req.header("user-agent") ?? null },
    );
    if (result.ok) {
      res.status(result.duplicate ? 200 : 201).json(result);
      return;
    }
    const status =
      result.code === "page_unavailable"
        ? 404
        : result.code === "rate_limited"
          ? 429
          : result.code === "insufficient_stock" || result.code === "unavailable" || result.code === "price_changed"
            ? 409
            : result.code === "not_accepting_orders"
              ? 503
              : 400;
    res.status(status).json(result);
  } catch (err) {
    console.error(JSON.stringify({ evt: "landing.order_failed", error: (err as Error).message?.slice(0, 200) }));
    res.status(500).json({ ok: false, code: "server_error" });
  }
});
