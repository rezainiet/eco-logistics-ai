import type { Types } from "mongoose";
import { findSkuCandidates, lineSku, type SkuCandidate } from "./sku-match.js";

/**
 * Links order lines that arrive without a catalogue reference (dashboard,
 * CSV, Shopify, WooCommerce, custom API) to the product — or variant —
 * whose stock they consume, so the inventory library can reserve it.
 *
 * Same exact-SKU rule as the cost snapshot: a line is linked only when its
 * SKU has exactly ONE candidate in the merchant's catalogue. Never linked:
 *   - no SKU, or a SKU nobody in the catalogue has
 *   - an ambiguous SKU (several products/variants share it)
 *   - an archived product (no longer stocked)
 *   - a product-level SKU of a product that sells variants (its stock is
 *     per variant, and which variant was bought is unknown)
 * A line that already carries a productId (landing-page orders) is left
 * exactly as it is.
 */

interface LinkableItem {
  sku?: string | null;
  productId?: unknown;
  variantId?: unknown;
  variantLabel?: string | null;
}

export type CatalogLinks = Map<string, SkuCandidate[]>;

/** One catalogue lookup for many lines (e.g. a whole CSV batch). */
export function catalogLinksFor(merchantId: Types.ObjectId, lines: ReadonlyArray<LinkableItem>): Promise<CatalogLinks> {
  return findSkuCandidates(
    merchantId,
    lines.filter((l) => !l.productId).map(lineSku).filter((s): s is string => s !== null),
  );
}

/** Applies looked-up links to lines; pure. */
export function applyCatalogLinks<T extends LinkableItem>(items: T[], links: CatalogLinks): T[] {
  return items.map((i) => {
    const sku = lineSku(i);
    if (i.productId || sku === null) return i;
    const found = links.get(sku);
    if (!found || found.length !== 1) return i;
    const c = found[0]!;
    if (!c.stockUnit || c.productStatus === "archived") return i;
    return {
      ...i,
      productId: c.productId,
      ...(c.variantId ? { variantId: c.variantId } : {}),
      ...(c.variantId && c.variantLabel && !i.variantLabel ? { variantLabel: c.variantLabel } : {}),
    };
  });
}

export async function linkItemsToCatalog<T extends LinkableItem>(merchantId: Types.ObjectId, items: T[]): Promise<T[]> {
  return applyCatalogLinks(items, await catalogLinksFor(merchantId, items));
}
