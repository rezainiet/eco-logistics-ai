import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { FinanceEntry, InventoryMovement, MerchantStats, Order, Product } from "@ecom/db";
import { __clearPathaoTokenCache, MockPathaoTransport } from "../src/lib/couriers/pathao.js";
import { placeLandingOrder, type PlaceOrderInput } from "../src/lib/commerce/landing-orders.js";
import { resolvePeriod } from "../src/lib/finance/period.js";
import { ensureSystemTemplates, __resetTemplateCacheForTests } from "../src/lib/landing/templates.js";
import { resolveLandingPageByHost } from "../src/lib/landing/resolve.js";
import { applyTrackingEvents } from "../src/server/tracking.js";
import { fetchPublicTimeline } from "../src/lib/public-tracking.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Merchant accounting. Realized sales revenue comes ONLY from delivered
 * orders (COD cash is collected on delivery) and is never stored as a
 * finance entry. Product cost comes from the per-item unitCost snapshot,
 * courier cost from the fee stored at booking; missing values are reported
 * as missing, never as zero. Manual income/expense entries are merchant
 * scoped, idempotent and voided rather than deleted.
 */

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Product.syncIndexes(), InventoryMovement.syncIndexes(), Order.syncIndexes(), FinanceEntry.syncIndexes()]);
});
afterAll(disconnectDb);
beforeEach(async () => {
  await resetDb();
  __resetTemplateCacheForTests();
  __clearPathaoTokenCache();
  MockPathaoTransport.reset();
});

const sampleOrder = {
  customer: { name: "Jane", phone: "+8801712345678", address: "House 5, Road 3", district: "Dhaka" },
  items: [{ name: "Shirt", quantity: 1, price: 500 }],
  cod: 500,
};
const ALL = { preset: "custom" as const, from: "2024-01-01", to: "2030-12-31" };
const THIS_MONTH = { preset: "month" as const };

async function merchant() {
  const m = await createMerchant();
  return { m, caller: callerFor(authUserFor(m)) };
}

/** Walks an order to `status` through the real manual path (updateOrder). */
async function walk(caller: ReturnType<typeof callerFor>, id: string, to: "confirmed" | "packed" | "shipped" | "in_transit" | "delivered" | "cancelled" | "rto") {
  const path: Record<string, string[]> = {
    confirmed: ["confirmed"],
    packed: ["confirmed", "packed"],
    shipped: ["confirmed", "packed", "shipped"],
    in_transit: ["confirmed", "packed", "shipped", "in_transit"],
    delivered: ["confirmed", "packed", "shipped", "delivered"],
    cancelled: ["cancelled"],
    rto: ["confirmed", "packed", "shipped", "rto"],
  };
  for (const s of path[to]!) await caller.orders.updateOrder({ id, status: s as never });
}

async function order(caller: ReturnType<typeof callerFor>, total: number, phoneSuffix: string) {
  return caller.orders.createOrder({
    ...sampleOrder,
    customer: { ...sampleOrder.customer, phone: `+88017123456${phoneSuffix}` },
    items: [{ name: "Item", quantity: 1, price: total }],
    cod: total,
  });
}

let keySeq = 0;
const idem = () => `fin-${Date.now()}-${++keySeq}-abcdefgh`;

describe("period resolution (Asia/Dhaka calendar days)", () => {
  it("today / month / year / custom map to Dhaka day boundaries", () => {
    const now = new Date("2026-03-31T20:30:00Z"); // 2026-04-01 02:30 in Dhaka
    expect(resolvePeriod({ preset: "today" }, now)).toMatchObject({ fromDay: "2026-04-01", toDay: "2026-04-01" });
    expect(resolvePeriod({ preset: "month" }, now)).toMatchObject({ fromDay: "2026-04-01", toDay: "2026-04-30" });
    expect(resolvePeriod({ preset: "year" }, now)).toMatchObject({ fromDay: "2026-01-01", toDay: "2026-12-31" });
    const c = resolvePeriod({ preset: "custom", from: "2026-02-01", to: "2026-02-28" }, now);
    expect(c.start.toISOString()).toBe("2026-01-31T18:00:00.000Z");
    expect(c.end.toISOString()).toBe("2026-02-28T18:00:00.000Z"); // exclusive
  });

  it("rejects invalid or inverted custom ranges", () => {
    expect(() => resolvePeriod({ preset: "custom", from: "2026-02-30", to: "2026-03-01" })).toThrow();
    expect(() => resolvePeriod({ preset: "custom", from: "2026-03-02", to: "2026-03-01" })).toThrow();
    expect(() => resolvePeriod({ preset: "custom" } as never)).toThrow();
  });
});

