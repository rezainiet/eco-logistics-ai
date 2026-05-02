import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import mongoose, { Types } from "mongoose";
import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";
import {
  BULK_UPLOAD_MODES,
  type BulkUploadMode,
  BulkUploadBatch,
  COURIER_PROVIDER_NAMES,
  Merchant,
  type MerchantFraudConfig,
  MerchantStats,
  Order,
  type OrderAutomation,
  ORDER_STATUSES,
  PendingAwb,
  PHONE_RE,
} from "@ecom/db";
import {
  billableProcedure,
  merchantObjectId,
  protectedProcedure,
  requestIp,
  requestUserAgent,
  router,
} from "../trpc.js";
import { cached, invalidate } from "../../lib/cache.js";
import { filterHash } from "../../lib/hash.js";
import {
  adapterFor,
  type AWBResponse,
  CourierError,
  hasCourierAdapter,
} from "../../lib/couriers/index.js";
import { syncOrderTracking } from "../tracking.js";
import { enqueueAutoBook } from "../../workers/automationBook.js";
import { enqueueOrderConfirmationSms } from "../../workers/automationSms.js";
import {
  canTransitionAutomation,
  decideAutomationAction,
  type AutomationState,
} from "../../lib/automation.js";
import {
  hashPhoneForNetwork,
  lookupNetworkRisk,
  type NetworkRiskAggregate,
} from "../../lib/fraud-network.js";
import {
  collectRiskHistory,
  collectRiskHistoryBatch,
  computeRisk,
  DEFAULT_WEIGHTS_VERSION,
  hashAddress,
  type RiskOptions,
  type RiskResult,
} from "../risk.js";
import { getMerchantValueRollup } from "../../lib/merchantValueRollup.js";
import { FraudPrediction } from "@ecom/db";
import { writeAudit } from "../../lib/audit.js";
import {
  buildFraudRejectSnapshot,
  buildPreActionSnapshot,
  buildPreRejectAutomationSnapshot,
} from "../../lib/rejectSnapshot.js";
import { rebuildQueueState } from "../../lib/queueState.js";
import { releaseQuota, reserveQuota } from "../../lib/usage.js";
import { getPlan } from "../../lib/plans.js";
import { fireFraudAlert } from "../../lib/alerts.js";
import { enqueueRescore } from "../../workers/riskRecompute.js";
import { resolveIdentityForOrder } from "../ingest.js";
import { normalizePhoneOrRaw } from "../../lib/phone.js";

const COUNT_TTL = 30;
const BULK_CHUNK = 500;
const MAX_BULK_ROWS = 50_000;
// Hard cap on the raw CSV string before it ever reaches the parser. csv-parse
// loads the whole string into memory; without this guard a single oversized
// row (or a 50k × 200KB pathological file) can OOM the API process. tRPC's
// JSON limit fires at ~1MB by default, but the cap here is enforced after
// JSON decode so it covers payloads that arrive base64-wrapped, gzipped, or
// from non-default Express body limits.
const MAX_BULK_CSV_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_BULK_COLUMNS_PER_ROW = 64;

const customerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().regex(PHONE_RE),
  address: z.string().min(1),
  district: z.string().min(1),
});

const itemSchema = z.object({
  name: z.string().min(1),
  sku: z.string().optional(),
  quantity: z.number().int().min(1),
  price: z.number().min(0),
});

const createOrderInput = z.object({
  orderNumber: z.string().min(1).optional(),
  customer: customerSchema,
  items: z.array(itemSchema).min(1),
  cod: z.number().min(0),
  total: z.number().min(0).optional(),
  /**
   * Per-order courier pin used by the automation engine on first attempt.
   * Falls back to the merchant's `automationConfig.autoBookCourier` and
   * then to `selectBestCourier` if absent.
   */
  pinnedCourier: z.enum(COURIER_PROVIDER_NAMES).optional(),
  /**
   * Caller-supplied idempotency token. The dashboard generates a UUID at
   * the moment the merchant clicks "Create" and re-sends it on retry —
   * the unique index on `(merchantId, source.clientRequestId)` collapses
   * duplicate submissions to a single order. Optional: when omitted the
   * legacy non-idempotent path is used.
   */
  clientRequestId: z.string().min(8).max(120).optional(),
});

const updateOrderInput = z.object({
  id: z.string().min(1),
  status: z.enum(ORDER_STATUSES).optional(),
  customer: customerSchema.partial().optional(),
  courier: z.string().max(100).optional(),
  trackingNumber: z.string().max(100).optional(),
  rtoReason: z.string().max(500).optional(),
});

function generateOrderNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 0xfff).toString(16).toUpperCase().padStart(3, "0");
  return `ORD-${ts}-${rand}`;
}

interface MerchantScoringSnapshot {
  disableNetworkSignals?: boolean;
  tier?: string;
  opts: RiskOptions;
  halfLifeDays: number;
  velocityWindowMin: number;
}

async function loadMerchantScoring(
  merchantId: Types.ObjectId,
): Promise<MerchantScoringSnapshot> {
  const m = (await Merchant.findById(merchantId)
    .select("subscription.tier fraudConfig")
    .lean()) as
    | { subscription?: { tier?: string }; fraudConfig?: MerchantFraudConfig | null }
    | null;
  const fc: MerchantFraudConfig = m?.fraudConfig ?? {};
  // Adaptive thresholds — derive from the merchant's order history so
  // per-merchant value distributions inform "high COD" without ops needing
  // to hand-tune each account. Caller (`computeRisk`) ignores these when
  // an explicit `highCodThreshold` / `extremeCodThreshold` is set, so a
  // merchant that pinned values still gets exactly what they pinned.
  const rollup = await getMerchantValueRollup(merchantId).catch(() => ({
    avgOrderValue: undefined,
    p75OrderValue: undefined,
    resolvedSampleSize: 0,
  }));
  return {
    tier: m?.subscription?.tier,
    opts: {
      highCodBdt: fc.highCodThreshold ?? undefined,
      extremeCodBdt: fc.extremeCodThreshold ?? undefined,
      suspiciousDistricts: fc.suspiciousDistricts ?? [],
      blockedPhones: fc.blockedPhones ?? [],
      blockedAddresses: fc.blockedAddresses ?? [],
      // Pass-through nullish so computeRisk applies its own default (3).
      // Negative explicit value disables velocity per-merchant.
      velocityThreshold: fc.velocityThreshold ?? undefined,
      p75OrderValue: rollup.p75OrderValue,
      avgOrderValue: rollup.avgOrderValue,
      weightOverrides: fc.signalWeightOverrides as
        | Map<string, number>
        | Record<string, number>
        | undefined,
      baseRtoRate: fc.baseRtoRate,
      weightsVersion: fc.weightsVersion ?? DEFAULT_WEIGHTS_VERSION,
    },
    halfLifeDays: fc.historyHalfLifeDays ?? 30,
    velocityWindowMin: fc.velocityWindowMin ?? 10,
    disableNetworkSignals:
      (fc as { disableNetworkSignals?: boolean }).disableNetworkSignals === true,
  };
}

async function scoreOrderForCreate(args: {
  merchantId: Types.ObjectId;
  cod: number;
  customer: { name: string; phone: string; address: string; district: string };
  ip?: string;
  addressHash?: string | null;
  scoring?: MerchantScoringSnapshot;
}): Promise<
  RiskResult & {
    scoredAt: Date;
    detected: boolean;
    addressHash: string | null;
    network: NetworkRiskAggregate | null;
  }
> {
  const scoring = args.scoring ?? (await loadMerchantScoring(args.merchantId));
  const addressHash =
    args.addressHash ?? hashAddress(args.customer.address, args.customer.district);
  const history = await collectRiskHistory({
    merchantId: args.merchantId,
    phone: args.customer.phone,
    ip: args.ip,
    addressHash: addressHash ?? undefined,
    halfLifeDays: scoring.halfLifeDays,
    velocityWindowMin: scoring.velocityWindowMin,
  });
  const result = computeRisk(
    {
      cod: args.cod,
      customer: args.customer,
      ip: args.ip,
      addressHash,
    },
    history,
    scoring.opts,
  );

  // Cross-merchant network signal — capped at +25, suppressed for merchants
  // that opted out via fraudConfig.disableNetworkSignals.
  let network: NetworkRiskAggregate | null = null;
  if (!scoring.disableNetworkSignals) {
    const phoneHash = hashPhoneForNetwork(args.customer.phone);
    network = await lookupNetworkRisk({
      phoneHash,
      addressHash,
      merchantId: args.merchantId,
    });
    if (network.bonus > 0) {
      result.signals.push({
        key: "fraud_network",
        weight: network.bonus,
        detail: `Seen at ${network.merchantCount} other merchants` +
          (network.rtoRate !== null
            ? ` — RTO ${Math.round(network.rtoRate * 100)}%`
            : ""),
      });
      result.reasons.push(
        `Cross-merchant network: ${network.rtoCount} RTOs across ${network.merchantCount} merchants`,
      );
      result.riskScore = Math.min(100, result.riskScore + network.bonus);
      result.level =
        result.riskScore <= 39 ? "low" : result.riskScore <= 69 ? "medium" : "high";
    }
  }

  return {
    ...result,
    scoredAt: new Date(),
    detected: result.level === "high",
    addressHash,
    network: network ?? null,
  };
}

function fraudDocFromRisk(risk: Awaited<ReturnType<typeof scoreOrderForCreate>>) {
  return {
    detected: risk.detected,
    riskScore: risk.riskScore,
    level: risk.level,
    reasons: risk.reasons,
    signals: risk.signals,
    reviewStatus: risk.reviewStatus,
    scoredAt: risk.scoredAt,
    confidence: risk.confidence,
    confidenceLabel: risk.confidenceLabel,
    hardBlocked: risk.hardBlocked,
  };
}

type TrpcErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "INTERNAL_SERVER_ERROR";

type BookResult =
  | {
      ok: true;
      value: {
        orderId: string;
        trackingNumber: string;
        courier: string;
        status: "shipped";
        estimatedDeliveryAt?: Date;
        fee?: number;
      };
    }
  | { ok: false; error: string; code?: TrpcErrorCode };

type TrackingEventView = { at: Date; description: string; location?: string | null };

const BOOKABLE_STATUSES = new Set(["pending", "confirmed", "packed"]);

/**
 * Allowed manual transitions for updateOrder. Shipments must walk through
 * packed → shipped → in_transit → delivered; direct jumps (pending → shipped
 * or pending → delivered) are blocked to keep stats + courier flow honest.
 * Terminal states (delivered, cancelled, rto) have no outgoing transitions.
 */
const ALLOWED_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["packed", "cancelled"],
  packed: ["shipped", "cancelled"],
  shipped: ["in_transit", "delivered", "rto"],
  in_transit: ["delivered", "rto"],
  delivered: [],
  cancelled: [],
  rto: [],
};

