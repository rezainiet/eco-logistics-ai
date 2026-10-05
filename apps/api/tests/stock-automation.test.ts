import type { AddressInfo } from "node:net";
import express from "express";
import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryMovement, Merchant, Notification, Order, PendingAwb, Product, WebhookInbox } from "@ecom/db";
import { encryptSecret } from "../src/lib/crypto.js";
import { adjustStock, reserveNewOrderStock, syncOrderInventory } from "../src/lib/inventory.js";
import { stockCrossing } from "../src/lib/inventory-alerts.js";
import { shopifyAdapter } from "../src/lib/integrations/shopify.js";
import { wooAdapter } from "../src/lib/integrations/woocommerce.js";
import { __clearPathaoTokenCache, MockPathaoTransport } from "../src/lib/couriers/pathao.js";
import { MockSteadfastTransport } from "../src/lib/couriers/steadfast.js";
import { processWebhookOnce } from "../src/server/ingest.js";
import { courierWebhookRouter } from "../src/server/webhooks/courier.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Stock automation: every order that references a catalogue product moves
 * its stock through the one inventory library, whatever its source —
 * dashboard, CSV, Shopify, WooCommerce — linked by unambiguous SKU only.
 * A short stock never fails an external order (kept, noted, notified, and
 * reserved by the next restock). Low / out-of-stock alerts fire once per
 * crossing and re-arm only after a restock. Couriers run on mock transports.
 */

const SF_SECRET = "sf-webhook-token-456";
const PH_SECRET = "ph_secret"; // helpers.createMerchant's Pathao apiSecret

let base = "";
let server: ReturnType<express.Express["listen"]>;

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Product.syncIndexes(), InventoryMovement.syncIndexes(), Order.syncIndexes(), PendingAwb.syncIndexes(), WebhookInbox.syncIndexes(), Notification.syncIndexes()]);
  const app = express();
  app.use("/api/webhooks/courier", courierWebhookRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/courier`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await disconnectDb();
});
beforeEach(async () => {
  await resetDb();
  __clearPathaoTokenCache();
  MockPathaoTransport.reset();
  MockSteadfastTransport.reset();
});

type Caller = ReturnType<typeof callerFor>;

async function merchant() {
  const m = await createMerchant();
  const mid = m._id as Types.ObjectId;
  await Merchant.updateOne({ _id: mid, "couriers.name": "steadfast" }, { $set: { "couriers.$.apiSecret": encryptSecret(SF_SECRET) } });
  return { mid, caller: callerFor(authUserFor(m)) };
}

let phoneSeq = 0;
const nextPhone = () => `+88017${String(20000000 + ++phoneSeq)}`;

const customer = () => ({ name: "Rahim", phone: nextPhone(), address: "House 1, Road 2", district: "Dhaka" });

function product(mid: Types.ObjectId, f: { name?: string; sku?: string; onHand?: number; threshold?: number; status?: string } = {}) {
  return Product.create({
    merchantId: mid,
    name: f.name ?? "Premium Achar",
    ...(f.sku ? { sku: f.sku } : {}),
    price: 500,
    ...(f.status ? { status: f.status } : {}),
    ...(f.threshold !== undefined ? { lowStockThreshold: f.threshold } : {}),
    inventory: { onHand: f.onHand ?? 10, reserved: 0 },
  });
}

async function stockOf(productId: unknown, variantId?: unknown) {
  const p = (await Product.findById(productId).lean())!;
  const inv = variantId ? p.variants!.find((v) => String(v._id) === String(variantId))!.inventory : p.inventory;
  return { onHand: inv.onHand, reserved: inv.reserved };
}

const movesOf = async (orderId: unknown) =>
  (await InventoryMovement.find({ orderId }).sort({ createdAt: 1, _id: 1 }).lean()).map((m) => m.type);

async function dashboardOrder(caller: Caller, items: Array<{ name: string; sku?: string; quantity: number; price?: number }>) {
  const r = await caller.orders.createOrder({
    customer: customer(),
    items: items.map((i) => ({ price: 500, ...i })),
    cod: 500,
  });
  return r.id;
}

const orderDoc = async (id: unknown) => (await Order.findById(id).lean())!;

const shopifyPayload = (id: number, lines: Array<{ sku?: string; quantity: number }>) => ({
  id,
  name: `#${id}`,
  total_price: "1000",
  created_at: "2026-10-01T10:00:00.000Z",
  customer: { first_name: "Shop", last_name: "Buyer", phone: nextPhone() },
  shipping_address: { name: "Shop Buyer", phone: nextPhone(), address1: "House 1", city: "Dhaka" },
  line_items: lines.map((l, i) => ({ id: i + 1, title: "Achar", quantity: l.quantity, price: "500", ...(l.sku ? { sku: l.sku } : {}) })),
  payment_gateway_names: ["Cash on Delivery"],
});

