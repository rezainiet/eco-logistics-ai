import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import { Notification, NOTIFICATION_KINDS } from "@ecom/db";
import { merchantObjectId, protectedProcedure, router } from "../trpc.js";

/**
 * In-app inbox for merchant alerts. Backs the bell icon in the dashboard
 * header. Today this is the surface where fraud alerts arrive — same shape
 * will be reused for tracking delays, trial reminders, etc.
 */

const listInput = z
  .object({
    cursor: z.string().nullable().default(null),
    limit: z.number().int().min(1).max(100).default(25),
    onlyUnread: z.boolean().default(false),
    kind: z.enum(NOTIFICATION_KINDS).optional(),
  })
  .default({ cursor: null, limit: 25, onlyUnread: false });

export const notificationsRouter = router({
  list: protectedProcedure.input(listInput).query(async ({ ctx, input }) => {
    const merchantId = merchantObjectId(ctx);
    const query: Record<string, unknown> = { merchantId };
    if (input.onlyUnread) query.readAt = null;
    if (input.kind) query.kind = input.kind;
    if (input.cursor && Types.ObjectId.isValid(input.cursor)) {
      query._id = { $lt: new Types.ObjectId(input.cursor) };
    }
    const items = await Notification.find(query)
      .sort({ _id: -1 })
      .limit(input.limit + 1)
      .lean();
    const hasMore = items.length > input.limit;
    const page = hasMore ? items.slice(0, -1) : items;
    const last = page[page.length - 1];
    const [unreadCount, totalCount] = await Promise.all([
      Notification.countDocuments({ merchantId, readAt: null }),
      Notification.countDocuments({ merchantId }),
    ]);
    return {
      total: totalCount,
      unread: unreadCount,
      nextCursor: hasMore && last ? String(last._id) : null,
      items: page.map((n) => ({
        id: String(n._id),
        kind: n.kind,
        severity: n.severity,
        title: n.title,
        body: n.body ?? null,
        link: n.link ?? null,
        subjectType: n.subjectType,
        subjectId: n.subjectId ? String(n.subjectId) : null,
        meta: n.meta ?? null,
        readAt: n.readAt ?? null,
        createdAt: n.createdAt,
      })),
    };
  }),

  unreadCount: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const unread = await Notification.countDocuments({ merchantId, readAt: null });
    return { unread };
  }),

  markRead: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const res = await Notification.updateOne(
        { _id: new Types.ObjectId(input.id), merchantId, readAt: null },
        { $set: { readAt: new Date() } },
      );
      return { id: input.id, marked: res.modifiedCount === 1 };
    }),

  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const res = await Notification.updateMany(
      { merchantId, readAt: null },
      { $set: { readAt: new Date() } },
    );
    return { updated: res.modifiedCount };
  }),
});
