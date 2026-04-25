import express, { type Request, type Response } from "express";
import { Types } from "mongoose";
import { Integration, type IntegrationProvider } from "@ecom/db";
import { adapterFor, hasAdapter } from "../../lib/integrations/index.js";
import { decryptSecret } from "../../lib/crypto.js";
import { processWebhookOnce } from "../ingest.js";

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
