import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Types } from "mongoose";
import { InventoryMovement, PRODUCT_CURRENCIES, Product, hasVariants } from "@ecom/db";
import { writeAudit } from "../../lib/audit.js";
import { InventoryError, adjustStock, inTransaction } from "../../lib/inventory.js";
import { assertOwnedAsset, parseObjectId, productView } from "../../lib/commerce/products.js";
import { buildVariants, variantsInput } from "../../lib/commerce/variants.js";
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
  /** What one unit costs the merchant; optional, private (never public). */
  costPrice: money.nullish(),
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
    .input(z.object({ ...productFields, initialStock: z.number().int().min(0).max(1_000_000).default(0), variants: variantsInput.optional() }))
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      checkCompareAt(input.price, input.compareAtPrice);
      const imageAssetId = await assertOwnedAsset(merchantId, input.imageAssetId);
      // Variants: stock lives per variant (the product's own stays 0).
      const built =
        input.variants && (input.variants.options.length || input.variants.variants.length)
          ? await buildVariants(merchantId, input.variants, { productPrice: input.price })
          : null;
      if (built && input.initialStock > 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A product with variants keeps stock per variant — set each variant's stock instead." });
      }
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
              ...(input.costPrice != null ? { costPrice: input.costPrice } : {}),
              currency: input.currency ?? "BDT",
              status: input.status ?? "active",
              ...(input.lowStockThreshold !== undefined ? { lowStockThreshold: input.lowStockThreshold } : {}),
              inventory: { onHand: input.initialStock, reserved: 0 },
              ...(built ? { options: built.options, variants: built.variants } : {}),
            },
          ],
          { session },
        );
        if (built?.initialStock.length) {
          await InventoryMovement.create(
            built.initialStock.map((v) => ({
              merchantId,
              productId: doc!._id,
              variantId: v.variantId,
              type: "INITIAL_STOCK",
              onHandDelta: v.quantity,
              reservedDelta: 0,
              onHandAfter: v.quantity,
              reservedAfter: 0,
              actorId: merchantId,
              actorType: "merchant",
            })),
            { session, ordered: true },
          );
        }
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
        costPrice: money.nullish(),
        currency: z.enum(PRODUCT_CURRENCIES).optional(),
        status: editableStatus.optional(),
        lowStockThreshold: threshold.optional(),
        /** Replaces the whole variant set (omit to leave variants unchanged; empty lists = no variants). */
        variants: variantsInput.optional(),
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
      // Cost changes apply to new orders only: placed orders keep their unitCost snapshot.
      if (input.costPrice !== undefined) {
        if (input.costPrice != null) $set.costPrice = input.costPrice;
        else $unset.costPrice = "";
      }
      if (input.currency !== undefined) $set.currency = input.currency;
      if (input.status !== undefined) $set.status = input.status;
      if (input.lowStockThreshold !== undefined) $set.lowStockThreshold = input.lowStockThreshold;

      // ---- Variants: validated, and saved only if no stock moved meanwhile ----
      const filter: Record<string, unknown> = { _id, merchantId, status: { $ne: "archived" } };
      let initialStock: Array<{ variantId: Types.ObjectId; quantity: number }> = [];
      if (input.variants) {
        const had = hasVariants(current);
        const wants = input.variants.variants.length > 0;
        if (!had && wants && ((current.inventory?.onHand ?? 0) > 0 || (current.inventory?.reserved ?? 0) > 0)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This product has stock of its own. Set its stock to 0 (and let open orders finish) before adding variants.",
          });
        }
        const built = await buildVariants(merchantId, input.variants, { productPrice: price, existing: current.variants ?? [] });
        initialStock = built.initialStock;
        if (wants) {
          $set.options = built.options;
          $set.variants = built.variants;
        } else {
          $unset.options = "";
          $unset.variants = "";
        }
        // Compare-and-set on every existing stock number (a checkout may have
        // reserved units while the merchant was editing).
        if (had) {
          const cur = current.variants ?? [];
          filter.variants = {
            $size: cur.length,
            $all: cur.map((v) => ({ $elemMatch: { _id: v._id, "inventory.onHand": v.inventory?.onHand ?? 0, "inventory.reserved": v.inventory?.reserved ?? 0 } })),
          };
        } else {
          filter["inventory.onHand"] = current.inventory?.onHand ?? 0;
          filter["inventory.reserved"] = current.inventory?.reserved ?? 0;
        }
      }

      const updateDoc = { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) };
      const updated = input.variants
        ? await inTransaction(async (session) => {
            const doc = await Product.findOneAndUpdate(filter, updateDoc, { new: true, session }).lean();
            if (!doc) return null;
            if (initialStock.length) {
              await InventoryMovement.create(
                initialStock.map((v) => ({
                  merchantId,
                  productId: _id,
                  variantId: v.variantId,
                  type: "INITIAL_STOCK",
                  onHandDelta: v.quantity,
                  reservedDelta: 0,
                  onHandAfter: v.quantity,
                  reservedAfter: 0,
                  actorId: merchantId,
                  actorType: "merchant",
                })),
                { session, ordered: true },
              );
            }
            return doc;
          }).catch(duplicateSku)
        : await Product.findOneAndUpdate(filter, updateDoc, { new: true }).lean().catch(duplicateSku);
      if (!updated) {
        const still = await Product.exists({ _id, merchantId, status: { $ne: "archived" } });
        if (!still) throw new TRPCError({ code: "NOT_FOUND", message: "Product not found." });
        throw new TRPCError({ code: "CONFLICT", message: "Stock changed while you were editing (a new order?). Reload and try again." });
      }
      audit(ctx, "product.updated", _id, {
        changed: [...Object.keys($set), ...Object.keys($unset)],
        ...(input.variants ? { variants: input.variants.variants.length, newVariantStock: initialStock.length } : {}),
        ...(input.price !== undefined && input.price !== current.price ? { price: { before: current.price, after: input.price } } : {}),
        ...(input.costPrice !== undefined && (input.costPrice ?? null) !== (current.costPrice ?? null)
          ? { costPrice: { before: current.costPrice ?? null, after: input.costPrice ?? null } }
          : {}),
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
        /** Required for a product with variants: which variant's stock changes. */
        variantId: z.string().max(24).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const productId = parseObjectId(input.id, "product id");
      const product = await Product.findOne({ _id: productId, merchantId, status: { $ne: "archived" } }).select("variants._id").lean();
      if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "Product not found." });
      let variantId: Types.ObjectId | undefined;
      if (hasVariants(product)) {
        if (!input.variantId) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose which variant's stock to change." });
        variantId = parseObjectId(input.variantId, "variant id");
        if (!product.variants!.some((v) => String(v._id) === String(variantId))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Variant not found." });
        }
      } else if (input.variantId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This product has no variants." });
      }
      const inventory = await adjustStock({
        merchantId,
        productId,
        ...(variantId ? { variantId } : {}),
        type: input.type,
        delta: input.delta,
        reason: input.reason,
        actorId: merchantId,
      }).catch(inventoryError);
      audit(ctx, "inventory.adjusted", productId, { type: input.type, delta: input.delta, onHandAfter: inventory.onHand, ...(variantId ? { variantId: String(variantId) } : {}) });
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
        variantId: m.variantId ? String(m.variantId) : null,
        reason: m.reason ?? null,
        actorType: m.actorType,
        createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : null,
      }));
    }),
});
