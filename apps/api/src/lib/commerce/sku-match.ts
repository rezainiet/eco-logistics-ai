import type { Types } from "mongoose";
import { Product } from "@ecom/db";

/**
 * Exact-SKU lookup in one merchant's catalogue — the single matching rule
 * shared by the order-cost snapshot (lib/finance/order-cost.ts) and the
 * stock link (lib/commerce/catalog-link.ts).
 *
 * Every product whose own SKU, or one of whose variants' SKU, equals an
 * order line's SKU is a candidate. Callers act only on a SKU with exactly
 * ONE candidate; anything else is ambiguous and is never guessed.
 */

export interface SkuCandidate {
  productId: Types.ObjectId;
  /** Set when the SKU belongs to a variant. */
  variantId?: Types.ObjectId;
  /** Readable variant label ("Red / M"), when it is a variant. */
  variantLabel?: string;
  /** The candidate's cost per unit (a variant without its own uses the product's); null = not recorded. */
  cost: number | null;
  productStatus: string;
  /** False for a product-level SKU on a product that sells variants: its stock lives on the variants. */
  stockUnit: boolean;
}

/** Trimmed, non-empty SKU of a line, or null. */
export function lineSku(item: { sku?: string | null }): string | null {
  return typeof item.sku === "string" && item.sku.trim() ? item.sku.trim() : null;
}

/** SKU → every catalogue candidate of that merchant (empty map when no SKU is given). */
export async function findSkuCandidates(
  merchantId: Types.ObjectId,
  skus: readonly string[],
): Promise<Map<string, SkuCandidate[]>> {
  const out = new Map<string, SkuCandidate[]>();
  const wanted = [...new Set(skus)];
  if (wanted.length === 0) return out;
  const products = await Product.find({ merchantId, $or: [{ sku: { $in: wanted } }, { "variants.sku": { $in: wanted } }] })
    .select("sku costPrice status variants._id variants.sku variants.costPrice variants.optionValues")
    .lean();
  const add = (sku: string, c: SkuCandidate) => {
    const list = out.get(sku) ?? [];
    list.push(c);
    out.set(sku, list);
  };
  for (const p of products) {
    const variants = p.variants ?? [];
    if (p.sku && wanted.includes(p.sku)) {
      add(p.sku, {
        productId: p._id,
        cost: typeof p.costPrice === "number" ? p.costPrice : null,
        productStatus: p.status,
        stockUnit: variants.length === 0,
      });
    }
    for (const v of variants) {
      if (!v.sku || !wanted.includes(v.sku)) continue;
      const cost = v.costPrice ?? p.costPrice;
      add(v.sku, {
        productId: p._id,
        variantId: v._id,
        variantLabel: (v.optionValues ?? []).join(" / ") || undefined,
        cost: typeof cost === "number" ? cost : null,
        productStatus: p.status,
        stockUnit: true,
      });
    }
  }
  return out;
}