describe("realized revenue = delivered orders only", () => {
  it("pending, confirmed, packed, shipped, in_transit, cancelled and RTO orders are not revenue", async () => {
    const { caller } = await merchant();
    const statuses = ["confirmed", "packed", "shipped", "in_transit", "cancelled", "rto"] as const;
    await order(caller, 100, "00"); // stays pending
    let i = 1;
    for (const s of statuses) {
      const o = await order(caller, 100 * (i + 1), String(i).padStart(2, "0"));
      await walk(caller, o.id, s);
      i++;
    }
    const delivered = await order(caller, 1250, "99");
    await walk(caller, delivered.id, "delivered");

    const s = await caller.finance.summary({ period: THIS_MONTH });
    expect(s.currency).toBe("BDT");
    expect(s.revenue.realized).toBe(1250);
    expect(s.revenue.deliveredOrders).toBe(1);
    // Placed this month and still open: pending 100 + confirmed 200 + packed 300 + shipped 400 + in_transit 500.
    expect(s.revenue.pendingOrderValue).toBe(1500);
    // Everything placed this month, any status.
    expect(s.revenue.grossOrderValue).toBe(100 + 200 + 300 + 400 + 500 + 600 + 700 + 1250);
    expect(s.netProfit).toBe(1250); // no costs recorded
  });

  it("manual 'delivered' stamps the recognition date; courier 'delivered' is recognized too", async () => {
    const { caller } = await merchant();
    const manual = await order(caller, 700, "01");
    await walk(caller, manual.id, "delivered");
    expect((await Order.findById(manual.id).lean())!.logistics?.deliveredAt).toBeInstanceOf(Date);

    const courier = await order(caller, 300, "02");
    await walk(caller, courier.id, "shipped");
    const snap = await Order.findById(courier.id).select("_id merchantId order logistics").lean();
    await applyTrackingEvents(snap as never, "delivered", [{ at: new Date(), providerStatus: "Delivered" }], { source: "webhook" });

    const s = await caller.finance.summary({ period: { preset: "today" } });
    expect(s.revenue.realized).toBe(1000);
    expect(s.revenue.deliveredOrders).toBe(2);
  });

  it("recognizes revenue in the period the order was DELIVERED, not placed", async () => {
    const { caller } = await merchant();
    const o = await order(caller, 900, "01");
    await walk(caller, o.id, "delivered");
    await Order.updateOne({ _id: o.id }, { $set: { "logistics.deliveredAt": new Date("2025-06-15T08:00:00Z") } });
    expect((await caller.finance.summary({ period: THIS_MONTH })).revenue.realized).toBe(0);
    const june = await caller.finance.summary({ period: { preset: "custom", from: "2025-06-01", to: "2025-06-30" } });
    expect(june.revenue.realized).toBe(900);
  });

  it("duplicate and concurrent delivered transitions count the order once", async () => {
    const { caller } = await merchant();
    const o = await order(caller, 1100, "01");
    await walk(caller, o.id, "shipped");
    const snap = await Order.findById(o.id).select("_id merchantId order logistics").lean();
    const ev = { at: new Date("2026-09-27T10:00:00Z"), providerStatus: "Delivered", description: "Delivered" };
    await Promise.allSettled([
      applyTrackingEvents(snap as never, "delivered", [ev], { source: "webhook" }),
      applyTrackingEvents(snap as never, "delivered", [ev], { source: "poll" }),
      caller.orders.updateOrder({ id: o.id, status: "delivered" }),
    ]);
    await caller.orders.updateOrder({ id: o.id, status: "delivered" }); // repeat: no-op
    const s = await caller.finance.summary({ period: ALL });
    expect(s.revenue.realized).toBe(1100);
    expect(s.revenue.deliveredOrders).toBe(1);
  });

  it("an order that is RTO is not revenue even if its courier fee was spent", async () => {
    const { caller } = await merchant();
    const o = await order(caller, 800, "01");
    await caller.orders.updateOrder({ id: o.id, status: "confirmed" });
    await caller.orders.bookShipment({ orderId: o.id, courier: "pathao" });
    await caller.orders.updateOrder({ id: o.id, status: "rto" });
    const s = await caller.finance.summary({ period: ALL });
    expect(s.revenue.realized).toBe(0);
    expect(s.courierCost.fromOrders).toBe(80); // mock Pathao fee on the returned parcel
    expect(s.netProfit).toBe(-80);
  });
});

