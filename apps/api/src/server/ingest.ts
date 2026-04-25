import { Types } from "mongoose";
import {
  Integration,
  Merchant,
  type MerchantFraudConfig,
  Order,
  TrackingEvent,
  TrackingSession,
  WebhookInbox,
} from "@ecom/db";
import {
  collectRiskHistory,
  computeRisk,
  hashAddress,
  type RiskOptions,
} from "./risk.js";
import { fireFraudAlert } from "../lib/alerts.js";
import { writeAudit } from "../lib/audit.js";
import { releaseQuota, reserveQuota } from "../lib/usage.js";
import { getPlan } from "../lib/plans.js";
import { invalidate } from "../lib/cache.js";
import type { NormalizedOrder } from "../lib/integrations/types.js";

/**
 * Ingest a normalized order from an external channel (Shopify webhook, Woo
 * webhook, custom API, dashboard form).
 *
 * Guarantees:
 *  - Quota-checked against the merchant's monthly cap (refunded on failure).
 *  - Fraud-scored using the same engine the dashboard uses.
 *  - Identity-stitched: behavioral sessions matching phone/email link to the
 *    new order so the merchant sees the buyer's prior intent signals.
 *  - High-risk orders fire a notification + audit entry.
 *
 * Idempotency lives one layer above (in `processWebhookOnce`) — callers that
 * dedupe by external id should hit that helper instead.
 */

export type IngestSource = "shopify" | "woocommerce" | "custom_api" | "csv" | "dashboard";

export interface IngestOptions {
  merchantId: Types.ObjectId;
  source: IngestSource;
  channel: "dashboard" | "bulk_upload" | "api" | "webhook" | "system";
  integrationId?: Types.ObjectId;
  ip?: string;
  userAgent?: string;
}

export interface IngestResult {
  ok: boolean;
  orderId?: string;
  duplicate?: boolean;
  error?: string;
  riskLevel?: "low" | "medium" | "high";
  riskScore?: number;
}

