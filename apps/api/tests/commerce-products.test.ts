import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { InventoryMovement, LandingAsset, Order, Product } from "@ecom/db";
import {
  InventoryError,
  adjustStock,
  inTransaction,
  reconcileOrderInventory,
  reserveOrderStock,
} from "../src/lib/inventory.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Product catalog + inventory: tenant isolation, validation, the stock
 * ledger, atomic reservation under concurrency, and idempotent
 * order-driven stock transitions.
 */

async function merchantCaller(email: string) {
  const m = await createMerchant({ email });
  return { merchant: m, caller: callerFor(authUserFor(m)) };
}

const shirt = { name: "Premium Cotton Shirt", price: 1290, sku: "SHIRT-01", initialStock: 23 };

beforeAll(async () => {
  await ensureDb();
  // autoIndex is async; the unique indexes are part of what is tested.
  await Product.syncIndexes();
  await InventoryMovement.syncIndexes();
});
afterAll(disconnectDb);

describe("product catalog", () => {
  beforeEach(resetDb);

  it("creates a product with BDT default, derived stock status and an INITIAL_STOCK movement", async () => {
    const { merchant, caller } = await merchantCaller("a@shop.test");
    const p = await caller.products.create(shirt);
    expect(p).toMatchObject({ name: shirt.name, price: 1290, currency: "BDT", status: "active", onHand: 23, reserved: 0, available: 23, stockStatus: "in_stock" });
    const moves = await InventoryMovement.find({ productId: p.id }).lean();
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ type: "INITIAL_STOCK", onHandDelta: 23, onHandAfter: 23, reservedAfter: 0 });
    expect(String(moves[0]!.merchantId)).toBe(String(merchant._id));

    const out = await caller.products.create({ name: "Smart Watch", price: 2490, initialStock: 0 });
    expect(out.stockStatus).toBe("out_of_stock");
    const low = await caller.products.create({ name: "Kitchen Knife Set", price: 890, initialStock: 3, lowStockThreshold: 5 });
    expect(low.stockStatus).toBe("low_stock");
    const list = await caller.products.list();
    expect(list.counts).toEqual({ total: 3, lowStock: 1, outOfStock: 1 });
    expect((await caller.products.list({ stock: "out" })).items.map((i) => i.name)).toEqual(["Smart Watch"]);
  });

  it("validates price, compare-at price, SKU uniqueness and image ownership", async () => {
    const { caller } = await merchantCaller("a@shop.test");
    await expect(caller.products.create({ name: "X", price: -1 })).rejects.toThrow();
    await expect(caller.products.create({ name: "", price: 10 })).rejects.toThrow();
    await expect(caller.products.create({ name: "X", price: 100, compareAtPrice: 90 })).rejects.toThrow(/Compare-at/);
    await caller.products.create({ name: "X", price: 100, sku: "DUP" });
    await expect(caller.products.create({ name: "Y", price: 100, sku: "DUP" })).rejects.toThrow(/SKU/);
    await expect(caller.products.create({ name: "Y", price: 100, sku: "<script>" })).rejects.toThrow();

    const other = await createMerchant({ email: "b@shop.test" });
    const foreignAsset = await LandingAsset.create({
      merchantId: other._id,
      mime: "image/png",
      bytes: 3,
      sha256: "x".repeat(64),
      data: Buffer.from("abc"),
    });
    await expect(caller.products.create({ name: "Z", price: 1, imageAssetId: String(foreignAsset._id) })).rejects.toThrow(/Invalid image/);
    await expect(caller.products.create({ name: "Z", price: 1, imageAssetId: "javascript:alert(1)" })).rejects.toThrow();
  });

  it("isolates tenants: another merchant can neither read nor change a product", async () => {
    const a = await merchantCaller("a@shop.test");
    const b = await merchantCaller("b@shop.test");
    const p = await a.caller.products.create(shirt);

    expect((await b.caller.products.list()).items).toHaveLength(0);
    await expect(b.caller.products.get({ id: p.id })).rejects.toThrow(/not found/i);
    await expect(b.caller.products.update({ id: p.id, price: 1 })).rejects.toThrow(/not found/i);
    await expect(b.caller.products.archive({ id: p.id })).rejects.toThrow(/not found/i);
    await expect(b.caller.products.adjustStock({ id: p.id, type: "RESTOCK", delta: 100 })).rejects.toThrow(/not found/i);
    expect(await b.caller.products.movements({ id: p.id })).toHaveLength(0);

    const fresh = await Product.findById(p.id).lean();
    expect(fresh).toMatchObject({ price: 1290, inventory: { onHand: 23, reserved: 0 }, status: "active" });
    // Same SKU is fine across merchants.
    await expect(b.caller.products.create(shirt)).resolves.toMatchObject({ sku: "SHIRT-01" });
  });

  it("restocks and adjusts through the ledger, never below reserved", async () => {
    const { merchant, caller } = await merchantCaller("a@shop.test");
    const p = await caller.products.create({ name: "Knife", price: 890, initialStock: 8 });
    await caller.products.adjustStock({ id: p.id, type: "RESTOCK", delta: 2 });
    const adj = await caller.products.adjustStock({ id: p.id, type: "MANUAL_ADJUSTMENT", delta: -3, reason: "damaged" });
    expect(adj).toMatchObject({ onHand: 7, available: 7 });
    await expect(caller.products.adjustStock({ id: p.id, type: "RESTOCK", delta: -1 })).rejects.toThrow();
    await expect(caller.products.adjustStock({ id: p.id, type: "MANUAL_ADJUSTMENT", delta: -8 })).rejects.toThrow(/below/);

    // Reserve 5, then on-hand can only drop to 5.
    const orderId = new Types.ObjectId();
    await inTransaction((s) => reserveOrderStock(s, { merchantId: merchant._id as Types.ObjectId, orderId, items: [{ productId: p.id, quantity: 5 }] }));
    await expect(caller.products.adjustStock({ id: p.id, type: "MANUAL_ADJUSTMENT", delta: -3 })).rejects.toThrow(/reserved/);
    await caller.products.adjustStock({ id: p.id, type: "MANUAL_ADJUSTMENT", delta: -2 });
    const after = await caller.products.get({ id: p.id });
    expect(after).toMatchObject({ onHand: 5, reserved: 5, available: 0, stockStatus: "out_of_stock" });

    const moves = await caller.products.movements({ id: p.id });
    expect(moves.map((m) => m.type)).toEqual(["MANUAL_ADJUSTMENT", "ORDER_RESERVED", "MANUAL_ADJUSTMENT", "RESTOCK", "INITIAL_STOCK"]);
    // Each row's "after" matches the running totals.
    expect(moves[0]).toMatchObject({ onHandAfter: 5, reservedAfter: 5 });
  });

  it("archived products disappear from lists and cannot be edited", async () => {
    const { caller } = await merchantCaller("a@shop.test");
    const p = await caller.products.create(shirt);
    await caller.products.archive({ id: p.id });
    expect((await caller.products.list()).items).toHaveLength(0);
    await expect(caller.products.update({ id: p.id, name: "x" })).rejects.toThrow(/not found/i);
  });

  it("the ledger is append-only", async () => {
    const { caller } = await merchantCaller("a@shop.test");
    const p = await caller.products.create(shirt);
    await expect(InventoryMovement.updateOne({ productId: p.id }, { $set: { onHandDelta: 999 } })).rejects.toThrow(/append-only/);
  });
});

