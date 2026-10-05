import { Types } from "mongoose";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  AuditLog,
  CustomerReliability,
  Merchant,
  type MerchantFraudConfig,
  MerchantStats,
  Order,
  type OrderAutomation,
  REVIEW_STATUSES,
} from "@ecom/db";
import { merchantObjectId, protectedProcedure, router } from "../trpc.js";
import { invalidate } from "../../lib/cache.js";
import { writeAudit } from "../../lib/audit.js";
import { syncOrderInventory } from "../../lib/inventory.js";
import { collectRiskHistory, computeRisk, hashAddress, type RiskOptions } from "../risk.js";
import { getPlan } from "../../lib/plans.js";
import { releaseQuota, reserveQuota } from "../../lib/usage.js";
import {
  buildFraudRejectSnapshot,
  buildPreActionSnapshot,
} from "../../lib/rejectSnapshot.js";
import { fireFraudAlert } from "../../lib/alerts.js";
import {
  hashPhoneForNetwork,
  lookupNetworkRisk,
} from "../../lib/fraud-network.js";
import { enqueueRescore } from "../../workers/riskRecompute.js";
import {
  NO_ANSWER_REASON_CODES,
  REJECT_REASON_CODES,
  REQUEST_REASON_CODES,
  VERIFY_REASON_CODES,
  reviewStatusAfterRescore,
  type ReviewReasonCode,
} from "../../lib/verification.js";

const REVIEW_NOTE_MAX = 1000;

const queueFilter = z
  .enum(["pending_call", "no_answer", "optional_review", "all_open", "watch"])
  .default("all_open");

const reviewActionInput = z.object({
  id: z.string().min(1),
  notes: z.string().max(REVIEW_NOTE_MAX).optional(),
  /** Optional structured reason (lib/verification.ts); validated per action. */
  reasonCode: z.string().max(40).optional(),
});

/** Validate an optional reason code against the action's list. */
function reasonFor(allowed: readonly string[], code: string | undefined): ReviewReasonCode | undefined {
  if (code === undefined) return undefined;
  if (!allowed.includes(code)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `unknown reason code '${code}'` });
  }
  return code as ReviewReasonCode;
}

/** Order states from which courier dispatch has not started yet. */
const PRE_DISPATCH_STATUSES = ["pending", "confirmed", "packed"] as const;

/**
 * Audit actions that make up an order's verification history: scoring,
 * the review decisions, the confirmation flow and the cancel/restore pair.
 */
const VERIFICATION_HISTORY_ACTIONS = [
  "risk.recomputed",
  "review.requested",
  "review.verified",
  "review.rejected",
  "review.no_answer",
  "review.reopened",
  "automation.confirmed",
  "automation.rejected",
  "automation.sms_confirm",
  "automation.auto_expired",
  "automation.escalated_no_reply",
  "automation.auto_booked",
  "order.cancelled",
  "order.restored",
] as const;

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
    confidence?: number;
    confidenceLabel?: "Safe" | "Verify" | "Risky";
    hardBlocked?: boolean;
    smsFeedback?: "confirmed" | "rejected" | "no_reply";
  };
  createdAt: Date;
};

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
 * This merchant's *own* delivery history with a buyer phone, summarised
 * for the review pane. Read straight off the CustomerReliability
 * aggregate (race-safe, indexed on `{ merchantId, phoneHash }`) — these
 * are the same real delivered/RTO/cancelled counters the risk engine
 * already trusts, NOT a re-derivation. For a COD operator deciding
 * whether to spend a phone call, "you've delivered to this customer 4
 * times, 0 returns" is the single most decisive 5-second signal, and
 * today it isn't surfaced anywhere.
 */
export type CustomerHistorySummary = {
  delivered: number;
  rto: number;
  cancelled: number;
  resolved: number;
  isRepeat: boolean;
  /** Plain-language trust band. "new" = no resolved history with you. */
  label: "new" | "trusted" | "mixed" | "risky";
};

function summariseCustomerHistory(counts: {
  deliveredCount?: number;
  rtoCount?: number;
  cancelledCount?: number;
} | null): CustomerHistorySummary {
  const delivered = Math.max(0, counts?.deliveredCount ?? 0);
  const rto = Math.max(0, counts?.rtoCount ?? 0);
  const cancelled = Math.max(0, counts?.cancelledCount ?? 0);
  const resolved = delivered + rto + cancelled;
  let label: CustomerHistorySummary["label"];
  if (resolved === 0) {
    label = "new";
  } else if (rto >= 2 || rto / resolved > 0.4) {
    // Two confirmed returns, or returns on >40% of resolved orders, is
    // a hard "this buyer costs you money" pattern.
    label = "risky";
  } else if (delivered >= 3 && rto === 0) {
    label = "trusted";
  } else {
    label = "mixed";
  }
  return { delivered, rto, cancelled, resolved, isRepeat: resolved > 0, label };
}

