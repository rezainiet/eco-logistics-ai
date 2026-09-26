import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { InventoryMovement, PRODUCT_CURRENCIES, Product } from "@ecom/db";
import { writeAudit } from "../../lib/audit.js";
import { InventoryError, adjustStock, inTransaction } from "../../lib/inventory.js";
import { assertOwnedAsset, parseObjectId, productView } from "../../lib/commerce/products.js";
import { billableProcedure, merchantObjectId, protectedProcedure, router } from "../trpc.js";

/**
 * Merchant product catalog + stock. Tenant = the authenticated merchant:
 * merchantId always comes from ctx, and every query filters on it, so one
 * merchant can never read or change another's products (a foreign id is
 * simply NOT_FOUND).
 *
 * Price and product fields are edited here; stock is never set directly —
 * it moves only through the inventory library (ledgered, atomic).
 */

const money = z.number().finite().min(0).max(10_000_000);
const name = z.string().trim().min(1, "Name is required").max(120);
const description = z.string().trim().max(2000);
const sku = z
  .string()
  .trim()
  .max(64)
  .regex(/^[A-Za-z0-9._\-/ ]*$/, "SKU may contain letters, numbers, - _ . /");
const editableStatus = z.enum(["draft", "active", "inactive"]);
const threshold = z.number().int().min(0).max(100_000);

const productFields = {
  name,
  description: description.optional(),
  imageAssetId: z.string().max(24).nullish(),
  sku: sku.nullish(),
  price: money,
  compareAtPrice: money.nullish(),
  currency: z.enum(PRODUCT_CURRENCIES).optional(),
  status: editableStatus.optional(),
  lowStockThreshold: threshold.optional(),
};

function checkCompareAt(price: number | undefined, compareAt: number | null | undefined) {
  if (compareAt != null && price != null && compareAt > 0 && compareAt <= price) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Compare-at price must be higher than the price." });
  }
}

function duplicateSku(err: unknown): never {
  if ((err as { code?: number })?.code === 11000) {
    throw new TRPCError({ code: "CONFLICT", message: "Another product already uses this SKU." });
  }
  throw err;
}

function inventoryError(err: unknown): never {
  if (err instanceof InventoryError) {
    const message =
      err.code === "below_reserved"
        ? "Stock can't go below the units reserved by open orders."
        : err.code === "invalid_quantity"
          ? "Enter a whole number of units."
          : "Product not found.";
    throw new TRPCError({ code: err.code === "product_not_found" ? "NOT_FOUND" : "BAD_REQUEST", message });
  }
  throw err;
}

type Ctx = { user: { id: string; email: string }; request: { ip: string | null; userAgent: string | null } };

function audit(ctx: Ctx, action: "product.created" | "product.updated" | "product.archived" | "inventory.adjusted", subjectId: unknown, meta: Record<string, unknown>) {
  const merchantId = merchantObjectId(ctx);
  void writeAudit({
    merchantId,
    actorId: merchantId,
    actorEmail: ctx.user.email,
    actorType: "merchant",
    action,
    subjectType: "product",
    subjectId: subjectId as never,
    meta,
    ip: ctx.request.ip,
    userAgent: ctx.request.userAgent,
  });
}

