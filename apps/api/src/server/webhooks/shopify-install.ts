import express, { type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { env } from "../../env.js";
import { getRedis } from "../../lib/redis.js";
import {
  buildShopifyInstallUrl,
  verifyShopifyOAuthHmac,
} from "../../lib/integrations/shopify.js";

/**
 * Public Shopify install entry-point.
 *
 * Mounted at `GET /api/shopify/install?shop=<shop>.myshopify.com[&hmac=&timestamp=&host=]`.
 *
 * This is the URL Shopify hits when:
 *   - A merchant clicks "Install" from the Shopify App Store
 *   - A merchant follows a referral / Partners install link
 *   - The Shopify reviewer test-installs during App Store review
 *
 * Behaviour (in order):
 *   1. Validate shop domain shape — refuse anything that isn't <slug>.myshopify.com.
 *   2. Validate `SHOPIFY_APP_API_KEY` + `SHOPIFY_APP_API_SECRET` env presence —
 *      without them OAuth literally cannot start, so fail fast with a 503 the
 *      ops dashboard / on-call can see, never silently redirect to a broken
 *      authorize URL.
 *   3. If `hmac` is present in the query (Shopify always ships one on real
 *      install initiation), verify it constant-time against the app secret
 *      and reject mismatches with 401. Reject `timestamp` skew > 5 min as
 *      replay protection.
 *   4. Mint a 32-byte cryptographic nonce (the OAuth `state`).
 *   5. Persist `{shop, hmacValid, scopes, createdAt}` in Redis under
 *      `shopify:install:pending:<nonce>` with a 10-minute TTL. Redis is the
 *      right store here — there's no merchantId yet (the visitor isn't
 *      authenticated), and we want the record to expire on its own if the
 *      merchant abandons the install screen.
 *   6. Build the Shopify authorize URL (`buildShopifyInstallUrl`) targeting
 *      our existing callback at `/api/integrations/oauth/shopify/callback`,
 *      with `state=<nonce>`. The callback will look up the nonce in Redis
 *      (new "public install" branch) before falling through to the legacy
 *      per-merchant Integration lookup.
 *   7. 302 redirect.
 *
 * Replay/state-mismatch protection:
 *   - HMAC validated against the platform secret before any state is written.
 *   - Timestamp must be within ±5 min when supplied.
 *   - Nonce is single-use: the callback `DEL`s the Redis key after read.
 *   - Each install attempt mints a fresh nonce — replaying an old install
 *     URL just creates a new pending record that times out on its own.
 */

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const PENDING_INSTALL_TTL_SEC = 10 * 60;
const HMAC_FRESHNESS_WINDOW_SEC = 5 * 60;

/**
 * Default scopes for the public-distribution app. Read-only by design — see
 * the integrations connect modal copy ("read-only access · read_orders scope
 * only"). Keep this in lock-step with the scopes declared in the Shopify
 * Partners portal; a mismatch causes a `scope_subset_granted` warning during
 * callback.
 */
const PUBLIC_INSTALL_SCOPES = ["read_orders", "read_customers"] as const;

export const PENDING_INSTALL_REDIS_PREFIX = "shopify:install:pending:";

export interface PendingShopifyInstall {
  shop: string;
  hmacValid: boolean;
  scopes: readonly string[];
  createdAt: number;
}

export const shopifyInstallRouter = express.Router();

shopifyInstallRouter.get("/", async (req: Request, res: Response) => {
  const shopRaw = typeof req.query.shop === "string" ? req.query.shop : "";
  const shop = shopRaw.trim().toLowerCase();

  // 1. Validate shop domain shape.
  if (!shop || !SHOP_DOMAIN_RE.test(shop)) {
    return res.status(400).json({
      ok: false,
      error: "invalid_shop",
      detail: "Expected `shop=<slug>.myshopify.com`.",
    });
  }

  // 2. App credentials must be present — without them no OAuth at all.
  const appKey = env.SHOPIFY_APP_API_KEY ?? "";
  const appSecret = env.SHOPIFY_APP_API_SECRET ?? "";
  if (!appKey || !appSecret) {
    console.error(
      "[shopify-install] SHOPIFY_APP_API_KEY / SHOPIFY_APP_API_SECRET are not set on this environment",
    );
    return res
      .status(503)
      .json({ ok: false, error: "app_credentials_not_configured" });
  }

  // 3. HMAC verification (when present) + replay protection.
  const hasHmac = typeof req.query.hmac === "string" && req.query.hmac.length > 0;
  let hmacValid = false;
  if (hasHmac) {
    const queryForHmac = req.query as Record<string, string | string[] | undefined>;
    if (!verifyShopifyOAuthHmac(queryForHmac, appSecret)) {
      console.warn("[shopify-install] hmac_mismatch", { shop });
      return res.status(401).json({ ok: false, error: "hmac_mismatch" });
    }
    hmacValid = true;
    const tsRaw = req.query.timestamp;
    if (typeof tsRaw === "string") {
      const ts = Number.parseInt(tsRaw, 10);
      if (Number.isFinite(ts)) {
        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - ts) > HMAC_FRESHNESS_WINDOW_SEC) {
          console.warn("[shopify-install] timestamp_out_of_window", {
            shop,
            ts,
            now,
            skewSec: Math.abs(now - ts),
          });
          return res
            .status(401)
            .json({ ok: false, error: "request_expired" });
        }
      }
    }
  }

  // 4 + 5. Mint nonce, persist pending install.
  const nonce = randomBytes(32).toString("base64url");
  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    console.error("[shopify-install] redis_unavailable", {
      err: (err as Error).message,
    });
    return res.status(503).json({ ok: false, error: "install_temporarily_unavailable" });
  }
  const pending: PendingShopifyInstall = {
    shop,
    hmacValid,
    scopes: PUBLIC_INSTALL_SCOPES,
    createdAt: Date.now(),
  };
  try {
    await redis.set(
      `${PENDING_INSTALL_REDIS_PREFIX}${nonce}`,
      JSON.stringify(pending),
      "EX",
      PENDING_INSTALL_TTL_SEC,
    );
  } catch (err) {
    console.error("[shopify-install] redis_write_failed", {
      err: (err as Error).message,
    });
    return res
      .status(503)
      .json({ ok: false, error: "install_temporarily_unavailable" });
  }

  // 6. Build authorize URL pointing at the existing callback.
  const redirectUri = `${env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/integrations/oauth/shopify/callback`;
  const installUrl = buildShopifyInstallUrl({
    shopDomain: shop,
    apiKey: appKey,
    redirectUri,
    scopes: [...PUBLIC_INSTALL_SCOPES],
    state: nonce,
  });

  // 8. Audit log — no merchantId yet (the visitor is pre-auth) and the
  // shop isn't an ObjectId, so the chained Mongo audit log isn't
  // appropriate here. Log to stdout instead so Railway picks it up; the
  // *completion* of the install (after the merchant signs up and claims)
  // is what gets the proper merchant-scoped audit row.
  console.log("[shopify-install] redirecting to authorize", {
    shop,
    hmacValid,
    statePrefix: nonce.slice(0, 6) + "...",
    redirectUri,
    scopes: pending.scopes,
    managedFlow: typeof req.query.host === "string",
    ip: req.ip,
  });

  // 7. Redirect.
  return res.redirect(302, installUrl);
});