describe("inventory concurrency and idempotency", () => {
  beforeEach(resetDb);

  it("stock 1, two simultaneous reservations → exactly one succeeds", async () => {
    const m = await createMerchant({ email: "a@shop.test" });
    const merchantId = m._id as Types.ObjectId;
    const p = await Product.create({ merchantId, name: "Last one", price: 100, inventory: { onHand: 1, reserved: 0 } });
    const attempt = () =>
      inTransaction((s) => reserveOrderStock(s, { merchantId, orderId: new Types.ObjectId(), items: [{ productId: p._id, quantity: 1 }] }));
    const results = await Promise.allSettled([attempt(), attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(InventoryError);
      expect((r as PromiseRejectedResult).reason.code).toBe("insufficient_stock");
    }
    const fresh = await Product.findById(p._id).lean();
    expect(fresh!.inventory).toEqual({ onHand: 1, reserved: 1 });
    expect(await InventoryMovement.countDocuments({ productId: p._id, type: "ORDER_RESERVED" })).toBe(1);
  });

  it("inactive products and foreign merchants cannot be reserved", async () => {
    const m = await createMerchant({ email: "a@shop.test" });
    const other = await createMerchant({ email: "b@shop.test" });
    const p = await Product.create({ merchantId: m._id, name: "Off", price: 100, status: "inactive", inventory: { onHand: 10, reserved: 0 } });
    await expect(
      inTransaction((s) => reserveOrderStock(s, { merchantId: m._id as Types.ObjectId, orderId: new Types.ObjectId(), items: [{ productId: p._id, quantity: 1 }] })),
    ).rejects.toBeInstanceOf(InventoryError);
    await expect(
      inTransaction((s) =>
        reserveOrderStock(s, { merchantId: other._id as Types.ObjectId, orderId: new Types.ObjectId(), items: [{ productId: p._id, quantity: 1 }] }),
      ),
    ).rejects.toMatchObject({ code: "product_not_found" });
    expect((await Product.findById(p._id).lean())!.inventory.reserved).toBe(0);
  });

  it("a multi-line reservation is all-or-nothing", async () => {
    const m = await createMerchant({ email: "a@shop.test" });
    const merchantId = m._id as Types.ObjectId;
    const a = await Product.create({ merchantId, name: "A", price: 1, inventory: { onHand: 5, reserved: 0 } });
    const b = await Product.create({ merchantId, name: "B", price: 1, inventory: { onHand: 1, reserved: 0 } });
    await expect(
      inTransaction((s) =>
        reserveOrderStock(s, {
          merchantId,
          orderId: new Types.ObjectId(),
          items: [
            { productId: a._id, quantity: 2 },
            { productId: b._id, quantity: 2 },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "insufficient_stock", productId: String(b._id) });
    expect((await Product.findById(a._id).lean())!.inventory.reserved).toBe(0);
    expect(await InventoryMovement.countDocuments({ merchantId })).toBe(0);
  });

  async function orderWithStock(merchantId: Types.ObjectId, productId: Types.ObjectId, quantity: number) {
    const order = await Order.create({
      merchantId,
      orderNumber: `LP-${new Types.ObjectId().toString().slice(-6)}`,
      customer: { name: "Rahim", phone: "+8801711111111", address: "House 1, Road 2", district: "Dhaka" },
      items: [{ name: "Shirt", quantity, price: 100, productId }],
      order: { cod: 100 * quantity, total: 100 * quantity, status: "pending" },
      inventory: { state: "reserved", cycle: 1, reservedAt: new Date() },
    });
    await inTransaction((s) => reserveOrderStock(s, { merchantId, orderId: order._id, items: [{ productId, quantity }] }));
    return order;
  }

  it("cancellation releases stock once, however many times it is reconciled", async () => {
    const m = await createMerchant({ email: "a@shop.test" });
    const merchantId = m._id as Types.ObjectId;
    const p = await Product.create({ merchantId, name: "Shirt", price: 100, inventory: { onHand: 5, reserved: 0 } });
    const order = await orderWithStock(merchantId, p._id, 2);
    expect((await Product.findById(p._id).lean())!.inventory).toEqual({ onHand: 5, reserved: 2 });

    await Order.updateOne({ _id: order._id }, { $set: { "order.status": "cancelled" } });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => reconcileOrderInventory(order._id)));
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect((await Product.findById(p._id).lean())!.inventory).toEqual({ onHand: 5, reserved: 0 });
    expect(await InventoryMovement.countDocuments({ orderId: order._id, type: "ORDER_CANCELLED" })).toBe(1);
    expect((await Order.findById(order._id).lean())!.inventory!.state).toBe("released");

    // Restore → re-reserved (new cycle), cancel again → released again.
    await Order.updateOne({ _id: order._id }, { $set: { "order.status": "pending" } });
    expect(await reconcileOrderInventory(order._id)).toMatchObject({ changed: true, to: "reserved" });
    expect((await Product.findById(p._id).lean())!.inventory).toEqual({ onHand: 5, reserved: 2 });
    await Order.updateOne({ _id: order._id }, { $set: { "order.status": "cancelled" } });
    await reconcileOrderInventory(order._id);
    expect((await Product.findById(p._id).lean())!.inventory).toEqual({ onHand: 5, reserved: 0 });
  });

  it("delivery fulfils once; repeated delivered events never double-deduct", async () => {
    const m = await createMerchant({ email: "a@shop.test" });
    const merchantId = m._id as Types.ObjectId;
    const p = await Product.create({ merchantId, name: "Shirt", price: 100, inventory: { onHand: 5, reserved: 0 } });
    const order = await orderWithStock(merchantId, p._id, 2);
    await Order.updateOne({ _id: order._id }, { $set: { "order.status": "delivered" } });
    await Promise.all([reconcileOrderInventory(order._id), reconcileOrderInventory(order._id), reconcileOrderInventory(order._id)]);
    expect((await Product.findById(p._id).lean())!.inventory).toEqual({ onHand: 3, reserved: 0 });
    expect(await InventoryMovement.countDocuments({ orderId: order._id, type: "ORDER_FULFILLED" })).toBe(1);
    // A late RTO after delivery does not silently restock (returns are booked by the merchant).
    await Order.updateOne({ _id: order._id }, { $set: { "order.status": "rto" } });
    expect(await reconcileOrderInventory(order._id)).toMatchObject({ changed: false });
    expect((await Product.findById(p._id).lean())!.inventory).toEqual({ onHand: 3, reserved: 0 });
  });

  it("restoring a cancelled order when stock is gone keeps it released with a note", async () => {
    const m = await createMerchant({ email: "a@shop.test" });
    const merchantId = m._id as Types.ObjectId;
    const p = await Product.create({ merchantId, name: "Shirt", price: 100, inventory: { onHand: 2, reserved: 0 } });
    const order = await orderWithStock(merchantId, p._id, 2);
    await Order.updateOne({ _id: order._id }, { $set: { "order.status": "cancelled" } });
    await reconcileOrderInventory(order._id);
    await orderWithStock(merchantId, p._id, 2); // someone else buys the stock
    await Order.updateOne({ _id: order._id }, { $set: { "order.status": "pending" } });
    const r = await reconcileOrderInventory(order._id);
    expect(r.changed).toBe(false);
    expect(r.note).toMatch(/^insufficient_stock/);
    const fresh = await Order.findById(order._id).lean();
    expect(fresh!.inventory).toMatchObject({ state: "released" });
    expect((await Product.findById(p._id).lean())!.inventory).toEqual({ onHand: 2, reserved: 2 });
  });

  it("orders without catalog items are untouched", async () => {
    const m = await createMerchant({ email: "a@shop.test" });
    const order = await Order.create({
      merchantId: m._id,
      orderNumber: "D-1",
      customer: { name: "X", phone: "+8801711111111", address: "A", district: "Dhaka" },
      items: [{ name: "Manual", quantity: 1, price: 10 }],
      order: { cod: 10, total: 10, status: "cancelled" },
    });
    expect(await reconcileOrderInventory(order._id)).toEqual({ changed: false });
  });

  it("adjustStock rejects non-integer and zero deltas", async () => {
    const m = await createMerchant({ email: "a@shop.test" });
    const p = await Product.create({ merchantId: m._id, name: "S", price: 1, inventory: { onHand: 1, reserved: 0 } });
    for (const delta of [0, 1.5, Number.NaN]) {
      await expect(adjustStock({ merchantId: m._id as Types.ObjectId, productId: p._id, type: "RESTOCK", delta })).rejects.toMatchObject({ code: "invalid_quantity" });
    }
  });
});
