import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import {
  Order,
  RecoveryTask,
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
      return rows.map((r) => ({
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
      }));
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
      const task = await RecoveryTask.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      });
      if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "task not found" });

      const now = new Date();
      task.status = input.status;
      if (input.note !== undefined) task.note = input.note;
      if (input.status === "contacted") {
        task.lastChannel = input.channel;
        task.contactedAt = now;
        task.contactedBy = merchantId;
      }
      if (input.status === "recovered") {
        task.recoveredAt = now;
        if (input.recoveredOrderId && Types.ObjectId.isValid(input.recoveredOrderId)) {
          task.recoveredOrderId = new Types.ObjectId(input.recoveredOrderId);
        } else if (task.phone) {
          // Best-effort: link the most recent order from the same buyer.
          const variants = phoneLookupVariants(task.phone);
          const recent = await Order.findOne({
            merchantId,
            "customer.phone":
              variants.length > 1 ? { $in: variants } : task.phone,
            createdAt: { $gte: task.abandonedAt },
          })
            .sort({ createdAt: -1 })
            .select("_id")
            .lean();
          if (recent) task.recoveredOrderId = recent._id;
        }
      }
      await task.save();

      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "tracking.identified",
        subjectType: "session",
        subjectId: task._id,
        meta: {
          kind: "recovery_update",
          newStatus: input.status,
          channel: input.channel ?? null,
          recoveredOrderId: task.recoveredOrderId ? String(task.recoveredOrderId) : null,
        },
      });

      return {
        id: String(task._id),
        status: task.status,
        recoveredOrderId: task.recoveredOrderId ? String(task.recoveredOrderId) : null,
      };
    }),
});
