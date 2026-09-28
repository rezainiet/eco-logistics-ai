import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import { MAX_OPTION_VALUES, MAX_VARIANT_OPTIONS, MAX_VARIANTS, VARIANT_STATUSES, availableStock, stockStatusOf } from "@ecom/db";
import { assertOwnedAsset, assetUrlOf } from "./products.js";

/**
 * Product variants (e.g. Color × Size): validation of merchant input and the
 * merchant-facing view. A product either has no variants (stock on the
 * product) or has variants (stock, and optionally price / cost / SKU /
 * image, per variant; missing values fall back to the product's).
 *
 * Stock is never set here: new variants may start with an initial stock that
 * is booked through the ledger (INITIAL_STOCK), and existing variants keep
 * their numbers — the router's compare-and-set makes sure an edit never
 * overwrites stock that moved meanwhile.
 */

const money = z.number().finite().min(0).max(10_000_000);
const label = z.string().trim().min(1).max(30);
const sku = z.string().trim().max(64).regex(/^[A-Za-z0-9._\-/ ]*$/, "SKU may contain letters, numbers, - _ . /");

export const optionInput = z.object({ name: label, values: z.array(label).min(1).max(MAX_OPTION_VALUES) });
export const variantInput = z.object({
  /** Existing variant id (edit); absent for a new combination. */
  id: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  optionValues: z.array(label).min(1).max(MAX_VARIANT_OPTIONS),
  sku: sku.nullish(),
  price: money.nullish(),
  compareAtPrice: money.nullish(),
  costPrice: money.nullish(),
  imageAssetId: z.string().max(24).nullish(),
  status: z.enum(VARIANT_STATUSES).optional(),
  /** New variants only: units in stock to start with (booked as INITIAL_STOCK). */
  initialStock: z.number().int().min(0).max(1_000_000).optional(),
});
export const variantsInput = z.object({
  options: z.array(optionInput).max(MAX_VARIANT_OPTIONS),
  variants: z.array(variantInput).max(MAX_VARIANTS),
});
export type VariantsInput = z.infer<typeof variantsInput>;

type Inv = { onHand: number; reserved: number };
export interface StoredVariant {
  _id: Types.ObjectId;
  optionValues: string[];
  sku?: string;
  price?: number;
  compareAtPrice?: number;
  costPrice?: number;
  imageAssetId?: Types.ObjectId;
  status: (typeof VARIANT_STATUSES)[number];
  inventory: Inv;
}

