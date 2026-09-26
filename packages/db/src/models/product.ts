import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";

const { Schema, model, models } = mongoose;

/**
 * A merchant's sellable product. Tenant = Merchant; every read and write is
 * scoped by `merchantId` (apps/api/src/server/routers/products.ts).
 *
 * Stock lives on the product (`inventory`) and is only ever changed by the
 * inventory library (apps/api/src/lib/inventory.ts) with conditional atomic
 * updates, each paired with an `InventoryMovement` row in the same
 * transaction:
 *   onHand    physical units in the merchant's stock
 *   reserved  units promised to open orders (not yet delivered/cancelled)
 *   available = onHand − reserved  (never negative — enforced by the guards)
 *
 * "Out of stock" is not a stored status: it is derived from `available`, so
 * it can never disagree with the numbers.
 */
export const PRODUCT_STATUSES = ["draft", "active", "inactive", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/** Currencies a product may be priced in. BDT is the default. */
export const PRODUCT_CURRENCIES = ["BDT", "USD"] as const;
export type ProductCurrency = (typeof PRODUCT_CURRENCIES)[number];
export const DEFAULT_CURRENCY: ProductCurrency = "BDT";

export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

const inventorySchema = new Schema(
  {
    onHand: { type: Number, required: true, default: 0, min: 0 },
    reserved: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false },
);

const productSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 2000, default: "" },
    /** A LandingAsset of the same merchant (uploaded through the asset route). */
    imageAssetId: { type: Schema.Types.ObjectId, ref: "LandingAsset" },
    sku: { type: String, trim: true, maxlength: 64 },
    price: { type: Number, required: true, min: 0 },
    compareAtPrice: { type: Number, min: 0 },
    currency: { type: String, enum: PRODUCT_CURRENCIES, default: DEFAULT_CURRENCY, required: true },
    status: { type: String, enum: PRODUCT_STATUSES, default: "active", required: true },
    lowStockThreshold: { type: Number, min: 0, default: DEFAULT_LOW_STOCK_THRESHOLD },
    inventory: { type: inventorySchema, required: true, default: () => ({ onHand: 0, reserved: 0 }) },
    archivedAt: { type: Date },
  },
  { timestamps: true, collection: "products" },
);

productSchema.index({ merchantId: 1, status: 1, updatedAt: -1 });
productSchema.index(
  { merchantId: 1, sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $type: "string" } } },
);

export type Product = InferSchemaType<typeof productSchema> & { _id: Types.ObjectId };

export const Product: Model<Product> =
  (models.Product as Model<Product>) || model<Product>("Product", productSchema);

export type StockStatus = "in_stock" | "low_stock" | "out_of_stock";

export function availableStock(inv: { onHand?: number | null; reserved?: number | null } | null | undefined): number {
  return Math.max(0, (inv?.onHand ?? 0) - (inv?.reserved ?? 0));
}

export function stockStatusOf(p: {
  inventory?: { onHand?: number | null; reserved?: number | null } | null;
  lowStockThreshold?: number | null;
}): StockStatus {
  const available = availableStock(p.inventory);
  if (available <= 0) return "out_of_stock";
  if (available <= (p.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD)) return "low_stock";
  return "in_stock";
}

/**
 * Append-only stock ledger. Every change to a product's `inventory` writes
 * exactly one row here, in the same transaction.
 *
 * `key` makes order-driven movements idempotent: it is
 * "<orderId>:<cycle>:<type>" and unique per merchant, so a repeated
 * webhook, retry or double-click can never apply the same movement twice.
 */
export const INVENTORY_MOVEMENT_TYPES = [
  "INITIAL_STOCK",
  "RESTOCK",
  "ORDER_RESERVED",
  "ORDER_CANCELLED",
  "ORDER_FULFILLED",
  "MANUAL_ADJUSTMENT",
  "RETURNED",
] as const;
export type InventoryMovementType = (typeof INVENTORY_MOVEMENT_TYPES)[number];

const inventoryMovementSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    type: { type: String, enum: INVENTORY_MOVEMENT_TYPES, required: true },
    /** Change to on-hand units (signed). */
    onHandDelta: { type: Number, required: true, default: 0 },
    /** Change to reserved units (signed). */
    reservedDelta: { type: Number, required: true, default: 0 },
    onHandAfter: { type: Number, required: true },
    reservedAfter: { type: Number, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order" },
    key: { type: String, maxlength: 120 },
    reason: { type: String, trim: true, maxlength: 300 },
    actorId: { type: Schema.Types.ObjectId },
    actorType: { type: String, enum: ["merchant", "system", "customer"], default: "system" },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "inventory_movements" },
);

inventoryMovementSchema.index({ merchantId: 1, productId: 1, createdAt: -1 });
inventoryMovementSchema.index({ merchantId: 1, orderId: 1 }, { partialFilterExpression: { orderId: { $exists: true } } });
inventoryMovementSchema.index(
  { merchantId: 1, key: 1 },
  { unique: true, partialFilterExpression: { key: { $type: "string" } } },
);

function refuseMovementUpdate() {
  throw new Error("InventoryMovement is append-only");
}
inventoryMovementSchema.pre("updateOne", refuseMovementUpdate);
inventoryMovementSchema.pre("updateMany", refuseMovementUpdate);
inventoryMovementSchema.pre("findOneAndUpdate", refuseMovementUpdate);
inventoryMovementSchema.pre("replaceOne", refuseMovementUpdate);

export type InventoryMovement = InferSchemaType<typeof inventoryMovementSchema> & { _id: Types.ObjectId };

export const InventoryMovement: Model<InventoryMovement> =
  (models.InventoryMovement as Model<InventoryMovement>) ||
  model<InventoryMovement>("InventoryMovement", inventoryMovementSchema);
