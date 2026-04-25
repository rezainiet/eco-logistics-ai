import express, { type Request, type Response } from "express";
import { Types } from "mongoose";
import { Integration, type IntegrationProvider } from "@ecom/db";
import { adapterFor, hasAdapter } from "../../lib/integrations/index.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { processWebhookOnce } from "../ingest.js";
import {
  exchangeShopifyCode,
  fetchShopifyShopInfo,
  registerShopifyWebhooks,
  verifyShopifyOAuthHmac,
} from "../../lib/integrations/shopify.js";
import { writeAudit } from "../../lib/audit.js";
import { safeStringEqual } from "../../lib/crypto.js";

/**
 * Inbound webhook receiver for commerce platforms. Mounted at
 * `/api/integrations/webhook/:provider/:integrationId` so each connector has
 * its own URL — that lets us look up the merchant + secret without trusting
 * any header sent by the upstream.
 *
 * Express's default JSON parser is replaced with `express.raw` here because
 * Shopify and Woo HMAC the *raw bytes* — re-stringifying parsed JSON would
 * change whitespace and break verification.
 */
export const integrationsWebhookRouter = express.Router();

integrationsWebhookRouter.post(
  "/:provider/:integrationId",
  express.raw({ type: "*/*", limit: "2mb" }),
  async (req: Request, res: Response) => {
    const { provider, integrationId } = req.params;
    if (!provider || !integrationId) {
      return res.status(400).json({ ok: false, error: "missing route params" });
    }
    if (!Types.ObjectId.isValid(integrationId)) {
      return res.status(400).json({ ok: false, error: "invalid integration id" });
    }
    if (!hasAdapter(provider as IntegrationProvider)) {
      return res.status(400).json({ ok: false, error: "unknown provider" });
    }

    const integration = await Integration.findById(integrationId).lean();
    if (!integration) {
      return res.status(404).json({ ok: false, error: "integration not found" });
    }
    if (String(integration.provider) !== provider) {
      return res.status(400).json({ ok: false, error: "provider mismatch" });
    }
    if (integration.status !== "connected") {
      return res.status(409).json({ ok: false, error: "integration not connected" });
    }

    const adapter = adapterFor(provider as IntegrationProvider);
    const rawBody = req.body as Buffer;
    const rawString = rawBody.toString("utf8");

    let secret: string | undefined;
    try {
      secret = integration.webhookSecret
        ? decryptSecret(integration.webhookSecret)
        : undefined;
    } catch {
      secret = undefined;
    }

    const valid = adapter.verifyWebhookSignature({
      rawBody: rawString,
      headers: req.headers,
      secret,
    });
    if (!valid) {
      await Integration.updateOne(
        { _id: integration._id },
        {
          $inc: { "webhookStatus.failures": 1 },
          $set: { "webhookStatus.lastError": "signature mismatch" },
        },
      );
      return res.status(401).json({ ok: false, error: "invalid signature" });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawString);
    } catch {
      return res.status(400).json({ ok: false, error: "invalid json" });
    }

    const topic =
      (req.headers["x-shopify-topic"] as string | undefined) ||
      (req.headers["x-wc-webhook-topic"] as string | undefined) ||
      (req.headers["x-event-topic"] as string | undefined) ||
      "order.created";

    const externalId =
      (req.headers["x-shopify-webhook-id"] as string | undefined) ||
      (req.headers["x-wc-webhook-delivery-id"] as string | undefined) ||
      (req.headers["x-ecom-event-id"] as string | undefined) ||
      (() => {
        const p = payload as { id?: number | string; externalId?: string };
        return p?.externalId ? String(p.externalId) : p?.id ? String(p.id) : "";
      })();

    if (!externalId) {
      return res.status(400).json({ ok: false, error: "missing external id" });
    }

    const normalized = adapter.normalizeWebhookPayload(topic, payload);

    const result = await processWebhookOnce({
      merchantId: integration.merchantId as Types.ObjectId,
      integrationId: integration._id,
      provider,
      topic,
      externalId,
      rawPayload: payload,
      payloadBytes: rawBody.byteLength,
      normalized,
      source: provider as "shopify" | "woocommerce" | "custom_api",
      ip: req.ip,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    });

    await Integration.updateOne(
      { _id: integration._id },
      { $set: { "webhookStatus.lastEventAt": new Date() } },
    );

    if (result.ok) {
      return res.json({
        ok: true,
        duplicate: !!result.duplicate,
        orderId: result.orderId ?? null,
      });
    }
    return res.status(202).json({ ok: false, error: result.error });
  },
);

/**
 * Shopify OAuth callback — completes the install kicked off by
 * `integrations.connect({ provider: "shopify" })`. Shopify redirects the
 * merchant browser here with `?code=…&state=…&shop=…&hmac=…`.
 *
 * We:
 *   1. Validate the `state` matches the nonce we stored at install-start.
 *   2. Validate the HMAC over the query string (proves Shopify sent it).
 *   3. POST `code` + app credentials to Shopify, get a permanent access token.
 *   4. Encrypt + persist the token, mark the integration `connected`.
 *   5. Best-effort fetch shop name/plan to populate the dashboard label.
 *   6. Redirect the merchant back to the dashboard with success/error flag.
 *
 * Failure mode: never leak token/error to the URL bar — redirect with a
 * generic `?error=<code>` and write the detail to the audit log.
 */
