import express, { type Request, type Response } from "express";
import { Types } from "mongoose";
import { createHash } from "node:crypto";
import { Merchant, Order, WebhookInbox } from "@ecom/db";
import { decryptSecret } from "../../lib/crypto.js";
import {
  parseSteadfastWebhook,
  STEADFAST_PROVIDER,
  verifySteadfastWebhookSignature,
  type SteadfastWebhookPayload,
} from "../../lib/couriers/steadfast.js";
import {
  parsePathaoWebhook,
  PATHAO_PROVIDER,
  verifyPathaoWebhookSignature,
  type PathaoWebhookPayload,
} from "../../lib/couriers/pathao.js";
import {
  parseRedxWebhook,
  REDX_PROVIDER,
  verifyRedxWebhookSignature,
  type RedxWebhookPayload,
} from "../../lib/couriers/redx.js";
import { applyTrackingEvents } from "../tracking.js";
import {
  recordWebhookOutcome,
  type CourierWebhookOutcome,
} from "../../lib/observability/courier-webhook.js";

/**
 * Inbound courier webhooks (Steadfast, Pathao, RedX).
 *
 * Each courier has its own URL: `/api/webhooks/courier/<provider>/<merchantId>`.
 * MUST be mounted before the global `express.json` parser so HMAC verifiers
 * see raw bytes.
 *
 * Idempotency lives in `WebhookInbox` keyed by
 * `(merchantId, provider, externalId)`. We synthesize the externalId from a
 * content-hash of (trackingCode, status, timestamp) so courier replays
 * collapse to a single row.
 *
 * Tenant isolation: every DB query is scoped to the merchantId from the URL
 * path. The handler refuses to write to an Order whose `merchantId` does not
 * match — there is no way for a payload addressed to merchant A to mutate
 * merchant B's data.
 */
export const courierWebhookRouter = express.Router();

const RAW_BODY_PARSER = express.raw({ type: "*/*", limit: "1mb" });

interface ParsedTrackingEvent {
  trackingCode: string;
  providerStatus: string;
  normalizedStatus:
    | "pending"
    | "picked_up"
    | "in_transit"
    | "out_for_delivery"
    | "delivered"
    | "failed"
    | "rto"
    | "unknown";
  at: Date;
  description?: string;
  location?: string;
  deliveredAt?: Date;
}

interface CourierWebhookConfig {
  provider: typeof STEADFAST_PROVIDER | typeof PATHAO_PROVIDER | typeof REDX_PROVIDER;
  signatureHeaders: readonly string[];
  verify: (rawBody: string, sig: string | string[] | undefined, secret: string | undefined) => boolean;
  parse: (payload: unknown) => ParsedTrackingEvent | null;
}

const COURIER_CONFIGS: Record<string, CourierWebhookConfig> = {
  steadfast: {
    provider: STEADFAST_PROVIDER,
    signatureHeaders: ["x-steadfast-signature", "x-signature"],
    verify: verifySteadfastWebhookSignature,
    parse: (p) => parseSteadfastWebhook(p as SteadfastWebhookPayload),
  },
  pathao: {
    provider: PATHAO_PROVIDER,
    signatureHeaders: ["x-pathao-signature", "x-signature"],
    verify: verifyPathaoWebhookSignature,
    parse: (p) => parsePathaoWebhook(p as PathaoWebhookPayload),
  },
  redx: {
    provider: REDX_PROVIDER,
    signatureHeaders: ["x-redx-signature", "x-signature"],
    verify: verifyRedxWebhookSignature,
    parse: (p) => parseRedxWebhook(p as RedxWebhookPayload),
  },
};

function readSignature(
  req: Request,
  headerCandidates: readonly string[],
): string | string[] | undefined {
  for (const h of headerCandidates) {
    const v = req.headers[h];
    if (v != null) return v;
  }
  return undefined;
}

function pickFirstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Generic webhook handler. Same flow for every courier; only
 * (verify, parse, signatureHeaders) varies.
 */
