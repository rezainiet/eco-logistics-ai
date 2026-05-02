import express, { type Request, type Response } from "express";
import { Types } from "mongoose";
import { Integration, type IntegrationProvider } from "@ecom/db";
import { adapterFor, hasAdapter } from "../../lib/integrations/index.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { enqueueInboundWebhook } from "../ingest.js";
import { QUEUE_NAMES, safeEnqueue } from "../../lib/queue.js";
import {
  exchangeShopifyCode,
  fetchShopifyShopInfo,
  registerShopifyWebhooks,
  verifyShopifyOAuthHmac,
} from "../../lib/integrations/shopify.js";
import { writeAudit } from "../../lib/audit.js";
import { safeStringEqual } from "../../lib/crypto.js";

/**
 * Maximum age (ms) of an inbound webhook before we reject it as stale. The
 * inbox unique index already collapses replays into idempotent no-ops, but
 * the freshness gate stops a captured payload from being weaponised hours or
 * days later — pairs with the TTL on `WebhookInbox.expiresAt`.
 */
const WEBHOOK_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;
/** Allow a small clock-skew tolerance for upstream timestamps in the future. */
const WEBHOOK_FUTURE_SKEW_MS = 60 * 1000;

function readUpstreamTimestamp(headers: Record<string, unknown>): Date | null {
  // Shopify ships ISO8601 in `x-shopify-triggered-at`. Custom-API senders use
  // `x-event-timestamp` (epoch seconds OR ISO). Woo doesn't send a timestamp
  // header, so callers without one fall through and skip the freshness check.
  const candidates = [
    "x-shopify-triggered-at",
    "x-event-timestamp",
    "x-timestamp",
  ];
  for (const key of candidates) {
    const v = headers[key];
    const raw = Array.isArray(v) ? v[0] : v;
    if (typeof raw !== "string" || !raw) continue;
    // Numeric epoch — accept seconds OR milliseconds.
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      const ms = n < 1e12 ? n * 1000 : n;
      const d = new Date(ms);
      if (!isNaN(d.getTime())) return d;
      continue;
    }
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

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
    if (!Buffer.isBuffer(rawBody)) {
      // Defence-in-depth: if a future middleware change ever lets the global
      // JSON parser run first, HMAC verification becomes mathematically
      // impossible. Fail loudly rather than silently 401 every delivery.
      console.error(
        "[webhook] expected Buffer body — middleware ordering regressed",
      );
      return res.status(500).json({ ok: false, error: "raw body unavailable" });
    }
    const rawString = rawBody.toString("utf8");

    // HMAC key resolution differs by platform:
    //   - Shopify signs every webhook with the app's `client_secret`
    //     (== our stored `credentials.apiSecret`). The platform doesn't know
    //     about any secret we mint locally.
    //   - WooCommerce, custom_api: we configure the secret on their side
    //     during connect, so `integration.webhookSecret` is the source of
    //     truth.
    let secret: string | undefined;
    try {
      if (provider === "shopify") {
        const stored = (integration.credentials as Record<string, string | undefined> | undefined)
          ?.apiSecret;
        secret = stored ? decryptSecret(stored) : undefined;
      } else {
        secret = integration.webhookSecret
          ? decryptSecret(integration.webhookSecret)
          : undefined;
      }
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

    // Freshness gate — reject replays of captured payloads. Only enforced
    // when the upstream sends a verifiable timestamp; absence means the
    // platform doesn't ship one (Woo) and we must accept the delivery.
    const upstreamAt = readUpstreamTimestamp(
      req.headers as Record<string, unknown>,
    );
    if (upstreamAt) {
      const skew = Date.now() - upstreamAt.getTime();
      if (skew > WEBHOOK_FRESHNESS_WINDOW_MS) {
        return res
          .status(400)
          .json({ ok: false, error: "stale webhook (outside 5m window)" });
      }
      if (skew < -WEBHOOK_FUTURE_SKEW_MS) {
        return res
          .status(400)
          .json({ ok: false, error: "future-dated webhook" });
      }
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

    // Stamp the inbox row in `received` state. The unique index collapses
    // duplicate deliveries into a no-op so we can ACK immediately without
    // ever touching the ingestion pipeline twice.
    let stamped;
    try {
      stamped = await enqueueInboundWebhook({
        merchantId: integration.merchantId as Types.ObjectId,
        integrationId: integration._id as Types.ObjectId,
        provider,
        topic,
        externalId,
        rawPayload: payload,
        payloadBytes: rawBody.byteLength,
      });
    } catch (err) {
      console.error(
        "[webhook] inbox stamp failed",
        (err as Error).message,
      );
      // 5xx so the upstream retries — we never lost the event.
      return res.status(500).json({ ok: false, error: "inbox unavailable" });
    }

    // Bookkeeping that doesn't gate the ACK — fire-and-forget.
    void Integration.updateOne(
      { _id: integration._id },
      { $set: { "webhookStatus.lastEventAt": new Date() } },
    ).catch((e) =>
      console.error("[webhook] integration touch failed", (e as Error).message),
    );

    if (stamped.duplicate) {
      // Already processed (or in-flight). Echo the prior order id when known.
      return res.status(202).json({
        ok: true,
        duplicate: true,
        orderId: stamped.resolvedOrderId ?? null,
      });
    }

    // Hand off to the worker. `safeEnqueue` never throws — on Redis outage
    // it returns ok:false and notifies the merchant, but the inbox row is
    // already on disk so the next sweep will still pick it up.
    void safeEnqueue(
      QUEUE_NAMES.webhookProcess,
      "webhook-process:ingest",
      { inboxId: String(stamped.inboxId) },
      {
        // Job-level retries are off — the inbox row owns the canonical
        // backoff schedule via `nextRetryAt`.
        attempts: 1,
      },
      {
        merchantId: String(integration.merchantId),
        description: `${provider} webhook ingest`,
      },
    );

    return res.status(202).json({ ok: true, queued: true });
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
    const dashboard = `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3001"}/dashboard/integrations`;
    const fail = (errorCode: string) =>
      res.redirect(`${dashboard}?error=${encodeURIComponent(errorCode)}`);

    // Shopify can land here with an `error=…` param (most commonly
    // `access_denied` when the merchant clicks "Cancel" on the approval
    // screen, or `invalid_request` when the install URL was malformed).
    // Distinguish those from a genuinely missing `code` so the dashboard
    // can show a friendlier message than "Missing OAuth parameters".
    const errorParam = typeof req.query.error === "string" ? req.query.error : null;
    if (errorParam) {
      // `access_denied` → merchant declined; everything else is mapped to
      // a generic "we couldn't complete the install" so we don't leak
      // upstream error vocab into the merchant UI.
      const code =
        errorParam === "access_denied" ? "user_cancelled" : "shopify_install_rejected";
      return fail(code);
    }

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
