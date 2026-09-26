import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { LandingAsset, type Product, availableStock, stockStatusOf } from "@ecom/db";
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
  "_id" | "name" | "description" | "imageAssetId" | "sku" | "price" | "compareAtPrice" | "currency" | "status" | "lowStockThreshold" | "inventory"
> & { createdAt?: Date; updatedAt?: Date };

/** Merchant-facing product shape (dashboard). */
export function productView(p: ProductDoc) {
  return {
    id: String(p._id),
    name: p.name,
    description: p.description ?? "",
    imageAssetId: p.imageAssetId ? String(p.imageAssetId) : null,
    imageUrl: assetUrlOf(p.imageAssetId),
    sku: p.sku ?? null,
    price: p.price,
    compareAtPrice: p.compareAtPrice ?? null,
    currency: p.currency ?? "BDT",
    status: p.status,
    lowStockThreshold: p.lowStockThreshold ?? 5,
    onHand: p.inventory?.onHand ?? 0,
    reserved: p.inventory?.reserved ?? 0,
    available: availableStock(p.inventory),
    stockStatus: stockStatusOf(p),
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