const wooPayload = (id: number, lines: Array<{ sku?: string; quantity: number }>) => ({
  id,
  number: String(id),
  status: "processing",
  total: "1000",
  payment_method: "cod",
  billing: { first_name: "Woo", last_name: "Buyer", phone: nextPhone(), address_1: "Road 2", city: "Dhaka" },
  shipping: { first_name: "Woo", last_name: "Buyer", phone: nextPhone(), address_1: "Road 2", city: "Dhaka" },
  line_items: lines.map((l, i) => ({ id: i + 1, name: "Achar", quantity: l.quantity, total: String(500 * l.quantity), ...(l.sku ? { sku: l.sku } : {}) })),
});

async function shopifyOrder(mid: Types.ObjectId, payload: ReturnType<typeof shopifyPayload>) {
  return processWebhookOnce({
    merchantId: mid,
    integrationId: new Types.ObjectId(),
    provider: "shopify",
    topic: "orders/create",
    externalId: String(payload.id),
    rawPayload: payload,
    payloadBytes: 100,
    normalized: shopifyAdapter.normalizeWebhookPayload("orders/create", payload),
    source: "shopify",
  });
}

async function wooOrder(mid: Types.ObjectId, payload: ReturnType<typeof wooPayload>) {
  return processWebhookOnce({
    merchantId: mid,
    integrationId: new Types.ObjectId(),
    provider: "woocommerce",
    topic: "order.created",
    externalId: String(payload.id),
    rawPayload: payload,
    payloadBytes: 100,
    normalized: wooAdapter.normalizeWebhookPayload("order.created", payload),
    source: "woocommerce",
  });
}

const post = (path: string, body: object, headers: Record<string, string>) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const pathaoHook = (mid: Types.ObjectId, body: object) => post(`/pathao/${mid}`, body, { "X-PATHAO-Signature": PH_SECRET });
const steadfastHook = (mid: Types.ObjectId, body: object) => post(`/steadfast/${mid}`, body, { authorization: `Bearer ${SF_SECRET}` });

const notices = (mid: Types.ObjectId, kind: string) => Notification.find({ merchantId: mid, kind }).sort({ _id: 1 }).lean();

