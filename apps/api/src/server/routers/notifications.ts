import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import { Merchant, Notification, NOTIFICATION_KINDS } from "@ecom/db";
import { merchantObjectId, protectedProcedure, router } from "../trpc.js";
import { getPlan } from "../../lib/plans.js";
import { INBOX_KINDS, inboxCategoryOf, resolveInboxLink } from "../../lib/notification-inbox.js";

/**
 * In-app inbox for merchant alerts. `inbox` backs the dashboard bell and
 * drawer (the merchant-facing kinds, lib/notification-inbox.ts); `list` is
 * the raw feed (used by the operational banner). Every query and write is
 * scoped to the session's merchant.
 */

const inboxInput = z
  .object({
    cursor: z.string().nullable().default(null),
    limit: z.number().int().min(1).max(50).default(20),
    /** "unread" (default) is exactly what the bell counts; "all" adds read history. */
    filter: z.enum(["unread", "all"]).default("unread"),
  })
  .default({ cursor: null, limit: 20, filter: "unread" });

const listInput = z
  .object({
    cursor: z.string().nullable().default(null),
    limit: z.number().int().min(1).max(100).default(25),
    onlyUnread: z.boolean().default(false),
    kind: z.enum(NOTIFICATION_KINDS).optional(),
    /** Any of these kinds (e.g. the courier outcome kinds the bell drawer lists). */
    kinds: z.array(z.enum(NOTIFICATION_KINDS)).min(1).max(20).optional(),
  })
  .default({ cursor: null, limit: 25, onlyUnread: false });

export const notificationsRouter = router({
  list: protectedProcedure.input(listInput).query(async ({ ctx, input }) => {
    const merchantId = merchantObjectId(ctx);
    const query: Record<string, unknown> = { merchantId };
    if (input.onlyUnread) query.readAt = null;
    if (input.kind) query.kind = input.kind;
    else if (input.kinds) query.kind = { $in: input.kinds };
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

  /**
   * The merchant inbox: newest first, with the destination each row opens
   * (resolved server-side — never a guessed link) and the unread count over
   * the SAME filter, so the bell and the drawer can never disagree.
   */
  inbox: protectedProcedure.input(inboxInput).query(async ({ ctx, input }) => {
    const merchantId = merchantObjectId(ctx);
    const base: Record<string, unknown> = { merchantId, kind: { $in: INBOX_KINDS } };
    const query: Record<string, unknown> = { ...base, ...(input.filter === "unread" ? { readAt: null } : {}) };
    if (input.cursor && Types.ObjectId.isValid(input.cursor)) query._id = { $lt: new Types.ObjectId(input.cursor) };
    const [rows, unread, merchant] = await Promise.all([
      Notification.find(query).sort({ _id: -1 }).limit(input.limit + 1).lean(),
      Notification.countDocuments({ ...base, readAt: null }),
      Merchant.findById(merchantId).select("subscription.tier").lean(),
    ]);
    // Review alerts open the review queue only where the plan includes it.
    const fraudReview = ctx.user.role === "admin" || getPlan(merchant?.subscription?.tier).features.fraudReview;
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, -1) : rows;
    return {
      unread,
      nextCursor: hasMore && page.length ? String(page[page.length - 1]!._id) : null,
      items: page.map((n) => ({
        id: String(n._id),
        kind: n.kind,
        category: inboxCategoryOf(n.kind),
        severity: n.severity ?? "warning",
        title: n.title,
        body: n.body ?? null,
        href: resolveInboxLink(n, { fraudReview }),
        read: !!n.readAt,
        createdAt: n.createdAt,
      })),
    };
  }),

  /**
   * Without input: every notification of the merchant (unchanged). The
   * drawer passes `scope: "inbox"` and `upToId` = the newest row it showed,
   * so a notification that arrives after the merchant looked is never
   * marked read unseen. Only unread rows are touched; read state is never
   * reverted.
   */
  markAllRead: protectedProcedure
    .input(
      z
        .object({
          scope: z.enum(["all", "inbox"]).default("all"),
          upToId: z.string().optional(),
        })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const filter: Record<string, unknown> = { merchantId, readAt: null };
      if (input?.scope === "inbox") filter.kind = { $in: INBOX_KINDS };
      if (input?.upToId) {
        if (!Types.ObjectId.isValid(input.upToId)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
        }
        filter._id = { $lte: new Types.ObjectId(input.upToId) };
      }
      const res = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
      return { updated: res.modifiedCount };
    }),
});
