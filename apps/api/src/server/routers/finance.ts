import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import { AuditLog, FINANCE_CATEGORIES, FinanceEntry, financeCategory, type FinanceEntry as FinanceEntryDoc } from "@ecom/db";
import { writeAudit } from "../../lib/audit.js";
import { dhakaMidnight, resolvePeriod } from "../../lib/finance/period.js";
import { financeMonthly, financeSummary } from "../../lib/finance/report.js";
import { orderProfitList } from "../../lib/finance/order-cost.js";
import { merchantObjectId, protectedProcedure, router } from "../trpc.js";

/**
 * Merchant accounting (BDT). Tenant = the authenticated merchant: merchantId
 * always comes from ctx and every query filters on it, so another
 * merchant's entry is simply NOT_FOUND. Entries are voided, never deleted.
 * Sales revenue is computed from delivered orders (lib/finance/report.ts) and
 * cannot be entered by hand.
 */

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date")
  .refine((d) => {
    try {
      dhakaMidnight(d);
      return true;
    } catch {
      return false;
    }
  }, "Invalid date");

const period = z.discriminatedUnion("preset", [
  z.object({ preset: z.literal("today") }),
  z.object({ preset: z.literal("month") }),
  z.object({ preset: z.literal("year") }),
  z.object({ preset: z.literal("custom"), from: day, to: day }),
]);

/** Positive BDT amount with at most 2 decimals (poisha). */
const amount = z
  .number()
  .finite()
  .positive("Amount must be more than 0")
  .max(1_000_000_000)
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "At most 2 decimal places");

const text = (max: number) => z.string().trim().max(max);

function parseId(id: string): Types.ObjectId {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid entry id." });
  return new Types.ObjectId(id);
}

