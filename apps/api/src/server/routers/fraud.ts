import { Types } from "mongoose";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  Merchant,
  type MerchantFraudConfig,
  MerchantStats,
  Order,
  REVIEW_STATUSES,
} from "@ecom/db";
import { protectedProcedure, router } from "../trpc.js";
import { invalidate } from "../../lib/cache.js";
import { writeAudit } from "../../lib/audit.js";
import { collectRiskHistory, computeRisk, hashAddress, type RiskOptions } from "../risk.js";
import { getPlan } from "../../lib/plans.js";
import { bumpUsage, checkQuota } from "../../lib/usage.js";
import { fireFraudAlert } from "../../lib/alerts.js";
import { enqueueRescore } from "../../workers/riskRecompute.js";

const REVIEW_NOTE_MAX = 1000;

const queueFilter = z.enum(["pending_call", "no_answer", "all_open"]).default("all_open");

const reviewActionInput = z.object({
  id: z.string().min(1),
  notes: z.string().max(REVIEW_NOTE_MAX).optional(),
});

type FraudDoc = {
  _id: Types.ObjectId;
  merchantId: Types.ObjectId;
  orderNumber: string;
  customer: { name: string; phone: string; address: string; district: string };
  order: { cod: number; total: number; status: string };
  fraud?: {
    riskScore?: number;
    level?: "low" | "medium" | "high";
    reasons?: string[];
    signals?: Array<{ key: string; weight: number; detail?: string }>;
    reviewStatus?: (typeof REVIEW_STATUSES)[number];
    reviewedAt?: Date;
    reviewNotes?: string;
    scoredAt?: Date;
  };
  createdAt: Date;
};

function merchantObjectId(ctx: { user: { id: string } }): Types.ObjectId {
  return new Types.ObjectId(ctx.user.id);
}

function parseObjectId(id: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "invalid order id" });
  }
  return new Types.ObjectId(id);
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Gate fraud-review access on the merchant's plan. Starter doesn't get the
 * feature at all; Growth/Scale/Enterprise do. Admins bypass.
 */
async function ensureFraudAccess(
  merchantId: Types.ObjectId,
  role: "merchant" | "admin" | "agent",
): Promise<void> {
  if (role === "admin") return;
  const m = await Merchant.findById(merchantId).select("subscription.tier").lean();
  const plan = getPlan(m?.subscription?.tier);
  if (!plan.features.fraudReview) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `fraud review is not available on the ${plan.name} plan — upgrade to Growth or higher`,
    });
  }
}

