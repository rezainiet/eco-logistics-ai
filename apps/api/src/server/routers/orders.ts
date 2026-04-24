import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";
import {
  COURIER_PROVIDER_NAMES,
  Merchant,
  type MerchantFraudConfig,
  MerchantStats,
  Order,
  ORDER_STATUSES,
} from "@ecom/db";
import {
  billableProcedure,
  protectedProcedure,
  requestIp,
  requestUserAgent,
  router,
} from "../trpc.js";
import { cached, invalidate } from "../../lib/cache.js";
import { filterHash } from "../../lib/hash.js";
import { adapterFor, CourierError, hasCourierAdapter } from "../../lib/couriers/index.js";
import { syncOrderTracking } from "../tracking.js";
import {
  collectRiskHistory,
  collectRiskHistoryBatch,
  computeRisk,
  hashAddress,
  type RiskOptions,
  type RiskResult,
} from "../risk.js";
import { writeAudit } from "../../lib/audit.js";
import { releaseQuota, reserveQuota } from "../../lib/usage.js";
import { getPlan } from "../../lib/plans.js";
import { fireFraudAlert } from "../../lib/alerts.js";
import { enqueueRescore } from "../../workers/riskRecompute.js";

const PHONE_RE = /^\+?[0-9]{7,15}$/;
const COUNT_TTL = 30;
const BULK_CHUNK = 500;
const MAX_BULK_ROWS = 50_000;

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
});

const updateOrderInput = z.object({
  id: z.string().min(1),
  status: z.enum(ORDER_STATUSES).optional(),
  customer: customerSchema.partial().optional(),
  courier: z.string().max(100).optional(),
  trackingNumber: z.string().max(100).optional(),
  rtoReason: z.string().max(500).optional(),
});

function merchantObjectId(ctx: { user: { id: string } }): Types.ObjectId {
  return new Types.ObjectId(ctx.user.id);
}

function generateOrderNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 0xfff).toString(16).toUpperCase().padStart(3, "0");
  return `ORD-${ts}-${rand}`;
}

interface MerchantScoringSnapshot {
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
  return {
    tier: m?.subscription?.tier,
    opts: {
      highCodBdt: fc.highCodThreshold ?? undefined,
      extremeCodBdt: fc.extremeCodThreshold ?? undefined,
      suspiciousDistricts: fc.suspiciousDistricts ?? [],
      blockedPhones: fc.blockedPhones ?? [],
      blockedAddresses: fc.blockedAddresses ?? [],
      velocityThreshold: fc.velocityThreshold ?? 0,
    },
    halfLifeDays: fc.historyHalfLifeDays ?? 30,
    velocityWindowMin: fc.velocityWindowMin ?? 10,
  };
}