function isTransitionAllowed(from: string, to: string): boolean {
  if (from === to) return true;
  return (ALLOWED_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

const BULK_BOOK_CONCURRENCY = 5;

/* -------------------------------------------------------------------------- */
/* Bulk-upload safety primitives                                               */
/* -------------------------------------------------------------------------- */

/** Anti-replay window for `uploadContext.uploadedAt`. */
const BULK_UPLOAD_MAX_DRIFT_MS = 7 * 24 * 60 * 60 * 1000;
/** Lookback for the recent-orders dedup query. The dateBucket key still
 *  fully disambiguates same-key orders across days; this bound is just the
 *  outer scan window so we don't blow up on a year of history. */
const DEDUP_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Stable per-order item fingerprint. Sorts the items so order doesn't
 * matter, normalises name (lowercased + trimmed), and includes quantity
 * + price so a 2× of the same item ≠ a 1× of the same item, and a
 * price tweak makes it a different fingerprint.
 *
 * Single-item CSV rows produce a single-element fingerprint. Existing
 * multi-item orders fingerprint over their full items array — different
 * fingerprint than any single-item CSV row, which is the correct
 * conservative behaviour (don't false-positive a multi-line order
 * against a single CSV row).
 */
function computeItemFingerprint(
  items: ReadonlyArray<{ name?: string | null; quantity?: number | null; price?: number | null }>,
): string {
  if (!items || items.length === 0) return "noitems";
  const norm = items
    .map((i) => {
      const name = (i.name ?? "").trim().toLowerCase();
      const qty = Number.isFinite(i.quantity) ? Math.round(Number(i.quantity)) : 0;
      const price = Number.isFinite(i.price) ? Math.round(Number(i.price) * 100) : 0;
      return `${name}:${qty}:${price}`;
    })
    .sort()
    .join("|");
  return createHash("sha256").update(norm).digest("hex").slice(0, 24);
}

/** UTC calendar-day bucket. `2026-05-01` etc. */
function computeDateBucket(d: Date | string | number): string {
  const date = d instanceof Date ? d : new Date(d);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Composite dedup key: phone | cod | itemFingerprint | dateBucket. */
function dedupKey(args: {
  phone: string;
  cod: number;
  itemFingerprint: string;
  dateBucket: string;
}): string {
  return `${args.phone}|${args.cod}|${args.itemFingerprint}|${args.dateBucket}`;
}

const uploadContextSchema = z.object({
  uploadedAt: z.coerce.date(),
  source: z.string().min(1).max(60),
  externalBatchId: z.string().min(8).max(128),
});

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Idempotent single-order shipment booking. Called by bookShipment / bulkBookShipment.
 *
 * Contract:
 *  - If the order already has a trackingNumber, returns the existing booking
 *    (idempotent — safe to replay).
 *  - Only orders in pending/confirmed/packed can be booked. Everything else
 *    returns a structured error (never throws from the bulk path).
 *  - Creates AWB via adapter → atomically sets logistics fields and status →
 *    updates merchant stats → invalidates dashboard cache.
 */
export async function bookSingleShipment(args: {
  merchantId: Types.ObjectId;
  userId: string;
  orderId: string;
  courier: (typeof COURIER_PROVIDER_NAMES)[number];
  weight?: number;
}): Promise<BookResult> {
  if (!Types.ObjectId.isValid(args.orderId)) {
    return { ok: false, error: "invalid order id", code: "BAD_REQUEST" };
  }
  if (!hasCourierAdapter(args.courier)) {
    return { ok: false, error: `courier '${args.courier}' is not supported yet`, code: "BAD_REQUEST" };
  }
  const orderOid = new Types.ObjectId(args.orderId);

  // -------- Cheap pre-checks -------------------------------------------
  // None of these touch the upstream — race windows here only cause us to
  // miss a state transition, not duplicate-charge a courier. The lock
  // acquisition below re-asserts the same invariants atomically.
  const order = await Order.findOne({ _id: orderOid, merchantId: args.merchantId });
  if (!order) return { ok: false, error: "order not found", code: "NOT_FOUND" };

  if (order.logistics?.trackingNumber) {
    return {
      ok: true,
      value: {
        orderId: String(order._id),
        trackingNumber: order.logistics.trackingNumber,
        courier: order.logistics.courier ?? args.courier,
        status: "shipped",
        estimatedDeliveryAt: order.logistics.estimatedDelivery ?? undefined,
      },
    };
  }
  if (!BOOKABLE_STATUSES.has(order.order.status)) {
    return {
      ok: false,
      error: `order is '${order.order.status}' — only pending/confirmed/packed can be booked`,
      code: "CONFLICT",
    };
  }
  const reviewStatus = order.fraud?.reviewStatus ?? "not_required";
  if (reviewStatus === "pending_call" || reviewStatus === "no_answer") {
    return {
      ok: false,
      error: `order requires call verification before booking (${reviewStatus})`,
      code: "CONFLICT",
    };
  }
  if (reviewStatus === "rejected") {
    return {
      ok: false,
      error: "order was rejected during verification",
      code: "CONFLICT",
    };
  }

  const merchant = await Merchant.findById(args.merchantId)
    .select("couriers subscription.status")
    .lean();
  if (!merchant) return { ok: false, error: "merchant not found", code: "NOT_FOUND" };
  const courierConfig = merchant.couriers.find((c) => c.name === args.courier);
  if (!courierConfig) {
    return { ok: false, error: `${args.courier} is not configured — add credentials in Settings`, code: "BAD_REQUEST" };
  }
  if (courierConfig.enabled === false) {
    return { ok: false, error: `${args.courier} is disabled for this merchant`, code: "FORBIDDEN" };
  }

  // -------- Acquire exclusive booking lock -----------------------------
  // Atomic findOneAndUpdate guarded on (no in-flight booking, no
  // tracking number, status is bookable). The same filter also bumps
  // bookingAttempt monotonically — every retry gets a fresh attempt
  // counter and therefore a fresh idempotency-key seed. If two callers
  // race here, exactly one wins; the other re-reads to figure out
  // whether to return idempotent success or signal CONFLICT.
  const lockNow = new Date();
  const locked = (await Order.findOneAndUpdate(
    {
      _id: orderOid,
      merchantId: args.merchantId,
      "logistics.bookingInFlight": { $ne: true },
      "logistics.trackingNumber": { $in: [null, ""] },
      "order.status": { $in: [...BOOKABLE_STATUSES] },
    },
    {
      $set: {
        "logistics.bookingInFlight": true,
        "logistics.bookingLockedAt": lockNow,
      },
      // Bump `version` alongside bookingAttempt so any concurrent worker that
      // reads the order during the upstream-call window sees a fresher version
      // and its own CAS write will MISS — preventing a fraud/automation
      // worker from clobbering state that booking finalize is about to write.
      $inc: { "logistics.bookingAttempt": 1, version: 1 },
    },
    {
      new: true,
      projection: {
        "logistics.bookingAttempt": 1,
        "order.status": 1,
        "logistics.trackingNumber": 1,
        version: 1,
      },
    },
  ).lean()) as
    | {
        version?: number;
        order?: { status?: (typeof ORDER_STATUSES)[number] };
        logistics?: { bookingAttempt?: number; trackingNumber?: string };
      }
    | null;

  if (!locked) {
    // Race lost. Re-read to surface the right error to the caller.
    const fresh = await Order.findOne({ _id: orderOid, merchantId: args.merchantId })
      .select(
        "logistics.trackingNumber logistics.courier logistics.bookingInFlight logistics.estimatedDelivery order.status",
      )
      .lean();
    if (!fresh) return { ok: false, error: "order not found", code: "NOT_FOUND" };
    if (fresh.logistics?.trackingNumber) {
      return {
        ok: true,
        value: {
          orderId: String(orderOid),
          trackingNumber: fresh.logistics.trackingNumber,
          courier: fresh.logistics.courier ?? args.courier,
          status: "shipped",
          estimatedDeliveryAt: fresh.logistics.estimatedDelivery ?? undefined,
        },
      };
    }
    if (fresh.logistics?.bookingInFlight) {
      return {
        ok: false,
        error: "another booking attempt is in progress for this order",
        code: "CONFLICT",
      };
    }
    return {
      ok: false,
      error: `order state changed — current status '${fresh.order?.status}' is not bookable`,
      code: "CONFLICT",
    };
  }

  const prevStatus =
    locked.order?.status ?? (order.order.status as (typeof ORDER_STATUSES)[number]);
  const attempt = locked.logistics?.bookingAttempt ?? 1;
  // Captured at lock time; the finalize CAS below filters on this so any
  // concurrent worker that mutated the doc (and therefore bumped version)
  // during the upstream call sends us down the orphan-AWB path instead of
  // silently overwriting their write.
  const lockedVersion = locked.version ?? 0;
  const idempotencyKey = createHash("sha256")
    .update(`${args.orderId}:${attempt}`)
    .digest("hex")
    .slice(0, 64);

  // -------- Pending-AWB ledger row BEFORE the upstream call -----------
  // Upsert keyed on (orderId, attempt) so the same attempt number
  // always points at the same row — a process-restart retry of the
  // SAME attempt re-uses the row instead of inserting a duplicate.
  await PendingAwb.updateOne(
    { orderId: orderOid, attempt },
    {
      $setOnInsert: {
        orderId: orderOid,
        merchantId: args.merchantId,
        courier: args.courier,
        attempt,
        idempotencyKey,
        status: "pending",
        requestedAt: lockNow,
      },
    },
    { upsert: true },
  );

  // -------- Upstream call ---------------------------------------------
  // From here every exit MUST either flip the ledger to a terminal
  // state OR leave it as `pending` for the reconciler. The lock is
  // released on every non-orphan path; orphans intentionally hold the
  // pending-AWB row open so the reconciler can correlate it later.
  let awb: AWBResponse;
  try {
    const adapter = adapterFor({
      name: courierConfig.name as (typeof COURIER_PROVIDER_NAMES)[number],
      accountId: courierConfig.accountId,
      apiKey: courierConfig.apiKey,
      apiSecret: courierConfig.apiSecret ?? undefined,
      baseUrl: courierConfig.baseUrl ?? undefined,
    });
    awb = await adapter.createAWB({
      orderNumber: order.orderNumber,
      customer: order.customer,
      items: order.items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })),
      cod: order.order.cod,
      weight: args.weight,
      idempotencyKey,
    });
  } catch (err) {
    const message = err instanceof CourierError ? err.message : (err as Error).message;
    await Promise.allSettled([
      PendingAwb.updateOne(
        { orderId: orderOid, attempt },
        {
          $set: {
            status: "failed",
            lastError: message.slice(0, 500),
            completedAt: new Date(),
          },
        },
      ),
      Order.updateOne(
        { _id: orderOid, merchantId: args.merchantId },
        { $set: { "logistics.bookingInFlight": false } },
      ),
    ]);
    return { ok: false, error: message };
  }

  // -------- Persist tracking + release lock atomically ----------------
  // The same bookable-status guard as before — protects against a state
  // change (e.g. customer cancellation) that landed during the upstream
  // call. If this filter loses, the AWB is stranded at the courier;
  // the ledger row is flipped to `orphaned` and the reconciler/ops
  // surface it for manual handling.
  const updated = await Order.updateOne(
    {
      _id: orderOid,
      merchantId: args.merchantId,
      // Optimistic-concurrency guard: the version captured at lock time. A
      // concurrent worker that mutated the order during the upstream call
      // (riskRecompute, automation-stale, restore) would have bumped this,
      // and we'd MISS here — flowing into the orphan-AWB path below where
      // the reconciler/ops handle it. Without this, a fraud rescore that
      // landed mid-flight could be silently undone by stale subdoc writes.
      version: lockedVersion,
      "order.status": { $in: [...BOOKABLE_STATUSES] },
      "logistics.trackingNumber": { $in: [null, ""] },
    },
    {
      $set: {
        "order.status": "shipped",
        "logistics.shippedAt": new Date(),
        "logistics.courier": args.courier,
        "logistics.trackingNumber": awb.trackingNumber,
        "logistics.bookingInFlight": false,
        ...(awb.estimatedDeliveryAt
          ? { "logistics.estimatedDelivery": awb.estimatedDeliveryAt }
          : {}),
      },
      $inc: { version: 1 },
    },
  );

  if (updated.modifiedCount === 1) {
    await Promise.allSettled([
      PendingAwb.updateOne(
        { orderId: orderOid, attempt },
        {
          $set: {
            status: "succeeded",
            trackingNumber: awb.trackingNumber,
            providerOrderId: awb.providerOrderId,
            completedAt: new Date(),
          },
        },
      ),
      prevStatus !== "shipped"
        ? MerchantStats.updateOne(
            { merchantId: args.merchantId },
            {
              $inc: { [prevStatus]: -1, shipped: 1 },
              $set: { updatedAt: new Date() },
            },
          )
        : Promise.resolve(),
      invalidate(`dashboard:${args.userId}`),
    ]);
    return {
      ok: true,
      value: {
        orderId: String(orderOid),
        trackingNumber: awb.trackingNumber,
        courier: args.courier,
        status: "shipped",
        estimatedDeliveryAt: awb.estimatedDeliveryAt,
        fee: awb.fee,
      },
    };
  }

  // Atomic update lost — order state changed during the upstream call.
  // The AWB exists at the courier but nothing in our DB references it.
  // Mark the ledger orphaned (so ops/reconciler can decide) and release
  // the lock so the order isn't wedged.
  await Promise.allSettled([
    PendingAwb.updateOne(
      { orderId: orderOid, attempt },
      {
        $set: {
          status: "orphaned",
          trackingNumber: awb.trackingNumber,
          providerOrderId: awb.providerOrderId,
          lastError: "order state changed during upstream call — AWB orphaned",
          completedAt: new Date(),
        },
      },
    ),
    Order.updateOne(
      { _id: orderOid, merchantId: args.merchantId },
      { $set: { "logistics.bookingInFlight": false } },
    ),
  ]);
  return {
    ok: false,
    error: "order state changed during upstream call — AWB is orphaned, ops notified",
    code: "CONFLICT",
  };
}

/* -------------------------------------------------------------------------- */
/* Bulk-upload helpers                                                         */
/* -------------------------------------------------------------------------- */

interface BulkStagedRow {
  rowNumber: number;
  customer: { name: string; phone: string; address: string; district: string };
  quantity: number;
  price: number;
  cod: number;
  itemName: string;
  orderNumber: string;
  addressHash: string | null;
  /** sha256(name:quantity:priceCents) — element of the dedup key. */
  itemFingerprint: string;
}

interface BulkParsed {
  staged: BulkStagedRow[];
  errors: Array<{ row: number; error: string; field?: string }>;
  headerWarnings: Array<{ original: string; mappedTo: string }>;
  unknownColumns: string[];
  totalRows: number;
}

/**
 * Canonical column name → list of accepted aliases. Aliases are matched
 * case-insensitively after stripping non-alphanumerics, so "customer phone",
 * "customer-phone", "Customer_Phone" all resolve to "customerPhone".
 *
 * Anything not in the map is preserved as-is so unknown columns surface
 * cleanly in the preview.
 */
const HEADER_ALIASES: Record<string, string[]> = {
  customerName: ["customername", "name", "fullname", "buyer", "buyername", "recipient"],
  customerPhone: ["customerphone", "phone", "mobile", "mobilenumber", "mobileno", "contact"],
  customerAddress: ["customeraddress", "address", "shippingaddress", "deliveryaddress"],
  customerDistrict: ["customerdistrict", "district", "city", "town", "area", "zone"],
  itemName: ["itemname", "productname", "product", "item", "sku"],
  quantity: ["quantity", "qty", "amount", "count"],
  price: ["price", "unitprice", "rate", "totalamount", "total"],
  cod: ["cod", "codamount", "cashondelivery"],
  orderNumber: ["ordernumber", "orderid", "ref", "reference"],
};

