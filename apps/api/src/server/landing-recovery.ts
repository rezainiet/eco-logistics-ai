import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { customerIp } from "./landing-orders.js";
import { recordLandingActivity, restoreRecoveryCart } from "../lib/recovery/landing.js";

/**
 * Landing-page cart recovery endpoints, called by the public renderer's
 * same-origin proxies (apps/sites /api/activity and /api/recover), like
 * /api/landing/orders. The page and merchant always come from the
 * hostname; nothing in the body names a merchant.
 *
 *   POST /api/landing/activity  cart activity → tracking events (abandonment)
 *   POST /api/landing/recover   recovery link token → that page's saved cart
 */

const activityLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => `lp-activity:${ipKeyGenerator(customerIp(req) ?? "unknown")}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, code: "rate_limited" },
});

// Token guessing is pointless (256-bit tokens) but still capped per IP.
const recoverLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => `lp-recover:${ipKeyGenerator(customerIp(req) ?? "unknown")}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, code: "rate_limited" },
});

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

export const landingActivityRouter = Router();

landingActivityRouter.post("/", activityLimiter, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const result = await recordLandingActivity(
      {
        host: str(body.host, 300),
        locale: typeof body.locale === "string" ? body.locale.slice(0, 8) : null,
        sessionId: str(body.sessionId, 80),
        type: str(body.type, 40),
        clientEventId: str(body.clientEventId, 80),
        cart: body.cart,
        item: body.item,
        phone: body.phone,
        email: body.email,
        touch: body.touch,
      },
      { ip: customerIp(req), userAgent: req.header("user-agent") ?? null },
    );
    if (result.ok) {
      res.status(202).json(result);
      return;
    }
    res.status(result.code === "page_unavailable" ? 404 : 400).json(result);
  } catch (err) {
    console.error(JSON.stringify({ evt: "landing.activity_failed", error: (err as Error).message?.slice(0, 200) }));
    res.status(500).json({ ok: false, code: "server_error" });
  }
});

export const landingRecoverRouter = Router();

landingRecoverRouter.post("/", recoverLimiter, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const result = await restoreRecoveryCart({
      host: str(body.host, 300),
      locale: typeof body.locale === "string" ? body.locale.slice(0, 8) : null,
      token: body.token,
    });
    res.setHeader("cache-control", "no-store");
    if (result.ok) {
      res.json(result);
      return;
    }
    res.status(result.code === "page_unavailable" ? 404 : result.code === "expired" ? 410 : 400).json(result);
  } catch (err) {
    console.error(JSON.stringify({ evt: "landing.recover_failed", error: (err as Error).message?.slice(0, 200) }));
    res.status(500).json({ ok: false, code: "server_error" });
  }
});
