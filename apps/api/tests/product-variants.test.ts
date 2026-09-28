import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { FinanceEntry, InventoryMovement, Order, Product } from "@ecom/db";
import { placeLandingOrder, type PlaceOrderInput } from "../src/lib/commerce/landing-orders.js";
import { reconcileOrderInventory } from "../src/lib/inventory.js";
import { ensureSystemTemplates, __resetTemplateCacheForTests } from "../src/lib/landing/templates.js";
import { resolveLandingPageByHost } from "../src/lib/landing/resolve.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Product variants (Color × Size …): per-variant price / SKU / image / stock,
 * multi-variant carts and orders, per-variant reservations through the same
 * inventory ledger, order snapshots, and the unchanged simple-product path.
 */

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const ALL = { preset: "custom" as const, from: "2024-01-01", to: "2030-12-31" };
let seq = 0;
const key = () => `var-${Date.now()}-${++seq}-abcdefgh`;
const customer = { name: "রহিম", phone: "01712345678", address: "বাড়ি ১২, রোড ৫, ধানমন্ডি", district: "ঢাকা" };

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Product.syncIndexes(), InventoryMovement.syncIndexes(), Order.syncIndexes(), FinanceEntry.syncIndexes()]);
});
afterAll(disconnectDb);
beforeEach(async () => {
  await resetDb();
  __resetTemplateCacheForTests();
});
afterEach(() => vi.restoreAllMocks());

type Caller = ReturnType<typeof callerFor>;

const TEE = {
  options: [
    { name: "Color", values: ["Red", "Blue"] },
    { name: "Size", values: ["M", "L"] },
  ],
  variants: [
    { optionValues: ["Red", "M"], sku: "TEE-R-M", price: 500, costPrice: 200, initialStock: 5 },
    { optionValues: ["Red", "L"], sku: "TEE-R-L", price: 550, initialStock: 1 },
    { optionValues: ["Blue", "M"], sku: "TEE-B-M", initialStock: 0 },
    { optionValues: ["Blue", "L"], sku: "TEE-B-L", compareAtPrice: 600, initialStock: 3 },
  ],
};

async function merchant() {
  const m = await createMerchant();
  return { m, caller: callerFor(authUserFor(m)) };
}

/** A published landing page selling a variant T-shirt (and a simple mug). */
async function shop(tee = TEE) {
  await ensureSystemTemplates();
  const { m, caller } = await merchant();
  const product = await caller.products.create({ name: "Tee", price: 450, costPrice: 150, variants: tee });
  const mug = await caller.products.create({ name: "Mug", price: 300, initialStock: 4 });
  const tpl = (await caller.landingPages.templates()).find((t) => t.key === "bd-modern-shop")!;
  const page = await caller.landingPages.create({ templateId: tpl.id, name: "Shop" });
  const got = await caller.landingPages.get({ id: page.id });
  const bn = (got.draftContent as Record<string, Record<string, Record<string, unknown>>>).bn!;
  bn.order!.cta = { label: "অর্ডার", action: { kind: "whatsapp", phone: "+8801711000000", message: "" } };
  const saved = await caller.landingPages.saveDraft({ id: page.id, content: { bn }, expectedRevision: 1 });
  const linked = await caller.landingPages.setProducts({ id: page.id, expectedRevision: saved.page.draftRevision, products: [{ productId: product.id }, { productId: mug.id }] });
  const slug = `var-${seq++}-shop`;
  await caller.landingPages.setSlug({ id: page.id, slug });
  await caller.landingPages.publish({ id: page.id, expectedRevision: linked.page.draftRevision });
  const host = `${slug}.localhost`;
  const resolved = await resolveLandingPageByHost(host, { rootDomain: "localhost", useCache: false });
  if (resolved.kind !== "ok") throw new Error("not published");
  const v = (label: string) => product.variants.find((x) => x.label === label)!;
  const place = (items: PlaceOrderInput["items"], extra: Partial<PlaceOrderInput> = {}) =>
    placeLandingOrder({ host, locale: null, idempotencyKey: key(), items, customer, deliveryOptionId: resolved.commerce!.delivery[0]!.id, ...extra });
  return { m, caller, product, mug, v, place, host, resolved };
}