function normalizeHeaderKey(raw: string): string {
  return raw.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Walks the canonical→aliases map once to build the inverse — alias key
 * (normalized) → canonical name. Built lazily to keep the cost off cold
 * paths that don't touch CSV.
 */
let _aliasIndex: Map<string, string> | null = null;
function getAliasIndex(): Map<string, string> {
  if (_aliasIndex) return _aliasIndex;
  const idx = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    idx.set(normalizeHeaderKey(canonical), canonical);
    for (const a of aliases) idx.set(normalizeHeaderKey(a), canonical);
  }
  _aliasIndex = idx;
  return idx;
}

/**
 * Parse + validate a CSV. Pure: no DB, no quotas, no fraud history. Returns
 * the staged rows plus row-level errors and a `headerWarnings` array that
 * lists every alias→canonical mapping we applied. Used by both the live
 * `bulkUpload` mutation and the dry-run `previewBulkUpload` query so the
 * preview's verdict is exactly what the import will see.
 */
export function parseAndStageBulk(csv: string): BulkParsed {
  // Reject oversized payloads before invoking csv-parse — the parser loads
  // the entire string, so a 100MB blob is a memory-DoS even if it would
  // ultimately be rejected for too many rows. Byte length (not char length)
  // matches the wire-size cap the merchant actually paid in upload time.
  const sizeBytes = Buffer.byteLength(csv, "utf8");
  if (sizeBytes > MAX_BULK_CSV_BYTES) {
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `csv too large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB) — max ${(MAX_BULK_CSV_BYTES / 1024 / 1024).toFixed(0)} MB`,
    });
  }
  let rows: Array<Record<string, string>>;
  try {
    rows = parseCsv(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false,
    });
  } catch (err) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `csv parse error: ${(err as Error).message}`,
    });
  }
  if (rows.length > 0 && Object.keys(rows[0] ?? {}).length > MAX_BULK_COLUMNS_PER_ROW) {
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `csv has too many columns (max ${MAX_BULK_COLUMNS_PER_ROW})`,
    });
  }
  const headerWarnings: Array<{ original: string; mappedTo: string }> = [];
  const unknownColumns: string[] = [];
  const errors: Array<{ row: number; error: string; field?: string }> = [];
  const staged: BulkStagedRow[] = [];

  if (rows.length === 0) {
    return { staged, errors, headerWarnings, unknownColumns, totalRows: 0 };
  }

  // Build a per-original-header → canonical map so every row in the CSV is
  // remapped consistently. Track the *first* original header that mapped
  // to each canonical so error messages can echo what the merchant typed.
  const originalToCanonical = new Map<string, string>();
  const canonicalToOriginal = new Map<string, string>();
  const aliasIndex = getAliasIndex();
  const firstRowKeys = Object.keys(rows[0] ?? {});
  for (const k of firstRowKeys) {
    const canonical = aliasIndex.get(normalizeHeaderKey(k));
    if (canonical) {
      originalToCanonical.set(k, canonical);
      if (k !== canonical && !canonicalToOriginal.has(canonical)) {
        canonicalToOriginal.set(canonical, k);
        headerWarnings.push({ original: k, mappedTo: canonical });
      }
    } else {
      unknownColumns.push(k);
    }
  }

  /** What a merchant typed for `field` in the header, or the canonical name. */
  function originalNameFor(field: string): string {
    return canonicalToOriginal.get(field) ?? field;
  }

  rows.forEach((rawRow, idx) => {
    const rowNumber = idx + 2; // CSV row number (1-indexed + header)
    // Project rawRow → canonical via the header map.
    const row: Record<string, string> = {};
    for (const [origKey, canonical] of originalToCanonical) {
      const v = rawRow[origKey];
      if (v !== undefined) row[canonical] = v;
    }

    const required: Array<"customerName" | "customerPhone" | "customerAddress" | "customerDistrict"> = [
      "customerName",
      "customerPhone",
      "customerAddress",
      "customerDistrict",
    ];
    for (const f of required) {
      if (!row[f] || !String(row[f]).trim()) {
        errors.push({
          row: rowNumber,
          field: f,
          error: `missing ${f} (${originalNameFor(f) === f ? `expected column "${f}"` : `looked in column "${originalNameFor(f)}"`})`,
        });
        return;
      }
    }

    if (!PHONE_RE.test(row.customerPhone!)) {
      errors.push({
        row: rowNumber,
        field: "customerPhone",
        error: `invalid phone "${row.customerPhone}" (column "${originalNameFor("customerPhone")}") — expected 7-15 digits, optional leading +`,
      });
      return;
    }
    row.customerPhone = normalizePhoneOrRaw(row.customerPhone!) ?? row.customerPhone!;

    const quantity = Number(row.quantity ?? "1");
    const price = Number(row.price);
    const cod = Number(row.cod ?? row.price);
    if (Number.isNaN(price)) {
      errors.push({
        row: rowNumber,
        field: "price",
        error: `invalid number in column "${originalNameFor("price")}" (got "${rawRow[originalNameFor("price")] ?? ""}")`,
      });
      return;
    }
    if (Number.isNaN(cod)) {
      errors.push({
        row: rowNumber,
        field: "cod",
        error: `invalid number in column "${originalNameFor("cod")}"`,
      });
      return;
    }
    if (Number.isNaN(quantity) || quantity < 1) {
      errors.push({
        row: rowNumber,
        field: "quantity",
        error: `invalid quantity in column "${originalNameFor("quantity")}" — must be ≥ 1`,
      });
      return;
    }

    const customer = {
      name: row.customerName!.trim(),
      phone: row.customerPhone!,
      address: row.customerAddress!.trim(),
      district: row.customerDistrict!.trim(),
    };
    const itemName = (row.itemName ?? "").trim() || "Item";
    staged.push({
      rowNumber,
      customer,
      quantity,
      price,
      cod,
      itemName,
      orderNumber: (row.orderNumber ?? "").trim() || generateOrderNumber(),
      addressHash: hashAddress(customer.address, customer.district),
      itemFingerprint: computeItemFingerprint([{ name: itemName, quantity, price }]),
    });
  });

  return { staged, errors, headerWarnings, unknownColumns, totalRows: rows.length };
}

/**
 * Match details for a staged row that collided with an existing order.
 * The bulk mutation needs the matched orderId + status to decide what
 * to do under each `mode`:
 *   - skip      → drop the row, report the match
 *   - replace   → cancel the existing (if still bookable) and insert
 *                 the fresh row
 *   - review    → return to caller without inserting anything
 */
export interface BulkDuplicateMatch {
  row: number;
  phone: string;
  cod: number;
  itemFingerprint: string;
  dateBucket: string;
  matchedOrderId: string;
  matchedOrderNumber: string;
  matchedStatus: (typeof ORDER_STATUSES)[number];
  matchedCreatedAt: Date;
  /** True when matched order is still in pending/confirmed (i.e.
   *  Replace mode can act on it). False for shipped/in_transit/etc. */
  replaceable: boolean;
  /** Reason for the row's exclusion. "in_batch" = duplicate of an
   *  earlier row in the same CSV; "recent_order" = matched the DB. */
  reason: "in_batch" | "recent_order";
}

/**
 * Filters out staged rows that already exist as a recent order from the
 * same merchant. Composite key:
 *
 *     phone | cod | itemFingerprint | dateBucket(UTC day)
 *
 * Adding `itemFingerprint` stops the v1 false-positive where two
 * different items happening to total the same COD collapsed into one
 * order. Adding `dateBucket` stops the v1 false-positive where a
 * legitimate next-day reorder from the same customer was dropped as a
 * duplicate.
 *
 * Stale-CSV defence (S4 from the financial audit): only ACTIVE orders
 * are matched; cancelled/rto/delivered are excluded so a CSV
 * containing those rows would re-create them — `replaceable=false` on
 * those rows means Replace mode also can't touch them.
 */
export async function dedupAgainstRecentOrders(
  merchantId: Types.ObjectId,
  staged: BulkStagedRow[],
  errors: Array<{ row: number; error: string; field?: string }>,
  options: { now?: Date } = {},
): Promise<{
  kept: BulkStagedRow[];
  duplicates: BulkDuplicateMatch[];
  /** Per-key lookup so the caller can join staged → match without re-scanning. */
  matchByKey: Map<string, BulkDuplicateMatch>;
}> {
  if (staged.length === 0) {
    return { kept: [], duplicates: [], matchByKey: new Map() };
  }
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - DEDUP_LOOKBACK_MS);
  const phones = Array.from(new Set(staged.map((s) => s.customer.phone)));
  const cods = Array.from(new Set(staged.map((s) => s.cod)));

  // Outer scan: index-friendly (phone + cod + active + createdAt window).
  // We then refine in-process using the full composite key, since
  // itemFingerprint and dateBucket aren't stored on the order doc.
  const recent = (await Order.find(
    {
      merchantId,
      "customer.phone": { $in: phones },
      "order.cod": { $in: cods },
      createdAt: { $gte: since },
      // Active-only — see comment above. Cancelled/rto/delivered rows
      // do NOT match, so a stale CSV containing them goes through the
      // happy path (and quota / fraud / audit all see the implications).
      "order.status": { $nin: ["cancelled", "rto", "delivered"] },
    },
    {
      _id: 1,
      orderNumber: 1,
      "customer.phone": 1,
      "order.cod": 1,
      "order.status": 1,
      items: 1,
      createdAt: 1,
    },
  ).lean()) as Array<{
    _id: Types.ObjectId;
    orderNumber: string;
    customer: { phone: string };
    order: { cod: number; status: (typeof ORDER_STATUSES)[number] };
    items?: Array<{ name?: string; quantity?: number; price?: number }>;
    createdAt?: Date;
  }>;

  const REPLACEABLE_STATUSES = new Set<(typeof ORDER_STATUSES)[number]>([
    "pending",
    "confirmed",
  ]);

  const recentByKey = new Map<string, BulkDuplicateMatch>();
  for (const r of recent) {
    if (!r.createdAt) continue;
    const fp = computeItemFingerprint(r.items ?? []);
    const bucket = computeDateBucket(r.createdAt);
    const key = dedupKey({
      phone: r.customer.phone,
      cod: r.order.cod,
      itemFingerprint: fp,
      dateBucket: bucket,
    });
    // First match wins (sort by createdAt desc would be ideal, but
    // duplicates inside the lookback are already a red flag — any
    // match is enough to surface the row).
    if (!recentByKey.has(key)) {
      recentByKey.set(key, {
        row: 0, // filled in per-staged below
        phone: r.customer.phone,
        cod: r.order.cod,
        itemFingerprint: fp,
        dateBucket: bucket,
        matchedOrderId: String(r._id),
        matchedOrderNumber: r.orderNumber,
        matchedStatus: r.order.status,
        matchedCreatedAt: r.createdAt,
        replaceable: REPLACEABLE_STATUSES.has(r.order.status),
        reason: "recent_order",
      });
    }
  }

  const kept: BulkStagedRow[] = [];
  const duplicates: BulkDuplicateMatch[] = [];
  const matchByKey = new Map<string, BulkDuplicateMatch>();
  // In-batch dedup uses the merchant's wall-clock "today" as the date
  // bucket — staged rows haven't been written yet so they share the
  // same bucket regardless of when the upload lands.
  const stagedBucket = computeDateBucket(now);
  const seenInBatch = new Set<string>();

  for (const s of staged) {
    const key = dedupKey({
      phone: s.customer.phone,
      cod: s.cod,
      itemFingerprint: s.itemFingerprint,
      dateBucket: stagedBucket,
    });
    if (seenInBatch.has(key)) {
      const dup: BulkDuplicateMatch = {
        row: s.rowNumber,
        phone: s.customer.phone,
        cod: s.cod,
        itemFingerprint: s.itemFingerprint,
        dateBucket: stagedBucket,
        matchedOrderId: "",
        matchedOrderNumber: "(another row in this CSV)",
        matchedStatus: "pending",
        matchedCreatedAt: now,
        replaceable: false,
        reason: "in_batch",
      };
      duplicates.push(dup);
      matchByKey.set(key, dup);
      errors.push({
        row: s.rowNumber,
        error: "duplicate of an earlier row in this CSV (same phone + COD + items + day)",
      });
      continue;
    }
    seenInBatch.add(key);
    const matched = recentByKey.get(key);
    if (matched) {
      const dup = { ...matched, row: s.rowNumber };
      duplicates.push(dup);
      matchByKey.set(key, dup);
      errors.push({
        row: s.rowNumber,
        error: `duplicate of recent order ${matched.matchedOrderNumber} (${matched.matchedStatus})`,
      });
      continue;
    }
    kept.push(s);
  }
  return { kept, duplicates, matchByKey };
}

