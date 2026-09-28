import { describe, expect, it } from "vitest";
import type { CatalogProduct } from "@ecom/landing";
import { addToCart, cartTotals, lineKey, parseCart, reconcileCart, removeFromCart, setQuantity } from "@/lib/commerce/cart";

/** Cart lines per product, or per variant of a product with variants. */

const P = "6ab73cca06587711398245c7";
const RED_M = "6ab73cca06587711398245d1";
const BLUE_L = "6ab73cca06587711398245d2";
const MUG = "6ab73cca06587711398245e1";

const tee: CatalogProduct = {
  id: P,
  name: "Tee",
  description: "",
  imageAssetId: "6ab73cca06587711398245f0",
  price: 450,
  compareAtPrice: null,
  currency: "BDT",
  available: true,
  stockStatus: "in_stock",
  maxQuantity: 5,
  badge: null,
  ctaText: null,
  featured: false,
  options: [
    { name: "Color", values: ["Red", "Blue"] },
    { name: "Size", values: ["M", "L"] },
  ],
  variants: [
    { id: RED_M, optionValues: ["Red", "M"], label: "Red / M", price: 500, compareAtPrice: null, imageAssetId: "6ab73cca06587711398245f1", available: true, stockStatus: "in_stock", maxQuantity: 5 },
    { id: BLUE_L, optionValues: ["Blue", "L"], label: "Blue / L", price: 450, compareAtPrice: null, imageAssetId: null, available: true, stockStatus: "low_stock", maxQuantity: 2 },
  ],
  priceFrom: true,
};
const mug: CatalogProduct = { ...tee, id: MUG, name: "Mug", price: 300, maxQuantity: 4, options: undefined, variants: undefined, priceFrom: undefined };
const v = (id: string) => tee.variants!.find((x) => x.id === id)!;

describe("cart with variants", () => {
  it("different variants are separate lines; the same variant merges; simple products unchanged", () => {
    let lines = addToCart([], tee, 2, v(RED_M));
    lines = addToCart(lines, tee, 1, v(BLUE_L));
    lines = addToCart(lines, tee, 1, v(RED_M));
    lines = addToCart(lines, mug, 1);
    expect(lines).toEqual([
      { productId: P, variantId: RED_M, quantity: 3 },
      { productId: P, variantId: BLUE_L, quantity: 1 },
      { productId: MUG, quantity: 1 },
    ]);
    const t = cartTotals(lines, [tee, mug]);
    expect(t.lines.map((l) => [l.key, l.price, l.imageAssetId, l.lineTotal])).toEqual([
      [`${P}:${RED_M}`, 500, "6ab73cca06587711398245f1", 1500],
      [`${P}:${BLUE_L}`, 450, tee.imageAssetId, 450], // no variant image → product image
      [MUG, 300, tee.imageAssetId, 300],
    ]);
    expect(t.subtotal).toBe(2250);
    expect(t.count).toBe(5);
  });

  it("a product with variants can't be added without choosing one; quantities cap per variant", () => {
    expect(addToCart([], tee, 1)).toEqual([]);
    let lines = addToCart([], tee, 9, v(BLUE_L));
    expect(lines[0]!.quantity).toBe(2);
    lines = setQuantity(lines, tee, 5, v(BLUE_L));
    expect(lines[0]!.quantity).toBe(2);
    lines = removeFromCart(lines, lineKey({ productId: P, variantId: BLUE_L }));
    expect(lines).toEqual([]);
  });

  it("reconcile drops variants that disappeared or sold out, and keeps the rest", () => {
    const lines = [
      { productId: P, variantId: RED_M, quantity: 4 },
      { productId: P, variantId: BLUE_L, quantity: 1 },
      { productId: P, quantity: 1 }, // a stale simple line for a product that now has variants
    ];
    const soldOut: CatalogProduct = { ...tee, variants: [{ ...v(RED_M), maxQuantity: 3 }, { ...v(BLUE_L), available: false, maxQuantity: 0 }] };
    expect(reconcileCart(lines, [soldOut])).toEqual([{ productId: P, variantId: RED_M, quantity: 3 }]);
  });

  it("parses stored carts, rejecting malformed variant ids and duplicate lines", () => {
    expect(
      parseCart([
        { productId: P, variantId: RED_M, quantity: 1 },
        { productId: P, variantId: RED_M, quantity: 2 },
        { productId: P, variantId: "<x>", quantity: 1 },
        { productId: MUG, quantity: 1 },
      ]),
    ).toEqual([
      { productId: P, variantId: RED_M, quantity: 1 },
      { productId: MUG, quantity: 1 },
    ]);
  });
});