const stockOf = async (productId: string, variantId?: string) => {
  const p = (await Product.findById(productId).lean())!;
  return variantId ? p.variants!.find((x) => String(x._id) === variantId)!.inventory : p.inventory;
};

describe("creating and editing variants", () => {
  it("one dimension and two dimensions; per-variant price, SKU, stock booked in the ledger", async () => {
    const { caller } = await merchant();
    const one = await caller.products.create({
      name: "Cap",
      price: 200,
      variants: { options: [{ name: "Color", values: ["Black", "White"] }], variants: [{ optionValues: ["Black"], initialStock: 2 }, { optionValues: ["White"], price: 250 }] },
    });
    expect(one.hasVariants).toBe(true);
    expect(one.variants.map((v) => [v.label, v.effectivePrice, v.onHand])).toEqual([["Black", 200, 2], ["White", 250, 0]]);
    expect(one.onHand).toBe(2); // sum of variants; the product's own stock stays 0
    expect((await Product.findById(one.id).lean())!.inventory).toMatchObject({ onHand: 0, reserved: 0 });

    const tee = await caller.products.create({ name: "Tee", price: 450, variants: TEE });
    expect(tee.variants.map((v) => v.label)).toEqual(["Red / M", "Red / L", "Blue / M", "Blue / L"]);
    expect(tee.variants.map((v) => v.sku)).toEqual(["TEE-R-M", "TEE-R-L", "TEE-B-M", "TEE-B-L"]);
    const moves = await InventoryMovement.find({ productId: tee.id }).lean();
    expect(moves.map((m) => [m.type, m.onHandDelta, String(m.variantId)]).sort()).toEqual(
      [
        ["INITIAL_STOCK", 5, tee.variants[0]!.id],
        ["INITIAL_STOCK", 1, tee.variants[1]!.id],
        ["INITIAL_STOCK", 3, tee.variants[3]!.id],
      ].sort(),
    );
  });

  it("rejects invalid combinations, duplicates, unknown values, duplicate SKUs and bad compare-at prices", async () => {
    const { caller } = await merchant();
    const opt = [{ name: "Size", values: ["S", "M"] }];
    const make = (variants: object[], options: object[] = opt) =>
      caller.products.create({ name: "X", price: 100, variants: { options, variants } as never });
    await expect(make([{ optionValues: ["S", "Red"] }])).rejects.toThrow(/one value for each option/);
    await expect(make([{ optionValues: ["XL"] }])).rejects.toThrow(/not a value of Size/);
    await expect(make([{ optionValues: ["S"] }, { optionValues: ["s"] }])).rejects.toThrow(/listed twice/);
    await expect(make([{ optionValues: ["S"], sku: "A" }, { optionValues: ["M"], sku: "a" }])).rejects.toThrow(/SKU a is used by two/i);
    await expect(make([{ optionValues: ["S"], price: 100, compareAtPrice: 90 }])).rejects.toThrow(/Compare-at/);
    await expect(make([{ optionValues: ["S"] }], [{ name: "Size", values: ["S", "S"] }])).rejects.toThrow(/listed twice under Size/);
    await expect(make([], opt)).rejects.toThrow(/at least one variant/);
    await expect(caller.products.create({ name: "X", price: 100, initialStock: 3, variants: { options: opt, variants: [{ optionValues: ["S"] }] } })).rejects.toThrow(/per variant/);
  });

  it("variant images must be the merchant's own uploads", async () => {
    const a = await merchant();
    const b = await merchant();
    const theirs = await b.caller.landingPages.uploadAsset({ dataUrl: `data:image/png;base64,${PNG_1PX}` });
    const mine = await a.caller.landingPages.uploadAsset({ dataUrl: `data:image/png;base64,${PNG_1PX}` });
    const opts = [{ name: "Color", values: ["Red"] }];
    await expect(a.caller.products.create({ name: "X", price: 1, variants: { options: opts, variants: [{ optionValues: ["Red"], imageAssetId: theirs.id }] } })).rejects.toThrow(/Invalid image/);
    const ok = await a.caller.products.create({ name: "X", price: 1, variants: { options: opts, variants: [{ optionValues: ["Red"], imageAssetId: mine.id }] } });
    expect(ok.variants[0]!.imageAssetId).toBe(mine.id);
    expect(ok.variants[0]!.imageUrl).toMatch(new RegExp(`${mine.id}$`));
  });

  it("editing keeps each variant's stock; removing a variant with stock is refused; adding one books its initial stock", async () => {
    const { caller } = await merchant();
    const tee = await caller.products.create({ name: "Tee", price: 450, variants: TEE });
    const withIds = tee.variants.map((v) => ({ id: v.id, optionValues: v.optionValues, sku: v.sku, price: v.price }));
    const edited = await caller.products.update({
      id: tee.id,
      variants: {
        options: [{ name: "Color", values: ["Red", "Blue", "Green"] }, TEE.options[1]!],
        variants: [...withIds.map((v, i) => (i === 0 ? { ...v, price: 520 } : v)), { optionValues: ["Green", "M"], initialStock: 7 }],
      },
    });
    expect(edited.variants.find((v) => v.label === "Red / M")).toMatchObject({ onHand: 5, effectivePrice: 520 });
    expect(edited.variants.find((v) => v.label === "Green / M")).toMatchObject({ onHand: 7 });
    expect(await InventoryMovement.countDocuments({ productId: tee.id, type: "INITIAL_STOCK" })).toBe(4);

    // "Red / M" (5 in stock) left out → refused.
    await expect(caller.products.update({ id: tee.id, variants: { options: TEE.options, variants: withIds.slice(1) } })).rejects.toThrow(/can't be removed/);
    // "Blue / M" has no stock → can be removed (every variant holding stock is kept).
    const keep = edited.variants.filter((v) => v.label !== "Blue / M").map((v) => ({ id: v.id, optionValues: v.optionValues, sku: v.sku, price: v.price }));
    const fewer = await caller.products.update({
      id: tee.id,
      variants: { options: [{ name: "Color", values: ["Red", "Blue", "Green"] }, TEE.options[1]!], variants: keep },
    });
    expect(fewer.variants.map((v) => v.label)).toEqual(["Red / M", "Red / L", "Blue / L", "Green / M"]);
    expect(fewer.variants.find((v) => v.label === "Green / M")!.onHand).toBe(7);
  });

  it("an edit never overwrites stock that moved meanwhile (compare-and-set → CONFLICT)", async () => {
    const { caller } = await merchant();
    const tee = await caller.products.create({ name: "Tee", price: 450, variants: TEE });
    const redM = tee.variants[0]!.id;
    const realFindOne = Product.findOne.bind(Product);
    vi.spyOn(Product, "findOne").mockImplementationOnce(((...args: Parameters<typeof Product.findOne>) => {
      const q = realFindOne(...args);
      const origLean = q.lean.bind(q);
      (q as unknown as { lean: () => Promise<unknown> }).lean = async () => {
        const doc = await origLean();
        // A checkout reserves a unit between the editor's read and its write.
        await Product.updateOne({ _id: tee.id }, { $inc: { "variants.$[v].inventory.reserved": 1 } }, { arrayFilters: [{ "v._id": new Types.ObjectId(redM) }] });
        return doc;
      };
      return q;
    }) as never);
    await expect(
      caller.products.update({ id: tee.id, variants: { options: TEE.options, variants: tee.variants.map((v) => ({ id: v.id, optionValues: v.optionValues, price: 999 })) } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await stockOf(tee.id, redM)).toMatchObject({ onHand: 5, reserved: 1 });
    expect((await Product.findById(tee.id).lean())!.variants![0]!.price).toBe(500);
  });

  it("a simple product with stock can't silently become a variant product", async () => {
    const { caller } = await merchant();
    const mug = await caller.products.create({ name: "Mug", price: 300, initialStock: 4 });
    await expect(caller.products.update({ id: mug.id, variants: { options: [{ name: "Color", values: ["Red"] }], variants: [{ optionValues: ["Red"] }] } })).rejects.toThrow(/stock of its own/);
    await caller.products.adjustStock({ id: mug.id, type: "MANUAL_ADJUSTMENT", delta: -4 });
    const converted = await caller.products.update({ id: mug.id, variants: { options: [{ name: "Color", values: ["Red"] }], variants: [{ optionValues: ["Red"], initialStock: 2 }] } });
    expect(converted.hasVariants).toBe(true);
    expect(converted.onHand).toBe(2);
  });

  it("stock adjustments name the variant; wrong or missing variant is refused", async () => {
    const { caller } = await merchant();
    const tee = await caller.products.create({ name: "Tee", price: 450, variants: TEE });
    const mug = await caller.products.create({ name: "Mug", price: 300, initialStock: 1 });
    await expect(caller.products.adjustStock({ id: tee.id, type: "RESTOCK", delta: 2 })).rejects.toThrow(/Choose which variant/);
    await expect(caller.products.adjustStock({ id: tee.id, type: "RESTOCK", delta: 2, variantId: new Types.ObjectId().toHexString() })).rejects.toThrow(/Variant not found/);
    await expect(caller.products.adjustStock({ id: mug.id, type: "RESTOCK", delta: 2, variantId: tee.variants[0]!.id })).rejects.toThrow(/no variants/);
    const after = await caller.products.adjustStock({ id: tee.id, type: "RESTOCK", delta: 2, variantId: tee.variants[2]!.id });
    expect(after.variants[2]).toMatchObject({ label: "Blue / M", onHand: 2 });
    await expect(caller.products.adjustStock({ id: tee.id, type: "MANUAL_ADJUSTMENT", delta: -9, variantId: tee.variants[2]!.id })).rejects.toThrow();
    const mv = await caller.products.movements({ id: tee.id });
    expect(mv[0]).toMatchObject({ type: "RESTOCK", onHandDelta: 2, variantId: tee.variants[2]!.id });
  });
});

describe("public catalog", () => {
  it("shows options and public variant data only — never cost", async () => {
    const { resolved, product } = await shop();
    const p = resolved.commerce!.products.find((x) => x.id === product.id)!;
    expect(p.options).toEqual(TEE.options);
    expect(p.variants!.map((v) => [v.label, v.price, v.available, v.maxQuantity])).toEqual([
      ["Red / M", 500, true, 5],
      ["Red / L", 550, true, 1],
      ["Blue / M", 450, false, 0],
      ["Blue / L", 450, true, 3],
    ]);
    expect(p.price).toBe(450);
    expect(p.priceFrom).toBe(true);
    expect(p.variants![3]!.compareAtPrice).toBe(600);
    // No private field anywhere in the public payload (keys, not words — the template footer says "All rights reserved.").
    expect(JSON.stringify(resolved)).not.toMatch(/"(costPrice|unitCost|cost|onHand|reserved|inventory)":/);
  });
});

describe("checkout with variants", () => {
  it("different variants of one product are separate lines in one order; each reserves its own stock", async () => {
    const { place, product, v, mug } = await shop();
    const r = await place([
      { productId: product.id, variantId: v("Red / M").id, quantity: 2 },
      { productId: product.id, variantId: v("Blue / L").id, quantity: 1 },
      { productId: mug.id, quantity: 1 },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.subtotal).toBe(500 * 2 + 450 + 300);
    expect(r.items.map((i) => [i.name, i.variantLabel ?? null, i.quantity, i.price])).toEqual([
      ["Tee (Red / M)", "Red / M", 2, 500],
      ["Tee (Blue / L)", "Blue / L", 1, 450],
      ["Mug", null, 1, 300],
    ]);
    const o = (await Order.findOne({ orderNumber: r.orderNumber }).lean())!;
    expect(o.items[0]).toMatchObject({ sku: "TEE-R-M", unitCost: 200, variantLabel: "Red / M", variantOptions: [{ name: "Color", value: "Red" }, { name: "Size", value: "M" }] });
    expect(o.items[1]).toMatchObject({ sku: "TEE-B-L", unitCost: 150 }); // no variant cost → product cost
    expect(await stockOf(product.id, v("Red / M").id)).toMatchObject({ onHand: 5, reserved: 2 });
    expect(await stockOf(product.id, v("Blue / L").id)).toMatchObject({ onHand: 3, reserved: 1 });
    expect(await stockOf(mug.id)).toMatchObject({ onHand: 4, reserved: 1 });
    const moves = await InventoryMovement.find({ orderId: o._id }).lean();
    expect(moves.map((m) => m.key).sort()).toEqual(
      [`${o._id}:1:ORDER_RESERVED:${product.id}:${v("Red / M").id}`, `${o._id}:1:ORDER_RESERVED:${product.id}:${v("Blue / L").id}`, `${o._id}:1:ORDER_RESERVED:${mug.id}`].sort(),
    );
  });

  it("the same variant sent twice merges into one line", async () => {
    const { place, product, v } = await shop();
    const r = await place([
      { productId: product.id, variantId: v("Red / M").id, quantity: 1 },
      { productId: product.id, variantId: v("Red / M").id, quantity: 2 },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.quantity).toBe(3);
  });

  it("server-authoritative: variant required, foreign/inactive variant refused, browser price never used", async () => {
    const { place, product, v, mug, caller } = await shop();
    expect(await place([{ productId: product.id, quantity: 1 }])).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await place([{ productId: mug.id, variantId: v("Red / M").id, quantity: 1 }])).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await place([{ productId: product.id, variantId: new Types.ObjectId().toHexString(), quantity: 1 }])).toMatchObject({ ok: false, code: "unavailable" });
    // Another product's variant id is not a variant of this product.
    const other = await caller.products.create({ name: "Other", price: 1, variants: { options: [{ name: "S", values: ["A"] }], variants: [{ optionValues: ["A"], initialStock: 1 }] } });
    expect(await place([{ productId: product.id, variantId: other.variants[0]!.id, quantity: 1 }])).toMatchObject({ ok: false, code: "unavailable" });
    expect(await place([{ productId: product.id, variantId: v("Blue / M").id, quantity: 1 }])).toMatchObject({ ok: false, code: "unavailable", variantIds: [v("Blue / M").id] });
    // A tampered price is refused with the server's prices.
    const tampered = await place([{ productId: product.id, variantId: v("Red / M").id, quantity: 1, unitPrice: 1 }]);
    expect(tampered).toMatchObject({ ok: false, code: "price_changed", prices: [{ productId: product.id, variantId: v("Red / M").id, price: 500 }] });
    // Inactive variant → unavailable.
    const cur = (await caller.products.get({ id: product.id })).variants;
    await caller.products.update({ id: product.id, variants: { options: TEE.options, variants: cur.map((x) => ({ id: x.id, optionValues: x.optionValues, price: x.price, sku: x.sku, status: x.label === "Red / L" ? ("inactive" as const) : ("active" as const) })) } });
    expect(await place([{ productId: product.id, variantId: v("Red / L").id, quantity: 1 }])).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("insufficient variant stock, and two buyers racing for a variant's last unit: exactly one wins", async () => {
    const { place, product, v } = await shop();
    expect(await place([{ productId: product.id, variantId: v("Red / L").id, quantity: 2 }])).toMatchObject({
      ok: false,
      code: "insufficient_stock",
      variantId: v("Red / L").id,
      available: 1,
    });
    const results = await Promise.all([
      place([{ productId: product.id, variantId: v("Red / L").id, quantity: 1 }], { customer: { ...customer, phone: "01711111111" } }),
      place([{ productId: product.id, variantId: v("Red / L").id, quantity: 1 }], { customer: { ...customer, phone: "01722222222" } }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "insufficient_stock" });
    expect(await stockOf(product.id, v("Red / L").id)).toMatchObject({ onHand: 1, reserved: 1 });
  });

  it("orders keep their snapshot when the variant is edited later; cancel/deliver move each variant's stock once", async () => {
    const { place, product, v, caller } = await shop();
    const r = await place([
      { productId: product.id, variantId: v("Red / M").id, quantity: 2 },
      { productId: product.id, variantId: v("Blue / L").id, quantity: 1 },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const cur = (await caller.products.get({ id: product.id })).variants;
    await caller.products.update({
      id: product.id,
      variants: { options: TEE.options, variants: cur.map((x) => ({ id: x.id, optionValues: x.optionValues, sku: `${x.sku}-NEW`, price: 999, costPrice: 1 })) },
    });
    const o = (await Order.findOne({ orderNumber: r.orderNumber }).lean())!;
    expect(o.items.map((i) => [i.price, i.sku, i.unitCost, i.variantLabel])).toEqual([
      [500, "TEE-R-M", 200, "Red / M"],
      [450, "TEE-B-L", 150, "Blue / L"],
    ]);
    // Deliver: each variant's reservation becomes a shipment exactly once (repeat reconcile = no-op).
    for (const s of ["confirmed", "packed", "shipped", "delivered"]) await caller.orders.updateOrder({ id: String(o._id), status: s as never });
    await reconcileOrderInventory(o._id);
    expect(await stockOf(product.id, v("Red / M").id)).toMatchObject({ onHand: 3, reserved: 0 });
    expect(await stockOf(product.id, v("Blue / L").id)).toMatchObject({ onHand: 2, reserved: 0 });
    // Accounting: revenue and product cost come from the snapshot.
    const s = await caller.finance.summary({ period: ALL });
    expect(s.productCost).toMatchObject({ fromOrders: 200 * 2 + 150, complete: true });
    expect(s.revenue.realized).toBe(o.order.total);

    // A second order, cancelled: reservations released per variant.
    const r2 = await place([{ productId: product.id, variantId: v("Red / M").id, quantity: 1 }]);
    if (!r2.ok) throw new Error(JSON.stringify(r2));
    const o2 = (await Order.findOne({ orderNumber: r2.orderNumber }).lean())!;
    await caller.orders.updateOrder({ id: String(o2._id), status: "cancelled" });
    await caller.orders.updateOrder({ id: String(o2._id), status: "cancelled" });
    expect(await stockOf(product.id, v("Red / M").id)).toMatchObject({ onHand: 3, reserved: 0 });
    expect((await InventoryMovement.find({ orderId: o2._id }).lean()).map((m) => m.type).sort()).toEqual(["ORDER_CANCELLED", "ORDER_RESERVED"]);
  });

  it("marketing attribution still reaches a variant order", async () => {
    const { place, product, v } = await shop();
    const r = await place([{ productId: product.id, variantId: v("Red / M").id, quantity: 1 }], {
      attribution: { lastTouch: { at: new Date().toISOString(), source: "facebook", medium: "cpc" } },
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect((await Order.findOne({ orderNumber: r.orderNumber }).lean())!.attribution!.lastTouch).toMatchObject({ channel: "meta" });
  });
});

describe("tenant isolation", () => {
  it("merchant B can't read, edit or restock merchant A's variants, nor buy them through B's page", async () => {
    const a = await shop();
    const b = await merchant();
    await expect(b.caller.products.get({ id: a.product.id })).rejects.toThrow(/not found/i);
    await expect(b.caller.products.update({ id: a.product.id, variants: { options: TEE.options, variants: [] } })).rejects.toThrow(/not found/i);
    await expect(b.caller.products.adjustStock({ id: a.product.id, type: "RESTOCK", delta: 5, variantId: a.v("Red / M").id })).rejects.toThrow(/not found/i);
    // B's variant ids are rejected as A's variants, and A's product is not on B's page.
    const bTee = await b.caller.products.create({ name: "Tee", price: 1, variants: { options: [{ name: "S", values: ["A"] }], variants: [{ optionValues: ["A"], initialStock: 1 }] } });
    expect(await a.place([{ productId: a.product.id, variantId: bTee.variants[0]!.id, quantity: 1 }])).toMatchObject({ ok: false, code: "unavailable" });
    expect(await a.place([{ productId: bTee.id, variantId: bTee.variants[0]!.id, quantity: 1 }])).toMatchObject({ ok: false, code: "not_on_page" });
    expect(await stockOf(a.product.id, a.v("Red / M").id)).toMatchObject({ onHand: 5, reserved: 0 });
  });
});