export const ordersRouter = router({
  createOrder: billableProcedure.input(createOrderInput).mutation(async ({ ctx, input }) => {
    const merchantId = merchantObjectId(ctx);
    // Idempotency fast-path: if the same merchant re-submits with the same
    // clientRequestId (double-click, network retry, crash-recovery), return
    // the existing order without entering the transaction. Saves one round-
    // trip on the common case; the transaction below is the AUTHORITATIVE
    // guard — the unique index on (merchantId, source.clientRequestId) +
    // the in-tx re-lookup catch a request that races past this fast path.
    if (input.clientRequestId) {
      const existing = await Order.findOne({
        merchantId,
        "source.clientRequestId": input.clientRequestId,
      })
        .select("_id orderNumber fraud")
        .lean();
      if (existing) {
        return {
          id: String(existing._id),
          orderNumber: existing.orderNumber,
          risk: {
            level: existing.fraud?.level ?? "low",
            score: existing.fraud?.riskScore ?? 0,
            reviewStatus: existing.fraud?.reviewStatus ?? "not_required",
            reasons: existing.fraud?.reasons ?? [],
          },
          idempotent: true as const,
        };
      }
    }
    const scoring = await loadMerchantScoring(merchantId);
    const plan = getPlan(scoring.tier);

    const total = input.total ?? input.items.reduce((s, i) => s + i.price * i.quantity, 0);
    const ip = requestIp(ctx) ?? undefined;
    const userAgent = requestUserAgent(ctx) ?? undefined;
    // Canonical-form the phone before the row hits Mongo so identity-
    // resolution and fraud history join on a stable key.
    const customer = {
      ...input.customer,
      phone: normalizePhoneOrRaw(input.customer.phone) ?? input.customer.phone,
    };
    const addressHash = hashAddress(customer.address, customer.district);
    // Risk scoring is read-only against existing orders — safe (and cheaper)
    // to run BEFORE opening the transaction. The score is then written
    // inside the tx so a rollback un-does it.
    const risk = await scoreOrderForCreate({
      merchantId,
      cod: input.cod,
      customer,
      ip,
      addressHash,
      scoring,
    });

    // ---- Exactly-once critical section ----------------------------------
    // Three writes that MUST commit atomically:
    //   1. idempotency re-check (catches a concurrent insert that landed
    //      between the fast path above and the start of this tx)
    //   2. quota reservation ($inc on the monthly Usage counter)
    //   3. Order insert (with clientRequestId for the unique-index guard)
    //
    // Either all three commit or all three abort. A duplicate clientRequestId
    // surfaces as a Mongo write conflict (E11000); we abort, look up the
    // winner, and return the SAME shape as the fast path — caller cannot
    // tell whether their request was the original or the retry.
    //
    // Quota refund is INSIDE the abort path (the $inc never committed) so
    // there is no "ghost reservation" possibility on rollback.
    type OrderCreated = { id: string; orderNumber: string; risk: typeof risk; idempotent: false };
    type IdempotentHit = { id: string; orderNumber: string; risk: { level: string; score: number; reviewStatus: string; reasons: string[] }; idempotent: true };
    type CreateOutcome = { kind: "created"; order: OrderCreated; orderDoc: any } | { kind: "idempotent"; payload: IdempotentHit } | { kind: "quota_exhausted"; reservation: Awaited<ReturnType<typeof reserveQuota>> };

    const session = await mongoose.startSession();
    let outcome: CreateOutcome;
    try {
      outcome = await session.withTransaction<CreateOutcome>(async () => {
        // 1. In-tx idempotency check — a concurrent inserter that beat us
        // past the fast path is visible here under the tx's snapshot view.
        if (input.clientRequestId) {
          const existing = await Order.findOne({
            merchantId,
            "source.clientRequestId": input.clientRequestId,
          })
            .select("_id orderNumber fraud")
            .session(session)
            .lean();
          if (existing) {
            return {
              kind: "idempotent",
              payload: {
                id: String(existing._id),
                orderNumber: existing.orderNumber,
                risk: {
                  level: existing.fraud?.level ?? "low",
                  score: existing.fraud?.riskScore ?? 0,
                  reviewStatus: existing.fraud?.reviewStatus ?? "not_required",
                  reasons: existing.fraud?.reasons ?? [],
                },
                idempotent: true,
              },
            };
          }
        }

        // 2. Quota reservation — same session so a downstream insert failure
        // rolls the $inc back automatically.
        const reservation = await reserveQuota(merchantId, plan, "ordersCreated", 1, { session });
        if (!reservation.allowed) {
          return { kind: "quota_exhausted", reservation };
        }

        // 3. Order insert. `Order.create([doc], { session })` — array form is
        // the only signature that accepts options; the post-save hook reads
        // `this.$session()` to keep the MerchantStats $inc in this tx too.
        const created = await Order.create(
          [
            {
              merchantId,
              orderNumber: input.orderNumber ?? generateOrderNumber(),
              customer,
              items: input.items,
              order: { cod: input.cod, total, status: "pending" },
              fraud: fraudDocFromRisk(risk),
              ...(input.pinnedCourier
                ? { automation: { pinnedCourier: input.pinnedCourier } }
                : {}),
              source: {
                ip: ip ?? undefined,
                userAgent,
                addressHash: addressHash ?? undefined,
                channel: "dashboard",
                ...(input.clientRequestId
                  ? { clientRequestId: input.clientRequestId }
                  : {}),
              },
            },
          ],
          { session },
        );
        const orderDoc = created[0]!;
        return {
          kind: "created",
          orderDoc,
          order: {
            id: String(orderDoc._id),
            orderNumber: orderDoc.orderNumber,
            risk,
            idempotent: false,
          },
        };
      });
    } catch (err) {
      // E11000 on (merchantId, clientRequestId) means a concurrent inserter
      // won the race INSIDE our tx window — withTransaction has already
      // aborted (rolling back the quota $inc). Look up the winner and
      // return the idempotent shape so the caller sees exactly-once.
      const code = (err as { code?: number })?.code;
      const codeName = (err as { codeName?: string })?.codeName;
      if ((code === 11000 || codeName === "DuplicateKey") && input.clientRequestId) {
        const existing = await Order.findOne({
          merchantId,
          "source.clientRequestId": input.clientRequestId,
        })
          .select("_id orderNumber fraud")
          .lean();
        if (existing) {
          await session.endSession();
          return {
            id: String(existing._id),
            orderNumber: existing.orderNumber,
            risk: {
              level: existing.fraud?.level ?? "low",
              score: existing.fraud?.riskScore ?? 0,
              reviewStatus: existing.fraud?.reviewStatus ?? "not_required",
              reasons: existing.fraud?.reasons ?? [],
            },
            idempotent: true as const,
          };
        }
      }
      await session.endSession();
      throw err;
    }
    await session.endSession();

    if (outcome.kind === "quota_exhausted") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `monthly order quota reached (${outcome.reservation.used}/${outcome.reservation.limit}) — upgrade your plan`,
      });
    }
    if (outcome.kind === "idempotent") {
      return outcome.payload;
    }
    const order = outcome.orderDoc;

    // Best-effort post-create work runs OUTSIDE the transaction — these are
    // observability / automation hooks that must not roll back the order if
    // they fail. Wrapped in a try/catch so a stray throw cannot prevent the
    // mutation from returning the created order to the caller.
    try {
      // Feedback-loop ledger — captured at scoring time, outcome stamped
      // later by the tracking pipeline. Best-effort; never undoes the order.
      void FraudPrediction.create({
        merchantId,
        orderId: order._id,
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
      // --- Automation engine ---------------------------------------------
      // Decide what (if anything) the engine should do for this fresh order.
      // Persistence is best-effort; a failure must not roll back the order
      // creation. Booking is fire-and-forget — never blocks the response.
      let automationState: AutomationState = "not_evaluated";
      let automationReason = "";
      try {
        const merchant = await Merchant.findById(merchantId)
          .select("automationConfig couriers")
          .lean();
        const automationCfg = (merchant as { automationConfig?: Record<string, unknown> } | null)?.automationConfig ?? {};
        const decision = decideAutomationAction(risk.level, risk.riskScore, automationCfg as never);
        automationState = decision.state;
        automationReason = decision.reason;

        if (decision.action !== "no_op") {
          const set: Record<string, unknown> = {
            "automation.state": decision.state,
            "automation.decidedBy": "system",
            "automation.decidedAt": new Date(),
            "automation.reason": decision.reason.slice(0, 200),
          };
          let confirmationCode: string | undefined;
          if (decision.state === "auto_confirmed") {
            set["automation.confirmedAt"] = new Date();
            set["order.status"] = "confirmed";
          } else if (decision.state === "pending_confirmation") {
            // Mint a 6-digit code so an inbound "YES 123456" reply maps to
            // a single order even when the same customer has multiple
            // pending orders.
            confirmationCode = String(Math.floor(10000000 + Math.random() * 90000000));
            set["automation.confirmationCode"] = confirmationCode;
            set["automation.confirmationChannel"] = "sms";
            // confirmationSentAt is stamped by the SMS worker on success,
            // so the stale-pending sweeper sees a missing timestamp until
            // the gateway actually accepts the message.
          }
          await Order.updateOne({ _id: order._id }, { $set: set });

          // Pending-confirmation outbound SMS — queued, with retries +
          // exponential backoff. Survives transient gateway outages.
          if (decision.state === "pending_confirmation" && confirmationCode) {
            void enqueueOrderConfirmationSms({
              orderId: String(order._id),
              merchantId: String(merchantId),
              phone: order.customer.phone,
              orderNumber: order.orderNumber,
              codAmount: order.order.cod,
              confirmationCode,
            }).catch((err) =>
              console.error("[automation] enqueue confirm SMS failed:", (err as Error).message),
            );
          }
          void writeAudit({
            merchantId,
            actorId: merchantId,
            actorType: "system",
            action: `automation.${decision.action}`,
            subjectType: "order",
            subjectId: order._id,
            meta: { state: decision.state, reason: decision.reason, riskScore: risk.riskScore },
          });

          // Auto-book hook: never inline-await, never throw. If booking fails,
          // the order stays in `confirmed` and the merchant can retry from UI.
          if (decision.shouldAutoBook) {
            const courierName =
              (automationCfg as { autoBookCourier?: string }).autoBookCourier ??
              ((merchant as { couriers?: Array<{ name: string; enabled?: boolean }> } | null)?.couriers ?? [])
                .find((c) => c.enabled !== false)?.name;
            if (courierName) {
              // Auto-book runs in the BullMQ queue (apps/api/src/workers/automationBook.ts)
              // with attempts: 3, exponential backoff, and a critical-tier
              // merchant notification when retries are exhausted. Never blocks
              // the response; never throws.
              void enqueueAutoBook({
                orderId: String(order._id),
                merchantId: String(merchantId),
                userId: ctx.user.id,
                courier: courierName,
              }).catch((err) =>
                console.error("[automation] enqueueAutoBook failed:", (err as Error).message),
              );
            }
          }
        }
      } catch (err) {
        console.error("[automation] evaluation failed", (err as Error).message);
      }

      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "risk.scored",
        subjectType: "order",
        subjectId: order._id,
        meta: { level: risk.level, score: risk.riskScore, reasons: risk.reasons },
      });
      if (risk.level === "high") {
        // Awaited so the merchant's inbox is guaranteed-written before the
        // mutation response returns — we never silently drop a fraud alert.
        await fireFraudAlert({
          merchantId,
          orderId: order._id,
          orderNumber: order.orderNumber,
          phone: order.customer.phone,
          riskScore: risk.riskScore,
          level: risk.level,
          reasons: risk.reasons,
          kind: "fraud.pending_review",
        });
      }
      void resolveIdentityForOrder({
        merchantId,
        orderId: order._id,
        phone: order.customer.phone,
      }).catch((err) => console.error("[orders.create] identity stitch failed", err));
    } catch (err) {
      // Order is already committed — best-effort post-create work failing
      // must NOT roll back the order or throw to the caller. Log and move
      // on; the merchant has a valid order in their list either way.
      console.error("[orders.create] post-commit hook failed", (err as Error).message);
    }
    return {
      id: String(order._id),
      orderNumber: order.orderNumber,
      risk: {
        level: risk.level,
        score: risk.riskScore,
        reviewStatus: risk.reviewStatus,
        reasons: risk.reasons,
      },
      idempotent: false as const,
    };
  }),

  listOrders: protectedProcedure
    .input(
      z
        .object({
          status: z.enum(ORDER_STATUSES).optional(),
          courier: z.string().optional(),
          dateFrom: z.coerce.date().optional(),
          dateTo: z.coerce.date().optional(),
          phone: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({ limit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const q: Record<string, unknown> = { merchantId };
      if (input.status) q["order.status"] = input.status;
      if (input.courier) q["logistics.courier"] = input.courier;
      if (input.phone) q["customer.phone"] = input.phone;
      if (input.dateFrom || input.dateTo) {
        q.createdAt = {
          ...(input.dateFrom ? { $gte: input.dateFrom } : {}),
          ...(input.dateTo ? { $lte: input.dateTo } : {}),
        };
      }

      const findQuery: Record<string, unknown> = { ...q };
      if (input.cursor) {
        findQuery._id = { $lt: new Types.ObjectId(input.cursor) };
      }

      const items = await Order.find(findQuery)
        .sort({ _id: -1 })
        .limit(input.limit + 1)
        .lean();

      const hasMore = items.length > input.limit;
      const page = hasMore ? items.slice(0, -1) : items;
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? String(last._id) : null;

      const countFilterKey = filterHash({
        m: String(merchantId),
        s: input.status,
        c: input.courier,
        p: input.phone,
        f: input.dateFrom?.toISOString(),
        t: input.dateTo?.toISOString(),
      });
      const total = await cached(
        `orders:count:${ctx.user.id}:${countFilterKey}`,
        COUNT_TTL,
        () => Order.countDocuments(q),
      );

      return {
        total,
        nextCursor,
        items: page.map((o) => {
          const events = o.logistics?.trackingEvents ?? [];
          const latest = events.length > 0 ? events[events.length - 1] : null;
          return {
            id: String(o._id),
            orderNumber: o.orderNumber,
            status: o.order.status,
            cod: o.order.cod,
            total: o.order.total,
            customer: o.customer,
            courier: o.logistics?.courier,
            trackingNumber: o.logistics?.trackingNumber,
            normalizedStatus: latest?.normalizedStatus,
            eventCount: events.length,
            lastPolledAt: o.logistics?.lastPolledAt,
            deliveredAt: o.logistics?.deliveredAt,
            returnedAt: o.logistics?.returnedAt,
            pollError: o.logistics?.pollError,
            riskScore: o.fraud?.riskScore ?? 0,
            riskLevel: o.fraud?.level ?? "low",
            reviewStatus: o.fraud?.reviewStatus ?? "not_required",
            automationState: o.automation?.state ?? "not_evaluated",
            bookedByAutomation: o.automation?.bookedByAutomation ?? false,
            createdAt: o.createdAt,
          };
        }),
      };
    }),

  listCouriers: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const couriers = await Order.distinct("logistics.courier", {
      merchantId,
      "logistics.courier": { $exists: true, $ne: null },
    });
    return couriers.filter((c): c is string => typeof c === "string" && c.length > 0).sort();
  }),

  getOrder: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid order id" });
      }
      const merchantId = merchantObjectId(ctx);
      const order = await Order.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      }).lean();
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });

      const events = [...(order.logistics?.trackingEvents ?? [])].sort(
        (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
      );
      const latest = events.length > 0 ? events[events.length - 1] : null;

      return {
        id: String(order._id),
        orderNumber: order.orderNumber,
        status: order.order.status,
        cod: order.order.cod,
        total: order.order.total,
        customer: order.customer,
        items: order.items,
        courier: order.logistics?.courier,
        trackingNumber: order.logistics?.trackingNumber,
        normalizedStatus: latest?.normalizedStatus,
        estimatedDelivery: order.logistics?.estimatedDelivery,
        deliveredAt: order.logistics?.deliveredAt,
        returnedAt: order.logistics?.returnedAt,
        lastPolledAt: order.logistics?.lastPolledAt,
        pollError: order.logistics?.pollError,
        pollErrorCount: order.logistics?.pollErrorCount ?? 0,
        rtoReason: order.logistics?.rtoReason,
        trackingEvents: events.map((e) => ({
          at: e.at,
          providerStatus: e.providerStatus,
          normalizedStatus: e.normalizedStatus,
          description: e.description ?? null,
          location: e.location ?? null,
        })),
        riskScore: order.fraud?.riskScore ?? 0,
        createdAt: order.createdAt,
      };
    }),

  refreshTracking: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid order id" });
      }
      const merchantId = merchantObjectId(ctx);
      const order = await Order.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      })
        .select("_id merchantId order logistics")
        .lean();
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });

      const result = await syncOrderTracking({
        _id: order._id,
        merchantId: order.merchantId,
        order: order.order as never,
        logistics: order.logistics as never,
      });

      if (result.error) {
        return {
          ok: false as const,
          orderId: result.orderId,
          error: result.error,
        };
      }
      if (result.skipped) {
        return {
          ok: false as const,
          orderId: result.orderId,
          skipped: result.skipped,
        };
      }
      return {
        ok: true as const,
        orderId: result.orderId,
        newEvents: result.newEvents ?? 0,
        statusTransition: result.statusTransition,
      };
    }),

  /**
   * Dry-run sibling of `bulkUpload`. Parses + validates + dedups but never
   * writes. The dialog calls this first so the merchant sees row-level
   * errors, header-mapping warnings, and duplicate matches BEFORE any
   * orders are created. Output shape is a superset of bulkUpload's so the
   * confirm step can show identical numbers.
   */
  previewBulkUpload: protectedProcedure
    .input(
      z.object({
        csv: z.string().min(1).max(MAX_BULK_CSV_BYTES),
        mode: z.enum(BULK_UPLOAD_MODES).default("skip"),
        uploadContext: uploadContextSchema.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const parsed = parseAndStageBulk(input.csv);
      if (parsed.totalRows > MAX_BULK_ROWS) {
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message: `max ${MAX_BULK_ROWS} rows per upload — split the file or use the async upload endpoint`,
        });
      }
      const merchantId = merchantObjectId(ctx);
      const errorsCopy = [...parsed.errors];
      const dedup = await dedupAgainstRecentOrders(merchantId, parsed.staged, errorsCopy);

      // Stale-upload telemetry — surface as warning fields, never block
      // the preview (preview is read-only).
      const driftMs = input.uploadContext
        ? Date.now() - input.uploadContext.uploadedAt.getTime()
        : 0;
      const staleUpload = driftMs > BULK_UPLOAD_MAX_DRIFT_MS;
      const duplicateBatch = input.uploadContext
        ? Boolean(
            await BulkUploadBatch.findOne({
              merchantId,
              externalBatchId: input.uploadContext.externalBatchId,
            })
              .select("_id")
              .lean(),
          )
        : false;

      // Replace-mode: tell the merchant exactly how many existing
      // orders would be cancelled. Non-replaceable matches (already
      // shipped/delivered/etc) stay as plain duplicates.
      const replaceableDupes = dedup.duplicates.filter(
        (d) => d.reason === "recent_order" && d.replaceable,
      );
      const nonReplaceableDupes = dedup.duplicates.filter(
        (d) => d.reason === "recent_order" && !d.replaceable,
      );
      const inBatchDupes = dedup.duplicates.filter((d) => d.reason === "in_batch");

      // Effective inserts under each mode — what the merchant will
      // actually see materialise after the click.
      const wouldInsertUnderMode =
        input.mode === "review"
          ? 0
          : input.mode === "replace"
            ? dedup.kept.length + replaceableDupes.length
            : dedup.kept.length;
      const wouldReplace = input.mode === "replace" ? replaceableDupes.length : 0;
      const wouldSkip =
        input.mode === "replace"
          ? inBatchDupes.length + nonReplaceableDupes.length
          : dedup.duplicates.length;

      const sampleSource = dedup.kept.length > 0 ? dedup.kept : parsed.staged;
      const preview = sampleSource.slice(0, 5).map((s) => ({
        rowNumber: s.rowNumber,
        customer: s.customer,
        itemName: s.itemName,
        quantity: s.quantity,
        price: s.price,
        cod: s.cod,
      }));
      return {
        mode: input.mode,
        totalRows: parsed.totalRows,
        validRows: dedup.kept.length,
        errorRows: errorsCopy.length,
        errors: errorsCopy,
        headerWarnings: parsed.headerWarnings,
        unknownColumns: parsed.unknownColumns,
        duplicates: dedup.duplicates,
        // Mode-aware projections so the UI can render an exact preview
        // banner ("This will create N orders and replace M existing").
        wouldInsert: wouldInsertUnderMode,
        wouldReplace,
        wouldSkip,
        replaceableCount: replaceableDupes.length,
        nonReplaceableCount: nonReplaceableDupes.length,
        // Anti-replay warnings — surfaced now so the merchant can
        // abort before clicking Upload.
        warnings: {
          staleUpload,
          duplicateBatch,
          uploadDriftMs: driftMs,
          maxDriftMs: BULK_UPLOAD_MAX_DRIFT_MS,
        },
        preview,
      };
    }),

  bulkUpload: billableProcedure
    .input(
      z.object({
        csv: z.string().min(1).max(MAX_BULK_CSV_BYTES),
        mode: z.enum(BULK_UPLOAD_MODES).default("skip"),
        uploadContext: uploadContextSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const parsed = parseAndStageBulk(input.csv);
      if (parsed.totalRows > MAX_BULK_ROWS) {
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message: `max ${MAX_BULK_ROWS} rows per upload — split the file or use the async upload endpoint`,
        });
      }
      const { staged, errors, headerWarnings, totalRows } = parsed;

      const merchantId = merchantObjectId(ctx);
      const scoring = await loadMerchantScoring(merchantId);
      const uploaderIp = requestIp(ctx) ?? undefined;
      const uploaderUA = requestUserAgent(ctx) ?? undefined;
      const mode = input.mode;

      // --- Stale-upload guard (anti-replay).
      // 1) Drift: if the client `uploadedAt` is more than 7d behind
      //    server now, refuse. Catches a saved request payload being
      //    replayed weeks later.
      // 2) Duplicate batch: insert a BulkUploadBatch row keyed on
      //    (merchantId, externalBatchId). Re-submitting the same id
      //    collides on the unique index → reject.
      let batchId: Types.ObjectId | null = null;
      if (input.uploadContext) {
        const drift = Date.now() - input.uploadContext.uploadedAt.getTime();
        if (drift > BULK_UPLOAD_MAX_DRIFT_MS) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `upload is stale — uploadedAt is ${Math.floor(drift / 86400_000)}d old (max ${Math.floor(BULK_UPLOAD_MAX_DRIFT_MS / 86400_000)}d). Refresh the page and re-upload.`,
          });
        }
        try {
          const batch = await BulkUploadBatch.create({
            merchantId,
            externalBatchId: input.uploadContext.externalBatchId,
            source: input.uploadContext.source,
            uploadedAt: input.uploadContext.uploadedAt,
            mode,
            status: "processing",
            ip: uploaderIp,
            userAgent: uploaderUA,
          });
          batchId = batch._id;
        } catch (err) {
          // E11000 = duplicate (merchantId, externalBatchId).
          const msg = (err as Error).message ?? "";
          if (msg.includes("E11000") || msg.includes("duplicate key")) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "this batch was already uploaded — generate a new batch id (refresh the page) before re-trying",
            });
          }
          throw err;
        }
      }

      // --- Dedup: composite key (phone+cod+itemFingerprint+dateBucket).
      const dedupResult = await dedupAgainstRecentOrders(merchantId, staged, errors);
      const duplicates = dedupResult.duplicates;
      let stagedAfterDedup = dedupResult.kept;
      let replacedOrderIds: Types.ObjectId[] = [];

      // --- Mode handling -------------------------------------------------
      // skip    : default — duplicates dropped (already done by dedup).
      // review  : do NOT insert anything; return what would have happened
      //           so the merchant can adjust the CSV and try again.
      // replace : for replaceable matches (status pending|confirmed),
      //           cancel the matched order (release quota + audit) and
      //           promote the staged row back into the insert set. Non-
      //           replaceable matches still drop with a warning.
      if (mode === "review") {
        if (batchId) {
          await BulkUploadBatch.updateOne(
            { _id: batchId },
            {
              $set: {
                status: "review_pending",
                rowsParsed: totalRows,
                rowsDuplicatesSkipped: duplicates.length,
                rowsErrors: errors.length,
                completedAt: new Date(),
              },
            },
          );
        }
        return {
          mode,
          inserted: 0,
          replaced: 0,
          errors,
          totalRows,
          flagged: 0,
          duplicates,
          headerWarnings,
        };
      }

      if (mode === "replace") {
        const stagedByKey = new Map<string, BulkStagedRow>();
        const stagedBucket = computeDateBucket(new Date());
        for (const s of staged) {
          stagedByKey.set(
            dedupKey({
              phone: s.customer.phone,
              cod: s.cod,
              itemFingerprint: s.itemFingerprint,
              dateBucket: stagedBucket,
            }),
            s,
          );
        }
        const promoted: BulkStagedRow[] = [];
        for (const dup of duplicates) {
          if (dup.reason !== "recent_order" || !dup.replaceable) continue;
          // Atomic cancel — guard ensures the order didn't transition
          // to shipped between dedup read and now. If the guard
          // fails, leave the duplicate alone (do NOT insert the
          // staged row, otherwise we'd have two active orders).
          const updated = await Order.findOneAndUpdate(
            {
              _id: new Types.ObjectId(dup.matchedOrderId),
              merchantId,
              "order.status": { $in: ["pending", "confirmed"] },
            },
            {
              $set: {
                "order.status": "cancelled",
                "order.preRejectStatus": dup.matchedStatus,
                "automation.state": "rejected",
                "automation.preRejectState": dup.matchedStatus,
                "automation.decidedBy": "merchant",
                "automation.decidedAt": new Date(),
                "automation.rejectedAt": new Date(),
                "automation.rejectionReason":
                  `replaced by CSV upload (mode=replace, batch=${input.uploadContext?.externalBatchId ?? "n/a"})`,
              },
            },
            { new: true, projection: { _id: 1 } },
          ).lean();
          if (updated) {
            replacedOrderIds.push(updated._id as Types.ObjectId);
            await releaseQuota(merchantId, "ordersCreated", 1);
            const stagedRow = stagedByKey.get(
              dedupKey({
                phone: dup.phone,
                cod: dup.cod,
                itemFingerprint: dup.itemFingerprint,
                dateBucket: stagedBucket,
              }),
            );
            if (stagedRow) promoted.push(stagedRow);
          }
        }
        if (promoted.length > 0) {
          stagedAfterDedup = [...stagedAfterDedup, ...promoted];
        }
      }

      if (stagedAfterDedup.length === 0) {
        if (batchId) {
          await BulkUploadBatch.updateOne(
            { _id: batchId },
            {
              $set: {
                status: "completed",
                rowsParsed: totalRows,
                rowsInserted: 0,
                rowsReplaced: replacedOrderIds.length,
                rowsDuplicatesSkipped: duplicates.length,
                rowsErrors: errors.length,
                completedAt: new Date(),
              },
            },
          );
        }
        return {
          mode,
          inserted: 0,
          replaced: replacedOrderIds.length,
          errors,
          totalRows,
          flagged: 0,
          duplicates,
          headerWarnings,
        };
      }

      // --- Batch-compute real fraud history for every phone + address in the
      // upload. Keeps the full bulk path at O(phones + addresses) lookups
      // instead of O(rows), and closes the historical-bypass gap that existed
      // in v1.
      const phoneSet = new Set<string>();
      const addressSet = new Set<string>();
      for (const s of stagedAfterDedup) {
        phoneSet.add(s.customer.phone);
        if (s.addressHash) addressSet.add(s.addressHash);
      }
      const batch = await collectRiskHistoryBatch({
        merchantId,
        phones: [...phoneSet],
        addressHashes: [...addressSet],
        halfLifeDays: scoring.halfLifeDays,
      });

      // Pre-compute how many times each phone/address appears *within this
      // CSV* so a fraudster can't bypass duplicate signals by batch-uploading
      // 10 copies in the same file.
      const withinPhone = new Map<string, number>();
      const withinAddress = new Map<string, number>();
      for (const s of stagedAfterDedup) {
        withinPhone.set(s.customer.phone, (withinPhone.get(s.customer.phone) ?? 0) + 1);
        if (s.addressHash) {
          withinAddress.set(s.addressHash, (withinAddress.get(s.addressHash) ?? 0) + 1);
        }
      }

      const docs: Array<Record<string, unknown>> = [];
      const pendingAlerts: Array<{
        orderIndex: number;
        orderNumber: string;
        phone: string;
        risk: ReturnType<typeof computeRisk>;
      }> = [];

      for (let i = 0; i < stagedAfterDedup.length; i++) {
        const s = stagedAfterDedup[i]!;
        const phoneHist = batch.byPhone.get(s.customer.phone) ?? {
          phoneOrdersCount: 0,
          phoneReturnedCount: 0,
          phoneCancelledCount: 0,
          phoneUnreachableCount: 0,
        };
        const addrHist =
          (s.addressHash && batch.byAddress.get(s.addressHash)) ||
          { addressDistinctPhones: 0, addressReturnedCount: 0 };
        const withinPhoneDup = (withinPhone.get(s.customer.phone) ?? 1) - 1;
        const withinAddrDup = s.addressHash
          ? (withinAddress.get(s.addressHash) ?? 1) - 1
          : 0;
        const risk = computeRisk(
          {
            cod: s.cod,
            customer: s.customer,
            ip: uploaderIp,
            addressHash: s.addressHash,
          },
          {
            phoneOrdersCount: phoneHist.phoneOrdersCount + withinPhoneDup,
            phoneReturnedCount: phoneHist.phoneReturnedCount,
            phoneCancelledCount: phoneHist.phoneCancelledCount,
            phoneUnreachableCount: phoneHist.phoneUnreachableCount,
            ipRecentCount: 0,
            phoneVelocityCount: phoneHist.phoneOrdersCount + withinPhoneDup + 1,
            addressDistinctPhones: addrHist.addressDistinctPhones + withinAddrDup,
            addressReturnedCount: addrHist.addressReturnedCount,
          },
          scoring.opts,
        );
        docs.push({
          merchantId,
          orderNumber: s.orderNumber,
          customer: s.customer,
          items: [{ name: s.itemName, quantity: s.quantity, price: s.price }],
          order: { cod: s.cod, total: s.price * s.quantity, status: "pending" },
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
            ip: uploaderIp,
            userAgent: uploaderUA,
            addressHash: s.addressHash ?? undefined,
            channel: "bulk_upload",
          },
        });
        if (risk.level === "high") {
          pendingAlerts.push({
            orderIndex: i,
            orderNumber: s.orderNumber,
            phone: s.customer.phone,
            risk,
          });
        }
      }

      // Reserve the entire batch against the monthly cap up-front. Fewer rows
      // actually land when per-doc writes fail → we release the difference.
      const plan = getPlan(scoring.tier);
      const reservation = await reserveQuota(merchantId, plan, "ordersCreated", docs.length);
      if (!reservation.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `bulk upload exceeds monthly order quota (${reservation.used}/${reservation.limit}) — upgrade your plan`,
        });
      }

      let inserted = 0;
      let flagged = 0;
      const insertedIds: Array<Types.ObjectId> = [];
      try {
        for (let i = 0; i < docs.length; i += BULK_CHUNK) {
          const chunk = docs.slice(i, i + BULK_CHUNK);
          try {
            const result = await Order.insertMany(chunk, { ordered: false });
            inserted += result.length;
            for (const r of result) {
              insertedIds.push(r._id as Types.ObjectId);
              if ((r as { fraud?: { level?: string } }).fraud?.level === "high") {
                flagged += 1;
              }
            }
          } catch (err: unknown) {
            const bulkErr = err as {
              result?: { insertedCount?: number };
              insertedDocs?: Array<{ _id?: Types.ObjectId; fraud?: { level?: string } }>;
              writeErrors?: Array<{ index?: number; errmsg?: string }>;
            };
            const good = bulkErr.insertedDocs ?? [];
            inserted += bulkErr.result?.insertedCount ?? good.length;
            for (const r of good) {
              if (r._id) insertedIds.push(r._id);
              if (r.fraud?.level === "high") flagged += 1;
            }
            for (const we of bulkErr.writeErrors ?? []) {
              errors.push({ row: i + (we.index ?? 0) + 2, error: we.errmsg ?? "write error" });
            }
          }
        }
      } finally {
        const refund = docs.length - inserted;
        if (refund > 0) {
          await releaseQuota(merchantId, "ordersCreated", refund);
        }
      }

      // Fire alerts for every HIGH row that actually landed. We match on
      // the inserted _ids (not indices) because `insertMany { ordered: false }`
      // can skip docs on write conflicts without preserving index alignment.
      if (pendingAlerts.length > 0 && insertedIds.length > 0) {
        const flaggedDocs = (await Order.find(
          { _id: { $in: insertedIds }, "fraud.level": "high" },
          { _id: 1, orderNumber: 1, customer: 1, "fraud.riskScore": 1, "fraud.reasons": 1 },
        ).lean()) as Array<{
          _id: Types.ObjectId;
          orderNumber: string;
          customer: { phone: string };
          fraud?: { riskScore?: number; reasons?: string[] };
        }>;
        await Promise.all(
          flaggedDocs.map((doc) =>
            fireFraudAlert({
              merchantId,
              orderId: doc._id,
              orderNumber: doc.orderNumber,
              phone: doc.customer?.phone,
              riskScore: doc.fraud?.riskScore ?? 0,
              level: "high",
              reasons: doc.fraud?.reasons ?? [],
              kind: "fraud.pending_review",
            }),
          ),
        );
      }

      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "risk.scored",
        subjectType: "merchant",
        subjectId: merchantId,
        meta: {
          bulkUpload: true,
          mode,
          batchId: batchId ? String(batchId) : null,
          externalBatchId: input.uploadContext?.externalBatchId ?? null,
          totalRows,
          inserted,
          replaced: replacedOrderIds.length,
          flagged,
          rejected: errors.length,
          duplicates: duplicates.length,
          ip: uploaderIp ?? null,
        },
      });

      if (batchId) {
        await BulkUploadBatch.updateOne(
          { _id: batchId },
          {
            $set: {
              status: "completed",
              rowsParsed: totalRows,
              rowsInserted: inserted,
              rowsReplaced: replacedOrderIds.length,
              rowsDuplicatesSkipped: duplicates.length,
              rowsErrors: errors.length,
              completedAt: new Date(),
            },
          },
        );
      }

      return {
        mode,
        inserted,
        replaced: replacedOrderIds.length,
        errors,
        totalRows,
        flagged,
        duplicates,
        headerWarnings,
      };
    }),

  updateOrder: protectedProcedure.input(updateOrderInput).mutation(async ({ ctx, input }) => {
    if (!Types.ObjectId.isValid(input.id)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "invalid order id" });
    }
    const merchantId = merchantObjectId(ctx);
    const order = await Order.findOne({ _id: new Types.ObjectId(input.id), merchantId });
    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });

    const prevStatus = order.order.status;
    const nextStatus = input.status ?? prevStatus;

    if (input.status && input.status !== prevStatus) {
      if (!isTransitionAllowed(prevStatus, input.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `invalid status transition: ${prevStatus} → ${input.status}`,
        });
      }
      order.order.status = input.status;
    }
    if (input.customer) {
      Object.assign(order.customer, input.customer);
    }
    if (input.courier !== undefined || input.trackingNumber !== undefined || input.rtoReason !== undefined) {
      order.logistics = order.logistics ?? {};
      if (input.courier !== undefined) order.logistics.courier = input.courier;
      if (input.trackingNumber !== undefined) order.logistics.trackingNumber = input.trackingNumber;
      if (input.rtoReason !== undefined) order.logistics.rtoReason = input.rtoReason;
    }

    await order.save();

    if (nextStatus !== prevStatus) {
      await MerchantStats.updateOne(
        { merchantId },
        {
          $inc: { [prevStatus]: -1, [nextStatus]: 1 },
          $set: { updatedAt: new Date() },
        },
      );
      await invalidate(`dashboard:${ctx.user.id}`);

      // Fan out a rescore when an order goes into a terminal negative state —
      // other open orders from the same phone just got riskier.
      if (nextStatus === "rto" || nextStatus === "cancelled") {
        void enqueueRescore({
          merchantId: String(merchantId),
          phone: order.customer.phone,
          trigger: nextStatus === "rto" ? "order.rto" : "order.cancelled",
          triggerOrderId: String(order._id),
        });
      }
    }

    return { id: String(order._id), status: order.order.status };
  }),

  deleteOrder: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid order id" });
      }
      const merchantId = merchantObjectId(ctx);
      const order = await Order.findOneAndDelete({
        _id: new Types.ObjectId(input.id),
        merchantId,
      }).lean();
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });

      const status = order.order?.status ?? "pending";
      await MerchantStats.updateOne(
        { merchantId },
        {
          $inc: { totalOrders: -1, [status]: -1 },
          $set: { updatedAt: new Date() },
        },
      );
      await invalidate(`dashboard:${ctx.user.id}`);

      return { id: input.id, deleted: true };
    }),

  /**
   * Manual confirmation — used when the merchant clicks "Confirm" on a
   * pending_confirmation row, OR (rare) when an admin overrides a previous
   * rejection. Idempotent: confirming an already-confirmed/auto_confirmed
   * order is a no-op success. Refuses to walk back from rejected.
   */
  confirmOrder: protectedProcedure
    .input(z.object({ id: z.string().min(1), reason: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const _id = new Types.ObjectId(input.id);
      const order = await Order.findOne({ _id, merchantId })
        .select("automation order.status")
        .lean();
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });

      const fromState = (order as { automation?: { state?: AutomationState } }).automation?.state
        ?? "not_evaluated";
      const toState: AutomationState = "confirmed";
      if (!canTransitionAutomation(fromState, toState)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `cannot confirm from automation state "${fromState}"`,
        });
      }
      // No-op idempotency: already confirmed or auto-confirmed.
      if (fromState === "confirmed" || fromState === "auto_confirmed") {
        return { id: input.id, state: fromState, idempotent: true };
      }

      const now = new Date();
      const set: Record<string, unknown> = {
        "automation.state": toState,
        "automation.decidedBy": "merchant",
        "automation.decidedAt": now,
        "automation.confirmedAt": now,
        "automation.reason": (input.reason ?? "merchant confirmed").slice(0, 200),
      };
      // Walk the order status forward only when it is still pending — never
      // pull a shipped/delivered order back to "confirmed".
      const prevStatus = (order as { order?: { status?: string } }).order?.status;
      if (prevStatus === "pending") {
        set["order.status"] = "confirmed";
      }

      // Atomic write: include the from-state in the filter so a concurrent
      // sweep / SMS-reject can't be silently overwritten between the read
      // above and this write. A null result means somebody else moved the
      // state — return a 409 so the client can re-fetch and retry.
      const updated = await Order.findOneAndUpdate(
        { _id, merchantId, "automation.state": fromState },
        { $set: set },
        { new: true, projection: { _id: 1 } },
      ).lean();
      if (!updated) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "order state changed in the background — refresh and retry",
        });
      }

      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "merchant",
        action: "automation.confirmed",
        subjectType: "order",
        subjectId: _id,
        meta: { from: fromState, reason: input.reason ?? null },
      });

      // Mirror the SMS-inbound auto-book hook so dashboard confirms ship
      // automatically too. Never inline-await; never throw.
      try {
        const merchant = await Merchant.findById(merchantId)
          .select("automationConfig couriers")
          .lean();
        const cfg = (merchant as { automationConfig?: { autoBookEnabled?: boolean; autoBookCourier?: string } } | null)
          ?.automationConfig ?? {};
        if (cfg.autoBookEnabled === true) {
          const courierName =
            cfg.autoBookCourier ??
            ((merchant as { couriers?: Array<{ name: string; enabled?: boolean }> } | null)?.couriers ?? [])
              .find((c) => c.enabled !== false)?.name;
          if (courierName) {
            void enqueueAutoBook({
              orderId: String(_id),
              merchantId: String(merchantId),
              userId: ctx.user.id,
              courier: courierName,
            }).catch((err) =>
              console.error("[confirmOrder] auto-book enqueue failed:", (err as Error).message),
            );
          }
        }
      } catch (err) {
        console.error("[confirmOrder] auto-book lookup failed:", (err as Error).message);
      }

      return { id: input.id, state: toState, idempotent: false };
    }),

  /**
   * Manual rejection — sets automation.state to rejected and (if the order
   * has not yet shipped) flips order.status to cancelled. Idempotent on
   * already-rejected. Always blocked once the order is shipped/in transit.
   */
  rejectOrder: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        reason: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const _id = new Types.ObjectId(input.id);
      const order = await Order.findOne({ _id, merchantId })
        .select("automation order.status fraud.reviewStatus fraud.level")
        .lean();
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });

      const fromState = (order as { automation?: { state?: AutomationState } }).automation?.state
        ?? "not_evaluated";
      if (fromState === "rejected") {
        return { id: input.id, state: fromState, idempotent: true };
      }
      if (!canTransitionAutomation(fromState, "rejected")) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `cannot reject from automation state "${fromState}"`,
        });
      }
      const status = (order as { order?: { status?: string } }).order?.status;
      if (status && !["pending", "confirmed"].includes(status)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `cannot reject — order is already ${status}. Cancel via courier instead.`,
        });
      }

      const now = new Date();
      const fromStatus = (status ?? "pending") as (typeof ORDER_STATUSES)[number];
      // Atomic: include from-state in the filter to close the TOCTOU window
      // between the read above and this write. If the state moved (sweep,
      // SMS-confirm, parallel reject) → 409 and the client refetches.
      // The pre-reject snapshot is what `restoreOrder` reads back so a
      // restored order returns to the EXACT state it had before the reject.
      const fraudSnapshot = buildFraudRejectSnapshot(
        (order as { fraud?: { reviewStatus?: string; level?: string } }).fraud,
      );
      const preActionSnapshot = buildPreActionSnapshot({
        orderStatus: fromStatus,
        automation: (order as { automation?: OrderAutomation }).automation,
        fraud: (order as { fraud?: { reviewStatus?: string; level?: string } }).fraud,
      });
      const updated = await Order.findOneAndUpdate(
        { _id, merchantId, "automation.state": fromState },
        {
          $set: {
            "automation.state": "rejected",
            "automation.preRejectState": fromState,
            "automation.decidedBy": "merchant",
            "automation.decidedAt": now,
            "automation.rejectedAt": now,
            "automation.rejectionReason": (input.reason ?? "").slice(0, 500),
            "order.status": "cancelled",
            "order.preRejectStatus": fromStatus,
            "fraud.preRejectReviewStatus": fraudSnapshot.preRejectReviewStatus,
            "fraud.preRejectLevel": fraudSnapshot.preRejectLevel,
            // Top-level consolidated snapshot — restoreOrder uses this
            // when present (new rejects), falls back to the field-by-
            // field snapshots above on legacy rows.
            preActionSnapshot,
          },
        },
        { new: true, projection: { _id: 1 } },
      ).lean();
      if (!updated) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "order state changed in the background — refresh and retry",
        });
      }
      // Refund the quota slot — the order is no longer countable against
      // the merchant's monthly cap. `restoreOrder` deliberately does NOT
      // re-reserve, so a restore is always allowed regardless of cap.
      await releaseQuota(merchantId, "ordersCreated", 1);
      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "merchant",
        action: "automation.rejected",
        subjectType: "order",
        subjectId: _id,
        meta: {
          from: fromState,
          fromStatus,
          quotaReleased: 1,
          reason: input.reason ?? null,
        },
      });
      return { id: input.id, state: "rejected" as const, idempotent: false };
    }),

  /**
   * Restore a recently merchant-rejected order back to a bookable state.
   *
   * Gates: rejected within RESTORE_WINDOW_MS, decidedBy=merchant, order.status
   * still cancelled. We deliberately do NOT restore system-rejected orders
   * (sweeper auto-expire, fraud-review reject) — those died for a reason and
   * the merchant should re-review the underlying signal first.
   *
   * Atomic: the from-filter pins (state, decidedBy, rejectedAt window) so a
   * concurrent reject re-fire or status walk can't get clobbered.
   */
  restoreOrder: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid order id" });
      }
      const merchantId = merchantObjectId(ctx);
      const _id = new Types.ObjectId(input.id);
      const RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;
      const cutoff = new Date(Date.now() - RESTORE_WINDOW_MS);
      const now = new Date();

      // We need the pre-reject snapshot to restore the EXACT prior state.
      // Read it before re-reserving quota so we can short-circuit on the
      // common no-op cases without burning a quota check.
      const probe = await Order.findOne({ _id, merchantId })
        .select("automation order.status order.preRejectStatus orderNumber preActionSnapshot version")
        .lean<{
          orderNumber?: string;
          version?: number;
          automation?: {
            state?: AutomationState;
            preRejectState?: AutomationState;
            decidedBy?: string;
            rejectedAt?: Date;
          };
          order?: { status?: string; preRejectStatus?: string };
          preActionSnapshot?: {
            order?: { status?: string };
            automation?: { state?: string; subdoc?: Record<string, unknown> };
            fraud?: { reviewStatus?: string | null; level?: string | null };
          };
        }>();
      if (!probe) {
        throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });
      }
      const state = probe.automation?.state;
      if (state !== "rejected") {
        throw new TRPCError({
          code: "CONFLICT",
          message: `order is not in a restorable state (current: ${state ?? "unknown"})`,
        });
      }
      if (probe.automation?.decidedBy !== "merchant") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "only merchant-rejected orders can be restored",
        });
      }
      if (
        !probe.automation?.rejectedAt ||
        new Date(probe.automation.rejectedAt) < cutoff
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `restore window has expired (24h since rejection)`,
        });
      }
      if ((probe.order?.status ?? "cancelled") !== "cancelled") {
        throw new TRPCError({
          code: "CONFLICT",
          message: `order status changed since rejection (current: ${probe.order?.status ?? "unknown"})`,
        });
      }

      // Pre-resolve target values for the audit log + return shape.
      // Inside the aggregation pipeline these are still derived from
      // $preActionSnapshot via $ifNull cascades — these locals are
      // just for the post-write audit/result.
      const snapshotState =
        (probe.preActionSnapshot?.automation?.state as AutomationState | undefined) ??
        (probe.automation?.preRejectState as AutomationState | undefined);
      const targetState: AutomationState = snapshotState ?? "not_evaluated";
      const snapshotStatus = (probe.preActionSnapshot?.order?.status ??
        probe.order?.preRejectStatus) as (typeof ORDER_STATUSES)[number] | undefined;
      const targetStatus = snapshotStatus ?? ("pending" as (typeof ORDER_STATUSES)[number]);

      // Quota: BYPASSED on restore. The order existed before and was
      // counted against the cap until the reject released its slot —
      // putting it back is reversing the merchant's own action and
      // should never fail because of the limit. Side effect: a merchant
      // at-cap who restores will momentarily exceed by 1; subsequent
      // new orders will be blocked until they're back under, which
      // is the correct accounting.
      const reactivationsInc = 1;

      // Aggregation-pipeline update so we can replace the entire
      // `automation` subdoc with $mergeObjects(preRejectAutomation snapshot,
      // restore-time meta). Falls back gracefully if the snapshot is
      // missing (legacy rows from before this PR) — $mergeObjects(null, x)
      // ≡ x, so behaviour degrades to "just set state + decidedBy".
      // Two-stage aggregation pipeline:
      //   1. Splat the rich snapshot (or the legacy fallbacks) into
      //      automation/order/fraud, then overwrite the meta with
      //      restore-time values.
      //   2. Strip every snapshot field so a future reject + restore
      //      round-trips cleanly from the new "current" state.
      //
      // The snapshot path uses $ifNull cascades so legacy rows
      // (rejected before this PR) still restore — they fall back to
      // (preRejectState, preRejectStatus, preRejectReviewStatus,
      // preRejectLevel) which the prior reject paths populated.
      // Optimistic-concurrency: version captured by the probe above. A
      // riskRecompute or stale-sweeper landing between probe and write
      // would have bumped version; the CAS makes us return CONFLICT to
      // the caller (existing error path) rather than overwrite their
      // work. The aggregation pipeline includes a `$add` on version so
      // the bump rides inside the same atomic operation.
      const probeVersion = probe.version ?? 0;
      const restored = await Order.findOneAndUpdate(
        {
          _id,
          merchantId,
          version: probeVersion,
          "automation.state": "rejected",
          "automation.decidedBy": "merchant",
          "automation.rejectedAt": { $gte: cutoff },
          "order.status": "cancelled",
        },
        [
          {
            $set: {
              automation: {
                $mergeObjects: [
                  // Rich snapshot (new path) — automation.subdoc is the
                  // pre-reject subset.
                  { $ifNull: ["$preActionSnapshot.automation.subdoc", {}] },
                  {
                    state: {
                      $ifNull: [
                        "$preActionSnapshot.automation.state",
                        targetState,
                      ],
                    },
                    decidedBy: "merchant",
                    decidedAt: now,
                    reason: "restored by merchant",
                  },
                ],
              },
              "order.status": {
                $ifNull: ["$preActionSnapshot.order.status", targetStatus],
              },
              "fraud.reviewStatus": {
                $ifNull: [
                  "$preActionSnapshot.fraud.reviewStatus",
                  "$fraud.preRejectReviewStatus",
                  "$fraud.reviewStatus",
                ],
              },
              "fraud.level": {
                $ifNull: [
                  "$preActionSnapshot.fraud.level",
                  "$fraud.preRejectLevel",
                  "$fraud.level",
                ],
              },
              version: { $add: [{ $ifNull: ["$version", 0] }, 1] },
            },
          },
          {
            $unset: [
              "automation.preRejectState",
              "automation.rejectedAt",
              "automation.rejectionReason",
              "order.preRejectStatus",
              "fraud.preRejectReviewStatus",
              "fraud.preRejectLevel",
              "preActionSnapshot",
            ],
          },
        ],
        { new: true, projection: { _id: 1, orderNumber: 1, fraud: 1, automation: 1, order: 1 } },
      ).lean<{
        _id: Types.ObjectId;
        orderNumber?: string;
        fraud?: { reviewStatus?: string };
        automation?: { state?: string };
        order?: { status?: string };
      }>();
      void reactivationsInc; // accounting hook — quota is intentionally not re-charged

      if (!restored) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "order state changed in the background — refresh and retry",
        });
      }

      // Rebuild queue state. Idempotent — auto-sms collapses on jobId,
      // booking is intentionally never re-enqueued, and fraud-queue
      // eligibility is derived from fraud.reviewStatus which we just
      // restored. Failure here is best-effort; restore itself succeeded.
      const rebuild = await rebuildQueueState({
        orderId: _id,
        merchantId,
        skipAudit: true,
      }).catch((err) => {
        console.error("[restoreOrder] rebuildQueueState failed:", (err as Error).message);
        return null;
      });

      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "merchant",
        action: "automation.restored",
        subjectType: "order",
        subjectId: _id,
        meta: {
          orderNumber: restored.orderNumber,
          restoredState: targetState,
          restoredStatus: targetStatus,
          restoredFraudReviewStatus: restored.fraud?.reviewStatus ?? null,
          quotaBypassed: true,
          smsEnqueued: rebuild?.smsEnqueued ?? false,
          fraudQueueEligible: rebuild?.fraudQueueEligible ?? false,
        },
      });
      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "system",
        action: "automation.queue_rebuilt",
        subjectType: "order",
        subjectId: _id,
        meta: {
          smsEnqueued: rebuild?.smsEnqueued ?? false,
          bookingEnqueued: false,
          fraudQueueEligible: rebuild?.fraudQueueEligible ?? false,
          reason: rebuild?.reason ?? "rebuild_failed",
        },
      });
      return {
        id: input.id,
        state: targetState,
        orderStatus: targetStatus,
        fraudReviewStatus: restored.fraud?.reviewStatus ?? null,
        smsEnqueued: rebuild?.smsEnqueued ?? false,
        fraudQueueEligible: rebuild?.fraudQueueEligible ?? false,
      };
    }),


  /**
   * Bulk confirm — same per-row semantics as confirmOrder, batched.
   * Capped at 200 ids per call. Returns a per-id status map so the UI
   * can render "12 confirmed, 3 already confirmed, 1 not found".
   */
  bulkConfirmOrders: protectedProcedure
    .input(z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const validIds = input.ids
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));
      if (validIds.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "no valid ids" });
      }
      const orders = await Order.find({ _id: { $in: validIds }, merchantId })
        .select("_id automation order.status")
        .lean();
      const found = new Map(orders.map((o) => [String(o._id), o]));
      const result = {
        confirmed: [] as string[],
        alreadyConfirmed: [] as string[],
        notFound: [] as string[],
        rejectedTooLate: [] as string[],
        // Read said state X was legal; the per-row write found state Y. The
        // background sweeper or a parallel reject got there first.
        conflicted: [] as string[],
        invalid: [] as string[],
      };
      const now = new Date();
      const baseSet = {
        "automation.state": "confirmed" as const,
        "automation.decidedBy": "merchant" as const,
        "automation.decidedAt": now,
        "automation.confirmedAt": now,
        "automation.reason": "bulk confirm",
      };

      // Per-id atomic write — each carries the from-state in the filter so
      // a concurrent sweep / SMS-confirm / reject cannot be silently
      // overwritten by the bulk action.
      await mapWithConcurrency(input.ids, BULK_BOOK_CONCURRENCY, async (id) => {
        if (!Types.ObjectId.isValid(id)) {
          result.invalid.push(id);
          return;
        }
        const o = found.get(id);
        if (!o) {
          result.notFound.push(id);
          return;
        }
        const fromState = (o as { automation?: { state?: AutomationState } }).automation?.state
          ?? "not_evaluated";
        if (fromState === "confirmed" || fromState === "auto_confirmed") {
          result.alreadyConfirmed.push(id);
          return;
        }
        if (!canTransitionAutomation(fromState, "confirmed")) {
          result.rejectedTooLate.push(id);
          return;
        }
        const status = (o as { order?: { status?: string } }).order?.status;
        const set: Record<string, unknown> = { ...baseSet };
        if (status === "pending") set["order.status"] = "confirmed";

        const updated = await Order.findOneAndUpdate(
          { _id: o._id as Types.ObjectId, merchantId, "automation.state": fromState },
          { $set: set },
          { new: true, projection: { _id: 1 } },
        ).lean();
        if (updated) {
          result.confirmed.push(id);
        } else {
          result.conflicted.push(id);
        }
      });

      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "merchant",
        action: "automation.bulk_confirmed",
        subjectType: "merchant",
        subjectId: merchantId,
        meta: {
          count: result.confirmed.length,
          requested: input.ids.length,
          conflicted: result.conflicted.length,
        },
      });
      return result;
    }),

  /**
   * Bulk reject. Same shape as bulkConfirmOrders. Skips orders that have
   * already shipped/in transit/delivered (they cannot be retroactively
   * rejected — the merchant has to cancel via the courier).
   */
  bulkRejectOrders: protectedProcedure
    .input(
      z.object({
        ids: z.array(z.string().min(1)).min(1).max(200),
        reason: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const validIds = input.ids
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));
      if (validIds.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "no valid ids" });
      }
      const orders = await Order.find({ _id: { $in: validIds }, merchantId })
        .select("_id automation order.status fraud.reviewStatus fraud.level")
        .lean();
      const found = new Map(orders.map((o) => [String(o._id), o]));
      const result = {
        rejected: [] as string[],
        alreadyRejected: [] as string[],
        notFound: [] as string[],
        tooLate: [] as string[],
        // Per-id atomic write lost the race — sweep / SMS / parallel
        // confirm-reject moved the state between the read and the write.
        conflicted: [] as string[],
        invalid: [] as string[],
      };
      const now = new Date();

      await mapWithConcurrency(input.ids, BULK_BOOK_CONCURRENCY, async (id) => {
        if (!Types.ObjectId.isValid(id)) {
          result.invalid.push(id);
          return;
        }
        const o = found.get(id);
        if (!o) {
          result.notFound.push(id);
          return;
        }
        const fromState = (o as { automation?: { state?: AutomationState } }).automation?.state
          ?? "not_evaluated";
        if (fromState === "rejected") {
          result.alreadyRejected.push(id);
          return;
        }
        if (!canTransitionAutomation(fromState, "rejected")) {
          result.tooLate.push(id);
          return;
        }
        const status = (o as { order?: { status?: string } }).order?.status;
        if (status && !["pending", "confirmed"].includes(status)) {
          result.tooLate.push(id);
          return;
        }
        const fromStatus = (status ?? "pending") as (typeof ORDER_STATUSES)[number];

        // Snapshot the full pre-action state PER ROW so restoreOrder
        // can return each order to its individual prior values. The
        // baseSet cannot be hoisted because the snapshot differs per
        // row.
        const fraudSnapshot = buildFraudRejectSnapshot(
          (o as { fraud?: { reviewStatus?: string; level?: string } }).fraud,
        );
        const preActionSnapshot = buildPreActionSnapshot({
          orderStatus: fromStatus,
          automation: (o as { automation?: OrderAutomation }).automation,
          fraud: (o as { fraud?: { reviewStatus?: string; level?: string } }).fraud,
        });
        const updated = await Order.findOneAndUpdate(
          { _id: o._id as Types.ObjectId, merchantId, "automation.state": fromState },
          {
            $set: {
              "automation.state": "rejected" as const,
              "automation.preRejectState": fromState,
              "automation.decidedBy": "merchant" as const,
              "automation.decidedAt": now,
              "automation.rejectedAt": now,
              "automation.rejectionReason": (input.reason ?? "bulk reject").slice(0, 500),
              "order.status": "cancelled" as const,
              "order.preRejectStatus": fromStatus,
              "fraud.preRejectReviewStatus": fraudSnapshot.preRejectReviewStatus,
              "fraud.preRejectLevel": fraudSnapshot.preRejectLevel,
              preActionSnapshot,
            },
          },
          { new: true, projection: { _id: 1 } },
        ).lean();
        if (updated) {
          result.rejected.push(id);
        } else {
          result.conflicted.push(id);
        }
      });

      // Release quota in a single batch instead of per-row to keep the write
      // count down. If a sibling row was already rejected (alreadyRejected
      // bucket) we DO NOT release for it — that quota was already returned
      // by the previous reject.
      if (result.rejected.length > 0) {
        await releaseQuota(merchantId, "ordersCreated", result.rejected.length);
      }
      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "merchant",
        action: "automation.bulk_rejected",
        subjectType: "merchant",
        subjectId: merchantId,
        meta: {
          count: result.rejected.length,
          requested: input.ids.length,
          conflicted: result.conflicted.length,
          quotaReleased: result.rejected.length,
          reason: input.reason ?? null,
        },
      });
      return result;
    }),
  bookShipment: billableProcedure
    .input(
      z.object({
        orderId: z.string().min(1),
        courier: z.enum(COURIER_PROVIDER_NAMES),
        weight: z.number().min(0.1).max(30).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const merchantForPlan = await Merchant.findById(merchantId)
        .select("subscription.tier couriers")
        .lean();
      const plan = getPlan(merchantForPlan?.subscription?.tier);
      // Plan-level courier limit: enterprise gets unlimited, others cap at
      // plan.features.courierLimit distinct active couriers.
      const activeCouriers = (merchantForPlan?.couriers ?? []).filter((c) => c.enabled !== false);
      if (
        activeCouriers.length > plan.features.courierLimit &&
        !activeCouriers.slice(0, plan.features.courierLimit).some((c) => c.name === input.courier)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `your ${plan.name} plan allows ${plan.features.courierLimit} couriers — upgrade to use '${input.courier}'`,
        });
      }
      const reservation = await reserveQuota(merchantId, plan, "shipmentsBooked", 1);
      if (!reservation.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `monthly shipment quota reached (${reservation.used}/${reservation.limit}) — upgrade your plan`,
        });
      }
      let result: BookResult;
      try {
        result = await bookSingleShipment({
          merchantId,
          userId: ctx.user.id,
          orderId: input.orderId,
          courier: input.courier,
          weight: input.weight,
        });
      } catch (err) {
        await releaseQuota(merchantId, "shipmentsBooked", 1);
        throw err;
      }
      if (!result.ok) {
        await releaseQuota(merchantId, "shipmentsBooked", 1);
        throw new TRPCError({
          code: result.code ?? "BAD_REQUEST",
          message: result.error ?? "shipment booking failed",
        });
      }
      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "order.booked",
        subjectType: "order",
        subjectId: new Types.ObjectId(result.value.orderId),
        meta: { courier: result.value.courier, trackingNumber: result.value.trackingNumber },
      });
      return result.value;
    }),

  bulkBookShipment: billableProcedure
    .input(
      z.object({
        orderIds: z.array(z.string().min(1)).min(1).max(200),
        courier: z.enum(COURIER_PROVIDER_NAMES),
        weight: z.number().min(0.1).max(30).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const merchantForPlan = await Merchant.findById(merchantId)
        .select("subscription.tier couriers")
        .lean();
      const plan = getPlan(merchantForPlan?.subscription?.tier);
      const activeCouriers = (merchantForPlan?.couriers ?? []).filter((c) => c.enabled !== false);
      if (
        activeCouriers.length > plan.features.courierLimit &&
        !activeCouriers.slice(0, plan.features.courierLimit).some((c) => c.name === input.courier)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `your ${plan.name} plan allows ${plan.features.courierLimit} couriers — upgrade to use '${input.courier}'`,
        });
      }

      const batchSize = input.orderIds.length;
      const reservation = await reserveQuota(merchantId, plan, "shipmentsBooked", batchSize);
      if (!reservation.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `bulk booking exceeds monthly shipment quota (${reservation.used}/${reservation.limit}) — upgrade your plan`,
        });
      }

      let results: Array<{ orderId: string } & BookResult>;
      try {
        results = await mapWithConcurrency(input.orderIds, BULK_BOOK_CONCURRENCY, async (id) => {
          const r = await bookSingleShipment({
            merchantId,
            userId: ctx.user.id,
            orderId: id,
            courier: input.courier,
            weight: input.weight,
          });
          return { orderId: id, ...r };
        });
      } catch (err) {
        await releaseQuota(merchantId, "shipmentsBooked", batchSize);
        throw err;
      }

      const succeeded = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      const refund = batchSize - succeeded.length;
      if (refund > 0) {
        await releaseQuota(merchantId, "shipmentsBooked", refund);
      }

      if (succeeded.length > 0) {
        void writeAudit({
          merchantId,
          actorId: merchantId,
          action: "order.booked",
          subjectType: "merchant",
          subjectId: merchantId,
          meta: {
            bulk: true,
            courier: input.courier,
            total: results.length,
            succeeded: succeeded.length,
            failed: failed.length,
          },
        });
      }

      return {
        total: results.length,
        succeeded: succeeded.length,
        failed: failed.length,
        results: results.map((r) =>
          r.ok
            ? { ok: true as const, ...r.value }
            : { ok: false as const, orderId: r.orderId, error: r.error ?? "unknown", code: r.code },
        ),
      };
    }),

  getTracking: protectedProcedure
    .input(z.object({ orderId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.orderId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid order id" });
      }
      const merchantId = merchantObjectId(ctx);
      const order = await Order.findOne({ _id: new Types.ObjectId(input.orderId), merchantId })
        .select("logistics order.status")
        .lean();
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });
      const trackingNumber = order.logistics?.trackingNumber;
      const courier = order.logistics?.courier;
      if (!trackingNumber || !courier) {
        return { status: order.order?.status ?? "pending", events: [] as TrackingEventView[] };
      }
      const merchant = await Merchant.findById(merchantId)
        .select("couriers")
        .lean();
      const config = merchant?.couriers.find((c) => c.name === courier);
      if (!config || !hasCourierAdapter(config.name as never)) {
        return { trackingNumber, courier, events: [] as TrackingEventView[] };
      }
      try {
        const info = await adapterFor({
          name: config.name as never,
          accountId: config.accountId,
          apiKey: config.apiKey,
          apiSecret: config.apiSecret ?? undefined,
          baseUrl: config.baseUrl ?? undefined,
        }).getTracking(trackingNumber);
        return {
          trackingNumber,
          courier,
          providerStatus: info.providerStatus,
          normalizedStatus: info.normalizedStatus,
          events: info.events.map((e) => ({
            at: e.at,
            description: e.description,
            location: e.location ?? null,
          })),
        };
      } catch (err) {
        return {
          trackingNumber,
          courier,
          error: err instanceof CourierError ? err.message : "tracking lookup failed",
          events: [] as TrackingEventView[],
        };
      }
    }),

  suggestCourier: protectedProcedure
    .input(z.object({ district: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const merchant = await Merchant.findById(ctx.user.id)
        .select("couriers.name couriers.accountId couriers.preferredDistricts")
        .lean();
      if (!merchant) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
      const target = input.district.toLowerCase();
      const ranked = [...merchant.couriers]
        .map((c) => {
          const exact = c.preferredDistricts.some((d) => d.toLowerCase() === target);
          return { name: c.name, accountId: c.accountId, exactMatch: exact };
        })
        .sort((a, b) => Number(b.exactMatch) - Number(a.exactMatch));
      return { district: input.district, couriers: ranked };
    }),
});