describe("order → product/variant link and automatic reservation, per source", () => {
  it("dashboard: exact SKU links and reserves; ambiguous, missing, foreign, archived and variant-parent SKUs never do", async () => {
    const { mid, caller } = await merchant();
    const other = await createMerchant();
    const achar = await product(mid, { sku: "ACHAR-1", onHand: 10 });
    const shirt = await Product.create({
      merchantId: mid,
      name: "Shirt",
      sku: "SHIRT",
      price: 900,
      options: [{ name: "Size", values: ["M", "L"] }],
      variants: [
        { optionValues: ["M"], sku: "SHIRT-M", inventory: { onHand: 4, reserved: 0 } },
        { optionValues: ["L"], sku: "SHIRT-L", inventory: { onHand: 4, reserved: 0 } },
      ],
    });
    await product(mid, { name: "Cap", sku: "DUP", onHand: 5 });
    await Product.create({ merchantId: mid, name: "Hat", price: 200, options: [{ name: "Size", values: ["M"] }], variants: [{ optionValues: ["M"], sku: "DUP", inventory: { onHand: 5, reserved: 0 } }] });
    await product(mid, { name: "Old", sku: "OLD", onHand: 5, status: "archived" });
    await product(other._id as Types.ObjectId, { name: "Theirs", sku: "THEIRS", onHand: 5 });

    const id = await dashboardOrder(caller, [
      { name: "Achar", sku: "ACHAR-1", quantity: 2 },
      { name: "Shirt M", sku: "SHIRT-M", quantity: 1 },
      { name: "Shirt (no size)", sku: "SHIRT", quantity: 1 },
      { name: "Dup", sku: "DUP", quantity: 1 },
      { name: "Free text", quantity: 1 },
      { name: "Unknown", sku: "NOPE", quantity: 1 },
      { name: "Old", sku: "OLD", quantity: 1 },
      { name: "Theirs", sku: "THEIRS", quantity: 1 },
    ]);
    const o = await orderDoc(id);
    const mVariant = shirt.variants![0]!;
    expect(o.items.map((i) => (i.productId ? String(i.productId) : null))).toEqual([String(achar._id), String(shirt._id), null, null, null, null, null, null]);
    expect(String(o.items[1]!.variantId)).toBe(String(mVariant._id));
    expect(o.items[1]!.variantLabel).toBe("M");
    expect(o.inventory).toMatchObject({ state: "reserved", cycle: 1 });
    expect(await stockOf(achar._id)).toEqual({ onHand: 10, reserved: 2 });
    expect(await stockOf(shirt._id, mVariant._id)).toEqual({ onHand: 4, reserved: 1 });
    expect(await stockOf(shirt._id, shirt.variants![1]!._id)).toEqual({ onHand: 4, reserved: 0 });
    expect(await movesOf(id)).toEqual(["ORDER_RESERVED", "ORDER_RESERVED"]);
    expect((await Product.findOne({ sku: "THEIRS" }).lean())!.inventory.reserved).toBe(0);
  });

  it("an order whose lines match nothing holds no stock state at all", async () => {
    const { mid, caller } = await merchant();
    await product(mid, { sku: "ACHAR-1" });
    const id = await dashboardOrder(caller, [{ name: "Free text", quantity: 1 }, { name: "Nope", sku: "NOPE", quantity: 1 }]);
    expect((await orderDoc(id)).inventory).toBeUndefined();
    expect(await InventoryMovement.countDocuments({ merchantId: mid })).toBe(0);
  });

  it("CSV: a SKU column links and reserves each row; rows without a match are imported unchanged", async () => {
    const { mid, caller } = await merchant();
    const achar = await product(mid, { sku: "ACHAR-1", onHand: 3 });
    const csv = [
      "orderNumber,customerName,customerPhone,customerAddress,customerDistrict,itemName,sku,quantity,price,cod",
      `CSV-1,Jane,${nextPhone()},Address 1,Dhaka,Achar,ACHAR-1,2,500,1000`,
      `CSV-2,Bob,${nextPhone()},Address 2,Sylhet,Pants,,1,700,700`,
      `CSV-3,Ann,${nextPhone()},Address 3,Khulna,Mystery,NOPE,1,100,100`,
      `CSV-4,Raj,${nextPhone()},Address 4,Rajshahi,Achar,ACHAR-1,2,500,1000`,
    ].join("\n");
    const res = await caller.orders.bulkUpload({ csv });
    expect(res.inserted).toBe(4);
    const byNumber = async (n: string) => (await Order.findOne({ merchantId: mid, orderNumber: n }).lean())!;
    const [r1, r2, r3, r4] = await Promise.all(["CSV-1", "CSV-2", "CSV-3", "CSV-4"].map(byNumber));
    expect(r1!.items[0]).toMatchObject({ name: "Achar", sku: "ACHAR-1" });
    expect(String(r1!.items[0]!.productId)).toBe(String(achar._id));
    expect(r1!.inventory?.state).toBe("reserved");
    expect(r2!.items[0]!.productId).toBeUndefined();
    expect(r2!.inventory).toBeUndefined();
    expect(r3!.items[0]).toMatchObject({ name: "Mystery", sku: "NOPE" });
    expect(r3!.inventory).toBeUndefined();
    // 3 on hand: the first row took 2, the fourth (2 more) is kept, short.
    expect(r4!.inventory).toMatchObject({ state: "released", note: `insufficient_stock:${achar._id}` });
    expect(await stockOf(achar._id)).toEqual({ onHand: 3, reserved: 2 });
  });

  it("CSV: a file with only a SKU column still names the item after it (as before)", async () => {
    const { mid, caller } = await merchant();
    await product(mid, { sku: "ACHAR-1" });
    const csv = ["customerName,customerPhone,customerAddress,customerDistrict,sku,quantity,price", `Jane,${nextPhone()},Address 1,Dhaka,ACHAR-1,1,500`].join("\n");
    expect((await caller.orders.bulkUpload({ csv })).inserted).toBe(1);
    const o = (await Order.findOne({ merchantId: mid }).lean())!;
    expect(o.items[0]).toMatchObject({ name: "ACHAR-1", sku: "ACHAR-1" });
    expect(o.inventory?.state).toBe("reserved");
  });

  it("Shopify: line SKUs link and reserve; a redelivered webhook reserves nothing more", async () => {
    const { mid } = await merchant();
    const achar = await product(mid, { sku: "ACHAR-1", onHand: 10 });
    const payload = shopifyPayload(7001, [{ sku: "ACHAR-1", quantity: 3 }, { quantity: 1 }]);
    const first = await shopifyOrder(mid, payload);
    expect(first.ok).toBe(true);
    const o = await orderDoc(first.orderId);
    expect(String(o.items[0]!.productId)).toBe(String(achar._id));
    expect(o.items[1]!.productId).toBeUndefined();
    expect(await stockOf(achar._id)).toEqual({ onHand: 10, reserved: 3 });
    const again = await shopifyOrder(mid, payload);
    expect(again).toMatchObject({ ok: true, duplicate: true });
    await reserveNewOrderStock(first.orderId!); // a stray retry of the reservation itself
    expect(await stockOf(achar._id)).toEqual({ onHand: 10, reserved: 3 });
    expect(await movesOf(first.orderId)).toEqual(["ORDER_RESERVED"]);
  });

  it("WooCommerce: line SKUs link and reserve (variant SKU too)", async () => {
    const { mid } = await merchant();
    const shirt = await Product.create({
      merchantId: mid,
      name: "Shirt",
      price: 900,
      options: [{ name: "Size", values: ["L"] }],
      variants: [{ optionValues: ["L"], sku: "SHIRT-L", inventory: { onHand: 6, reserved: 0 } }],
    });
    const r = await wooOrder(mid, wooPayload(8001, [{ sku: "SHIRT-L", quantity: 2 }]));
    expect(r.ok).toBe(true);
    const o = await orderDoc(r.orderId);
    expect(String(o.items[0]!.variantId)).toBe(String(shirt.variants![0]!._id));
    expect(await stockOf(shirt._id, shirt.variants![0]!._id)).toEqual({ onHand: 6, reserved: 2 });
  });
});