export const shopifyOauthRouter = express.Router();

shopifyOauthRouter.get(
  "/oauth/shopify/callback",
  async (req: Request, res: Response) => {
    const dashboard = `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"}/dashboard/integrations`;
    const fail = (errorCode: string) =>
      res.redirect(`${dashboard}?error=${encodeURIComponent(errorCode)}`);

    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const shop = typeof req.query.shop === "string" ? req.query.shop : null;
    if (!code || !state || !shop) return fail("missing_params");

    // Shopify ships shop as `<name>.myshopify.com` — reject anything else so
    // the redirect can't be smuggled into a lookalike domain.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
      return fail("invalid_shop");
    }

    const integration = await Integration.findOne({
      provider: "shopify",
      accountKey: shop.toLowerCase(),
      status: "pending",
    });
    if (!integration) return fail("integration_not_found");

    const storedNonce = integration.credentials?.installNonce;
    if (!storedNonce || !safeStringEqual(state, storedNonce)) {
      return fail("state_mismatch");
    }

    let apiKey: string;
    let apiSecret: string;
    try {
      apiKey = decryptSecret(integration.credentials!.apiKey as string);
      apiSecret = decryptSecret(integration.credentials!.apiSecret as string);
    } catch {
      return fail("credential_decrypt_failed");
    }

    if (!verifyShopifyOAuthHmac(req.query as Record<string, string | string[] | undefined>, apiSecret)) {
      void writeAudit({
        merchantId: integration.merchantId as Types.ObjectId,
        actorId: integration.merchantId as Types.ObjectId,
        actorType: "system",
        action: "integration.shopify_oauth",
        subjectType: "integration",
        subjectId: integration._id,
        meta: { ok: false, reason: "hmac_mismatch", shop },
      });
      return fail("hmac_mismatch");
    }

    let exchange;
    try {
      exchange = await exchangeShopifyCode({
        shopDomain: shop,
        apiKey,
        apiSecret,
        code,
      });
    } catch (err) {
      void writeAudit({
        merchantId: integration.merchantId as Types.ObjectId,
        actorId: integration.merchantId as Types.ObjectId,
        actorType: "system",
        action: "integration.shopify_oauth",
        subjectType: "integration",
        subjectId: integration._id,
        meta: { ok: false, reason: (err as Error).message.slice(0, 200), shop },
      });
      return fail("token_exchange_failed");
    }

    const shopInfo = await fetchShopifyShopInfo({
      shopDomain: shop,
      accessToken: exchange.accessToken,
    });

    // Auto-register webhooks so the merchant doesn't have to copy/paste the
    // URL into the Shopify admin panel. Failures don't block connect — they
    // surface in `webhookStatus.lastError` with a clear retry path.
    const callbackUrl = `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/integrations/webhook/shopify/${String(integration._id)}`;
    const reg = await registerShopifyWebhooks({
      shopDomain: shop,
      accessToken: exchange.accessToken,
      callbackUrl,
    });

    const now = new Date();
    integration.credentials = {
      ...(integration.credentials ?? {}),
      accessToken: encryptSecret(exchange.accessToken),
      // Wipe the install nonce so the same code can't be replayed later.
      installNonce: undefined,
      scopes: exchange.scope ? exchange.scope.split(",").map((s) => s.trim()).filter(Boolean) : integration.credentials?.scopes ?? [],
    } as typeof integration.credentials;
    integration.status = "connected";
    integration.connectedAt = now;
    integration.disconnectedAt = null;
    if (shopInfo) {
      integration.label = `Shopify · ${shopInfo.name}`;
    }
    integration.health = {
      ok: true,
      lastError: undefined,
      lastCheckedAt: now,
    };
    integration.webhookStatus = {
      registered: reg.registered.length > 0,
      lastEventAt: integration.webhookStatus?.lastEventAt,
      failures: integration.webhookStatus?.failures ?? 0,
      lastError: reg.errors.length > 0 ? reg.errors.join("; ").slice(0, 500) : undefined,
    };
    await integration.save();

    void writeAudit({
      merchantId: integration.merchantId as Types.ObjectId,
      actorId: integration.merchantId as Types.ObjectId,
      actorType: "system",
      action: "integration.shopify_oauth",
      subjectType: "integration",
      subjectId: integration._id,
      meta: {
        ok: true,
        shop,
        shopName: shopInfo?.name ?? null,
        plan: shopInfo?.planName ?? null,
        scopes: exchange.scope || null,
        webhooksRegistered: reg.registered,
        webhookErrors: reg.errors,
      },
    });

    return res.redirect(
      `${dashboard}?connected=shopify&shop=${encodeURIComponent(shop)}`,
    );
  },
);