export async function ingestNormalizedOrder(
  normalized: NormalizedOrder,
  opts: IngestOptions,
): Promise<IngestResult> {
  if (!normalized.customer?.phone) {
    return { ok: false, error: "missing customer phone" };
  }

  // Duplicate guard — same merchant + same upstream id = no-op.
  const existing = await Order.findOne({
    merchantId: opts.merchantId,
    "source.externalId": normalized.externalId,
  })
    .select("_id")
    .lean();
  if (existing) {
    return { ok: true, duplicate: true, orderId: String(existing._id) };
  }

  const merchant = await Merchant.findById(opts.merchantId)
    .select("subscription.tier fraudConfig")
    .lean();
  if (!merchant) return { ok: false, error: "merchant not found" };

  const plan = getPlan(merchant.subscription?.tier);
  const reservation = await reserveQuota(opts.merchantId, plan, "ordersCreated", 1);
  if (!reservation.allowed) {
    return {
      ok: false,
      error: `monthly order quota reached (${reservation.used}/${reservation.limit})`,
    };
  }

  try {
    const fraudConfig: MerchantFraudConfig = (merchant.fraudConfig ?? {}) as MerchantFraudConfig;
    const riskOpts: RiskOptions = {
      highCodBdt: fraudConfig.highCodThreshold ?? undefined,
      extremeCodBdt: fraudConfig.extremeCodThreshold ?? undefined,
      suspiciousDistricts: fraudConfig.suspiciousDistricts ?? [],
      blockedPhones: fraudConfig.blockedPhones ?? [],
      blockedAddresses: fraudConfig.blockedAddresses ?? [],
      velocityThreshold: fraudConfig.velocityThreshold ?? 0,
    };
    const addressHashValue = hashAddress(
      normalized.customer.address,
      normalized.customer.district,
    );
    const history = await collectRiskHistory({
      merchantId: opts.merchantId,
      phone: normalized.customer.phone,
      ip: opts.ip,
      addressHash: addressHashValue ?? undefined,
      halfLifeDays: fraudConfig.historyHalfLifeDays ?? 30,
      velocityWindowMin: fraudConfig.velocityWindowMin ?? 10,
    });
    const risk = computeRisk(
      {
        cod: normalized.cod,
        customer: normalized.customer,
        ip: opts.ip,
        addressHash: addressHashValue,
      },
      history,
      riskOpts,
    );

    const orderNumber =
      normalized.externalOrderNumber ??
      `${opts.source.toUpperCase().slice(0, 4)}-${normalized.externalId.slice(-8)}`;

    const orderDoc = await Order.create({
      merchantId: opts.merchantId,
      orderNumber,
      customer: {
        name: normalized.customer.name,
        phone: normalized.customer.phone,
        address: normalized.customer.address,
        district: normalized.customer.district,
      },
      items: normalized.items,
      order: {
        cod: normalized.cod,
        total: normalized.total,
        status: "pending",
      },
      fraud: {
        detected: risk.level === "high",
        riskScore: risk.riskScore,
        level: risk.level,
        reasons: risk.reasons,
        signals: risk.signals,
        reviewStatus: risk.reviewStatus,
        scoredAt: new Date(),
      },
      source: {
        ip: opts.ip,
        userAgent: opts.userAgent,
        addressHash: addressHashValue ?? undefined,
        channel: opts.channel,
        externalId: normalized.externalId,
        sourceProvider: opts.source,
        integrationId: opts.integrationId,
        customerEmail: normalized.customer.email ?? undefined,
        placedAt: normalized.placedAt,
      },
    });

    void writeAudit({
      merchantId: opts.merchantId,
      actorId: opts.merchantId,
      actorType: "system",
      action: "order.ingested",
      subjectType: "order",
      subjectId: orderDoc._id,
      meta: {
        source: opts.source,
        externalId: normalized.externalId,
        riskLevel: risk.level,
        riskScore: risk.riskScore,
      },
    });

    if (opts.integrationId) {
      await Integration.updateOne(
        { _id: opts.integrationId, merchantId: opts.merchantId },
        {
          $inc: { "counts.ordersImported": 1 },
          $set: {
            lastSyncAt: new Date(),
            "webhookStatus.lastEventAt": new Date(),
            "health.ok": true,
          },
        },
      );
    }

    if (risk.level === "high") {
      await fireFraudAlert({
        merchantId: opts.merchantId,
        orderId: orderDoc._id,
        orderNumber: orderDoc.orderNumber,
        phone: orderDoc.customer.phone,
        riskScore: risk.riskScore,
        level: risk.level,
        reasons: risk.reasons,
        kind: "fraud.pending_review",
      });
    }

    await invalidate(`dashboard:${String(opts.merchantId)}`);

    // Identity-resolution best-effort — links prior anon sessions.
    void resolveIdentityForOrder({
      merchantId: opts.merchantId,
      orderId: orderDoc._id,
      phone: normalized.customer.phone,
      email: normalized.customer.email,
    }).catch((err) => console.error("[ingest] identity resolution failed", err));

    return {
      ok: true,
      orderId: String(orderDoc._id),
      riskLevel: risk.level,
      riskScore: risk.riskScore,
    };
  } catch (err) {
    await releaseQuota(opts.merchantId, "ordersCreated", 1);
    if (opts.integrationId) {
      await Integration.updateOne(
        { _id: opts.integrationId, merchantId: opts.merchantId },
        {
          $inc: { "counts.ordersFailed": 1 },
          $set: {
            "health.ok": false,
            "health.lastError": (err as Error).message.slice(0, 500),
            "health.lastCheckedAt": new Date(),
          },
        },
      );
    }
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Idempotent webhook entry-point. Stamps a `WebhookInbox` row before
 * processing so duplicate deliveries (Shopify retries, Woo at-least-once)
 * never spawn a second order.
 *
 * Returns:
 *  - `{ ok: true, duplicate: true }` if the externalId already landed
 *  - `{ ok: true, orderId }` on success
 *  - `{ ok: false, error }` on a hard failure (with the inbox row marked failed)
 */
export async function processWebhookOnce(args: {
  merchantId: Types.ObjectId;
  integrationId: Types.ObjectId;
  provider: string;
  topic: string;
  externalId: string;
  rawPayload: unknown;
  payloadBytes: number;
  normalized: NormalizedOrder | null;
  source: IngestSource;
  ip?: string;
  userAgent?: string;
}): Promise<IngestResult> {
  let inboxRow;
  try {
    inboxRow = await WebhookInbox.create({
      merchantId: args.merchantId,
      integrationId: args.integrationId,
      provider: args.provider,
      topic: args.topic,
      externalId: args.externalId,
      payload: args.rawPayload,
      payloadBytes: args.payloadBytes,
      status: "processing",
    });
  } catch (err: unknown) {
    const e = err as { code?: number };
    if (e?.code === 11000) {
      const existing = await WebhookInbox.findOne({
        merchantId: args.merchantId,
        provider: args.provider,
        externalId: args.externalId,
      })
        .select("status resolvedOrderId")
        .lean();
      return {
        ok: true,
        duplicate: true,
        orderId: existing?.resolvedOrderId ? String(existing.resolvedOrderId) : undefined,
      };
    }
    throw err;
  }

  if (!args.normalized) {
    await WebhookInbox.updateOne(
      { _id: inboxRow._id },
      { $set: { status: "succeeded", processedAt: new Date(), lastError: "ignored" } },
    );
    return { ok: true };
  }

  const result = await ingestNormalizedOrder(args.normalized, {
    merchantId: args.merchantId,
    source: args.source,
    channel: "webhook",
    integrationId: args.integrationId,
    ip: args.ip,
    userAgent: args.userAgent,
  });

  if (result.ok) {
    await WebhookInbox.updateOne(
      { _id: inboxRow._id },
      {
        $set: {
          status: "succeeded",
          processedAt: new Date(),
          ...(result.orderId
            ? { resolvedOrderId: new Types.ObjectId(result.orderId) }
            : {}),
        },
      },
    );
  } else {
    await WebhookInbox.updateOne(
      { _id: inboxRow._id },
      {
        $set: {
          status: "failed",
          lastError: result.error?.slice(0, 500),
          processedAt: new Date(),
        },
        $inc: { attempts: 1 },
      },
    );
  }

  return result;
}

/**
 * Identity resolution. Stitches behavioral sessions that share a phone or
 * email with the freshly-created order so the merchant sees prior intent
 * signals (browsed products, abandoned carts, repeat visits) for this buyer.
 *
 * Best-effort — never throws into the caller. The 30-day lookback keeps the
 * scan bounded; we only stitch sessions that don't already have a resolved
 * order.
 */
export async function resolveIdentityForOrder(args: {
  merchantId: Types.ObjectId;
  orderId: Types.ObjectId;
  phone?: string;
  email?: string;
}): Promise<{ stitchedSessions: number; stitchedEvents: number }> {
  if (!args.phone && !args.email) return { stitchedSessions: 0, stitchedEvents: 0 };
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const orFilter: Array<Record<string, unknown>> = [];
  if (args.phone) orFilter.push({ phone: args.phone });
  if (args.email) orFilter.push({ email: args.email.toLowerCase() });

  const sessionUpdate = await TrackingSession.updateMany(
    {
      merchantId: args.merchantId,
      $or: orFilter,
      lastSeenAt: { $gte: since },
      resolvedOrderId: { $exists: false },
    },
    {
      $set: {
        resolvedOrderId: args.orderId,
        resolvedAt: new Date(),
        ...(args.phone ? { phone: args.phone } : {}),
        ...(args.email ? { email: args.email.toLowerCase() } : {}),
      },
    },
  );

  const eventUpdate = await TrackingEvent.updateMany(
    {
      merchantId: args.merchantId,
      $or: orFilter,
      occurredAt: { $gte: since },
    },
    {
      $set: {
        ...(args.phone ? { phone: args.phone } : {}),
        ...(args.email ? { email: args.email.toLowerCase() } : {}),
      },
    },
  );

  if (sessionUpdate.modifiedCount > 0) {
    void writeAudit({
      merchantId: args.merchantId,
      actorId: args.merchantId,
      actorType: "system",
      action: "tracking.identified",
      subjectType: "order",
      subjectId: args.orderId,
      meta: {
        sessions: sessionUpdate.modifiedCount,
        events: eventUpdate.modifiedCount,
      },
    });
  }

  return {
    stitchedSessions: sessionUpdate.modifiedCount ?? 0,
    stitchedEvents: eventUpdate.modifiedCount ?? 0,
  };
}