function bad(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Validates the whole variant set for a product and returns what to store,
 * plus the initial stock to book for NEW variants. `existing` is the
 * product's current variants (their ids, and stock that must be preserved).
 */
export async function buildVariants(
  merchantId: Types.ObjectId,
  input: VariantsInput,
  ctx: { productPrice: number; existing?: ReadonlyArray<{ _id: unknown; inventory?: { onHand?: number | null; reserved?: number | null } | null }> | null },
): Promise<{ options: Array<{ name: string; values: string[] }>; variants: StoredVariant[]; initialStock: Array<{ variantId: Types.ObjectId; quantity: number }> }> {
  const { options, variants } = input;
  if (variants.length && !options.length) bad("Add at least one option (for example Size) before adding variants.");
  if (options.length && !variants.length) bad("Add at least one variant combination.");

  const names = new Set<string>();
  for (const o of options) {
    if (names.has(norm(o.name))) bad(`Option "${o.name}" is listed twice.`);
    names.add(norm(o.name));
    const vals = new Set<string>();
    for (const v of o.values) {
      if (vals.has(norm(v))) bad(`"${v}" is listed twice under ${o.name}.`);
      vals.add(norm(v));
    }
  }

  const existingById = new Map((ctx.existing ?? []).map((v) => [String(v._id), v]));
  const combos = new Set<string>();
  const skus = new Set<string>();
  const out: StoredVariant[] = [];
  const initialStock: Array<{ variantId: Types.ObjectId; quantity: number }> = [];
  for (const v of variants) {
    if (v.optionValues.length !== options.length) bad("Every variant needs one value for each option.");
    const values = v.optionValues.map((value, i) => {
      const match = options[i]!.values.find((x) => norm(x) === norm(value));
      if (!match) bad(`"${value}" is not a value of ${options[i]!.name}.`);
      return match;
    });
    const combo = values.map(norm).join("\u0000");
    if (combos.has(combo)) bad(`The combination ${values.join(" / ")} is listed twice.`);
    combos.add(combo);
    if (v.sku) {
      if (skus.has(v.sku.toLowerCase())) bad(`SKU ${v.sku} is used by two variants.`);
      skus.add(v.sku.toLowerCase());
    }
    const effectivePrice = v.price ?? ctx.productPrice;
    if (v.compareAtPrice != null && v.compareAtPrice > 0 && v.compareAtPrice <= effectivePrice) {
      bad(`Compare-at price of ${values.join(" / ")} must be higher than its price.`);
    }
    const image = await assertOwnedAsset(merchantId, v.imageAssetId ?? null);

    let id: Types.ObjectId;
    let inventory: Inv;
    if (v.id) {
      const prev = existingById.get(v.id);
      if (!prev) bad("A variant does not belong to this product.");
      id = new Types.ObjectId(v.id);
      inventory = { onHand: prev.inventory?.onHand ?? 0, reserved: prev.inventory?.reserved ?? 0 };
      existingById.delete(v.id);
    } else {
      id = new Types.ObjectId();
      inventory = { onHand: v.initialStock ?? 0, reserved: 0 };
      if ((v.initialStock ?? 0) > 0) initialStock.push({ variantId: id, quantity: v.initialStock! });
    }
    out.push({
      _id: id,
      optionValues: values,
      ...(v.sku ? { sku: v.sku } : {}),
      ...(v.price != null ? { price: v.price } : {}),
      ...(v.compareAtPrice ? { compareAtPrice: v.compareAtPrice } : {}),
      ...(v.costPrice != null ? { costPrice: v.costPrice } : {}),
      ...(image ? { imageAssetId: image } : {}),
      status: v.status ?? "active",
      inventory,
    });
  }
  // Variants left out of the new set are removed — only when they hold no stock.
  for (const [, gone] of existingById) {
    if ((gone.inventory?.onHand ?? 0) > 0 || (gone.inventory?.reserved ?? 0) > 0) {
      bad("A variant with stock or open orders can't be removed. Set its stock to 0 (or mark it inactive) first.");
    }
  }
  return { options: options.map((o) => ({ name: o.name, values: o.values })), variants: out, initialStock };
}

type VariantDoc = {
  _id: unknown;
  optionValues?: string[] | null;
  sku?: string | null;
  price?: number | null;
  compareAtPrice?: number | null;
  costPrice?: number | null;
  imageAssetId?: unknown;
  status?: string | null;
  inventory?: { onHand?: number | null; reserved?: number | null } | null;
};

export const variantLabel = (optionValues: ReadonlyArray<string> | null | undefined) => (optionValues ?? []).join(" / ");

/** Merchant-facing variant (dashboard). Includes the private cost price. */
export function variantView(
  p: { price: number; sku?: string | null; costPrice?: number | null; lowStockThreshold?: number | null },
  v: VariantDoc,
) {
  const inv = { onHand: v.inventory?.onHand ?? 0, reserved: v.inventory?.reserved ?? 0 };
  return {
    id: String(v._id),
    optionValues: v.optionValues ?? [],
    label: variantLabel(v.optionValues),
    sku: v.sku ?? null,
    price: v.price ?? null,
    effectivePrice: v.price ?? p.price,
    compareAtPrice: v.compareAtPrice ?? null,
    costPrice: v.costPrice ?? null,
    imageAssetId: v.imageAssetId ? String(v.imageAssetId) : null,
    imageUrl: assetUrlOf(v.imageAssetId),
    status: (v.status ?? "active") as (typeof VARIANT_STATUSES)[number],
    onHand: inv.onHand,
    reserved: inv.reserved,
    available: availableStock(inv),
    stockStatus: stockStatusOf({ inventory: inv, lowStockThreshold: p.lowStockThreshold }),
  };
}
