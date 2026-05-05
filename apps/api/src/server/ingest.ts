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
import {
  isNormalizationSkip,
  type NormalizationSkip,
  type NormalizedOrder,
} from "../lib/integrations/types.js";

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

    // Race-safe insert. Two workers can each pass the findOne dedup above
    // (rapid-fire order.created + order.updated webhooks for the same WC
    // order do this all the time) and reach the create in parallel. The
    // unique partial index on `(merchantId, source.externalId)` makes the
    // second insert throw E11000; we catch it here and treat it as a
    // duplicate. Belt-and-suspenders to the findOne above — both protect
    // against different races (findOne keeps reads off the create path on
    // the cold path; the catch keeps writes correct on the hot path).
    let orderDoc;
    try {
      orderDoc = await Order.create({
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
    } catch (err: unknown) {
      // Mongo's duplicate-key error code. The most common cause is the
      // race described above the create call: two workers passed the
      // findOne and both reached create. The unique partial index on
      // `(merchantId, source.externalId)` rejects the loser. Re-fetch the
      // winner so the caller still gets a valid orderId, and report it
      // as a duplicate so the integration counter doesn't double-bump.
      const e = err as { code?: number; message?: string } | null;
      if (e && e.code === 11000) {
        // Refund the quota we reserved for this insert. The winner already
        // has its own reservation; if we leave ours in place the merchant
        // gets double-charged for one upstream order on every webhook race.
        // FIX: previously called as `releaseQuota(merchantId, plan, "ordersCreated", 1)`
        // which mis-aligned with the (merchantId, metric, amount) signature in
        // usage.ts:133 — `plan` landed in the metric slot, "ordersCreated"
        // in the amount slot, and the $inc silently no-op'd. Aligned with the
        // signature now; quota refund actually applies.
        await releaseQuota(opts.merchantId, "ordersCreated", 1).catch(() => {});
        const winner = await Order.findOne({
          merchantId: opts.merchantId,
          "source.externalId": normalized.externalId,
        })
          .select("_id")
          .lean();
        if (winner) {
          return { ok: true, duplicate: true, orderId: String(winner._id) };
        }
        // Fell through — should not happen unless the index is also
        // matching on something other than what we filtered on. Surface as
        // a hard failure so it's loud rather than silently mis-attributed.
      }
      throw err;
    }

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
  /**
   * Adapter normalization result. `null` = topic not relevant (ignored);
   * `NormalizationSkip` = order-shaped but unprocessable (routed to
   * needs_attention without retry); `NormalizedOrder` = ingest.
   */
  normalized: NormalizedOrder | NormalizationSkip | null;
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

  // Skip envelope — adapter classified the event as order-shaped but
  // unprocessable. Mirror replayWebhookInbox: park as needs_attention and
  // do NOT schedule a retry. The synchronous caller (tests, dashboard
  // import preview) gets ok:false back so they can show the merchant
  // exactly what's wrong.
  if (isNormalizationSkip(args.normalized)) {
    await WebhookInbox.updateOne(
      { _id: inboxRow._id },
      {
        $set: {
          status: "needs_attention",
          processedAt: new Date(),
          skipReason: args.normalized.reason,
          lastError: `needs_attention: ${args.normalized.reason}`,
        },
      },
    );
    await fireWebhookNeedsAttentionAlert(
      {
        _id: inboxRow._id,
        merchantId: args.merchantId,
        integrationId: args.integrationId,
        provider: args.provider,
        topic: args.topic,
        externalId: args.externalId,
        lastError: `needs_attention: ${args.normalized.reason}`,
      },
      args.normalized,
    );
    return {
      ok: false,
      error: `needs_attention: ${args.normalized.reason}`,
    };
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
  /**
   * Outcome status for the caller:
   *  - succeeded        — order created or duplicate, OR topic was ignored
   *  - failed           — transient failure, will retry per nextRetryAt
   *  - dead_lettered    — out of retries, merchant alerted
   *  - needs_attention  — adapter said the event is order-shaped but
   *                       unprocessable (missing phone etc.) — won't retry
   *  - skipped          — row was already terminal (succeeded/needs_attention)
   *                       and nothing was done
   */
  status:
    | "succeeded"
    | "failed"
    | "dead_lettered"
    | "needs_attention"
    | "skipped";
  attempts: number;
  /** Populated when status is needs_attention. */
  skipReason?: string;
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
  // `needs_attention` is a deliberately-terminal state (no auto-retry). The
  // worker sweep must NOT re-run these — only an explicit manual replay
  // (after the merchant fixes their storefront) should re-enter ingestion.
  if (inbox.status === "needs_attention" && !args.manual) {
    return {
      ok: false,
      status: "skipped",
      attempts: inbox.attempts ?? 0,
      skipReason: inbox.skipReason ?? undefined,
      error: inbox.lastError ?? undefined,
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

  // Skip envelope — order-shaped but unprocessable (e.g. missing phone).
  // Park in `needs_attention`, surface a notification to the merchant, and
  // DO NOT schedule a retry. The same payload will fail the same way every
  // time; only a storefront fix + manual replay can recover it.
  if (isNormalizationSkip(normalized)) {
    inbox.status = "needs_attention";
    inbox.processedAt = new Date();
    inbox.skipReason = normalized.reason;
    inbox.lastError = `needs_attention: ${normalized.reason}`;
    inbox.nextRetryAt = undefined;
    // attempts stays as-is — these aren't retries, they're terminal classifications.
    await inbox.save();
    await fireWebhookNeedsAttentionAlert(inbox, normalized);
    return {
      ok: false,
      status: "needs_attention",
      attempts: inbox.attempts ?? 0,
      skipReason: normalized.reason,
      error: `needs_attention: ${normalized.reason}`,
    };
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

/**
 * Fire a merchant-facing notification when an inbox row hits the
 * `needs_attention` terminal state. The dedupe key is per-row so a single
 * stuck order doesn't spam — but every distinct order with the same root
 * cause (e.g. 50 orders missing phone) still produces a notification each,
 * which is the right behavior because the merchant needs to know the scale
 * of the problem.
 *
 * Severity is `warning` (not `critical` like the dead-letter alert) — these
 * orders are recoverable as soon as the storefront is fixed and the merchant
 * clicks Replay; nothing is permanently lost.
 */
async function fireWebhookNeedsAttentionAlert(
  inbox: {
    _id: Types.ObjectId;
    merchantId: Types.ObjectId | unknown;
    integrationId?: Types.ObjectId | unknown;
    provider: string;
    topic: string;
    externalId: string;
    lastError?: string | null;
  },
  skip: NormalizationSkip,
): Promise<void> {
  const merchantId = inbox.merchantId as Types.ObjectId;
  const integrationId = inbox.integrationId as Types.ObjectId | undefined;
  const dedupeKey = `webhook-needs-attention:${String(inbox._id)}`;
  // Human-readable message keyed on the skip reason. Kept short so the
  // notification list renders cleanly; the inbox detail UI carries the
  // full payload for debugging.
  const reasonCopy: Record<string, string> = {
    missing_phone: "Customer phone is missing — fix at checkout to deliver.",
    missing_external_id: "Order id missing in payload — likely malformed.",
    invalid_payload: "Payload structure was not recognized.",
  };
  const detail = reasonCopy[skip.reason] ?? skip.reason;
  try {
    await Notification.updateOne(
      { merchantId, dedupeKey },
      {
        $setOnInsert: {
          merchantId,
          kind: "integration.webhook_needs_attention",
          severity: "warning",
          title: `${inbox.provider} order needs attention`,
          body: `${inbox.topic} (id ${inbox.externalId}): ${detail}`,
          link: `/dashboard/integrations?inboxId=${String(inbox._id)}`,
          subjectType: "integration" as const,
          subjectId: integrationId ?? (inbox._id as Types.ObjectId),
          meta: {
            provider: inbox.provider,
            topic: inbox.topic,
            externalId: inbox.externalId,
            skipReason: skip.reason,
          },
          dedupeKey,
        },
      },
      { upsert: true },
    );
  } catch (err) {
    console.error(
      "[webhook] needs-attention notification failed",
      (err as Error).message,
    );
  }
  void writeAudit({
    merchantId,
    actorId: merchantId,
    actorType: "system",
    action: "integration.webhook_needs_attention",
    subjectType: "integration",
    subjectId: integrationId ?? (inbox._id as Types.ObjectId),
    meta: {
      provider: inbox.provider,
      topic: inbox.topic,
      externalId: inbox.externalId,
      skipReason: skip.reason,
    },
  });
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

  // Build the OR-match across every plausible phone variant + email so we
  // catch sessions/events recorded with a non-canonical form ("01711…")
  // even when the order arrives canonical ("+8801711…"). See
  // `phoneLookupVariants` for the variant table.
  const orClauses: Record<string, unknown>[] = [];
  const canonicalPhone = args.phone ? normalizePhoneOrRaw(args.phone) : null;
  const normalizedEmail = args.email
    ? args.email.trim().toLowerCase() || null
    : null;

  if (args.phone) {
    const variants = phoneLookupVariants(args.phone);
    if (variants.length > 0) {
      orClauses.push({
        phone: variants.length > 1 ? { $in: variants } : variants[0],
      });
    }
  }
  if (normalizedEmail) {
    orClauses.push({ email: normalizedEmail });
  }
  if (orClauses.length === 0) return { stitchedSessions: 0, stitchedEvents: 0 };

  // 1) Stitch sessions: any matching session inside the 30-day window that
  //    isn't already linked to an order. We also rewrite the stored phone
  //    to the canonical form so downstream funnels join cleanly.
  const sessionUpdate: Record<string, unknown> = {
    resolvedOrderId: args.orderId,
    resolvedAt: new Date(),
  };
  if (canonicalPhone) sessionUpdate.phone = canonicalPhone;
  if (normalizedEmail) sessionUpdate.email = normalizedEmail;

  const sessionsRes = await TrackingSession.updateMany(
    {
      merchantId: args.merchantId,
      lastSeenAt: { $gte: since },
      resolvedOrderId: { $exists: false },
      $or: orClauses,
    },
    { $set: sessionUpdate },
  );

  // 2) Stitch events: events have no resolvedOrderId field — the session
  //    edge is the source of truth for that linkage — but we still rewrite
  //    the phone field to canonical so risk + funnel queries find them.
  let stitchedEvents = 0;
  if (canonicalPhone) {
    const eventsRes = await TrackingEvent.updateMany(
      {
        merchantId: args.merchantId,
        occurredAt: { $gte: since },
        $or: orClauses,
        phone: { $exists: true, $ne: canonicalPhone },
      },
      { $set: { phone: canonicalPhone } },
    );
    stitchedEvents = eventsRes.modifiedCount ?? 0;
  }

  return {
    stitchedSessions: sessionsRes.modifiedCount ?? 0,
    stitchedEvents,
  };
}