export type RecommendedAction = {
  action: "ship" | "verify_call" | "reject_likely";
  /** One short merchant-language sentence. No model jargon. */
  hint: string;
};

/**
 * A single explicit "what should I do" call, derived only from signals
 * the merchant can already see (risk level, the customer's SMS reply,
 * this store's own history, the cross-merchant network). Deliberately
 * conservative: it never auto-decides, it only points the operator at
 * the fastest correct next step.
 */
function deriveRecommendedAction(input: {
  level: "low" | "medium" | "high";
  hardBlocked: boolean;
  smsFeedback: "confirmed" | "rejected" | "no_reply" | null;
  history: CustomerHistorySummary;
  networkRtoRate: number;
  networkRtoCount: number;
}): RecommendedAction {
  if (input.hardBlocked || input.smsFeedback === "rejected") {
    return {
      action: "reject_likely",
      hint: "Customer or rule already rejected this — reject unless you can reach them.",
    };
  }
  if (input.history.label === "risky" || input.networkRtoCount >= 3) {
    return {
      action: "reject_likely",
      hint:
        input.history.label === "risky"
          ? `This buyer has ${input.history.rto} return(s) with your store — call before shipping or reject.`
          : "This number has repeated returns across stores — call before shipping or reject.",
    };
  }
  if (input.smsFeedback === "confirmed" && input.level !== "high") {
    return {
      action: "ship",
      hint: "Customer confirmed by SMS and risk is acceptable — safe to book the courier.",
    };
  }
  if (input.history.label === "trusted" && input.level !== "high") {
    return {
      action: "ship",
      hint: `Repeat customer — ${input.history.delivered} delivered, 0 returns with your store. Safe to book.`,
    };
  }
  return {
    action: "verify_call",
    hint:
      input.level === "high"
        ? "High risk and unconfirmed — a quick verification call is worth it before booking."
        : "Unconfirmed — one short call confirms intent before you commit the courier cost.",
  };
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

/**
 * Review-queue cursor (audit OV-2). The queue is ordered by
 * (fraud.riskScore DESC, _id DESC); the cursor must carry BOTH values of
 * the last row, otherwise "_id < last" skips lower-scored orders with a
 * newer _id. Encoded as opaque base64url JSON. A missing/null score sorts
 * last in descending order, so it is carried as null.
 */
export interface ReviewCursor {
  s: number | null;
  id: string;
}

export function encodeReviewCursor(c: ReviewCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeReviewCursor(raw: string): ReviewCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<ReviewCursor>;
    const sOk = parsed.s === null || (typeof parsed.s === "number" && Number.isFinite(parsed.s));
    if (!sOk || typeof parsed.id !== "string" || !Types.ObjectId.isValid(parsed.id)) return null;
    return { s: parsed.s as number | null, id: parsed.id };
  } catch {
    return null;
  }
}

