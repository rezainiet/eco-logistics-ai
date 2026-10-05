import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CatalogProduct, MAX_CART_LINES } from "@ecom/landing";
import { addToCart, buyNowLines, lineKey } from "@/lib/commerce/cart";
import { initialPicks } from "@/app/lp/[label]/[[...locale]]/variant-picker";

/**
 * Buy now on the public page (Product spotlight, and the mobile order bar
 * pointed at one): the existing cart, then the existing checkout drawer.
 */

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const P = "6ab73cca06587711398245c7";
const RED_M = "6ab73cca06587711398245d1";
const RED_L = "6ab73cca06587711398245d2";
const BLUE_M = "6ab73cca06587711398245d3";
const BLUE_L = "6ab73cca06587711398245d4";
const MUG = "6ab73cca06587711398245e1";

const tee: CatalogProduct = {
  id: P,
  name: "Tee",
  description: "",
  imageAssetId: null,
  price: 450,
  compareAtPrice: null,
  currency: "BDT",
  available: true,
  stockStatus: "in_stock",
  maxQuantity: 5,
  badge: null,
  ctaText: null,
  featured: true,
  options: [
    { name: "Color", values: ["Red", "Blue"] },
    { name: "Size", values: ["M", "L"] },
  ],
  variants: [
    { id: RED_M, optionValues: ["Red", "M"], label: "Red / M", price: 500, compareAtPrice: null, imageAssetId: null, available: true, stockStatus: "in_stock", maxQuantity: 5 },
    { id: RED_L, optionValues: ["Red", "L"], label: "Red / L", price: 550, compareAtPrice: null, imageAssetId: null, available: true, stockStatus: "low_stock", maxQuantity: 1 },
    { id: BLUE_M, optionValues: ["Blue", "M"], label: "Blue / M", price: 450, compareAtPrice: null, imageAssetId: null, available: false, stockStatus: "out_of_stock", maxQuantity: 0 },
    { id: BLUE_L, optionValues: ["Blue", "L"], label: "Blue / L", price: 450, compareAtPrice: null, imageAssetId: null, available: true, stockStatus: "in_stock", maxQuantity: 3 },
  ],
  priceFrom: true,
};
const mug: CatalogProduct = { ...tee, id: MUG, name: "Mug", price: 300, maxQuantity: 4, options: undefined, variants: undefined, priceFrom: undefined };
const v = (id: string) => tee.variants!.find((x) => x.id === id)!;

describe("buyNowLines", () => {
  it("adds the item when it isn't in the cart, keeping what's already there", () => {
    const start = addToCart([], mug, 2);
    expect(buyNowLines(start, tee, 1, v(RED_M))).toEqual([
      { productId: MUG, quantity: 2 },
      { productId: P, variantId: RED_M, quantity: 1 },
    ]);
    expect(buyNowLines([], mug)).toEqual([{ productId: MUG, quantity: 1 }]);
  });

  it("never adds a second batch: pressing Buy now again leaves the cart as it is", () => {
    const once = buyNowLines([], mug);
    const twice = buyNowLines(once, mug);
    expect(twice).toBe(once);
    const bigger = addToCart([], mug, 3);
    expect(buyNowLines(bigger, mug, 1)).toBe(bigger); // more already in the cart: kept
  });

  it("raises the quantity to what was asked (capped by stock), never lowers it", () => {
    const one = buyNowLines([], tee, 1, v(BLUE_L));
    expect(buyNowLines(one, tee, 2, v(BLUE_L))).toEqual([{ productId: P, variantId: BLUE_L, quantity: 2 }]);
    expect(buyNowLines(one, tee, 9, v(BLUE_L))).toEqual([{ productId: P, variantId: BLUE_L, quantity: 3 }]);
  });

  it("refuses without an explicit variant, for unavailable variants and unavailable products", () => {
    expect(buyNowLines([], tee, 1)).toEqual([]);
    expect(buyNowLines([], tee, 1, null)).toEqual([]);
    expect(buyNowLines([], tee, 1, v(BLUE_M))).toEqual([]);
    expect(buyNowLines([], { ...mug, available: false, maxQuantity: 0 })).toEqual([]);
    // Stale lines already in a stored cart are left for the cart to reconcile, never bumped.
    const staleSimple = [{ productId: P, quantity: 1 }];
    expect(buyNowLines(staleSimple, tee, 2)).toBe(staleSimple);
    const soldOut = [{ productId: P, variantId: BLUE_M, quantity: 1 }];
    expect(buyNowLines(soldOut, tee, 2, v(BLUE_M))).toBe(soldOut);
  });

  it("a full cart is left alone (the page then shows the cart and why)", () => {
    const full = Array.from({ length: MAX_CART_LINES }, (_, i) => ({ productId: `6ab73cca06587711398246${String(i).padStart(2, "0")}`, quantity: 1 }));
    const next = buyNowLines(full, mug);
    expect(next).toBe(full);
    expect(next.some((l) => lineKey(l) === MUG)).toBe(false);
  });
});

