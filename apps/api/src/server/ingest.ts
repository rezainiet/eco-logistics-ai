import { Types } from "mongoose";
import {
  FraudPrediction,
  Integration,
  Merchant,
  type MerchantFraudConfig,
  Notification,
  Order,
  TrackingEvent,
  TrackingSession,
  WebhookInbox,
  type IntegrationProvider,
} from "@ecom/db";
import {
  collectRiskHistory,
  computeRisk,
  DEFAULT_WEIGHTS_VERSION,
  hashAddress,
  type RiskOptions,
} from "./risk.js";
import { getMerchantValueRollup } from "../lib/merchantValueRollup.js";
import { fireFraudAlert } from "../lib/alerts.js";
import { writeAudit } from "../lib/audit.js";
import { releaseQuota, reserveQuota } from "../lib/usage.js";
import { getPlan } from "../lib/plans.js";
import { invalidate } from "../lib/cache.js";
import { adapterFor, hasAdapter } from "../lib/integrations/index.js";
import { normalizePhoneOrRaw, phoneLookupVariants } from "../lib/phone.js";
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

  // E.164-normalize at the ingestion seam so identity-resolution doesn't
  // create duplicate buyers from "+8801711…", "8801711…", "01711…" variants.
  // Falls back to the cleaned raw form when normalization is ambiguous.
  const canonicalPhone =
    normalizePhoneOrRaw(normalized.customer.phone) ?? normalized.customer.phone;
  normalized = {
    ...normalized,
    customer: { ...normalized.customer, phone: canonicalPhone },
  };

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

  // Dynamic per-merchant value rollup — drives adaptive COD thresholds.
  // Cheap (cached 10 min); first hit aggregates the merchant's last 90d.
  const rollup = await getMerchantValueRollup(opts.merchantId).catch(() => ({
    avgOrderValue: undefined,
    p75OrderValue: undefined,
    resolvedSampleSize: 0,
  }));

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
      // Adaptive thresholds — only kick in when no explicit override exists.
      p75OrderValue: rollup.p75OrderValue,
      avgOrderValue: rollup.avgOrderValue,
      // Adaptive weights — written by the monthly tuning worker.
      weightOverrides: fraudConfig.signalWeightOverrides as
        | Map<string, number>
        | Record<string, number>
        | undefined,
      baseRtoRate: fraudConfig.baseRtoRate,
      weightsVersion: fraudConfig.weightsVersion ?? DEFAULT_WEIGHTS_VERSION,
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

    // Persist the prediction for the monthly weight tuner. Best-effort:
    // a failure here MUST NOT undo the order create. Idempotent via the
    // unique index on `orderId` so a rescore later will overwrite cleanly.
    void FraudPrediction.create({
      merchantId: opts.merchantId,
      orderId: orderDoc._id,
      riskScore: risk.riskScore,
      pRto: risk.pRto,
      levelPredicted: risk.level,
      customerTier: risk.customerTier,
      signals: risk.signals.map((s) => ({ key: s.key, weight: s.weight })),
      weightsVersion: risk.weightsVersion,
    }).catch((err) =>
      console.error(
        "[fraud-prediction] write failed",
        (err as Error).message,
      ),
    );

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
        pRto: risk.pRto,
        customerTier: risk.customerTier,
        weightsVersion: risk.weightsVersion,
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
 * ACK-fast inbound webhook entry-point. Stamps a `WebhookInbox` row in
 * `received` state and returns immediately — actual ingestion is deferred to
 * the `webhook-process` worker so the request thread is freed in <50ms.
 *
 * Idempotency is enforced by the `(merchantId, provider, externalId)` unique
 * index — a duplicate delivery returns `{ duplicate: true }` and the route
 * skips the enqueue.
 *
 * Returns:
 *  - `{ duplicate: true, inboxId, resolvedOrderId }` on a known event
 *  - `{ duplicate: false, inboxId }` on a fresh event (caller must enqueue)
 *  - throws on unexpected db errors so the caller can return 5xx
 */
export interface EnqueueInboundWebhookArgs {
  merchantId: Types.ObjectId;
  integrationId: Types.ObjectId;
  provider: string;
  topic: string;
  externalId: string;
  rawPayload: unknown;
  payloadBytes: number;
}

export interface EnqueueInboundWebhookResult {
  duplicate: boolean;
  inboxId: Types.ObjectId;
  resolvedOrderId?: string;
}