describe("product cost (unitCost snapshot) and courier fee", () => {
  async function shop() {
    await ensureSystemTemplates();
    const { m, caller } = await merchant();
    const shirt = await caller.products.create({ name: "Shirt", price: 1250, costPrice: 700, initialStock: 20 });
    const mug = await caller.products.create({ name: "Mug", price: 400, initialStock: 20 }); // no cost price
    const tpl = (await caller.landingPages.templates()).find((t) => t.key === "bd-modern-shop")!;
    const page = await caller.landingPages.create({ templateId: tpl.id, name: "Shop" });
    const got = await caller.landingPages.get({ id: page.id });
    const bn = (got.draftContent as Record<string, Record<string, Record<string, unknown>>>).bn!;
    bn.order!.cta = { label: "অর্ডার", action: { kind: "whatsapp", phone: "+8801711000000", message: "" } };
    const saved = await caller.landingPages.saveDraft({ id: page.id, content: { bn }, expectedRevision: 1 });
    const linked = await caller.landingPages.setProducts({ id: page.id, expectedRevision: saved.page.draftRevision, products: [{ productId: shirt.id }, { productId: mug.id }] });
    const slug = `fin-${keySeq++}-shop`;
    await caller.landingPages.setSlug({ id: page.id, slug });
    await caller.landingPages.publish({ id: page.id, expectedRevision: linked.page.draftRevision });
    const resolved = await resolveLandingPageByHost(`${slug}.localhost`, { rootDomain: "localhost", useCache: false });
    if (resolved.kind !== "ok") throw new Error("not published");
    const place = (items: PlaceOrderInput["items"], phone = "01712345678") =>
      placeLandingOrder({
        host: `${slug}.localhost`,
        locale: null,
        idempotencyKey: idem(),
        items,
        customer: { name: "রহিম", phone, address: "বাড়ি ১২, রোড ৫, ধানমন্ডি", district: "ঢাকা" },
        deliveryOptionId: resolved.commerce!.delivery[0]!.id,
      });
    return { m, caller, shirt, mug, place, resolved };
  }

  it("snapshots costPrice into unitCost; later cost changes do not alter the old order", async () => {
    const { caller, shirt, place } = await shop();
    const r = await place([{ productId: shirt.id, quantity: 2 }]);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const o = await Order.findOne({ orderNumber: r.orderNumber }).lean();
    expect(o!.items[0]).toMatchObject({ price: 1250, unitCost: 700, quantity: 2 });

    await caller.products.update({ id: shirt.id, costPrice: 900 });
    expect((await Order.findById(o!._id).lean())!.items[0]!.unitCost).toBe(700);
    expect((await caller.products.get({ id: shirt.id })).costPrice).toBe(900);

    await walk(caller, String(o!._id), "delivered");
    const s = await caller.finance.summary({ period: ALL });
    expect(s.productCost.fromOrders).toBe(1400);
    expect(s.productCost.complete).toBe(true);
    expect(s.revenue.realized).toBe(o!.order.total);
    expect(s.netProfit).toBe(o!.order.total - 1400);
  });

  it("missing cost is reported as missing, never as a recorded zero", async () => {
    const { caller, mug, shirt, place } = await shop();
    const r = await place([{ productId: mug.id, quantity: 1 }, { productId: shirt.id, quantity: 1 }]);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const o = await Order.findOne({ orderNumber: r.orderNumber }).lean();
    const mugLine = o!.items.find((i) => i.name === "Mug")!;
    expect(mugLine.unitCost).toBeUndefined();
    await walk(caller, String(o!._id), "delivered");

    const dashboardOrder = await order(caller, 500, "55"); // free-text item, no product → no cost
    await walk(caller, dashboardOrder.id, "delivered");

    const s = await caller.finance.summary({ period: ALL });
    expect(s.productCost.fromOrders).toBe(700); // only the shirt's recorded cost
    expect(s.productCost.ordersMissingCost).toBe(2);
    expect(s.productCost.complete).toBe(false);
    expect(s.costComplete).toBe(false);
    expect(s.warnings.map((w) => w.code)).toContain("missing_product_cost");
    expect(s.dataQuality.ordersMissingProductCost).toBe(2);
  });

  it("stores the courier fee at booking; bookings without a fee stay 'not recorded'", async () => {
    const { caller } = await merchant();
    const withFee = await order(caller, 1000, "01");
    await caller.orders.updateOrder({ id: withFee.id, status: "confirmed" });
    await caller.orders.bookShipment({ orderId: withFee.id, courier: "pathao" });
    expect((await Order.findById(withFee.id).lean())!.logistics?.courierFee).toBe(80);
    await caller.orders.updateOrder({ id: withFee.id, status: "delivered" });

    const noFee = await order(caller, 600, "02");
    await walk(caller, noFee.id, "delivered"); // delivered without a courier booking
    expect((await Order.findById(noFee.id).lean())!.logistics?.courierFee).toBeUndefined();

    const s = await caller.finance.summary({ period: ALL });
    expect(s.courierCost.fromOrders).toBe(80);
    expect(s.courierCost.ordersMissingFee).toBe(1);
    expect(s.courierCost.complete).toBe(false);
  });

  it("the order view exposes recorded cost and fee, or null when not recorded", async () => {
    const { caller, shirt, mug, place } = await shop();
    const r = await place([{ productId: shirt.id, quantity: 1 }, { productId: mug.id, quantity: 1 }]);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const o = await Order.findOne({ orderNumber: r.orderNumber }).lean();
    const view = await caller.orders.getOrder({ id: String(o!._id) });
    const lines = view.commerce!.lineItems;
    expect(lines.find((l) => l.name === "Shirt")!.unitCost).toBe(700);
    expect(lines.find((l) => l.name === "Mug")!.unitCost).toBeNull();
    expect(view.commerce!.courierFee).toBeNull();
  });

  it("costPrice never reaches public landing payloads or checkout responses", async () => {
    const { shirt, place, resolved } = await shop();
    expect(JSON.stringify(resolved)).not.toMatch(/costPrice|unitCost|"700"|:700\b/);
    const r = await place([{ productId: shirt.id, quantity: 1 }]);
    expect(JSON.stringify(r)).not.toMatch(/costPrice|unitCost/);
  });
});

