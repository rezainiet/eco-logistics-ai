import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";
import { Merchant, Order, ORDER_STATUSES } from "@ecom/db";
import { protectedProcedure, router } from "../trpc.js";
import { cached } from "../../lib/cache.js";
import { filterHash } from "../../lib/hash.js";

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

function merchantObjectId(ctx: { user: { id: string } }): Types.ObjectId {
  return new Types.ObjectId(ctx.user.id);
}

function generateOrderNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 0xfff).toString(16).toUpperCase().padStart(3, "0");
  return `ORD-${ts}-${rand}`;
}

export const ordersRouter = router({
  createOrder: protectedProcedure.input(createOrderInput).mutation(async ({ ctx, input }) => {
    const total = input.total ?? input.items.reduce((s, i) => s + i.price * i.quantity, 0);
    const order = await Order.create({
      merchantId: merchantObjectId(ctx),
      orderNumber: input.orderNumber ?? generateOrderNumber(),
      customer: input.customer,
      items: input.items,
      order: { cod: input.cod, total, status: "pending" },
    });
    return { id: String(order._id), orderNumber: order.orderNumber };
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
        items: page.map((o) => ({
          id: String(o._id),
          orderNumber: o.orderNumber,
          status: o.order.status,
          cod: o.order.cod,
          total: o.order.total,
          customer: o.customer,
          courier: o.logistics?.courier,
          trackingNumber: o.logistics?.trackingNumber,
          riskScore: o.fraud?.riskScore ?? 0,
          createdAt: o.createdAt,
        })),
      };
    }),

  bulkUpload: protectedProcedure
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
      const docs: Array<Record<string, unknown>> = [];
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
        docs.push({
          merchantId,
          orderNumber: row.orderNumber || generateOrderNumber(),
          customer: {
            name: row.customerName,
            phone: row.customerPhone,
            address: row.customerAddress,
            district: row.customerDistrict,
          },
          items: [{ name: row.itemName || "Item", quantity, price }],
          order: { cod, total: price * quantity, status: "pending" },
        });
      });

      let inserted = 0;
      for (let i = 0; i < docs.length; i += BULK_CHUNK) {
        const batch = docs.slice(i, i + BULK_CHUNK);
        try {
          const result = await Order.insertMany(batch, { ordered: false });
          inserted += result.length;
        } catch (err: any) {
          inserted += err?.result?.insertedCount ?? err?.insertedDocs?.length ?? 0;
          const writeErrors = err?.writeErrors ?? [];
          for (const we of writeErrors) {
            errors.push({ row: i + (we.index ?? 0) + 2, error: we.errmsg ?? "write error" });
          }
        }
      }

      return { inserted, errors, totalRows: rows.length };
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