function assertCategory(type: "income" | "expense", category: string) {
  const c = financeCategory(category);
  if (!c || c.type !== type) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown ${type} category "${category}".` });
  }
}

type EntryDoc = Pick<
  FinanceEntryDoc,
  "_id" | "type" | "category" | "amount" | "currency" | "occurredOn" | "description" | "reference" | "status" | "voidReason" | "voidedAt"
> & { createdAt?: Date; updatedAt?: Date; source?: { kind?: string } | null };

function entryView(e: EntryDoc) {
  return {
    id: String(e._id),
    type: e.type,
    category: e.category,
    categoryLabel: financeCategory(e.category)?.label ?? e.category,
    amount: e.amount,
    currency: e.currency,
    occurredOn: e.occurredOn,
    description: e.description ?? "",
    reference: e.reference ?? "",
    source: e.source?.kind ?? "manual",
    status: e.status,
    voidReason: e.voidReason ?? null,
    voidedAt: e.voidedAt ? new Date(e.voidedAt).toISOString() : null,
    createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : null,
    updatedAt: e.updatedAt ? new Date(e.updatedAt).toISOString() : null,
  };
}

type Ctx = { user: { id: string; email: string }; request: { ip: string | null; userAgent: string | null } };

function audit(
  ctx: Ctx,
  action: "finance.entry_created" | "finance.entry_updated" | "finance.entry_voided",
  subjectId: Types.ObjectId,
  extra: { meta?: Record<string, unknown>; prevState?: unknown; nextState?: unknown },
) {
  const merchantId = merchantObjectId(ctx);
  void writeAudit({
    merchantId,
    actorId: merchantId,
    actorEmail: ctx.user.email,
    actorType: "merchant",
    action,
    subjectType: "finance_entry",
    subjectId,
    ...extra,
    ip: ctx.request.ip,
    userAgent: ctx.request.userAgent,
  });
}

const auditState = (e: EntryDoc) => ({
  type: e.type,
  category: e.category,
  amount: e.amount,
  occurredOn: e.occurredOn,
  description: e.description ?? "",
  reference: e.reference ?? "",
  status: e.status,
});

export const financeRouter = router({
  categories: protectedProcedure.query(() => ({
    income: FINANCE_CATEGORIES.filter((c) => c.type === "income").map(({ key, label, bucket }) => ({ key, label, bucket })),
    expense: FINANCE_CATEGORIES.filter((c) => c.type === "expense").map(({ key, label, bucket }) => ({ key, label, bucket })),
  })),

  summary: protectedProcedure.input(z.object({ period })).query(async ({ ctx, input }) => {
    return financeSummary(merchantObjectId(ctx), resolvePeriod(input.period));
  }),

  monthly: protectedProcedure.input(z.object({ year: z.number().int().min(2000).max(2100) })).query(async ({ ctx, input }) => {
    const p = resolvePeriod({ preset: "custom", from: `${input.year}-01-01`, to: `${input.year}-12-31` });
    return financeMonthly(merchantObjectId(ctx), input.year, p);
  }),

  list: protectedProcedure
    .input(
      z.object({
        period,
        type: z.enum(["income", "expense"]).optional(),
        category: text(40).optional(),
        includeVoid: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(100),
        cursor: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const p = resolvePeriod(input.period);
      const filter: Record<string, unknown> = {
        merchantId: merchantObjectId(ctx),
        occurredOn: { $gte: p.fromDay, $lte: p.toDay },
      };
      if (!input.includeVoid) filter.status = "active";
      if (input.type) filter.type = input.type;
      if (input.category) filter.category = input.category;
      if (input.cursor) filter._id = { $lt: new Types.ObjectId(input.cursor) };
      const docs = await FinanceEntry.find(filter)
        .sort({ occurredOn: -1, _id: -1 })
        .limit(input.limit + 1)
        .lean();
      const page = docs.slice(0, input.limit);
      return {
        items: page.map((d) => entryView(d as EntryDoc)),
        nextCursor: docs.length > input.limit ? String(page[page.length - 1]!._id) : null,
      };
    }),

  create: protectedProcedure
    .input(
      z.object({
        type: z.enum(["income", "expense"]),
        category: text(40).min(1),
        amount,
        occurredOn: day,
        description: text(500).optional(),
        reference: text(120).optional(),
        idempotencyKey: z.string().trim().min(8).max(80),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      assertCategory(input.type, input.category);
      const existing = await FinanceEntry.findOne({ merchantId, idempotencyKey: input.idempotencyKey }).lean();
      if (existing) return entryView(existing as EntryDoc);
      let created;
      try {
        created = await FinanceEntry.create({
          merchantId,
          type: input.type,
          category: input.category,
          amount: input.amount,
          currency: "BDT",
          occurredOn: input.occurredOn,
          description: input.description ?? "",
          reference: input.reference ?? "",
          source: { kind: "manual" },
          status: "active",
          createdBy: merchantId,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (err) {
        // A concurrent submission with the same key won the unique index.
        if ((err as { code?: number })?.code === 11000) {
          const winner = await FinanceEntry.findOne({ merchantId, idempotencyKey: input.idempotencyKey }).lean();
          if (winner) return entryView(winner as EntryDoc);
        }
        throw err;
      }
      const view = entryView(created.toObject() as EntryDoc);
      audit(ctx, "finance.entry_created", created._id, { nextState: auditState(created.toObject() as EntryDoc) });
      return view;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().max(24),
        category: text(40).min(1).optional(),
        amount: amount.optional(),
        occurredOn: day.optional(),
        description: text(500).optional(),
        reference: text(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const _id = parseId(input.id);
      const current = await FinanceEntry.findOne({ _id, merchantId }).lean();
      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Entry not found." });
      if (current.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: "A void entry can't be edited." });
      if (input.category !== undefined) assertCategory(current.type, input.category);

      const $set: Record<string, unknown> = { updatedBy: merchantId };
      for (const k of ["category", "amount", "occurredOn", "description", "reference"] as const) {
        if (input[k] !== undefined) $set[k] = input[k];
      }
      // Only while still active: a concurrent void wins.
      const updated = await FinanceEntry.findOneAndUpdate({ _id, merchantId, status: "active" }, { $set }, { new: true }).lean();
      if (!updated) throw new TRPCError({ code: "CONFLICT", message: "The entry was voided — refresh and try again." });
      audit(ctx, "finance.entry_updated", _id, {
        prevState: auditState(current as EntryDoc),
        nextState: auditState(updated as EntryDoc),
      });
      return entryView(updated as EntryDoc);
    }),

  /**
   * Order-level profit for the period: delivered orders (revenue − product
   * cost − courier fee) and returned parcels (courier fee), dated like the
   * P&L. `missingOnly` lists the orders whose cost is not recorded.
   */
  orderProfit: protectedProcedure
    .input(
      z.object({
        period,
        missingOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().max(200).nullable().default(null),
      }),
    )
    .query(({ ctx, input }) =>
      orderProfitList(merchantObjectId(ctx), resolvePeriod(input.period), { missingOnly: input.missingOnly, limit: input.limit, cursor: input.cursor }),
    ),

  /** One entry's change history (created / edited / voided), oldest first, from the audit trail. */
  entryHistory: protectedProcedure.input(z.object({ id: z.string().max(24) })).query(async ({ ctx, input }) => {
    const merchantId = merchantObjectId(ctx);
    const _id = parseId(input.id);
    if (!(await FinanceEntry.exists({ _id, merchantId }))) throw new TRPCError({ code: "NOT_FOUND", message: "Entry not found." });
    // Index {merchantId, subjectType, subjectId, at}.
    const rows = await AuditLog.find({
      merchantId,
      subjectType: "finance_entry",
      subjectId: _id,
      action: { $in: ["finance.entry_created", "finance.entry_updated", "finance.entry_voided"] },
    })
      .sort({ at: 1 })
      .limit(100)
      .select("action at actorEmail prevState nextState meta")
      .lean();
    return rows.map((r) => {
      const prev = (r.prevState ?? {}) as Record<string, unknown>;
      const next = (r.nextState ?? {}) as Record<string, unknown>;
      const changes = r.action === "finance.entry_updated"
        ? Object.keys(next)
            .filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]))
            .map((k) => ({ field: k, from: prev[k] ?? null, to: next[k] ?? null }))
        : [];
      return {
        at: r.at,
        action: r.action.replace("finance.entry_", "") as "created" | "updated" | "voided",
        by: r.actorEmail ?? null,
        changes,
        reason: typeof (r.meta as { reason?: unknown } | undefined)?.reason === "string" ? ((r.meta as { reason: string }).reason || null) : null,
      };
    });
  }),

  void: protectedProcedure
    .input(z.object({ id: z.string().max(24), reason: text(300).optional() }))
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const _id = parseId(input.id);
      const voided = await FinanceEntry.findOneAndUpdate(
        { _id, merchantId, status: "active" },
        { $set: { status: "void", voidedAt: new Date(), voidedBy: merchantId, voidReason: input.reason ?? "" } },
        { new: true },
      ).lean();
      if (voided) {
        audit(ctx, "finance.entry_voided", _id, { meta: { reason: input.reason ?? "" }, prevState: { status: "active" }, nextState: { status: "void" } });
        return entryView(voided as EntryDoc);
      }
      const current = await FinanceEntry.findOne({ _id, merchantId }).lean();
      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Entry not found." });
      return entryView(current as EntryDoc); // already void: idempotent
    }),
});