describe("finance entries", () => {
  it("creates income and expense entries with categories and audit metadata", async () => {
    const { m, caller } = await merchant();
    const cats = await caller.finance.categories();
    expect(cats.expense.map((c) => c.key)).toEqual(
      expect.arrayContaining(["product_cost", "courier", "ads_meta", "ads_google", "ads_tiktok", "office_rent", "salary", "other"]),
    );
    expect(cats.income.map((c) => c.key)).toEqual(expect.arrayContaining(["sales_other", "other_income"]));

    const e = await caller.finance.create({ type: "expense", category: "ads_meta", amount: 2500.5, occurredOn: "2026-09-10", description: "Boost", reference: "INV-1", idempotencyKey: idem() });
    expect(e).toMatchObject({ type: "expense", category: "ads_meta", amount: 2500.5, occurredOn: "2026-09-10", status: "active", currency: "BDT" });
    const doc = await FinanceEntry.findById(e.id).lean();
    expect(String(doc!.merchantId)).toBe(String(m._id));
    expect(String(doc!.createdBy)).toBe(String(m._id));
    expect(doc!.source).toMatchObject({ kind: "manual" });

    await expect(caller.finance.create({ type: "income", category: "ads_meta", amount: 1, occurredOn: "2026-09-10", idempotencyKey: idem() })).rejects.toThrow(/category/i);
    await expect(caller.finance.create({ type: "expense", category: "ads_meta", amount: 0, occurredOn: "2026-09-10", idempotencyKey: idem() })).rejects.toThrow();
    await expect(caller.finance.create({ type: "expense", category: "ads_meta", amount: 1.234, occurredOn: "2026-09-10", idempotencyKey: idem() })).rejects.toThrow();
    await expect(caller.finance.create({ type: "expense", category: "ads_meta", amount: 10, occurredOn: "2026-13-01", idempotencyKey: idem() })).rejects.toThrow();
    // "Sales" from orders is never a manual category.
    await expect(caller.finance.create({ type: "income", category: "sales", amount: 10, occurredOn: "2026-09-10", idempotencyKey: idem() })).rejects.toThrow(/category/i);
  });

  it("duplicate submissions with the same idempotency key create one entry (also concurrently)", async () => {
    const { caller } = await merchant();
    const input = { type: "expense" as const, category: "salary", amount: 15000, occurredOn: "2026-09-01", idempotencyKey: idem() };
    const [a, b, c] = await Promise.all([caller.finance.create(input), caller.finance.create(input), caller.finance.create(input)]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect(await caller.finance.create(input)).toMatchObject({ id: a.id });
    expect(await FinanceEntry.countDocuments({})).toBe(1);
  });

  it("edits active entries and voids instead of deleting; voided entries leave the totals", async () => {
    const { caller } = await merchant();
    const e = await caller.finance.create({ type: "expense", category: "office_rent", amount: 20000, occurredOn: "2026-09-01", idempotencyKey: idem() });
    const edited = await caller.finance.update({ id: e.id, amount: 22000, description: "September rent" });
    expect(edited).toMatchObject({ amount: 22000, description: "September rent" });
    const period = { preset: "custom" as const, from: "2026-09-01", to: "2026-09-30" };
    expect((await caller.finance.summary({ period })).office).toBe(22000);

    const v = await caller.finance.void({ id: e.id, reason: "entered twice" });
    expect(v).toMatchObject({ status: "void", voidReason: "entered twice" });
    expect(await caller.finance.void({ id: e.id })).toMatchObject({ status: "void" }); // idempotent
    await expect(caller.finance.update({ id: e.id, amount: 1 })).rejects.toThrow(/void/i);
    expect(await FinanceEntry.countDocuments({ _id: e.id })).toBe(1); // never deleted
    expect((await caller.finance.summary({ period })).office).toBe(0);
    expect((await caller.finance.list({ period })).items).toHaveLength(0);
    expect((await caller.finance.list({ period, includeVoid: true })).items).toHaveLength(1);
  });

  it("net profit = realized revenue + other income − product − courier − ads − office − salary − other", async () => {
    const { caller } = await merchant();
    const o = await order(caller, 10_000, "01");
    await caller.orders.updateOrder({ id: o.id, status: "confirmed" });
    await caller.orders.bookShipment({ orderId: o.id, courier: "pathao" }); // fee 80
    await caller.orders.updateOrder({ id: o.id, status: "delivered" });
    const today = resolvePeriod({ preset: "today" }).fromDay;
    const add = (type: "income" | "expense", category: string, amount: number) =>
      caller.finance.create({ type, category, amount, occurredOn: today, idempotencyKey: idem() });
    await add("income", "other_income", 500);
    await add("expense", "product_cost", 3000);
    await add("expense", "courier", 120);
    await add("expense", "ads_meta", 1000);
    await add("expense", "ads_google", 400);
    await add("expense", "ads_tiktok", 100);
    await add("expense", "office_rent", 2000);
    await add("expense", "salary", 1500);
    await add("expense", "other", 250);

    const s = await caller.finance.summary({ period: { preset: "today" } });
    expect(s).toMatchObject({
      otherIncome: 500,
      advertising: 1500,
      office: 2000,
      salary: 1500,
      otherExpenses: 250,
    });
    expect(s.revenue.realized).toBe(10_000);
    expect(s.productCost).toMatchObject({ fromOrders: 0, manual: 3000, total: 3000 });
    expect(s.courierCost).toMatchObject({ fromOrders: 80, manual: 120, total: 200 });
    expect(s.totalExpenses).toBe(3000 + 200 + 1500 + 2000 + 1500 + 250);
    expect(s.netProfit).toBe(10_000 + 500 - (3000 + 200 + 1500 + 2000 + 1500 + 250));
    const ads = s.byCategory.find((c) => c.category === "ads_meta")!;
    expect(ads).toMatchObject({ type: "expense", total: 1000, count: 1 });
  });

  it("monthly trend and yearly totals", async () => {
    const { caller } = await merchant();
    await caller.finance.create({ type: "expense", category: "salary", amount: 1000, occurredOn: "2026-01-15", idempotencyKey: idem() });
    await caller.finance.create({ type: "expense", category: "salary", amount: 2000, occurredOn: "2026-03-01", idempotencyKey: idem() });
    await caller.finance.create({ type: "income", category: "other_income", amount: 300, occurredOn: "2026-03-31", idempotencyKey: idem() });
    await caller.finance.create({ type: "expense", category: "salary", amount: 9999, occurredOn: "2025-12-31", idempotencyKey: idem() });
    const o = await order(caller, 5000, "01");
    await walk(caller, o.id, "delivered");
    await Order.updateOne({ _id: o.id }, { $set: { "logistics.deliveredAt": new Date("2026-03-31T19:00:00Z") } }); // 2026-04-01 01:00 Dhaka

    const y = await caller.finance.monthly({ year: 2026 });
    expect(y.months).toHaveLength(12);
    expect(y.months[0]).toMatchObject({ month: "2026-01", revenue: 0, expenses: 1000, netProfit: -1000 });
    expect(y.months[2]).toMatchObject({ month: "2026-03", otherIncome: 300, expenses: 2000, netProfit: -1700 });
    expect(y.months[3]).toMatchObject({ month: "2026-04", revenue: 5000, netProfit: 5000 });

    const year = await caller.finance.summary({ period: { preset: "custom", from: "2026-01-01", to: "2026-12-31" } });
    expect(year.salary).toBe(3000);
    expect(year.revenue.realized).toBe(5000);
    expect(year.netProfit).toBe(5000 + 300 - 3000);
  });
});

describe("tenant isolation", () => {
  it("merchant B cannot read, create for, edit, void or see revenue/profit of merchant A", async () => {
    const a = await merchant();
    const b = await merchant();
    const entry = await a.caller.finance.create({ type: "expense", category: "salary", amount: 5000, occurredOn: "2026-09-01", idempotencyKey: idem() });
    const o = await order(a.caller, 3000, "01");
    await walk(a.caller, o.id, "delivered");

    expect((await b.caller.finance.list({ period: ALL, includeVoid: true })).items).toHaveLength(0);
    await expect(b.caller.finance.update({ id: entry.id, amount: 1 })).rejects.toThrow(/not found/i);
    await expect(b.caller.finance.void({ id: entry.id })).rejects.toThrow(/not found/i);
    const bs = await b.caller.finance.summary({ period: ALL });
    expect(bs.revenue.realized).toBe(0);
    expect(bs.salary).toBe(0);
    expect(bs.netProfit).toBe(0);
    expect((await b.caller.finance.monthly({ year: new Date().getUTCFullYear() })).months.every((m) => m.revenue === 0 && m.expenses === 0)).toBe(true);

    // A merchantId smuggled into the input is ignored: the entry belongs to the caller.
    const smuggled = await b.caller.finance.create({
      type: "expense", category: "other", amount: 1, occurredOn: "2026-09-01", idempotencyKey: idem(),
      ...({ merchantId: String(a.m._id) } as object),
    } as never);
    expect(String((await FinanceEntry.findById(smuggled.id).lean())!.merchantId)).toBe(String(b.m._id));
    // Same idempotency key in two tenants = two independent entries.
    const key = idem();
    const ea = await a.caller.finance.create({ type: "expense", category: "other", amount: 7, occurredOn: "2026-09-01", idempotencyKey: key });
    const eb = await b.caller.finance.create({ type: "expense", category: "other", amount: 7, occurredOn: "2026-09-01", idempotencyKey: key });
    expect(ea.id).not.toBe(eb.id);

    const as = await a.caller.finance.summary({ period: ALL });
    expect(as.revenue.realized).toBe(3000);
    expect(as.salary).toBe(5000);
    expect(await MerchantStats.countDocuments({ merchantId: b.m._id, delivered: { $gt: 0 } })).toBe(0);
  });

  it("foreign or malformed ids are NOT_FOUND / BAD_REQUEST, never another tenant's data", async () => {
    const a = await merchant();
    await expect(a.caller.finance.update({ id: new Types.ObjectId().toHexString(), amount: 1 })).rejects.toThrow(/not found/i);
    await expect(a.caller.finance.void({ id: "not-an-id" })).rejects.toThrow();
  });
});

describe("courier cost: one stored fee per shipment, counted once by final state", () => {
  /** Order booked with a courier; pathao's booking returns a fee (80), steadfast's returns none. */
  async function booked(caller: ReturnType<typeof callerFor>, courier: "pathao" | "steadfast", total = 1000, phone = "01") {
    const o = await order(caller, total, phone);
    await caller.orders.updateOrder({ id: o.id, status: "confirmed" });
    await caller.orders.bookShipment({ orderId: o.id, courier });
    return o;
  }
  const courierDelivered = async (id: string, n = 1) => {
    for (let i = 0; i < n; i++) {
      const snap = await Order.findById(id).select("_id merchantId order logistics").lean();
      await applyTrackingEvents(snap as never, "delivered", [{ at: new Date("2026-09-27T10:00:00Z"), providerStatus: "Delivered", description: "Delivered" }], { source: "webhook" });
    }
  };
  const courierReturned = async (id: string, n = 1) => {
    for (let i = 0; i < n; i++) {
      const snap = await Order.findById(id).select("_id merchantId order logistics").lean();
      await applyTrackingEvents(snap as never, "rto", [{ at: new Date("2026-09-27T11:00:00Z"), providerStatus: "Returned", description: "Returned" }], { source: "poll" });
    }
  };

  it("delivered + courier fee = one courier cost, however many delivered events arrive", async () => {
    const { caller } = await merchant();
    const o = await booked(caller, "pathao");
    expect((await Order.findById(o.id).lean())!.logistics?.courierFee).toBe(80);
    await courierDelivered(o.id, 3);
    await caller.orders.updateOrder({ id: o.id, status: "delivered" }); // same-status repeat
    const s = await caller.finance.summary({ period: ALL });
    expect(s.courierCost).toMatchObject({ fromDelivered: 80, fromReturned: 0, fromOrders: 80, total: 80, ordersMissingFee: 0, complete: true });
    expect(s.revenue.realized).toBe(1000);
  });

  it("RTO + courier fee = one courier cost (manual or courier return, repeated), and no revenue", async () => {
    const { caller } = await merchant();
    const viaCourier = await booked(caller, "pathao", 1000, "01");
    await courierReturned(viaCourier.id, 3);
    const manual = await booked(caller, "pathao", 700, "02");
    await caller.orders.updateOrder({ id: manual.id, status: "rto" });
    await caller.orders.updateOrder({ id: manual.id, status: "rto" });
    for (const id of [viaCourier.id, manual.id]) {
      expect((await Order.findById(id).lean())!.logistics?.returnedAt).toBeInstanceOf(Date);
    }
    const s = await caller.finance.summary({ period: ALL });
    expect(s.courierCost).toMatchObject({ fromDelivered: 0, fromReturned: 160, total: 160, returnedOrders: 2, ordersMissingFee: 0 });
    expect(s.revenue.realized).toBe(0);
    expect(s.netProfit).toBe(-160);
  });

  it("a return later overridden by a courier 'delivered' counts its fee once, as delivered", async () => {
    const { caller } = await merchant();
    const o = await booked(caller, "pathao");
    await courierReturned(o.id);
    expect((await caller.finance.summary({ period: ALL })).courierCost).toMatchObject({ fromReturned: 80, fromDelivered: 0, total: 80 });
    await courierDelivered(o.id, 2); // rto -> delivered is the one allowed courier override
    const s = await caller.finance.summary({ period: ALL });
    expect((await Order.findById(o.id).lean())!.order.status).toBe("delivered");
    expect(s.courierCost).toMatchObject({ fromReturned: 0, fromDelivered: 80, total: 80, returnedOrders: 0 });
    expect(s.revenue.realized).toBe(1000);
  });

  it("delivered -> RTO is refused (manual and courier), so the fee cannot move or double", async () => {
    const { caller } = await merchant();
    const o = await booked(caller, "pathao");
    await courierDelivered(o.id);
    await expect(caller.orders.updateOrder({ id: o.id, status: "rto" })).rejects.toThrow(/invalid status transition/);
    await courierReturned(o.id, 2);
    const s = await caller.finance.summary({ period: ALL });
    expect((await Order.findById(o.id).lean())!.order.status).toBe("delivered");
    expect(s.courierCost).toMatchObject({ fromDelivered: 80, fromReturned: 0, total: 80 });
  });

  it("no courier fee (Steadfast/RedX bookings) is 'not recorded' for delivered and returned orders, never 0", async () => {
    const { caller } = await merchant();
    const d = await booked(caller, "steadfast", 1000, "01");
    const r = await booked(caller, "steadfast", 500, "02");
    for (const id of [d.id, r.id]) expect((await Order.findById(id).lean())!.logistics?.courierFee).toBeUndefined();
    await courierDelivered(d.id);
    await caller.orders.updateOrder({ id: r.id, status: "rto" });
    const s = await caller.finance.summary({ period: ALL });
    expect(s.courierCost).toMatchObject({ fromOrders: 0, total: 0, ordersMissingFee: 2, complete: false });
    expect(s.dataQuality.ordersMissingCourierFee).toBe(2);
    expect(s.warnings.find((w) => w.code === "missing_courier_fee")).toMatchObject({ count: 2 });
    expect(s.costComplete).toBe(false);
  });

  it("orders cancelled before shipment, or still in transit, carry no courier cost and no 'missing' flag", async () => {
    const { caller } = await merchant();
    const cancelled = await order(caller, 900, "01");
    await caller.orders.updateOrder({ id: cancelled.id, status: "confirmed" });
    await caller.orders.updateOrder({ id: cancelled.id, status: "cancelled" });
    await booked(caller, "pathao", 400, "02"); // shipped, not delivered yet
    const s = await caller.finance.summary({ period: ALL });
    expect(s.courierCost).toMatchObject({ fromOrders: 0, total: 0, ordersMissingFee: 0, complete: true });
    expect(s.warnings).toHaveLength(0);
  });

  it("concurrent bookings and status events store and count one fee", async () => {
    const { caller } = await merchant();
    const o = await order(caller, 1000, "01");
    await caller.orders.updateOrder({ id: o.id, status: "confirmed" });
    const bookings = await Promise.allSettled([
      caller.orders.bookShipment({ orderId: o.id, courier: "pathao" }),
      caller.orders.bookShipment({ orderId: o.id, courier: "pathao" }),
      caller.orders.bookShipment({ orderId: o.id, courier: "pathao" }),
    ]);
    const tracking = new Set(
      bookings.filter((b) => b.status === "fulfilled").map((b) => (b as PromiseFulfilledResult<{ trackingNumber: string }>).value.trackingNumber),
    );
    expect(tracking.size).toBe(1);
    expect((await Order.findById(o.id).lean())!.logistics?.courierFee).toBe(80);
    const snap = await Order.findById(o.id).select("_id merchantId order logistics").lean();
    const ev = { at: new Date("2026-09-27T10:00:00Z"), providerStatus: "Delivered", description: "Delivered" };
    await Promise.allSettled([
      applyTrackingEvents(snap as never, "delivered", [ev], { source: "webhook" }),
      applyTrackingEvents(snap as never, "delivered", [ev], { source: "poll" }),
      caller.orders.updateOrder({ id: o.id, status: "delivered" }),
    ]);
    const s = await caller.finance.summary({ period: ALL });
    expect(s.courierCost).toMatchObject({ fromDelivered: 80, total: 80 });
    expect(s.revenue).toMatchObject({ realized: 1000, deliveredOrders: 1 });
  });

  it("the public tracking page never exposes the courier fee or costs", async () => {
    const { caller } = await merchant();
    const o = await booked(caller, "pathao");
    const tn = (await Order.findById(o.id).lean())!.logistics!.trackingNumber!;
    const pub = await fetchPublicTimeline(tn);
    expect(pub).not.toBeNull();
    expect(JSON.stringify(pub)).not.toMatch(/courierFee|unitCost|costPrice/);
  });

  it("manual courier expenses are added as entered — flagged, never auto-reconciled", async () => {
    const { caller } = await merchant();
    const o = await booked(caller, "pathao");
    await courierDelivered(o.id);
    const today = resolvePeriod({ preset: "today" }).fromDay;
    await caller.finance.create({ type: "expense", category: "courier", amount: 150, occurredOn: today, idempotencyKey: idem() });
    const s = await caller.finance.summary({ period: ALL });
    expect(s.courierCost).toMatchObject({ fromOrders: 80, manual: 150, total: 230 });
    expect(s.warnings.map((w) => w.code)).toContain("manual_courier_with_recorded_fees");
  });
});

describe("historical delivered/returned orders without a recorded time", () => {
  it("fallback-dated revenue is reported separately from exact revenue, and stored data is untouched", async () => {
    const { caller } = await merchant();
    const exact = await order(caller, 1000, "01");
    await walk(caller, exact.id, "delivered");
    const legacy = await order(caller, 600, "02");
    await walk(caller, legacy.id, "delivered");
    await Order.updateOne({ _id: legacy.id }, { $unset: { "logistics.deliveredAt": "" } }); // pre-accounting row

    const s = await caller.finance.summary({ period: ALL });
    expect(s.revenue).toMatchObject({ realized: 1600, deliveredOrders: 2, exact: { amount: 1000, orders: 1 }, fallbackDated: { amount: 600, orders: 1 } });
    expect(s.dataQuality).toMatchObject({
      exactDeliveryRevenue: { amount: 1000, orders: 1 },
      fallbackDatedRevenue: { amount: 600, orders: 1 },
      ordersMissingProductCost: 2,
      ordersMissingCourierFee: 2,
    });
    const codes = s.warnings.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(["fallback_dated_revenue", "missing_product_cost", "missing_courier_fee"]));
    expect(s.warnings.find((w) => w.code === "fallback_dated_revenue")).toMatchObject({ count: 1, amount: 600 });
    // Reporting never writes: the legacy order still has no deliveredAt.
    expect((await Order.findById(legacy.id).lean())!.logistics?.deliveredAt).toBeUndefined();
    const y = await caller.finance.monthly({ year: Number(resolvePeriod({ preset: "today" }).fromDay.slice(0, 4)) });
    expect(y.months.reduce((n, m) => n + m.fallbackDatedOrders, 0)).toBe(1);
  });

  it("returned orders without returnedAt are flagged as fallback-dated", async () => {
    const { caller } = await merchant();
    const o = await order(caller, 500, "01");
    await walk(caller, o.id, "rto");
    await Order.updateOne({ _id: o.id }, { $unset: { "logistics.returnedAt": "" } });
    const s = await caller.finance.summary({ period: ALL });
    expect(s.dataQuality.fallbackDatedReturns).toBe(1);
    expect(s.warnings.map((w) => w.code)).toContain("fallback_dated_returns");
    expect((await Order.findById(o.id).lean())!.logistics?.returnedAt).toBeUndefined();
  });
});