describe("insufficient stock never blocks an external order", () => {
  it("keeps the order, notes and surfaces it, notifies once, and reserves it on restock", async () => {
    const { mid, caller } = await merchant();
    const achar = await product(mid, { sku: "ACHAR-1", onHand: 2, threshold: 0 });
    const r = await shopifyOrder(mid, shopifyPayload(7101, [{ sku: "ACHAR-1", quantity: 5 }]));
    expect(r.ok).toBe(true);
    let o = await orderDoc(r.orderId);
    expect(o.order.status).toBe("pending");
    expect(o.inventory).toMatchObject({ state: "released", note: `insufficient_stock:${achar._id}` });
    expect(await stockOf(achar._id)).toEqual({ onHand: 2, reserved: 0 });
    expect(await movesOf(r.orderId)).toEqual([]);

    const issues = await notices(mid, "order.stock_issue");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ link: `/dashboard/orders?focus=${r.orderId}`, subjectType: "order" });
    expect(issues[0]!.title).toContain(o.orderNumber);
    expect(issues[0]!.body).toContain("Premium Achar");

    // Surfaced: the orders list filter, its row flag, and the order detail.
    const short = await caller.orders.listOrders({ stockIssue: true });
    expect(short.items.map((i) => i.id)).toEqual([r.orderId]);
    expect(short.items[0]!.stockIssue).toBe(`insufficient_stock:${achar._id}`);
    expect((await caller.orders.getOrder({ id: r.orderId! })).commerce.inventory).toEqual({ state: "released", note: `insufficient_stock:${achar._id}` });

    // A status change while still short: no second notification.
    await caller.orders.updateOrder({ id: r.orderId!, status: "confirmed" });
    expect(await notices(mid, "order.stock_issue")).toHaveLength(1);

    // Not enough yet (2 + 2 < 5): still waiting.
    await adjustStock({ merchantId: mid, productId: achar._id as Types.ObjectId, type: "RESTOCK", delta: 2 });
    expect((await orderDoc(r.orderId)).inventory?.state).toBe("released");
    // Enough: reserved automatically, note cleared, gone from the filter.
    await adjustStock({ merchantId: mid, productId: achar._id as Types.ObjectId, type: "RESTOCK", delta: 3 });
    o = await orderDoc(r.orderId);
    expect(o.inventory).toMatchObject({ state: "reserved", cycle: 2 });
    expect(o.inventory?.note).toBeUndefined();
    expect(await stockOf(achar._id)).toEqual({ onHand: 7, reserved: 5 });
    expect((await caller.orders.listOrders({ stockIssue: true })).items).toHaveLength(0);
    expect(await movesOf(r.orderId)).toEqual(["ORDER_RESERVED"]);
  });

  it("concurrent orders can never oversell; concurrent retries of one order reserve once", async () => {
    const { mid } = await merchant();
    const achar = await product(mid, { sku: "ACHAR-1", onHand: 3, threshold: 0 });
    const ids = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const _id = new Types.ObjectId();
        await Order.create({
          _id,
          merchantId: mid,
          orderNumber: `RACE-${i}`,
          customer: customer(),
          items: [{ name: "Achar", sku: "ACHAR-1", quantity: 1, price: 500, productId: achar._id }],
          order: { cod: 500, total: 500, status: "pending" },
        });
        return _id;
      }),
    );
    const results = await Promise.all([...ids, ...ids].map((id) => reserveNewOrderStock(id)));
    expect(results.filter((x) => x.reserved)).toHaveLength(3);
    expect(await stockOf(achar._id)).toEqual({ onHand: 3, reserved: 3 });
    const states = (await Order.find({ _id: { $in: ids } }).lean()).map((o) => o.inventory?.state);
    expect(states.filter((s) => s === "reserved")).toHaveLength(3);
    expect(states.filter((s) => s === "released")).toHaveLength(3);
    expect(await InventoryMovement.countDocuments({ merchantId: mid, type: "ORDER_RESERVED" })).toBe(3);
    expect(await Notification.countDocuments({ merchantId: mid, kind: "order.stock_issue" })).toBe(3);
  });

  it("an order cancelled between its creation and its reservation is never reserved", async () => {
    const { mid } = await merchant();
    const achar = await product(mid, { sku: "ACHAR-1", onHand: 5 });
    const _id = new Types.ObjectId();
    const doc = {
      _id,
      merchantId: mid,
      orderNumber: "RACE-CANCEL",
      customer: customer(),
      items: [{ name: "Achar", sku: "ACHAR-1", quantity: 2, price: 500, productId: achar._id }],
      order: { cod: 1000, total: 1000, status: "pending" as const },
    };
    await Order.create({ ...doc, order: { ...doc.order, status: "cancelled" } });
    // The reservation read the order while it was still pending.
    const spy = vi.spyOn(Order, "findById").mockImplementationOnce(
      () => ({ select: () => ({ lean: async () => doc }) }) as unknown as ReturnType<typeof Order.findById>,
    );
    try {
      expect(await reserveNewOrderStock(_id)).toEqual({ reserved: false });
    } finally {
      spy.mockRestore();
    }
    expect(await stockOf(achar._id)).toEqual({ onHand: 5, reserved: 0 });
    expect((await orderDoc(_id)).inventory).toBeUndefined();
  });
});