describe("initialPicks (option chip → picker)", () => {
  it("starts from the clicked value plus the first available variant that has it", () => {
    expect(initialPicks(tee, { index: 0, value: "Red" })).toEqual(["Red", "M"]);
    expect(initialPicks(tee, { index: 1, value: "L" })).toEqual(["Red", "L"]);
    expect(initialPicks(tee, { index: 0, value: "Blue" })).toEqual(["Blue", "L"]); // skips sold-out Blue / M
  });

  it("never starts on something that can't be bought, or on a value that isn't offered", () => {
    const blueGone: CatalogProduct = { ...tee, variants: tee.variants!.map((x) => (x.optionValues[0] === "Blue" ? { ...x, available: false, maxQuantity: 0 } : x)) };
    expect(initialPicks(blueGone, { index: 0, value: "Blue" })).toBeNull();
    expect(initialPicks(tee, { index: 0, value: "Green" })).toBeNull();
    expect(initialPicks(tee, { index: 5, value: "Red" })).toBeNull();
    expect(initialPicks(tee, undefined)).toBeNull();
    expect(initialPicks(mug, { index: 0, value: "Red" })).toBeNull();
  });
});

describe("wiring: the existing cart and checkout, nothing new", () => {
  const commerce = src("../src/app/lp/[label]/[[...locale]]/landing-commerce.tsx");
  const picker = src("../src/app/lp/[label]/[[...locale]]/variant-picker.tsx");

  it("the one delegated listener handles Buy now inside the landing root only, before add-to-cart", () => {
    expect(commerce.match(/document\.addEventListener\("click"/g)).toHaveLength(1);
    const buyAt = commerce.indexOf('closest<HTMLElement>("[data-lp-cart-buy]")');
    const addAt = commerce.indexOf('closest<HTMLButtonElement>("button[data-lp-cart-add]")');
    expect(buyAt).toBeGreaterThan(0);
    expect(addAt).toBeGreaterThan(buyAt);
    expect(commerce).toContain('buy.closest("[data-landing-root]")');
    // Only products from the page's catalog, and only available ones.
    expect(commerce).toMatch(/const product = byId\.get\(buy\.dataset\.lpCartBuy \?\? ""\);\s*if \(!product \|\| !product\.available\) return;/);
  });

  it("variant products always go through the picker (explicit choice); simple products go straight to checkout", () => {
    expect(commerce).toMatch(/if \(product\.variants\?\.length\) \{[\s\S]{0,400}setPicking\(\{ product, mode: "buy"/);
    expect(commerce).toContain("buyNowRef.current(product, null, 1)");
    expect(commerce).toContain('picking.mode === "buy" ? buyNow(picking.product, variant, quantity)');
    expect(commerce).toContain('actionLabel={picking.mode === "buy" ? t.orderNow : undefined}');
  });

  it("Buy now opens the existing drawer at the details step and reports checkout start; no new order endpoint", () => {
    const buyNow = commerce.slice(commerce.indexOf("const buyNow = ("), commerce.indexOf("const buyNowRef"));
    expect(buyNow).toContain("buyNowLines(prev, product, quantity, variant)");
    expect(buyNow).toContain('openDrawer("details")');
    expect(buyNow).toContain("startCheckout(next)");
    expect(buyNow).not.toMatch(/fetch\(|\/api\//);
    // The order is still placed by the existing request only (plus cart recovery).
    expect([...commerce.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1])).toEqual(["/api/recover", "/api/checkout"]);
  });

  it("the picker never starts on an unavailable variant", () => {
    expect(picker).toContain("initialPicks(product, initial) ??");
    expect(picker).toContain("{actionLabel ?? t.addToCart}");
  });
});