export async function enqueueInboundWebhook(
  args: EnqueueInboundWebhookArgs,
): Promise<EnqueueInboundWebhookResult> {
  try {
    const row = await WebhookInbox.create({
      merchantId: args.merchantId,
      integrationId: args.integrationId,
      provider: args.provider,
      topic: args.topic,
      externalId: args.externalId,
      payload: args.rawPayload,
      payloadBytes: args.payloadBytes,
      status: "received",
    });
    return { duplicate: false, inboxId: row._id as Types.ObjectId };
  } catch (err: unknown) {
    const e = err as { code?: number };
    if (e?.code !== 11000) throw err;
    // Duplicate event — pull the prior row so the caller can echo the order id.
    const existing = await WebhookInbox.findOne({
      merchantId: args.merchantId,
      provider: args.provider,
      externalId: args.externalId,
    })
      .select("_id resolvedOrderId")
      .lean();
    if (!existing) {
      throw new Error("inbox upsert race: row vanished after dup-key");
    }
    return {
      duplicate: true,
      inboxId: existing._id as Types.ObjectId,
      resolvedOrderId: existing.resolvedOrderId
        ? String(existing.resolvedOrderId)
        : undefined,
    };
  }
}

/**
 * Synchronous webhook ingestion. Kept for tests and dashboard-driven imports
 * where the caller wants the order id back inline. Production webhook traffic
 * goes through `enqueueInboundWebhook` + the `webhook-process` worker so
 * upstream gets a 202 in <50ms.
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
    // Schedule the first retry. Subsequent retries are scheduled by
    // `replayWebhookInbox`, which keeps backoff state in one place.
    const attempts = 1;
    await WebhookInbox.updateOne(
      { _id: inboxRow._id },
      {
        $set: {
          status: "failed",
          lastError: result.error?.slice(0, 500),
          processedAt: new Date(),
          nextRetryAt: new Date(Date.now() + nextRetryDelayMs(attempts)),
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
/**
 * Webhook retry policy. Failed inbox rows are picked up by the
 * `webhook-retry` worker on this exponential schedule until `MAX_ATTEMPTS`,
 * after which they're dead-lettered with a merchant-visible alert.
 */
export const WEBHOOK_RETRY_MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [
  60_000, // 1m
  5 * 60_000, // 5m
  15 * 60_000, // 15m
  30 * 60_000, // 30m
  60 * 60_000, // 1h
];

/**
 * Returns the delay before the next retry given how many failures have
 * already occurred. `attempts=1` (first failure) → first delay (1m). The last
 * slot is sticky so post-cap callers don't index out of range.
 */
export function nextRetryDelayMs(attempts: number): number {
  const idx = Math.max(0, attempts - 1);
  if (idx >= RETRY_BACKOFF_MS.length) {
    return RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
  }
  return RETRY_BACKOFF_MS[idx]!;
}

export interface ReplayWebhookResult {
  ok: boolean;
  duplicate?: boolean;
  orderId?: string;
  error?: string;
  status: "succeeded" | "failed" | "dead_lettered" | "skipped";
  attempts: number;
}

/**
 * Re-run a previously-failed `WebhookInbox` row through the ingestion
 * pipeline. Used by both the retry worker (background) and the merchant
 * dashboard "replay" button (foreground).
 *
 * Behavior:
 *  - If the row was already succeeded, it's a no-op (status: "skipped").
 *  - On success: marks row succeeded, writes audit, returns the order id.
 *  - On failure: increments attempts, schedules `nextRetryAt` via backoff.
 *  - On the attempt that crosses `MAX_ATTEMPTS`: marks `deadLetteredAt`, fires
 *    a Notification + audit so the merchant sees it in the inbox.
 *
 * The `manual` flag distinguishes UI-driven replays (which audit-log the
 * actor and bypass the `nextRetryAt` gate) from worker-driven replays.
 */
