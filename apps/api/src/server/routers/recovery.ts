import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import {
  Order,
  RecoveryTask,
  TrackingSession,
  RECOVERY_CHANNELS,
  RECOVERY_STATUSES,
} from "@ecom/db";
import { billableProcedure, merchantObjectId, protectedProcedure, router, type SubscriptionSnapshot } from "../trpc.js";
import { writeAudit } from "../../lib/audit.js";
import {
  assertBehaviorAnalytics,
  entitlementsFor,
} from "../../lib/entitlements.js";
import { phoneLookupVariants } from "../../lib/phone.js";
import type { PlanTier } from "../../lib/plans.js";

/**
 * Abandoned-cart recovery surface. The worker creates `RecoveryTask` rows;
 * this router reads them, lets the agent mark a task contacted/dismissed,
 * and links a recovered order back to the task when it lands.
 *
 * Gated to behavior-analytics tier (Growth+). The actual outreach channels
 * (call/SMS/email) reuse the existing call-center + notification stacks —
 * this router is the queue + state-machine, not a new comms pipe.
 */

type RecoveryStatusValue = (typeof RECOVERY_STATUSES)[number];
type RecoveryUpdateStatus = "contacted" | "recovered" | "dismissed";

/**
 * Allowed status changes (audit CR-6), using only the existing statuses:
 *   pending   → contacted | recovered | dismissed
 *   contacted → contacted (another attempt) | recovered | dismissed
 *   recovered, dismissed, expired → terminal
 * Keyed by the TARGET status: which current statuses may move to it.
 */
export const RECOVERY_TRANSITIONS: Readonly<Record<RecoveryUpdateStatus, readonly RecoveryStatusValue[]>> = {
  contacted: ["pending", "contacted"],
  recovered: ["pending", "contacted"],
  dismissed: ["pending", "contacted"],
};

export function canTransitionRecovery(from: RecoveryStatusValue, to: RecoveryUpdateStatus): boolean {
  return RECOVERY_TRANSITIONS[to].includes(from);
}

function tierFromCtx(ctx: { subscription?: SubscriptionSnapshot | null | undefined }): PlanTier {
  return (ctx.subscription?.tier ?? "starter") as PlanTier;
}

const updateInputSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["contacted", "recovered", "dismissed"]),
  channel: z.enum(RECOVERY_CHANNELS).optional(),
  note: z.string().max(500).optional(),
  recoveredOrderId: z.string().optional(),
});