describe("order lifecycle moves stock exactly once", () => {
  it("created → reserved, shipped → still reserved, delivered → consumed; repeats change nothing", async () => {
    const { mid, caller } = await merchant();
    const achar = await product(mid, { sku: "ACHAR-1", onHand: 10, threshold: 0 });
    const id = await dashboardOrder(caller, [{ name: "Achar", sku: "ACHAR-1", quantity: 2 }]);
    for (const status of ["confirmed", "packed", "shipped"] as const) await caller.orders.updateOrder({ id, status });
    expect(await stockOf(achar._id)).toEqual({ onHand: 10, reserved: 2 });
    await caller.orders.updateOrder({ id, status: "delivered" });
    expect(await stockOf(achar._id)).toEqual({ onHand: 8, reserved: 0 });
    await caller.orders.updateOrder({ id, status: "delivered" }).catch(() => undefined);
    await syncOrderInventory([id, id]);
    expect(await stockOf(achar._id)).toEqual({ onHand: 8, reserved: 0 });
    expect(await movesOf(id)).toEqual(["ORDER_RESERVED", "ORDER_FULFILLED"]);
    expect((await orderDoc(id)).inventory?.state).toBe("fulfilled");
  });

  it("cancelled and rejected orders release their stock once", async () => {
    const { mid, caller } = await merchant();
    const achar = await product(mid, { sku: "ACHAR-1", onHand: 10, threshold: 0 });
    const cancelled = await dashboardOrder(caller, [{ name: "Achar", sku: "ACHAR-1", quantity: 2 }]);
    const rejected = await dashboardOrder(caller, [{ name: "Achar", sku: "ACHAR-1", quantity: 3 }]);
    expect(await stockOf(achar._id)).toEqual({ onHand: 10, reserved: 5 });
    await caller.orders.updateOrder({ id: cancelled, status: "cancelled" });
    await caller.orders.rejectOrder({ id: rejected, reason: "fake order" });
    await syncOrderInventory([cancelled, rejected]);
    expect(await stockOf(achar._id)).toEqual({ onHand: 10, reserved: 0 });
    expect(await movesOf(cancelled)).toEqual(["ORDER_RESERVED", "ORDER_CANCELLED"]);
    expect(await movesOf(rejected)).toEqual(["ORDER_RESERVED", "ORDER_CANCELLED"]);
  });

  it("courier delivered (Pathao) consumes, courier RTO (Steadfast) releases — replayed webhooks add nothing", async () => {
    const { mid, caller } = await merchant();
    const achar = await product(mid, { sku: "ACHAR-1", onHand: 10, threshold: 0 });
    const delivered = await dashboardOrder(caller, [{ name: "Achar", sku: "ACHAR-1", quantity: 1 }]);
    const returned = await dashboardOrder(caller, [{ name: "Achar", sku: "ACHAR-1", quantity: 2 }]);
    for (const id of [delivered, returned]) await caller.orders.updateOrder({ id, status: "confirmed" });

    const tn = (await caller.orders.bookShipment({ orderId: delivered, courier: "pathao" })).trackingNumber;
    await caller.orders.bookShipment({ orderId: returned, courier: "steadfast" });
    const consignment = (await orderDoc(returned)).logistics!.providerOrderId!;
    expect(await stockOf(achar._id)).toEqual({ onHand: 10, reserved: 3 });

    const done = { consignment_id: tn, order_status: "Delivered", updated_at: "2026-10-01T09:00:00Z", delivered_at: "2026-10-01T09:00:00Z" };
    await pathaoHook(mid, { consignment_id: tn, order_status: "In Transit", updated_at: "2026-09-30T08:00:00Z" });
    await pathaoHook(mid, done);
    await pathaoHook(mid, done);
    const back = { consignment_id: consignment, status: "returned", updated_at: "2026-10-01T10:00:00Z" };
    await steadfastHook(mid, back);
    await steadfastHook(mid, back);
    await steadfastHook(mid, { ...back, updated_at: "2026-10-01T11:00:00Z" });

    expect((await orderDoc(delivered)).order.status).toBe("delivered");
    expect((await orderDoc(returned)).order.status).toBe("rto");
    expect(await stockOf(achar._id)).toEqual({ onHand: 9, reserved: 0 });
    expect(await movesOf(delivered)).toEqual(["ORDER_RESERVED", "ORDER_FULFILLED"]);
    expect(await movesOf(returned)).toEqual(["ORDER_RESERVED", "RETURNED"]);
  });
});