export const fraudRouter = router({
  /**
   * Queue of orders needing human verification. Default view merges
   * pending_call + no_answer (both block booking). Agent filters by case type.
   */
  listPendingReviews: protectedProcedure
    .input(
      z
        .object({
          cursor: z.string().nullable().default(null),
          limit: z.number().int().min(1).max(100).default(25),
          filter: queueFilter,
        })
        .default({ cursor: null, limit: 25, filter: "all_open" }),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      await ensureFraudAccess(merchantId, ctx.user.role);
      const statusMatch =
        input.filter === "all_open"
          ? { $in: ["pending_call", "no_answer"] }
          : input.filter;

      const findQuery: Record<string, unknown> = {
        merchantId,
        "fraud.reviewStatus": statusMatch,
      };
      if (input.cursor && Types.ObjectId.isValid(input.cursor)) {
        findQuery._id = { $lt: new Types.ObjectId(input.cursor) };
      }

      const items = await Order.find(findQuery)
        .sort({ "fraud.riskScore": -1, _id: -1 })
        .limit(input.limit + 1)
        .lean<FraudDoc[]>();

      const hasMore = items.length > input.limit;
      const page = hasMore ? items.slice(0, -1) : items;
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? String(last._id) : null;

      const total = await Order.countDocuments({
        merchantId,
        "fraud.reviewStatus": statusMatch,
      });

      return {
        total,
        nextCursor,
        hasMore,
        items: page.map((o) => ({
          id: String(o._id),
          orderNumber: o.orderNumber,
          customer: {
            name: o.customer.name,
            phone: o.customer.phone,
            district: o.customer.district,
          },
          cod: o.order.cod,
          total: o.order.total,
          riskScore: o.fraud?.riskScore ?? 0,
          level: o.fraud?.level ?? "low",
          reviewStatus: o.fraud?.reviewStatus ?? "not_required",
          reasons: o.fraud?.reasons ?? [],
          scoredAt: o.fraud?.scoredAt ?? null,
          createdAt: o.createdAt,
        })),
      };
    }),

  /**
   * Full order detail for the agent review pane — includes every signal
   * so the agent can explain the risk call to the customer on the phone.
   */
  getReviewOrder: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const _id = parseObjectId(input.id);
      const order = await Order.findOne({ _id, merchantId }).lean<FraudDoc>();
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });

      return {
        id: String(order._id),
        orderNumber: order.orderNumber,
        customer: order.customer,
        cod: order.order.cod,
        total: order.order.total,
        status: order.order.status,
        fraud: {
          riskScore: order.fraud?.riskScore ?? 0,
          level: order.fraud?.level ?? "low",
          reasons: order.fraud?.reasons ?? [],
          signals: order.fraud?.signals ?? [],
          reviewStatus: order.fraud?.reviewStatus ?? "not_required",
          reviewedAt: order.fraud?.reviewedAt ?? null,
          reviewNotes: order.fraud?.reviewNotes ?? null,
          scoredAt: order.fraud?.scoredAt ?? null,
        },
        createdAt: order.createdAt,
      };
    }),

  /** Agent confirmed identity/intent → clears the review gate. */
  markVerified: protectedProcedure
    .input(reviewActionInput)
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      await ensureFraudAccess(merchantId, ctx.user.role);
      const plan = getPlan((await Merchant.findById(merchantId).select("subscription.tier").lean())?.subscription?.tier);
      const quota = await checkQuota(merchantId, plan, "fraudReviewsUsed");
      if (!quota.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `monthly fraud review quota reached (${quota.used}/${quota.limit}) — upgrade your plan`,
        });
      }
      const _id = parseObjectId(input.id);
      const now = new Date();
      const updated = await Order.findOneAndUpdate(
        {
          _id,
          merchantId,
          "fraud.reviewStatus": { $in: ["pending_call", "no_answer"] },
        },
        {
          $set: {
            "fraud.reviewStatus": "verified",
            "fraud.reviewedAt": now,
            "fraud.reviewedBy": merchantId,
            ...(input.notes ? { "fraud.reviewNotes": input.notes } : {}),
          },
        },
        { new: true },
      ).lean<FraudDoc>();
      if (!updated) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "order is not awaiting review",
        });
      }
      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "agent",
        action: "review.verified",
        subjectType: "order",
        subjectId: updated._id,
        meta: { notes: input.notes ?? null, riskScore: updated.fraud?.riskScore ?? 0 },
      });
      await bumpUsage(merchantId, "fraudReviewsUsed", 1);
      await invalidate(`dashboard:${ctx.user.id}`);
      return { id: String(updated._id), reviewStatus: "verified" as const };
    }),

  /**
   * Agent rejected the order → also cancels the underlying order so the
   * merchant's stats + downstream reporting stay consistent. One write,
   * then one stats adjustment.
   */
  markRejected: protectedProcedure
    .input(reviewActionInput)
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      await ensureFraudAccess(merchantId, ctx.user.role);
      const _id = parseObjectId(input.id);
      const now = new Date();
      const prior = await Order.findOne({ _id, merchantId })
        .select("order.status order.cod fraud.reviewStatus")
        .lean<{ order: { status: string; cod: number }; fraud?: { reviewStatus?: string } }>();
      if (!prior) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });
      const reviewStatus = prior.fraud?.reviewStatus ?? "not_required";
      if (!["pending_call", "no_answer"].includes(reviewStatus)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `order is not awaiting review (${reviewStatus})`,
        });
      }

      const prevStatus = prior.order.status;
      const updated = await Order.findOneAndUpdate(
        {
          _id,
          merchantId,
          "fraud.reviewStatus": { $in: ["pending_call", "no_answer"] },
        },
        {
          $set: {
            "fraud.reviewStatus": "rejected",
            "fraud.reviewedAt": now,
            "fraud.reviewedBy": merchantId,
            "order.status": "cancelled",
            ...(input.notes ? { "fraud.reviewNotes": input.notes } : {}),
          },
        },
        { new: true },
      ).lean<FraudDoc>();
      if (!updated) {
        throw new TRPCError({ code: "CONFLICT", message: "order state changed — retry" });
      }

      if (prevStatus !== "cancelled") {
        await MerchantStats.updateOne(
          { merchantId },
          {
            $inc: { [prevStatus]: -1, cancelled: 1 },
            $set: { updatedAt: new Date() },
          },
        );
      }

      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "agent",
        action: "review.rejected",
        subjectType: "order",
        subjectId: updated._id,
        meta: {
          notes: input.notes ?? null,
          riskScore: updated.fraud?.riskScore ?? 0,
          codSaved: prior.order.cod,
        },
      });
      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "agent",
        action: "order.cancelled",
        subjectType: "order",
        subjectId: updated._id,
        meta: { reason: "review_rejected" },
      });

      await bumpUsage(merchantId, "fraudReviewsUsed", 1);
      await invalidate(`dashboard:${ctx.user.id}`);

      // A confirmed rejection is the strongest possible fraud signal for the
      // same phone — refresh every open order from this customer.
      void enqueueRescore({
        merchantId: String(merchantId),
        phone: updated.customer.phone,
        trigger: "review.rejected",
        triggerOrderId: String(updated._id),
      });

      return {
        id: String(updated._id),
        reviewStatus: "rejected" as const,
        orderStatus: "cancelled" as const,
        codSaved: prior.order.cod,
      };
    }),

  /** Agent tried to call, no pickup — stays in queue, gets flagged separately. */
  markNoAnswer: protectedProcedure
    .input(reviewActionInput)
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      await ensureFraudAccess(merchantId, ctx.user.role);
      const _id = parseObjectId(input.id);
      const now = new Date();
      const updated = await Order.findOneAndUpdate(
        {
          _id,
          merchantId,
          "fraud.reviewStatus": { $in: ["pending_call", "no_answer"] },
        },
        {
          $set: {
            "fraud.reviewStatus": "no_answer",
            "fraud.reviewedAt": now,
            "fraud.reviewedBy": merchantId,
            ...(input.notes ? { "fraud.reviewNotes": input.notes } : {}),
          },
        },
        { new: true },
      ).lean<FraudDoc>();
      if (!updated) {
        throw new TRPCError({ code: "CONFLICT", message: "order is not awaiting review" });
      }
      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "agent",
        action: "review.no_answer",
        subjectType: "order",
        subjectId: updated._id,
        meta: { notes: input.notes ?? null },
      });

      // Unreachable customer on one order raises the unreachable_history
      // weight on every other open order. Queue a rescore so agents see the
      // updated scores the next time they load the queue.
      void enqueueRescore({
        merchantId: String(merchantId),
        phone: updated.customer.phone,
        trigger: "review.no_answer",
        triggerOrderId: String(updated._id),
      });

      return { id: String(updated._id), reviewStatus: "no_answer" as const };
    }),

  /**
   * Re-run scoring on an existing order — useful after bulk uploads (which
   * skip DB history for speed) or when the merchant wants a second opinion.
   * Does not overwrite reviewStatus if the order is already past review.
   */
  rescoreOrder: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      await ensureFraudAccess(merchantId, ctx.user.role);
      const _id = parseObjectId(input.id);
      const order = await Order.findOne({ _id, merchantId })
        .select("customer order.cod fraud.reviewStatus fraud.level source.ip source.addressHash orderNumber")
        .lean<{
          orderNumber: string;
          customer: { name: string; phone: string; address?: string; district: string };
          order: { cod: number };
          fraud?: {
            reviewStatus?: (typeof REVIEW_STATUSES)[number];
            level?: "low" | "medium" | "high";
          };
          source?: { ip?: string; addressHash?: string };
        }>();
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });

      const merchant = (await Merchant.findById(merchantId)
        .select("fraudConfig")
        .lean()) as { fraudConfig?: MerchantFraudConfig | null } | null;
      const fc: MerchantFraudConfig = merchant?.fraudConfig ?? {};
      const opts: RiskOptions = {
        highCodBdt: fc.highCodThreshold ?? undefined,
        extremeCodBdt: fc.extremeCodThreshold ?? undefined,
        suspiciousDistricts: fc.suspiciousDistricts ?? [],
        blockedPhones: fc.blockedPhones ?? [],
        blockedAddresses: fc.blockedAddresses ?? [],
        velocityThreshold: fc.velocityThreshold ?? 0,
      };
      const addressHash =
        order.source?.addressHash ??
        hashAddress(order.customer.address ?? "", order.customer.district ?? "");

      const history = await collectRiskHistory({
        merchantId,
        phone: order.customer.phone,
        ip: order.source?.ip,
        addressHash,
        excludeOrderId: _id,
        halfLifeDays: fc.historyHalfLifeDays ?? 30,
        velocityWindowMin: fc.velocityWindowMin ?? 10,
      });
      const risk = computeRisk(
        {
          cod: order.order.cod,
          customer: order.customer,
          ip: order.source?.ip,
          addressHash,
        },
        history,
        opts,
      );

      const terminalStatuses: Array<(typeof REVIEW_STATUSES)[number]> = [
        "verified",
        "rejected",
      ];
      const currentReview = order.fraud?.reviewStatus ?? "not_required";
      const nextReview = terminalStatuses.includes(currentReview)
        ? currentReview
        : risk.reviewStatus;

      await Order.updateOne(
        { _id, merchantId },
        {
          $set: {
            "fraud.detected": risk.level === "high",
            "fraud.riskScore": risk.riskScore,
            "fraud.level": risk.level,
            "fraud.reasons": risk.reasons,
            "fraud.signals": risk.signals,
            "fraud.reviewStatus": nextReview,
            "fraud.scoredAt": new Date(),
          },
        },
      );

      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "risk.recomputed",
        subjectType: "order",
        subjectId: _id,
        meta: {
          level: risk.level,
          score: risk.riskScore,
          reasons: risk.reasons,
          trigger: "manual",
        },
      });

      // If the manual rescore just lit up HIGH on a previously non-high order
      // (and review isn't already terminal), treat it like a fresh arrival.
      if (
        risk.level === "high" &&
        order.fraud?.level !== "high" &&
        !terminalStatuses.includes(currentReview)
      ) {
        await fireFraudAlert({
          merchantId,
          orderId: _id,
          orderNumber: order.orderNumber,
          phone: order.customer.phone,
          riskScore: risk.riskScore,
          level: risk.level,
          reasons: risk.reasons,
          kind: "fraud.rescored_high",
        });
      }

      return {
        id: String(_id),
        riskScore: risk.riskScore,
        level: risk.level,
        reviewStatus: nextReview,
        reasons: risk.reasons,
      };
    }),

  /**
   * Dashboard counters for the fraud analytics cards: today's risky orders,
   * verified, rejected, and estimated COD saved (sum of rejected COD).
   */
  getReviewStats: protectedProcedure
    .input(
      z
        .object({ days: z.number().int().min(1).max(90).default(7) })
        .default({ days: 7 }),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const since = new Date();
      since.setDate(since.getDate() - input.days);
      const today = startOfToday();

      const [result] = await Order.aggregate<{
        today: Array<{ risky: number; verified: number; rejected: number; codSaved: number }>;
        window: Array<{ risky: number; verified: number; rejected: number; codSaved: number }>;
        queue: Array<{ pending: number; noAnswer: number }>;
      }>([
        { $match: { merchantId } },
        {
          $facet: {
            today: [
              { $match: { createdAt: { $gte: today } } },
              {
                $group: {
                  _id: null,
                  risky: {
                    $sum: { $cond: [{ $eq: ["$fraud.level", "high"] }, 1, 0] },
                  },
                  verified: {
                    $sum: { $cond: [{ $eq: ["$fraud.reviewStatus", "verified"] }, 1, 0] },
                  },
                  rejected: {
                    $sum: { $cond: [{ $eq: ["$fraud.reviewStatus", "rejected"] }, 1, 0] },
                  },
                  codSaved: {
                    $sum: {
                      $cond: [
                        { $eq: ["$fraud.reviewStatus", "rejected"] },
                        "$order.cod",
                        0,
                      ],
                    },
                  },
                },
              },
            ],
            window: [
              { $match: { createdAt: { $gte: since } } },
              {
                $group: {
                  _id: null,
                  risky: {
                    $sum: { $cond: [{ $eq: ["$fraud.level", "high"] }, 1, 0] },
                  },
                  verified: {
                    $sum: { $cond: [{ $eq: ["$fraud.reviewStatus", "verified"] }, 1, 0] },
                  },
                  rejected: {
                    $sum: { $cond: [{ $eq: ["$fraud.reviewStatus", "rejected"] }, 1, 0] },
                  },
                  codSaved: {
                    $sum: {
                      $cond: [
                        { $eq: ["$fraud.reviewStatus", "rejected"] },
                        "$order.cod",
                        0,
                      ],
                    },
                  },
                },
              },
            ],
            queue: [
              {
                $match: {
                  "fraud.reviewStatus": { $in: ["pending_call", "no_answer"] },
                },
              },
              {
                $group: {
                  _id: null,
                  pending: {
                    $sum: { $cond: [{ $eq: ["$fraud.reviewStatus", "pending_call"] }, 1, 0] },
                  },
                  noAnswer: {
                    $sum: { $cond: [{ $eq: ["$fraud.reviewStatus", "no_answer"] }, 1, 0] },
                  },
                },
              },
            ],
          },
        },
      ]);

      const today0 = result?.today?.[0] ?? { risky: 0, verified: 0, rejected: 0, codSaved: 0 };
      const window0 = result?.window?.[0] ?? { risky: 0, verified: 0, rejected: 0, codSaved: 0 };
      const queue0 = result?.queue?.[0] ?? { pending: 0, noAnswer: 0 };

      return {
        days: input.days,
        today: today0,
        window: window0,
        queue: queue0,
      };
    }),
});