async function scoreOrderForCreate(args: {
  merchantId: Types.ObjectId;
  cod: number;
  customer: { name: string; phone: string; address: string; district: string };
  ip?: string;
  addressHash?: string | null;
  scoring?: MerchantScoringSnapshot;
}): Promise<RiskResult & { scoredAt: Date; detected: boolean; addressHash: string | null }> {
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
  return {
    ...result,
    scoredAt: new Date(),
    detected: result.level === "high",
    addressHash,
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
async function bookSingleShipment(args: {
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

  const order = await Order.findOne({
    _id: new Types.ObjectId(args.orderId),
    merchantId: args.merchantId,
  });
  if (!order) return { ok: false, error: "order not found", code: "NOT_FOUND" };

  const prevStatus = order.order.status;
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
  if (!BOOKABLE_STATUSES.has(prevStatus)) {
    return {
      ok: false,
      error: `order is '${prevStatus}' — only pending/confirmed/packed can be booked`,
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

  let awb: Awaited<ReturnType<ReturnType<typeof adapterFor>["createAWB"]>>;
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
    });
  } catch (err) {
    const message = err instanceof CourierError ? err.message : (err as Error).message;
    return { ok: false, error: message };
  }

  // Atomic write — only flip status if still in a bookable state (guards against races).
  const updated = await Order.updateOne(
    {
      _id: order._id,
      merchantId: args.merchantId,
      "order.status": { $in: [...BOOKABLE_STATUSES] },
      "logistics.trackingNumber": { $in: [null, ""] },
    },
    {
      $set: {
        "order.status": "shipped",
        "logistics.courier": args.courier,
        "logistics.trackingNumber": awb.trackingNumber,
        ...(awb.estimatedDeliveryAt
          ? { "logistics.estimatedDelivery": awb.estimatedDeliveryAt }
          : {}),
      },
    },
  );

  if (updated.modifiedCount === 1 && prevStatus !== "shipped") {
    await MerchantStats.updateOne(
      { merchantId: args.merchantId },
      {
        $inc: { [prevStatus]: -1, shipped: 1 },
        $set: { updatedAt: new Date() },
      },
    );
    await invalidate(`dashboard:${args.userId}`);
  }

  return {
    ok: true,
    value: {
      orderId: String(order._id),
      trackingNumber: awb.trackingNumber,
      courier: args.courier,
      status: "shipped",
      estimatedDeliveryAt: awb.estimatedDeliveryAt,
      fee: awb.fee,
    },
  };
}

export const ordersRouter = router({
  createOrder: billableProcedure.input(createOrderInput).mutation(async ({ ctx, input }) => {
    const merchantId = merchantObjectId(ctx);
    const scoring = await loadMerchantScoring(merchantId);
    const plan = getPlan(scoring.tier);
    const reservation = await reserveQuota(merchantId, plan, "ordersCreated", 1);
    if (!reservation.allowed) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `monthly order quota reached (${reservation.used}/${reservation.limit}) — upgrade your plan`,
      });
    }
    try {
      const total = input.total ?? input.items.reduce((s, i) => s + i.price * i.quantity, 0);
      const ip = requestIp(ctx) ?? undefined;
      const userAgent = requestUserAgent(ctx) ?? undefined;
      const addressHash = hashAddress(input.customer.address, input.customer.district);
      const risk = await scoreOrderForCreate({
        merchantId,
        cod: input.cod,
        customer: input.customer,
        ip,
        addressHash,
        scoring,
      });
      const order = await Order.create({
        merchantId,
        orderNumber: input.orderNumber ?? generateOrderNumber(),
        customer: input.customer,
        items: input.items,
        order: { cod: input.cod, total, status: "pending" },
        fraud: fraudDocFromRisk(risk),
        source: {
          ip: ip ?? undefined,
          userAgent,
          addressHash: addressHash ?? undefined,
          channel: "dashboard",
        },
      });
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
      return {
        id: String(order._id),
        orderNumber: order.orderNumber,
        risk: {
          level: risk.level,
          score: risk.riskScore,
          reviewStatus: risk.reviewStatus,
          reasons: risk.reasons,
        },
      };
    } catch (err) {
      await releaseQuota(merchantId, "ordersCreated", 1);
      throw err;
    }
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

  bulkUpload: billableProcedure
    .input(z.object({ csv: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      let rows: Record<string, string>[];
      try {
        rows = parseCsv(input.csv, { columns: true, skip_empty_lines: true, trim: true });
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `csv parse error: ${(err as Error).message}`,
        });
      }
      if (rows.length > MAX_BULK_ROWS) {
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message: `max ${MAX_BULK_ROWS} rows per upload — split the file or use the async upload endpoint`,
        });
      }

      const merchantId = merchantObjectId(ctx);
      const scoring = await loadMerchantScoring(merchantId);
      const uploaderIp = requestIp(ctx) ?? undefined;
      const uploaderUA = requestUserAgent(ctx) ?? undefined;

      interface StagedRow {
        rowNumber: number;
        customer: { name: string; phone: string; address: string; district: string };
        quantity: number;
        price: number;
        cod: number;
        itemName: string;
        orderNumber: string;
        addressHash: string | null;
      }

      const staged: StagedRow[] = [];
      const errors: Array<{ row: number; error: string }> = [];

      rows.forEach((row, idx) => {
        const quantity = Number(row.quantity ?? "1");
        const price = Number(row.price);
        const cod = Number(row.cod ?? row.price);
        if (!row.customerName || !row.customerPhone || !row.customerAddress || !row.customerDistrict) {
          errors.push({ row: idx + 2, error: "missing required customer fields" });
          return;
        }
        if (!PHONE_RE.test(row.customerPhone)) {
          errors.push({ row: idx + 2, error: "invalid phone" });
          return;
        }
        if (Number.isNaN(price) || Number.isNaN(cod) || Number.isNaN(quantity)) {
          errors.push({ row: idx + 2, error: "invalid number" });
          return;
        }
        const customer = {
          name: row.customerName,
          phone: row.customerPhone,
          address: row.customerAddress,
          district: row.customerDistrict,
        };
        staged.push({
          rowNumber: idx + 2,
          customer,
          quantity,
          price,
          cod,
          itemName: row.itemName || "Item",
          orderNumber: row.orderNumber || generateOrderNumber(),
          addressHash: hashAddress(customer.address, customer.district),
        });
      });

      if (staged.length === 0) {
        return { inserted: 0, errors, totalRows: rows.length };
      }

      // --- Batch-compute real fraud history for every phone + address in the
      // upload. Keeps the full bulk path at O(phones + addresses) lookups
      // instead of O(rows), and closes the historical-bypass gap that existed
      // in v1.
      const phoneSet = new Set<string>();
      const addressSet = new Set<string>();
      for (const s of staged) {
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
      for (const s of staged) {
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

      for (let i = 0; i < staged.length; i++) {
        const s = staged[i]!;
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
          totalRows: rows.length,
          inserted,
          flagged,
          rejected: errors.length,
          ip: uploaderIp ?? null,
        },
      });

      return { inserted, errors, totalRows: rows.length, flagged };
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