describe("low / out-of-stock alerts", () => {
  it("crossing rule", () => {
    expect(stockCrossing({ availableBefore: 6, availableAfter: 5 }, 5)).toBe("stock.low");
    expect(stockCrossing({ availableBefore: 5, availableAfter: 4 }, 5)).toBeNull();
    expect(stockCrossing({ availableBefore: 8, availableAfter: 0 }, 5)).toBe("stock.out");
    expect(stockCrossing({ availableBefore: 1, availableAfter: 0 }, 5)).toBe("stock.out");
    expect(stockCrossing({ availableBefore: 3, availableAfter: 1 }, 0)).toBeNull();
  });

  it("fire once per crossing, are not repeated by bounces, and re-arm only after a restock", async () => {
    const { mid, caller } = await merchant();
    const achar = await product(mid, { sku: "ACHAR-1", onHand: 7, threshold: 5 });
    const pid = achar._id as Types.ObjectId;
    const order = (qty: number) => dashboardOrder(caller, [{ name: "Achar", sku: "ACHAR-1", quantity: qty }]);

    await order(1); // 7 → 6
    expect(await notices(mid, "stock.low")).toHaveLength(0);
    const crossing = await order(1); // 6 → 5: low
    let low = await notices(mid, "stock.low");
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({
      title: "Low stock: Premium Achar",
      link: `/dashboard/products?stock=${pid}`,
      subjectType: "product",
      severity: "warning",
      meta: { available: 5, threshold: 5 },
    });
    expect(String(low[0]!.subjectId)).toBe(String(pid));
    const third = await order(1); // 5 → 4: already low
    // Cancellations lift it back above the line (4 → 6); crossing again
    // without a restock is the same episode, not a new alert.
    await caller.orders.updateOrder({ id: crossing, status: "cancelled" });
    await caller.orders.updateOrder({ id: third, status: "cancelled" });
    expect(await stockOf(pid)).toEqual({ onHand: 7, reserved: 1 });
    await order(1); // 6 → 5
    expect(await notices(mid, "stock.low")).toHaveLength(1);

    await order(5); // 5 → 0: out
    const out = await notices(mid, "stock.out");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "Out of stock: Premium Achar", severity: "critical", link: `/dashboard/products?stock=${pid}` });

    // Restock re-arms both lines.
    await adjustStock({ merchantId: mid, productId: pid, type: "RESTOCK", delta: 10 }); // 0 → 10
    await order(5); // 10 → 5: low again
    await order(5); // 5 → 0: out again
    expect(await notices(mid, "stock.low")).toHaveLength(2);
    expect(await notices(mid, "stock.out")).toHaveLength(2);
    // A restock that stays at or under the low line re-arms "out" but not "low".
    await adjustStock({ merchantId: mid, productId: pid, type: "RESTOCK", delta: 3 }); // 0 → 3
    await order(3); // 3 → 0
    low = await notices(mid, "stock.low");
    expect(low).toHaveLength(2);
    expect(await notices(mid, "stock.out")).toHaveLength(3);
  });

  it("variant alerts name the variant; manual removals alert too; replays never duplicate", async () => {
    const { mid } = await merchant();
    const shirt = await Product.create({
      merchantId: mid,
      name: "Shirt",
      price: 900,
      lowStockThreshold: 2,
      options: [{ name: "Size", values: ["M"] }],
      variants: [{ optionValues: ["M"], sku: "SHIRT-M", inventory: { onHand: 3, reserved: 0 } }],
    });
    const vid = shirt.variants![0]!._id as Types.ObjectId;
    const r = await wooOrder(mid, wooPayload(8101, [{ sku: "SHIRT-M", quantity: 1 }]));
    await reserveNewOrderStock(r.orderId!);
    await wooOrder(mid, wooPayload(8101, [{ sku: "SHIRT-M", quantity: 1 }]));
    const low = await notices(mid, "stock.low");
    expect(low).toHaveLength(1);
    expect(low[0]!.title).toBe("Low stock: Shirt — M");
    expect(low[0]!.meta).toMatchObject({ variantId: String(vid) });

    await adjustStock({ merchantId: mid, productId: shirt._id as Types.ObjectId, variantId: vid, type: "MANUAL_ADJUSTMENT", delta: -1, reason: "damaged" });
    expect(await notices(mid, "stock.out")).toHaveLength(0); // 1 available left
    await adjustStock({ merchantId: mid, productId: shirt._id as Types.ObjectId, variantId: vid, type: "MANUAL_ADJUSTMENT", delta: -1, reason: "damaged" });
    expect(await notices(mid, "stock.out")).toHaveLength(1);
  });

  it("the bell lists stock notices through the notifications router", async () => {
    const { mid, caller } = await merchant();
    await product(mid, { sku: "ACHAR-1", onHand: 1, threshold: 0 });
    await dashboardOrder(caller, [{ name: "Achar", sku: "ACHAR-1", quantity: 1 }]);
    const list = await caller.notifications.list({ onlyUnread: true, kinds: ["stock.low", "stock.out", "order.stock_issue"], limit: 20, cursor: null });
    expect(list.items.map((n) => n.kind)).toEqual(["stock.out"]);
    expect(list.items[0]).toMatchObject({ subjectType: "product" });
  });
});