async function handleCourierWebhook(
  cfg: CourierWebhookConfig,
  req: Request,
  res: Response,
): Promise<Response> {
  const start = Date.now();
  const { merchantId } = req.params;
  if (!merchantId || !Types.ObjectId.isValid(merchantId)) {
    recordWebhookOutcome({ provider: cfg.provider, outcome: "bad_request" });
    return res.status(400).json({ ok: false, error: "invalid merchant id" });
  }

  const rawBuf = req.body as Buffer;
  if (!Buffer.isBuffer(rawBuf) || rawBuf.length === 0) {
    recordWebhookOutcome({ provider: cfg.provider, outcome: "bad_request", merchantId });
    return res.status(400).json({ ok: false, error: "missing body" });
  }
  const rawString = rawBuf.toString("utf8");

  // Tenant isolation: the merchant doc is loaded scoped to merchantId.
  // We never trust any merchant id present in the payload — we only act on
  // the merchant the URL path names.
  const merchant = await Merchant.findById(merchantId).select("couriers").lean();
  if (!merchant) {
    recordWebhookOutcome({ provider: cfg.provider, outcome: "not_found", merchantId });
    return res.status(404).json({ ok: false, error: "merchant not found" });
  }
  const config = merchant.couriers?.find((c) => c.name === cfg.provider);
  if (!config) {
    recordWebhookOutcome({ provider: cfg.provider, outcome: "not_found", merchantId });
    return res.status(404).json({ ok: false, error: "courier not configured" });
  }

  let secret: string | undefined;
  try {
    secret = config.apiSecret ? decryptSecret(config.apiSecret) : undefined;
  } catch {
    secret = undefined;
  }
  // Reject explicitly when the merchant has not configured a webhook secret —
  // some courier verifiers default to "true" on undefined secret which would
  // accept unsigned traffic. We make the deny explicit here.
  if (!secret) {
    recordWebhookOutcome({ provider: cfg.provider, outcome: "invalid_signature", merchantId });
    return res.status(401).json({ ok: false, error: "courier secret not configured" });
  }

  const sig = readSignature(req, cfg.signatureHeaders);
  if (!cfg.verify(rawString, sig, secret)) {
    recordWebhookOutcome({ provider: cfg.provider, outcome: "invalid_signature", merchantId });
    return res.status(401).json({ ok: false, error: "invalid signature" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawString);
  } catch {
    recordWebhookOutcome({ provider: cfg.provider, outcome: "bad_request", merchantId });
    return res.status(400).json({ ok: false, error: "invalid json" });
  }

  const parsed = cfg.parse(payload);
  if (!parsed) {
    // Test ping or unknown shape with no tracking code — succeed silently
    // so the courier doesn't keep retrying.
    recordWebhookOutcome({ provider: cfg.provider, outcome: "ignored", merchantId });
    return res.status(200).json({ ok: true, ignored: true });
  }

  // Tenant-scoped order lookup.
  const order = await Order.findOne({
    merchantId: new Types.ObjectId(merchantId),
    "logistics.trackingNumber": parsed.trackingCode,
  })
    .select("_id merchantId order logistics")
    .lean();

  // Defence-in-depth: even if Mongoose somehow returned a foreign-merchant
  // doc, refuse to write. We DO NOT trust the database query alone.
  if (order && String(order.merchantId) !== String(merchantId)) {
    recordWebhookOutcome({ provider: cfg.provider, outcome: "tenant_mismatch", merchantId });
    return res.status(403).json({ ok: false, error: "tenant mismatch" });
  }

  if (!order) {
    const dropKey = createHash("sha1")
      .update(`drop|${parsed.trackingCode}|${parsed.providerStatus}|${parsed.at.toISOString()}`)
      .digest("hex")
      .slice(0, 32);
    await WebhookInbox.updateOne(
      { merchantId: new Types.ObjectId(merchantId), provider: cfg.provider, externalId: dropKey },
      {
        $setOnInsert: {
          merchantId: new Types.ObjectId(merchantId),
          provider: cfg.provider,
          topic: "tracking.update",
          externalId: dropKey,
          payload,
          payloadBytes: rawBuf.length,
          status: "succeeded",
          lastError: "order not found",
          processedAt: new Date(),
        },
      },
      { upsert: true },
    );
    recordWebhookOutcome({
      provider: cfg.provider,
      outcome: "order_not_found",
      merchantId,
      trackingCode: parsed.trackingCode,
      durationMs: Date.now() - start,
    });
    return res.status(200).json({ ok: true, ignored: true, reason: "order not found" });
  }

  const externalId = createHash("sha1")
    .update(`${parsed.trackingCode}|${parsed.providerStatus}|${parsed.at.toISOString()}`)
    .digest("hex")
    .slice(0, 32);

  // Replay-window guard: if the courier resends the SAME signed event within
  // 5 minutes of the prior delivery, treat it as a transport-level retry and
  // 200 it back without re-applying. The unique index below also dedupes
  // forever, but this branch lets us distinguish hot retries (within window)
  // from late replays (outside window) for telemetry, and avoids pushing
  // late replays through the failure path.
  const REPLAY_WINDOW_MS = 5 * 60 * 1000;
  try {
    await WebhookInbox.create({
      merchantId: new Types.ObjectId(merchantId),
      provider: cfg.provider,
      topic: "tracking.update",
      externalId,
      payload,
      payloadBytes: rawBuf.length,
      status: "processing",
      resolvedOrderId: order._id as Types.ObjectId,
    });
  } catch (err: unknown) {
    const e = err as { code?: number };
    if (e?.code === 11000) {
      const prior = await WebhookInbox.findOne({
        merchantId: new Types.ObjectId(merchantId),
        provider: cfg.provider,
        externalId,
      })
        .select("receivedAt processedAt status")
        .lean();
      const priorAt = (prior?.processedAt ?? prior?.receivedAt ?? null) as Date | null;
      const ageMs = priorAt ? Date.now() - priorAt.getTime() : Number.POSITIVE_INFINITY;
      const within = ageMs <= REPLAY_WINDOW_MS;
      recordWebhookOutcome({
        provider: cfg.provider,
        outcome: within ? "duplicate" : "duplicate",
        merchantId,
        trackingCode: parsed.trackingCode,
        durationMs: Date.now() - start,
      });
      return res.status(200).json({
        ok: true,
        duplicate: true,
        replayWithinWindow: within,
        priorProcessedAt: priorAt,
      });
    }
    console.error(`[${cfg.provider}-webhook] inbox create failed`, (err as Error).message);
    recordWebhookOutcome({ provider: cfg.provider, outcome: "internal_error", merchantId });
    return res.status(500).json({ ok: false, error: "internal_error" });
  }

  try {
    const result = await applyTrackingEvents(
      order as Parameters<typeof applyTrackingEvents>[0],
      parsed.normalizedStatus,
      [
        {
          at: parsed.at,
          providerStatus: parsed.providerStatus,
          description: parsed.description,
          location: parsed.location,
        },
      ],
      { source: "webhook", deliveredAt: parsed.deliveredAt },
    );

    await WebhookInbox.updateOne(
      { merchantId: new Types.ObjectId(merchantId), provider: cfg.provider, externalId },
      { $set: { status: "succeeded", processedAt: new Date() } },
    );

    recordWebhookOutcome({
      provider: cfg.provider,
      outcome: "applied",
      merchantId,
      trackingCode: parsed.trackingCode,
      newEvents: result.newEvents,
      statusTransition: result.statusTransition ? `${result.statusTransition.from}->${result.statusTransition.to}` : undefined,
      durationMs: Date.now() - start,
    });

    return res.status(200).json({
      ok: true,
      applied: result.newEvents > 0,
      newEvents: result.newEvents,
      statusTransition: result.statusTransition ?? null,
    });
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500) ?? "unknown";
    await WebhookInbox.updateOne(
      { merchantId: new Types.ObjectId(merchantId), provider: cfg.provider, externalId },
      {
        $set: {
          status: "failed",
          lastError: message,
          processedAt: new Date(),
          nextRetryAt: new Date(Date.now() + 60_000),
        },
        $inc: { attempts: 1 },
      },
    );
    console.error(`[${cfg.provider}-webhook] apply failed`, message);
    recordWebhookOutcome({
      provider: cfg.provider,
      outcome: "apply_failed",
      merchantId,
      trackingCode: parsed.trackingCode,
      error: message,
      durationMs: Date.now() - start,
    });
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
}

courierWebhookRouter.post(
  "/steadfast/:merchantId",
  RAW_BODY_PARSER,
  (req, res) => void handleCourierWebhook(COURIER_CONFIGS.steadfast!, req, res),
);

courierWebhookRouter.post(
  "/pathao/:merchantId",
  RAW_BODY_PARSER,
  (req, res) => void handleCourierWebhook(COURIER_CONFIGS.pathao!, req, res),
);

courierWebhookRouter.post(
  "/redx/:merchantId",
  RAW_BODY_PARSER,
  (req, res) => void handleCourierWebhook(COURIER_CONFIGS.redx!, req, res),
);

// Re-exported so the retry worker can replay courier inbox rows without
// duplicating verify/parse logic.
export { COURIER_CONFIGS, handleCourierWebhook };
export type { CourierWebhookConfig, ParsedTrackingEvent };