export async function replayWebhookInbox(args: {
  inboxId: Types.ObjectId;
  actorId?: Types.ObjectId;
  manual?: boolean;
}): Promise<ReplayWebhookResult> {
  const inbox = await WebhookInbox.findById(args.inboxId);
  if (!inbox) {
    return { ok: false, error: "inbox row not found", status: "skipped", attempts: 0 };
  }
  if (inbox.status === "succeeded") {
    return {
      ok: true,
      duplicate: true,
      orderId: inbox.resolvedOrderId ? String(inbox.resolvedOrderId) : undefined,
      status: "skipped",
      attempts: inbox.attempts ?? 0,
    };
  }

  if (!hasAdapter(inbox.provider as IntegrationProvider)) {
    return {
      ok: false,
      error: `unknown provider: ${inbox.provider}`,
      status: "failed",
      attempts: inbox.attempts ?? 0,
    };
  }
  const adapter = adapterFor(inbox.provider as IntegrationProvider);
  const normalized = adapter.normalizeWebhookPayload(inbox.topic, inbox.payload);

  // No normalized payload means the topic is one we ignore — mark succeeded
  // (matches the original processWebhookOnce behavior) so the row stops
  // flapping in the retry queue.
  if (!normalized) {
    inbox.status = "succeeded";
    inbox.processedAt = new Date();
    inbox.lastError = "ignored on replay";
    inbox.nextRetryAt = undefined;
    await inbox.save();
    return { ok: true, status: "succeeded", attempts: inbox.attempts ?? 0 };
  }

  const result = await ingestNormalizedOrder(normalized, {
    merchantId: inbox.merchantId as Types.ObjectId,
    source: inbox.provider as IngestSource,
    channel: "webhook",
    integrationId: inbox.integrationId as Types.ObjectId,
  });

  if (result.ok) {
    inbox.status = "succeeded";
    inbox.processedAt = new Date();
    inbox.nextRetryAt = undefined;
    if (result.orderId) {
      inbox.resolvedOrderId = new Types.ObjectId(result.orderId);
    }
    inbox.lastError = result.duplicate ? "duplicate (idempotent)" : undefined;
    await inbox.save();
    if (args.manual) {
      void writeAudit({
        merchantId: inbox.merchantId as Types.ObjectId,
        actorId: args.actorId ?? (inbox.merchantId as Types.ObjectId),
        actorType: "merchant",
        action: "integration.webhook_replayed",
        subjectType: "integration",
        subjectId: inbox.integrationId as Types.ObjectId,
        meta: {
          provider: inbox.provider,
          externalId: inbox.externalId,
          orderId: result.orderId,
          duplicate: !!result.duplicate,
        },
      });
    }
    return {
      ok: true,
      duplicate: !!result.duplicate,
      orderId: result.orderId,
      status: "succeeded",
      attempts: inbox.attempts ?? 0,
    };
  }

  // Failure path — bump attempts, schedule next retry or dead-letter.
  const attempts = (inbox.attempts ?? 0) + 1;
  inbox.attempts = attempts;
  inbox.lastError = result.error?.slice(0, 500);
  inbox.processedAt = new Date();
  inbox.status = "failed";
  if (attempts >= WEBHOOK_RETRY_MAX_ATTEMPTS) {
    inbox.deadLetteredAt = new Date();
    inbox.nextRetryAt = undefined;
    await inbox.save();
    await fireWebhookDeadLetterAlert(inbox);
    return {
      ok: false,
      error: result.error,
      status: "dead_lettered",
      attempts,
    };
  }
  inbox.nextRetryAt = new Date(Date.now() + nextRetryDelayMs(attempts));
  await inbox.save();
  return {
    ok: false,
    error: result.error,
    status: "failed",
    attempts,
  };
}

async function fireWebhookDeadLetterAlert(inbox: {
  _id: Types.ObjectId;
  merchantId: unknown;
  integrationId?: unknown;
  provider: string;
  topic: string;
  externalId: string;
  lastError?: string | null;
}): Promise<void> {
  const merchantId = inbox.merchantId as Types.ObjectId;
  const integrationId = inbox.integrationId as Types.ObjectId | undefined;
  const dedupeKey = `webhook-dlq:${String(inbox._id)}`;
  try {
    await Notification.updateOne(
      { merchantId, dedupeKey },
      {
        $setOnInsert: {
          merchantId,
          kind: "integration.webhook_failed",
          severity: "critical",
          title: `${inbox.provider} webhook permanently failed`,
          body: `Topic ${inbox.topic} (id ${inbox.externalId}) hit the retry cap. Last error: ${inbox.lastError ?? "unknown"}`,
          link: `/dashboard/integrations?inboxId=${String(inbox._id)}`,
          subjectType: "integration" as const,
          subjectId: integrationId ?? (inbox._id as Types.ObjectId),
          meta: {
            provider: inbox.provider,
            topic: inbox.topic,
            externalId: inbox.externalId,
            lastError: inbox.lastError ?? null,
          },
          dedupeKey,
        },
      },
      { upsert: true },
    );
  } catch (err) {
    console.error(
      "[webhook-retry] dead-letter notification failed",
      (err as Error).message,
    );
  }
  void writeAudit({
    merchantId,
    actorId: merchantId,
    actorType: "system",
    action: "integration.webhook_dead_lettered",
    subjectType: "integration",
    subjectId: integrationId ?? (inbox._id as Types.ObjectId),
    meta: {
      provider: inbox.provider,
      topic: inbox.topic,
      externalId: inbox.externalId,
      lastError: inbox.lastError ?? null,
    },
  });
}

export async function resolveIdentityForOrder(args: {
  merchantId: Types.ObjectId;
  orderId: Types.ObjectId;
  phone?: string;
  email?: string;
}): Promise<{ stitchedSessions: number; stitchedEvents: number }> {
  if (!args.phone && !args.email) return { stitchedSessions: 0, stitchedEvents: 0 };
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Match on every plausible phone variant so legacy sessions written before
  // E.164-normalization rolled out still stitch to new orders.
  const orFilter: Array<Record<string, unknown>> = [];
  if (args.phone) {
    const variants = phoneLookupVariants(args.phone);
    orFilter.push(variants.length > 1 ? { phone: { $in: variants } } : { phone: args.phone });
  }
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
