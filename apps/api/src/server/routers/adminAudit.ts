import { Types } from "mongoose";
import { z } from "zod";
import { AuditLog } from "@ecom/db";
import { adminProcedure, router, scopedAdminProcedure } from "../trpc.js";
import { verifyAuditChain } from "../../lib/audit.js";

/**
 * Audit search + chain-verification surface.
 *
 * search() is a generic filter API — actor, action, subject, time range,
 * free-text contains. Result rows include before/after state so the admin
 * can diff a sensitive mutation in one click.
 *
 * verifyChain() is super_admin-only because exposing chain status to a
 * compromised account lets the attacker time their tampering. It walks
 * the index from a checkpoint forward and returns the first break.
 */
export const adminAuditRouter = router({
  search: adminProcedure
    .input(
      z.object({
        actorId: z.string().optional(),
        actorType: z.enum(["merchant", "agent", "admin", "system"]).optional(),
        action: z.string().optional(),
        subjectType: z
          .enum([
            "order",
            "merchant",
            "courier",
            "call",
            "payment",
            "integration",
            "session",
            "pending_awb",
            "admin",
            "system",
          ])
          .optional(),
        subjectId: z.string().optional(),
        merchantId: z.string().optional(),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
        limit: z.number().int().min(1).max(500).default(100),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const filter: Record<string, unknown> = {};
      if (input.actorId && Types.ObjectId.isValid(input.actorId)) {
        filter.actorId = new Types.ObjectId(input.actorId);
      }
      if (input.actorType) filter.actorType = input.actorType;
      if (input.action) filter.action = input.action;
      if (input.subjectType) filter.subjectType = input.subjectType;
      if (input.subjectId && Types.ObjectId.isValid(input.subjectId)) {
        filter.subjectId = new Types.ObjectId(input.subjectId);
      }
      if (input.merchantId && Types.ObjectId.isValid(input.merchantId)) {
        filter.merchantId = new Types.ObjectId(input.merchantId);
      }
      if (input.since || input.until) {
        const at: Record<string, Date> = {};
        if (input.since) at.$gte = input.since;
        if (input.until) at.$lte = input.until;
        filter.at = at;
      }
      if (input.cursor && Types.ObjectId.isValid(input.cursor)) {
        filter._id = { $lt: new Types.ObjectId(input.cursor) };
      }

      const docs = await AuditLog.find(filter)
        .sort({ at: -1, _id: -1 })
        .limit(input.limit + 1)
        .lean();
      const hasMore = docs.length > input.limit;
      const rows = hasMore ? docs.slice(0, input.limit) : docs;
      return {
        rows: rows.map((r) => ({
          id: String(r._id),
          merchantId: r.merchantId ? String(r.merchantId) : null,
          actorId: r.actorId ? String(r.actorId) : null,
          actorEmail: r.actorEmail ?? null,
          actorType: r.actorType ?? null,
          actorScope: r.actorScope ?? null,
          action: r.action,
          subjectType: r.subjectType,
          subjectId: String(r.subjectId),
          meta: r.meta ?? null,
          prevState: r.prevState ?? null,
          nextState: r.nextState ?? null,
          ip: r.ip ?? null,
          userAgent: r.userAgent ?? null,
          at: r.at,
          prevHash: r.prevHash ?? null,
          selfHash: r.selfHash ?? null,
        })),
        nextCursor:
          hasMore && rows.length > 0
            ? String(rows[rows.length - 1]!._id)
            : null,
      };
    }),

  /**
   * Walk the chain forward from a checkpoint and report the first break.
   * super_admin only — see header.
   */
  verifyChain: scopedAdminProcedure("audit.verify_chain")
    .input(
      z
        .object({
          since: z.coerce.date().optional(),
          limit: z.number().int().min(1).max(20000).default(5000),
        })
        .default({ limit: 5000 }),
    )
    .query(async ({ input }) => {
      return verifyAuditChain({ since: input.since, limit: input.limit });
    }),
});