describe("merchant isolation", () => {
  it("one merchant's orders, stock and notices never touch another's", async () => {
    const a = await merchant();
    const b = await merchant();
    const achar = await product(a.mid, { sku: "SHARED-SKU", onHand: 1, threshold: 0 });
    // B uses the same SKU but has no such product: nothing of A's moves.
    const bOrder = await dashboardOrder(b.caller, [{ name: "Achar", sku: "SHARED-SKU", quantity: 1 }]);
    expect((await orderDoc(bOrder)).items[0]!.productId).toBeUndefined();
    expect(await stockOf(achar._id)).toEqual({ onHand: 1, reserved: 0 });

    // A sells out and has a short order; B sees none of it.
    await dashboardOrder(a.caller, [{ name: "Achar", sku: "SHARED-SKU", quantity: 1 }]);
    await dashboardOrder(a.caller, [{ name: "Achar", sku: "SHARED-SKU", quantity: 1 }]);
    expect(await Notification.countDocuments({ merchantId: a.mid, kind: { $in: ["stock.out", "order.stock_issue"] } })).toBe(2);
    expect((await b.caller.notifications.list({ kinds: ["stock.low", "stock.out", "order.stock_issue"], limit: 20, cursor: null })).items).toHaveLength(0);
    expect((await b.caller.orders.listOrders({ stockIssue: true })).items).toHaveLength(0);
    expect((await a.caller.orders.listOrders({ stockIssue: true })).items).toHaveLength(1);
    await expect(b.caller.products.adjustStock({ id: String(achar._id), type: "RESTOCK", delta: 5 })).rejects.toThrow(/not found/i);
    await expect(b.caller.products.movements({ id: String(achar._id) })).resolves.toEqual([]);
    expect(await stockOf(achar._id)).toEqual({ onHand: 1, reserved: 1 });
  });
});
