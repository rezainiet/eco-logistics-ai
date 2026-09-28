import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { LandingAsset, type Product, availableStock, hasVariants, stockStatusOf } from "@ecom/db";
import { variantView } from "./variants.js";
import { landingAssetBaseUrl } from "../landing/resolve.js";

/**
 * Product helpers shared by the products router, landing-page product
 * selection and the public landing payload.
 */

export function assetUrlOf(assetId: unknown): string | null {
  const id = assetId ? String(assetId) : "";
  return /^[a-f0-9]{24}$/.test(id) ? `${landingAssetBaseUrl()}/${id}` : null;
}

type ProductDoc = Pick<
  Product,
  "_id" | "name" | "description" | "imageAssetId" | "sku" | "price" | "compareAtPrice" | "costPrice" | "currency" | "status" | "lowStockThreshold" | "inventory" | "options" | "variants"
> & { createdAt?: Date; updatedAt?: Date };

/** Merchant-facing product shape (dashboard). */
export function productView(p: ProductDoc) {
  const variants = hasVariants(p) ? (p.variants ?? []).map((v) => variantView(p, v)) : [];
  const active = variants.filter((v) => v.status === "active");
  return {
    id: String(p._id),
    name: p.name,
    description: p.description ?? "",
    imageAssetId: p.imageAssetId ? String(p.imageAssetId) : null,
    imageUrl: assetUrlOf(p.imageAssetId),
    sku: p.sku ?? null,
    price: p.price,
    compareAtPrice: p.compareAtPrice ?? null,
    /** Private to the merchant — productView is only used on authenticated routes. */
    costPrice: p.costPrice ?? null,
    currency: p.currency ?? "BDT",
    status: p.status,
    lowStockThreshold: p.lowStockThreshold ?? 5,
    // A product with variants: totals over its (active) variants.
    onHand: variants.length ? active.reduce((s, v) => s + v.onHand, 0) : (p.inventory?.onHand ?? 0),
    reserved: variants.length ? active.reduce((s, v) => s + v.reserved, 0) : (p.inventory?.reserved ?? 0),
    available: variants.length ? active.reduce((s, v) => s + v.available, 0) : availableStock(p.inventory),
    stockStatus: stockStatusOf(p),
    hasVariants: variants.length > 0,
    options: (p.options ?? []).map((o) => ({ name: o.name, values: [...(o.values ?? [])] })),
    variants,
    createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : null,
  };
}

export type ProductView = ReturnType<typeof productView>;

/** An image must be an asset the same merchant uploaded. */
export async function assertOwnedAsset(merchantId: Types.ObjectId, assetId: string | null | undefined): Promise<Types.ObjectId | null> {
  if (!assetId) return null;
  if (!/^[a-f0-9]{24}$/.test(assetId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid image." });
  const id = new Types.ObjectId(assetId);
  const owned = await LandingAsset.exists({ _id: id, merchantId });
  if (!owned) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid image." });
  return id;
}

export function parseObjectId(id: string, what = "id"): Types.ObjectId {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new TRPCError({ code: "BAD_REQUEST", message: `invalid ${what}` });
  return new Types.ObjectId(id);
}