export const productsRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          status: z.enum(["all", "draft", "active", "inactive"]).default("all"),
          stock: z.enum(["all", "low", "out"]).default("all"),
          search: z.string().trim().max(80).optional(),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const filter: Record<string, unknown> = { merchantId, status: input.status === "all" ? { $ne: "archived" } : input.status };
      if (input.search) {
        const rx = new RegExp(input.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ name: rx }, { sku: rx }];
      }
      const docs = await Product.find(filter).sort({ updatedAt: -1 }).limit(500).lean();
      let items = docs.map(productView);
      if (input.stock === "low") items = items.filter((p) => p.stockStatus === "low_stock");
      if (input.stock === "out") items = items.filter((p) => p.stockStatus === "out_of_stock");
      const all = docs.map(productView);
      return {
        items,
        counts: {
          total: all.length,
          lowStock: all.filter((p) => p.stockStatus === "low_stock").length,
          outOfStock: all.filter((p) => p.stockStatus === "out_of_stock").length,
        },
      };
    }),

  get: protectedProcedure.input(z.object({ id: z.string().max(24) })).query(async ({ ctx, input }) => {
    const p = await Product.findOne({ _id: parseObjectId(input.id, "product id"), merchantId: merchantObjectId(ctx), status: { $ne: "archived" } }).lean();
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Product not found." });
    return productView(p);
  }),

  create: billableProcedure
    .input(z.object({ ...productFields, initialStock: z.number().int().min(0).max(1_000_000).default(0) }))
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      checkCompareAt(input.price, input.compareAtPrice);
      const imageAssetId = await assertOwnedAsset(merchantId, input.imageAssetId);
      const created = await inTransaction(async (session) => {
        const [doc] = await Product.create(
          [
            {
              merchantId,
              name: input.name,
              description: input.description ?? "",
              ...(imageAssetId ? { imageAssetId } : {}),
              ...(input.sku ? { sku: input.sku } : {}),
              price: input.price,
              ...(input.compareAtPrice ? { compareAtPrice: input.compareAtPrice } : {}),
              currency: input.currency ?? "BDT",
              status: input.status ?? "active",
              ...(input.lowStockThreshold !== undefined ? { lowStockThreshold: input.lowStockThreshold } : {}),
              inventory: { onHand: input.initialStock, reserved: 0 },
            },
          ],
          { session },
        );
        if (input.initialStock > 0) {
          await InventoryMovement.create(
            [
              {
                merchantId,
                productId: doc!._id,
                type: "INITIAL_STOCK",
                onHandDelta: input.initialStock,
                reservedDelta: 0,
                onHandAfter: input.initialStock,
                reservedAfter: 0,
                actorId: merchantId,
                actorType: "merchant",
              },
            ],
            { session },
          );
        }
        return doc!;
      }).catch(duplicateSku);
      audit(ctx, "product.created", created._id, { name: created.name, price: created.price, initialStock: input.initialStock });
      return productView(created.toObject());
    }),

  update: billableProcedure
    .input(
      z.object({
        id: z.string().max(24),
        name: name.optional(),
        description: description.optional(),
        imageAssetId: z.string().max(24).nullish(),
        sku: sku.nullish(),
        price: money.optional(),
        compareAtPrice: money.nullish(),
        currency: z.enum(PRODUCT_CURRENCIES).optional(),
        status: editableStatus.optional(),
        lowStockThreshold: threshold.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const _id = parseObjectId(input.id, "product id");
      const current = await Product.findOne({ _id, merchantId, status: { $ne: "archived" } }).lean();
      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Product not found." });
      const price = input.price ?? current.price;
      const compareAt = input.compareAtPrice === undefined ? current.compareAtPrice : input.compareAtPrice;
      checkCompareAt(price, compareAt);

      const $set: Record<string, unknown> = {};
      const $unset: Record<string, ""> = {};
      if (input.name !== undefined) $set.name = input.name;
      if (input.description !== undefined) $set.description = input.description;
      if (input.imageAssetId !== undefined) {
        const img = await assertOwnedAsset(merchantId, input.imageAssetId);
        if (img) $set.imageAssetId = img;
        else $unset.imageAssetId = "";
      }
      if (input.sku !== undefined) {
        if (input.sku) $set.sku = input.sku;
        else $unset.sku = "";
      }
      if (input.price !== undefined) $set.price = input.price;
      if (input.compareAtPrice !== undefined) {
        if (input.compareAtPrice) $set.compareAtPrice = input.compareAtPrice;
        else $unset.compareAtPrice = "";
      }
      if (input.currency !== undefined) $set.currency = input.currency;
      if (input.status !== undefined) $set.status = input.status;
      if (input.lowStockThreshold !== undefined) $set.lowStockThreshold = input.lowStockThreshold;

      const updated = await Product.findOneAndUpdate(
        { _id, merchantId, status: { $ne: "archived" } },
        { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) },
        { new: true },
      )
        .lean()
        .catch(duplicateSku);
      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Product not found." });
      audit(ctx, "product.updated", _id, {
        changed: [...Object.keys($set), ...Object.keys($unset)],
        ...(input.price !== undefined && input.price !== current.price ? { price: { before: current.price, after: input.price } } : {}),
      });
      return productView(updated);
    }),

  /** Hides the product everywhere (dashboard lists, landing pages, checkout). Order history keeps its snapshot. */
  archive: protectedProcedure.input(z.object({ id: z.string().max(24) })).mutation(async ({ ctx, input }) => {
    const merchantId = merchantObjectId(ctx);
    const _id = parseObjectId(input.id, "product id");
    const res = await Product.updateOne({ _id, merchantId, status: { $ne: "archived" } }, { $set: { status: "archived", archivedAt: new Date() } });
    if (res.matchedCount === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Product not found." });
    audit(ctx, "product.archived", _id, {});
    return { id: input.id, archived: true };
  }),

  adjustStock: protectedProcedure
    .input(
      z.object({
        id: z.string().max(24),
        type: z.enum(["RESTOCK", "MANUAL_ADJUSTMENT", "RETURNED"]),
        delta: z.number().int().min(-1_000_000).max(1_000_000),
        reason: z.string().trim().max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const productId = parseObjectId(input.id, "product id");
      const exists = await Product.exists({ _id: productId, merchantId, status: { $ne: "archived" } });
      if (!exists) throw new TRPCError({ code: "NOT_FOUND", message: "Product not found." });
      const inventory = await adjustStock({ merchantId, productId, type: input.type, delta: input.delta, reason: input.reason, actorId: merchantId }).catch(
        inventoryError,
      );
      audit(ctx, "inventory.adjusted", productId, { type: input.type, delta: input.delta, onHandAfter: inventory.onHand });
      const p = await Product.findOne({ _id: productId, merchantId }).lean();
      return productView(p!);
    }),

  movements: protectedProcedure
    .input(z.object({ id: z.string().max(24), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const productId = parseObjectId(input.id, "product id");
      const rows = await InventoryMovement.find({ merchantId, productId }).sort({ createdAt: -1, _id: -1 }).limit(input.limit).lean();
      return rows.map((m) => ({
        id: String(m._id),
        type: m.type,
        onHandDelta: m.onHandDelta,
        reservedDelta: m.reservedDelta,
        onHandAfter: m.onHandAfter,
        reservedAfter: m.reservedAfter,
        orderId: m.orderId ? String(m.orderId) : null,
        reason: m.reason ?? null,
        actorType: m.actorType,
        createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : null,
      }));
    }),
});
