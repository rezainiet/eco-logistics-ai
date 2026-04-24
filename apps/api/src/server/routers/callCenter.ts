import { Types } from "mongoose";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { CallLog, Order } from "@ecom/db";
import { protectedProcedure, router } from "../trpc.js";
import { invalidate } from "../../lib/cache.js";

const logCallInput = z.object({
  orderId: z.string().optional(),
  duration: z.number().int().min(0),
  answered: z.boolean(),
  successful: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
  callType: z.enum(["incoming", "outgoing"]).optional(),
  customerPhone: z.string().max(50).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  deliveryStatus: z.enum(["delivered", "pending", "rto"]).optional(),
});

const callTypeFilter = z.enum(["incoming", "outgoing", "all"]).default("all");

type CallLogDoc = {
  _id: Types.ObjectId;
  orderId?: Types.ObjectId;
  answered: boolean;
  outcome?: { successful?: boolean; reason?: string };
  duration: number;
  timestamp: Date;
  hour: number;
  notes?: string;
  callType?: "incoming" | "outgoing";
  customerPhone?: string;
  tags?: string[];
  deliveryStatus?: "delivered" | "pending" | "rto";
};

export const callCenterRouter = router({
  logCall: protectedProcedure.input(logCallInput).mutation(async ({ ctx, input }) => {
    const merchantId = new Types.ObjectId(ctx.user.id);

    let orderId: Types.ObjectId | undefined;
    if (input.orderId) {
      if (!Types.ObjectId.isValid(input.orderId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid orderId" });
      }
      const order = await Order.findById(input.orderId).select("merchantId").lean();
      if (!order || !merchantId.equals(order.merchantId)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });
      }
      orderId = new Types.ObjectId(input.orderId);
    }

    const now = new Date();
    const log = await CallLog.create({
      merchantId,
      orderId,
      timestamp: now,
      hour: now.getHours(),
      dayOfWeek: now.getDay(),
      duration: input.duration,
      answered: input.answered,
      outcome: input.successful !== undefined ? { successful: input.successful } : undefined,
      notes: input.notes,
      callType: input.callType,
      customerPhone: input.customerPhone,
      tags: input.tags,
      deliveryStatus: input.deliveryStatus,
    });

    await invalidate(`dashboard:${ctx.user.id}`);

    return { id: String(log._id), timestamp: log.timestamp, hour: log.hour };
  }),

  getCallLogs: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(25),
          cursor: z.string().nullable().default(null),
          callType: callTypeFilter,
        })
        .default({ limit: 25, cursor: null, callType: "all" }),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = new Types.ObjectId(ctx.user.id);
      const filter: Record<string, unknown> = { merchantId };

      if (input.callType !== "all") {
        filter.callType = input.callType;
      }

      if (input.cursor && Types.ObjectId.isValid(input.cursor)) {
        filter._id = { $lt: new Types.ObjectId(input.cursor) };
      }

      const items = await CallLog.find(filter)
        .sort({ _id: -1 })
        .limit(input.limit + 1)
        .lean<CallLogDoc[]>();

      const hasMore = items.length > input.limit;
      const page = hasMore ? items.slice(0, -1) : items;
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? String(last._id) : null;

      return {
        nextCursor,
        hasMore,
        calls: page.map((c) => ({
          id: String(c._id),
          orderId: c.orderId ? String(c.orderId) : null,
          answered: c.answered,
          successful: c.outcome?.successful ?? null,
          callType: c.callType ?? null,
          duration: c.duration,
          customerPhone: c.customerPhone ?? null,
          tags: c.tags ?? [],
          notes: c.notes ?? null,
          timestamp: c.timestamp,
          hour: c.hour,
          deliveryStatus: c.deliveryStatus ?? null,
        })),
      };
    }),

  getCallAnalytics: protectedProcedure
    .input(
      z
        .object({ days: z.number().int().min(1).max(90).default(30) })
        .default({ days: 30 }),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = new Types.ObjectId(ctx.user.id);
      const since = new Date();
      since.setDate(since.getDate() - input.days);

      const [result] = await CallLog.aggregate<{
        summary: Array<{
          totalCalls: number;
          answeredCalls: number;
          successfulCalls: number;
          avgDuration: number;
          totalDuration: number;
        }>;
        byType: Array<{ _id: "incoming" | "outgoing"; count: number; answerRate: number }>;
      }>([
        { $match: { merchantId, timestamp: { $gte: since } } },
        {
          $facet: {
            summary: [
              {
                $group: {
                  _id: null,
                  totalCalls: { $sum: 1 },
                  answeredCalls: { $sum: { $cond: ["$answered", 1, 0] } },
                  successfulCalls: {
                    $sum: { $cond: [{ $eq: ["$outcome.successful", true] }, 1, 0] },
                  },
                  avgDuration: { $avg: "$duration" },
                  totalDuration: { $sum: "$duration" },
                },
              },
            ],
            byType: [
              { $match: { callType: { $exists: true, $ne: null } } },
              {
                $group: {
                  _id: "$callType",
                  count: { $sum: 1 },
                  answerRate: { $avg: { $cond: ["$answered", 100, 0] } },
                },
              },
            ],
          },
        },
      ]);

      const s = result?.summary?.[0] ?? {
        totalCalls: 0,
        answeredCalls: 0,
        successfulCalls: 0,
        avgDuration: 0,
        totalDuration: 0,
      };

      const answerRate = s.totalCalls > 0 ? Math.round((s.answeredCalls / s.totalCalls) * 100) : 0;
      const successRate =
        s.answeredCalls > 0 ? Math.round((s.successfulCalls / s.answeredCalls) * 100) : 0;

      return {
        days: input.days,
        totalCalls: s.totalCalls,
        answeredCalls: s.answeredCalls,
        successfulCalls: s.successfulCalls,
        answerRate,
        successRate,
        avgDurationSeconds: Math.round(s.avgDuration || 0),
        totalDurationSeconds: Math.round(s.totalDuration || 0),
        byType: (result?.byType ?? []).map((t) => ({
          type: t._id,
          count: t.count,
          answerRate: Math.round(t.answerRate),
        })),
      };
    }),
});