/** Mongo filter for "strictly after `c`" in (riskScore DESC, _id DESC) order. */
export function reviewCursorFilter(c: ReviewCursor): Record<string, unknown> {
  const id = new Types.ObjectId(c.id);
  if (c.s === null) {
    // Only score-less rows remain, ordered by _id DESC.
    return { "fraud.riskScore": null, _id: { $lt: id } };
  }
  return {
    $or: [
      { "fraud.riskScore": { $lt: c.s } },
      { "fraud.riskScore": c.s, _id: { $lt: id } },
      // Score-less rows sort after every scored row.
      { "fraud.riskScore": null },
    ],
  };
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
      // Queue tabs:
      //   all_open       → must-review (HIGH) only — keeps the agent's queue tight
      //   pending_call   → just-arrived HIGH
      //   no_answer      → HIGH that we tried to call and failed
      //   watch          → just MEDIUM (optional_review) — the watch tab
      //   optional_review → alias for "watch", kept for callers using the
      //                     literal review-status name
      const statusMatch =
        input.filter === "all_open"
          ? { $in: ["pending_call", "no_answer"] }
          : input.filter === "watch"
            ? "optional_review"
            : input.filter;

      const findQuery: Record<string, unknown> = {
        merchantId,
        "fraud.reviewStatus": statusMatch,
      };
      if (input.cursor) {
        let cursor = decodeReviewCursor(input.cursor);
        if (!cursor && Types.ObjectId.isValid(input.cursor)) {
          // Legacy cursor (bare _id from an older client): recover the
          // score of that row — this merchant's rows only.
          const prev = await Order.findOne({ _id: new Types.ObjectId(input.cursor), merchantId })
            .select("fraud.riskScore")
            .lean<{ fraud?: { riskScore?: number | null } }>();
          if (prev) cursor = { s: prev.fraud?.riskScore ?? null, id: input.cursor };
        }
        if (!cursor) throw new TRPCError({ code: "BAD_REQUEST", message: "invalid cursor" });
        Object.assign(findQuery, reviewCursorFilter(cursor));
      }

      const items = await Order.find(findQuery)
        .sort({ "fraud.riskScore": -1, _id: -1 })
        .limit(input.limit + 1)
        .lean<FraudDoc[]>();

      const hasMore = items.length > input.limit;
      const page = hasMore ? items.slice(0, -1) : items;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeReviewCursor({ s: last.fraud?.riskScore ?? null, id: String(last._id) })
          : null;

      const total = await Order.countDocuments({
        merchantId,
        "fraud.reviewStatus": statusMatch,
      });

      // One batched read of this merchant's own history for every phone
      // on the page (indexed on { merchantId, phoneHash }) — turns the
      // queue from "wall of scores" into "who is this buyer to me".
      const phoneHashByOrder = new Map<string, string>();
      for (const o of page) {
        const h = hashPhoneForNetwork(o.customer.phone);
        if (h) phoneHashByOrder.set(String(o._id), h);
      }
      const relRows = await CustomerReliability.find({
        merchantId,
        phoneHash: { $in: [...new Set(phoneHashByOrder.values())] },
      })
        .select("phoneHash deliveredCount rtoCount cancelledCount")
        .lean<
          Array<{
            phoneHash: string;
            deliveredCount?: number;
            rtoCount?: number;
            cancelledCount?: number;
          }>
        >();
      const relByHash = new Map(relRows.map((r) => [r.phoneHash, r]));

      return {
        total,
        nextCursor,
        hasMore,
        items: page.map((o) => {
          const history = summariseCustomerHistory(
            relByHash.get(phoneHashByOrder.get(String(o._id)) ?? "") ?? null,
          );
          const level = o.fraud?.level ?? "low";
          const smsFeedback = o.fraud?.smsFeedback ?? null;
          const recommended = deriveRecommendedAction({
            level,
            hardBlocked: o.fraud?.hardBlocked ?? false,
            smsFeedback,
            history,
            networkRtoRate: 0,
            networkRtoCount: 0,
          });
          return {
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
          confidence: o.fraud?.confidence ?? Math.max(0, 100 - (o.fraud?.riskScore ?? 0)),
          confidenceLabel:
            o.fraud?.confidenceLabel ??
            (o.fraud?.level === "high"
              ? "Risky"
              : o.fraud?.level === "medium"
                ? "Verify"
                : "Safe"),
          hardBlocked: o.fraud?.hardBlocked ?? false,
          smsFeedback: o.fraud?.smsFeedback ?? null,
          customerHistory: history,
          recommendedAction: recommended,
          };
        }),
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
      // Same plan gate as the rest of the verification surface (audit OV-1):
      // the detail includes the cross-merchant network-risk read.
      await ensureFraudAccess(merchantId, ctx.user.role);
      const _id = parseObjectId(input.id);
      const order = await Order.findOne({ _id, merchantId }).lean<FraudDoc>();
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });

      // Cross-merchant network read — only aggregate counts surface, never
      // merchant identities. Returns an "EMPTY"-shaped object when the
      // fingerprint has no signal yet (pre-network or singleton merchant).
      const phoneHash = hashPhoneForNetwork(order.customer.phone);
      const { hashAddress } = await import("../risk.js");
      const addressHash = hashAddress(order.customer.address, order.customer.district);
      const network = await lookupNetworkRisk({
        phoneHash,
        addressHash,
        merchantId,
      });

      const rel = await CustomerReliability.findOne({ merchantId, phoneHash })
        .select("deliveredCount rtoCount cancelledCount firstOutcomeAt lastOutcomeAt")
        .lean<{
          deliveredCount?: number;
          rtoCount?: number;
          cancelledCount?: number;
          firstOutcomeAt?: Date;
          lastOutcomeAt?: Date;
        } | null>();
      const customerHistory = summariseCustomerHistory(rel);
      const recommendedAction = deriveRecommendedAction({
        level: order.fraud?.level ?? "low",
        hardBlocked: order.fraud?.hardBlocked ?? false,
        smsFeedback: order.fraud?.smsFeedback ?? null,
        history: customerHistory,
        networkRtoRate: network.rtoRate ?? 0,
        networkRtoCount: network.rtoCount ?? 0,
      });

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
          confidence:
            order.fraud?.confidence ?? Math.max(0, 100 - (order.fraud?.riskScore ?? 0)),
          confidenceLabel:
            order.fraud?.confidenceLabel ??
            (order.fraud?.level === "high"
              ? "Risky"
              : order.fraud?.level === "medium"
                ? "Verify"
                : "Safe"),
          hardBlocked: order.fraud?.hardBlocked ?? false,
          smsFeedback: order.fraud?.smsFeedback ?? null,
        },
        network: {
          merchantCount: network.merchantCount,
          deliveredCount: network.deliveredCount,
          rtoCount: network.rtoCount,
          cancelledCount: network.cancelledCount,
          rtoRate: network.rtoRate,
          firstSeenAt: network.firstSeenAt,
          lastSeenAt: network.lastSeenAt,
          matchedOn: network.matchedOn,
        },
        customerHistory: {
          ...customerHistory,
          firstOutcomeAt: rel?.firstOutcomeAt ?? null,
          lastOutcomeAt: rel?.lastOutcomeAt ?? null,
        },
        recommendedAction,
        createdAt: order.createdAt,
      };
    }),

  /** Agent confirmed identity/intent → clears the review gate. */
  markVerified: protectedProcedure
    .input(reviewActionInput)
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      await ensureFraudAccess(merchantId, ctx.user.role);
      const reasonCode = reasonFor(VERIFY_REASON_CODES, input.reasonCode);
      const plan = getPlan((await Merchant.findById(merchantId).select("subscription.tier").lean())?.subscription?.tier);
      // Reserve a slot atomically up-front. Two agents racing for the last
      // review-quota unit cannot both pass a `checkQuota` and then both
      // bump — the `$inc` here is conditional on the post-increment value
      // staying inside the cap.
      const reservation = await reserveQuota(merchantId, plan, "fraudReviewsUsed", 1);
      if (!reservation.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `monthly fraud review quota reached (${reservation.used}/${reservation.limit}) — upgrade your plan`,
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
            ...(reasonCode ? { "fraud.reviewReasonCode": reasonCode } : {}),
          },
          ...(reasonCode ? {} : { $unset: { "fraud.reviewReasonCode": "" } }),
        },
        { new: true },
      ).lean<FraudDoc>();
      if (!updated) {
        // No real state transition happened (order already verified /
        // rejected by another agent, or never in review). Refund the
        // quota slot so retries don't accumulate against the cap.
        await releaseQuota(merchantId, "fraudReviewsUsed", 1);
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
        meta: { notes: input.notes ?? null, reasonCode: reasonCode ?? null, riskScore: updated.fraud?.riskScore ?? 0 },
      });
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
      const reasonCode = reasonFor(REJECT_REASON_CODES, input.reasonCode);
      const _id = parseObjectId(input.id);
      const now = new Date();
      const prior = await Order.findOne({ _id, merchantId })
        .select("order.status order.cod automation fraud.reviewStatus fraud.level")
        .lean<{
          order: { status: string; cod: number };
          automation?: OrderAutomation;
          fraud?: { reviewStatus?: string; level?: string };
        }>();
      if (!prior) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });
      const reviewStatus = prior.fraud?.reviewStatus ?? "not_required";
      if (!["pending_call", "no_answer"].includes(reviewStatus)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `order is not awaiting review (${reviewStatus})`,
        });
      }

      const plan = getPlan((await Merchant.findById(merchantId).select("subscription.tier").lean())?.subscription?.tier);
      const reservation = await reserveQuota(merchantId, plan, "fraudReviewsUsed", 1);
      if (!reservation.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `monthly fraud review quota reached (${reservation.used}/${reservation.limit}) — upgrade your plan`,
        });
      }

      const prevStatus = prior.order.status;
      const fromAutomationState = prior.automation?.state ?? "not_evaluated";
      const fraudSnapshot = buildFraudRejectSnapshot(prior.fraud);
      const preActionSnapshot = buildPreActionSnapshot({
        orderStatus: prevStatus,
        automation: prior.automation,
        fraud: prior.fraud,
      });

      // Write the SAME snapshot fields that orders.rejectOrder and
      // orders.bulkRejectOrders write — without these, restoreOrder
      // cannot put a fraud-rejected order back, because its filter
      // requires automation.state="rejected" + decidedBy="merchant"
      // + rejectedAt set. Pre-this-change, fraud reject was
      // irrecoverable.
      //
      // The fraud.preRejectReviewStatus capture is what lets restore
      // re-enter the queue: the queue is built from
      // fraud.reviewStatus ∈ {pending_call, no_answer}, so restoring
      // the prior reviewStatus puts the order back in the merchant's
      // review query naturally.
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
            "fraud.preRejectReviewStatus": fraudSnapshot.preRejectReviewStatus,
            "fraud.preRejectLevel": fraudSnapshot.preRejectLevel,
            "order.status": "cancelled",
            "order.preRejectStatus": prevStatus,
            "automation.state": "rejected",
            "automation.preRejectState": fromAutomationState,
            "automation.decidedBy": "merchant",
            "automation.decidedAt": now,
            "automation.rejectedAt": now,
            "automation.rejectionReason":
              input.notes ?? (reasonCode ? `rejected during fraud review (${reasonCode})` : "rejected during fraud review"),
            preActionSnapshot,
            ...(input.notes ? { "fraud.reviewNotes": input.notes } : {}),
            ...(reasonCode ? { "fraud.reviewReasonCode": reasonCode } : {}),
          },
          ...(reasonCode ? {} : { $unset: { "fraud.reviewReasonCode": "" } }),
        },
        { new: true },
      ).lean<FraudDoc>();
      if (!updated) {
        // No state change — refund the fraud-review slot we reserved.
        await releaseQuota(merchantId, "fraudReviewsUsed", 1);
        throw new TRPCError({ code: "CONFLICT", message: "order state changed — retry" });
      }

      // Refund the order quota too — the order is cancelled, no longer
      // countable against the merchant's monthly cap. Matches the
      // behaviour of rejectOrder + bulkRejectOrders so all three reject
      // paths leave usage in the same shape.
      if (prevStatus !== "cancelled") {
        await releaseQuota(merchantId, "ordersCreated", 1);
      }
      await syncOrderInventory([_id]);

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
          reasonCode: reasonCode ?? null,
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
      const reasonCode = reasonFor(NO_ANSWER_REASON_CODES, input.reasonCode);
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
            ...(reasonCode ? { "fraud.reviewReasonCode": reasonCode } : {}),
          },
          ...(reasonCode ? {} : { $unset: { "fraud.reviewReasonCode": "" } }),
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
        meta: { notes: input.notes ?? null, reasonCode: reasonCode ?? null },
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
        .select("customer order.cod fraud.reviewStatus fraud.level fraud.manualReviewAt source.ip source.addressHash orderNumber")
        .lean<{
          orderNumber: string;
          customer: { name: string; phone: string; address?: string; district: string };
          order: { cod: number };
          fraud?: {
            reviewStatus?: (typeof REVIEW_STATUSES)[number];
            level?: "low" | "medium" | "high";
            manualReviewAt?: Date | null;
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
        velocityThreshold: fc.velocityThreshold ?? undefined,
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
      const nextReview = reviewStatusAfterRescore(currentReview, risk.reviewStatus, !!order.fraud?.manualReviewAt);

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
            "fraud.confidence": risk.confidence,
            "fraud.confidenceLabel": risk.confidenceLabel,
            "fraud.hardBlocked": risk.hardBlocked,
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
  /**
   * Merchant sends an order to verification: it enters the review queue
   * (pending_call) and cannot be booked until someone verifies it. Allowed
   * only before dispatch — not once a courier booking exists or is in
   * flight (the booking lock checks the same review state, so the two
   * can't both win). Sticky against rescoring until a person decides.
   */
  requestVerification: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        notes: z.string().max(REVIEW_NOTE_MAX).optional(),
        reasonCode: z.string().max(40).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      await ensureFraudAccess(merchantId, ctx.user.role);
      const reasonCode = reasonFor(REQUEST_REASON_CODES, input.reasonCode);
      const _id = parseObjectId(input.id);
      const now = new Date();
      const updated = await Order.findOneAndUpdate(
        {
          _id,
          merchantId,
          "fraud.reviewStatus": { $in: ["not_required", "optional_review", null] },
          "order.status": { $in: [...PRE_DISPATCH_STATUSES] },
          "logistics.trackingNumber": { $in: [null, ""] },
          "logistics.bookingInFlight": { $ne: true },
        },
        {
          $set: {
            "fraud.reviewStatus": "pending_call",
            "fraud.manualReviewAt": now,
            "fraud.manualReviewBy": merchantId,
            ...(input.notes ? { "fraud.reviewNotes": input.notes } : {}),
            ...(reasonCode ? { "fraud.reviewReasonCode": reasonCode } : {}),
          },
          ...(reasonCode ? {} : { $unset: { "fraud.reviewReasonCode": "" } }),
        },
        { new: true },
      ).lean<FraudDoc>();
      if (!updated) {
        const current = await Order.findOne({ _id, merchantId })
          .select("fraud.reviewStatus order.status logistics.trackingNumber logistics.bookingInFlight")
          .lean<{
            fraud?: { reviewStatus?: string };
            order?: { status?: string };
            logistics?: { trackingNumber?: string; bookingInFlight?: boolean };
          }>();
        if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });
        const review = current.fraud?.reviewStatus ?? "not_required";
        const message =
          current.logistics?.trackingNumber || current.logistics?.bookingInFlight
            ? "order is already being dispatched"
            : !(PRE_DISPATCH_STATUSES as readonly string[]).includes(current.order?.status ?? "")
              ? `order is '${current.order?.status}' — only orders not yet dispatched can be verified`
              : `order is already ${review === "pending_call" || review === "no_answer" ? "awaiting verification" : review}`;
        throw new TRPCError({ code: "CONFLICT", message });
      }
      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorEmail: ctx.user.email,
        actorType: ctx.user.role === "admin" ? "admin" : "merchant",
        action: "review.requested",
        subjectType: "order",
        subjectId: updated._id,
        meta: { notes: input.notes ?? null, reasonCode: reasonCode ?? null, riskScore: updated.fraud?.riskScore ?? 0 },
      });
      await invalidate(`dashboard:${ctx.user.id}`);
      return { id: String(updated._id), reviewStatus: "pending_call" as const };
    }),

  /**
   * One order's verification history, oldest first: scoring, review
   * decisions (with reason codes and notes), confirmation events and
   * cancel/restore. Read from the audit trail; this merchant's order only.
   */
  getVerificationHistory: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      await ensureFraudAccess(merchantId, ctx.user.role);
      const _id = parseObjectId(input.id);
      const owned = await Order.exists({ _id, merchantId });
      if (!owned) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });
      // Index {merchantId, subjectType, subjectId, at}.
      const rows = await AuditLog.find({
        merchantId,
        subjectType: "order",
        subjectId: _id,
        action: { $in: [...VERIFICATION_HISTORY_ACTIONS] },
      })
        .sort({ at: 1 })
        .limit(200)
        .select("action actorType at meta")
        .lean<Array<{ _id: Types.ObjectId; action: string; actorType?: string; at: Date; meta?: Record<string, unknown> }>>();
      const str = (v: unknown, max = 500) => (typeof v === "string" && v ? v.slice(0, max) : null);
      return rows.map((r) => ({
        id: String(r._id),
        at: r.at,
        action: r.action,
        actor: r.actorType ?? "system",
        reasonCode: str(r.meta?.reasonCode, 40),
        notes: str(r.meta?.notes),
        riskScore:
          typeof r.meta?.riskScore === "number"
            ? r.meta.riskScore
            : typeof r.meta?.score === "number"
              ? (r.meta.score as number)
              : null,
        level: str(r.meta?.level, 10),
      }));
    }),

  getReviewStats: protectedProcedure
    .input(
      z
        .object({ days: z.number().int().min(1).max(90).default(7) })
        .default({ days: 7 }),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      // Plan gate: keep the sidebar badge from advertising work the
      // merchant cannot action. listPendingReviews already throws
      // FORBIDDEN for Starter; mirror that here by returning a clean
      // zero shape instead of real counts. Avoids the "16 in queue"
      // badge on a tier that cannot open the queue.
      if (ctx.user.role !== "admin") {
        const m = await Merchant.findById(merchantId)
          .select("subscription.tier")
          .lean();
        const plan = getPlan(m?.subscription?.tier);
        if (!plan.features.fraudReview) {
          return {
            days: input.days,
            today: { risky: 0, verified: 0, rejected: 0, codSaved: 0 },
            window: { risky: 0, verified: 0, rejected: 0, codSaved: 0 },
            queue: { pending: 0, noAnswer: 0 },
          };
        }
      }
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