export const recoveryRouter = router({
  /**
   * Plan-aware view of recovery entitlements. UI uses this to decide whether
   * to render the page or upsell.
   */
  getEntitlements: protectedProcedure.query(async ({ ctx }) => {
    const { Merchant } = await import("@ecom/db");
    const m = await Merchant.findById(merchantObjectId(ctx)).select("subscription.tier").lean();
    const tier = (m?.subscription?.tier ?? "starter") as PlanTier;
    const view = entitlementsFor(tier);
    return {
      tier,
      enabled: view.behaviorAnalytics,
      recommendedUpgradeTier: view.recommendedUpgradeTier,
    };
  }),

  /**
   * Snapshot of the recovery queue. Filterable by status; default returns
   * the actionable rows (pending) sorted by abandon time descending.
   */
  list: billableProcedure
    .input(
      z
        .object({
          status: z.enum(RECOVERY_STATUSES).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({ limit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      assertBehaviorAnalytics(tierFromCtx(ctx));
      const merchantId = merchantObjectId(ctx);
      const filter: Record<string, unknown> = { merchantId };
      if (input.status) filter.status = input.status;
      const rows = await RecoveryTask.find(filter)
        .sort({ abandonedAt: -1 })
        .limit(input.limit)
        .lean();
      // Recovered orders of THIS merchant, for the order number / status column.
      const orderIds = rows.map((r) => r.recoveredOrderId).filter((id): id is Types.ObjectId => !!id);
      const orders = orderIds.length
        ? await Order.find({ _id: { $in: orderIds }, merchantId })
            .select("orderNumber order.status order.total order.cod")
            .lean()
        : [];
      const orderById = new Map(orders.map((o) => [String(o._id), o]));
      return rows.map((r) => {
        const o = r.recoveredOrderId ? orderById.get(String(r.recoveredOrderId)) : undefined;
        const er = r.emailRecovery;
        return {
        id: String(r._id),
        sessionId: r.sessionId,
        phone: r.phone ?? null,
        email: r.email ?? null,
        cartValue: r.cartValue ?? 0,
        topProducts: r.topProducts ?? [],
        abandonedAt: r.abandonedAt,
        status: r.status,
        lastChannel: r.lastChannel ?? null,
        contactedAt: r.contactedAt ?? null,
        recoveredOrderId: r.recoveredOrderId ? String(r.recoveredOrderId) : null,
        recoveredAt: r.recoveredAt ?? null,
        note: r.note ?? null,
        expiresAt: r.expiresAt ?? null,
        source: r.source ?? "storefront",
        emailStatus: er?.state ?? null,
        emailSentAt: er?.sentAt ?? null,
        emailError: er?.state === "failed" ? (er.lastError ?? null) : null,
        emailCancelReason: er?.state === "cancelled" ? (er.cancelReason ?? null) : null,
        clickedAt: er?.clickedAt ?? null,
        clicks: er?.clicks ?? 0,
        checkoutStartedAt: er?.checkoutStartedAt ?? null,
        recoveredOrder: o
          ? { number: o.orderNumber, status: o.order?.status ?? null, total: o.order?.total ?? o.order?.cod ?? 0 }
          : null,
        };
      });
    }),

  /**
   * The three questions the Recovery page answers first — how many buyers
   * abandoned, how many came back, and how much revenue that produced —
   * over the last `days` days (by abandonment time).
   *
   * Revenue follows the existing analytics rule: only DELIVERED orders count
   * (`revenueDelivered` = order.cod of delivered orders). Placed-but-not-yet-
   * delivered recovered orders are reported separately as order value; a
   * click or a started checkout is never revenue.
   */
  summary: billableProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(30) }).default({ days: 30 }))
    .query(async ({ ctx, input }) => {
      assertBehaviorAnalytics(tierFromCtx(ctx));
      const merchantId = merchantObjectId(ctx);
      const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
      const [abandonedCarts, taskAgg] = await Promise.all([
        // Index {merchantId, abandonedCart, lastSeenAt}.
        TrackingSession.countDocuments({ merchantId, abandonedCart: true, lastSeenAt: { $gte: since } }),
        RecoveryTask.aggregate<{
          _id: null;
          tasks: number;
          emailsSent: number;
          clicked: number;
          checkoutsStarted: number;
          recovered: number;
          orderIds: Types.ObjectId[];
        }>([
          { $match: { merchantId, abandonedAt: { $gte: since } } },
          {
            $group: {
              _id: null,
              tasks: { $sum: 1 },
              emailsSent: { $sum: { $cond: [{ $eq: ["$emailRecovery.state", "sent"] }, 1, 0] } },
              clicked: { $sum: { $cond: [{ $gt: ["$emailRecovery.clickedAt", null] }, 1, 0] } },
              checkoutsStarted: { $sum: { $cond: [{ $gt: ["$emailRecovery.checkoutStartedAt", null] }, 1, 0] } },
              recovered: { $sum: { $cond: [{ $eq: ["$status", "recovered"] }, 1, 0] } },
              orderIds: { $push: "$recoveredOrderId" },
            },
          },
        ]),
      ]);
      const t = taskAgg[0];
      const orderIds = (t?.orderIds ?? []).filter(Boolean);
      const orders = orderIds.length
        ? await Order.find({ _id: { $in: orderIds }, merchantId }).select("order.status order.cod order.total").lean()
        : [];
      let recoveredRevenue = 0;
      let recoveredOrderValue = 0;
      for (const o of orders) {
        recoveredOrderValue += o.order?.total ?? o.order?.cod ?? 0;
        if (o.order?.status === "delivered") recoveredRevenue += o.order?.cod ?? 0;
      }
      const tasks = t?.tasks ?? 0;
      const recovered = t?.recovered ?? 0;
      return {
        days: input.days,
        abandonedCarts,
        tasks,
        emailsSent: t?.emailsSent ?? 0,
        clicked: t?.clicked ?? 0,
        checkoutsStarted: t?.checkoutsStarted ?? 0,
        recovered,
        recoveredOrders: orders.length,
        recoveredOrderValue: Math.round(recoveredOrderValue),
        recoveredRevenue: Math.round(recoveredRevenue),
        /** Recovered ÷ carts that entered recovery (null until there is one). */
        recoveryRate: tasks > 0 ? recovered / tasks : null,
      };
    }),

  /** Counts per status — drives the dashboard summary cards. */
  counts: billableProcedure.query(async ({ ctx }) => {
    assertBehaviorAnalytics(tierFromCtx(ctx));
    const merchantId = merchantObjectId(ctx);
    const rows = await RecoveryTask.aggregate<{ _id: string; count: number; cartValue: number }>([
      { $match: { merchantId } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          cartValue: { $sum: "$cartValue" },
        },
      },
    ]);
    const map = new Map(rows.map((r) => [r._id, r]));
    const get = (s: string) => map.get(s) ?? { _id: s, count: 0, cartValue: 0 };
    return {
      pending: get("pending"),
      contacted: get("contacted"),
      recovered: get("recovered"),
      dismissed: get("dismissed"),
      expired: get("expired"),
      pipelineValue:
        (get("pending").cartValue ?? 0) + (get("contacted").cartValue ?? 0),
      recoveredValue: get("recovered").cartValue ?? 0,
    };
  }),

  /**
   * Mark a task contacted / recovered / dismissed. Audit-logged with the
   * acting agent so we can build a recovery-attribution view later.
   */
  update: billableProcedure
    .input(updateInputSchema)
    .mutation(async ({ ctx, input }) => {
      assertBehaviorAnalytics(tierFromCtx(ctx));
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const taskId = new Types.ObjectId(input.id);
      const task = await RecoveryTask.findOne({ _id: taskId, merchantId })
        .select("status phone abandonedAt")
        .lean();
      if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "task not found" });

      const from = task.status as RecoveryStatusValue;
      if (!canTransitionRecovery(from, input.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `cannot mark a ${from} task as ${input.status}`,
        });
      }

      // An explicitly linked order must belong to this merchant.
      let recoveredOrderId: Types.ObjectId | undefined;
      if (input.status === "recovered" && input.recoveredOrderId !== undefined) {
        if (!Types.ObjectId.isValid(input.recoveredOrderId)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "invalid order id" });
        }
        const owned = await Order.exists({ _id: new Types.ObjectId(input.recoveredOrderId), merchantId });
        if (!owned) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });
        recoveredOrderId = owned._id as Types.ObjectId;
      } else if (input.status === "recovered" && task.phone) {
        // Best-effort: link the most recent order from the same buyer (this merchant only).
        const variants = phoneLookupVariants(task.phone);
        const recent = await Order.findOne({
          merchantId,
          "customer.phone": variants.length > 1 ? { $in: variants } : task.phone,
          createdAt: { $gte: task.abandonedAt },
        })
          .sort({ createdAt: -1 })
          .select("_id")
          .lean();
        if (recent) recoveredOrderId = recent._id as Types.ObjectId;
      }

      const now = new Date();
      const set: Record<string, unknown> = { status: input.status };
      if (input.note !== undefined) set.note = input.note;
      if (input.status === "contacted") {
        set.lastChannel = input.channel;
        set.contactedAt = now;
        // The authenticated principal IS the merchant account (ctx.user.id);
        // there is no per-staff identity in the session to record here.
        set.contactedBy = merchantId;
      }
      if (input.status === "recovered") {
        set.recoveredAt = now;
        if (recoveredOrderId) set.recoveredOrderId = recoveredOrderId;
      }

      // Conditional on the status we validated against, so two concurrent
      // clicks can't both pass the transition check.
      const updated = await RecoveryTask.findOneAndUpdate(
        { _id: taskId, merchantId, status: from },
        { $set: set },
        { new: true },
      ).lean();
      if (!updated) {
        throw new TRPCError({ code: "CONFLICT", message: "task changed — refresh and try again" });
      }
      // The merchant acted first: a not-yet-sent automatic email is cancelled.
      await RecoveryTask.updateOne(
        { _id: updated._id, merchantId, "emailRecovery.state": { $in: ["queued", "failed"] } },
        { $set: { "emailRecovery.state": "cancelled", "emailRecovery.cancelReason": "merchant_action" }, $unset: { "emailRecovery.nextAttemptAt": "" } },
      );

      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorEmail: ctx.user.email,
        actorType: ctx.user.role === "admin" ? "admin" : "merchant",
        action: "recovery.task_updated",
        subjectType: "session",
        subjectId: updated._id,
        meta: {
          kind: "recovery_update",
          fromStatus: from,
          newStatus: input.status,
          channel: input.channel ?? null,
          recoveredOrderId: updated.recoveredOrderId ? String(updated.recoveredOrderId) : null,
        },
      });

      return {
        id: String(updated._id),
        status: updated.status,
        recoveredOrderId: updated.recoveredOrderId ? String(updated.recoveredOrderId) : null,
      };
    }),
});
