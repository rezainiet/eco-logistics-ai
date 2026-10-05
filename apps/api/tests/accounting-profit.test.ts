import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { AuditLog, FinanceEntry, Order, Product } from "@ecom/db";
import { ingestNormalizedOrder } from "../src/server/ingest.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Accounting profit engine on top of the finance ledger:
 *   net revenue  = delivered revenue − customer refunds
 *   gross profit = net revenue − product cost − courier cost
 *   net profit   = gross profit − advertising − other marketing − operating expenses + other income
 * Order costs are snapshotted once at order creation (SKU match only when
 * unambiguous); missing costs stay missing. Entries keep a change history.
 */

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Product.syncIndexes(), Order.syncIndexes(), FinanceEntry.syncIndexes()]);
});
afterAll(disconnectDb);
beforeEach(resetDb);

const ALL = { preset: "custom" as const, from: "2024-01-01", to: "2030-12-31" };
type Caller = ReturnType<typeof callerFor>;

async function merchant() {
  const m = await createMerchant();
  return { m, caller: callerFor(authUserFor(m)) };
}

let phoneSeq = 10;
async function order(caller: Caller, items: Array<{ name: string; sku?: string; quantity: number; price: number }>) {
  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  return caller.orders.createOrder({
    customer: { name: "Rahim", phone: `+88017123456${String(++phoneSeq).padStart(2, "0")}`, address: "House 5, Road 3", district: "Dhaka" },
    items,
    cod: total,
  });
}

async function walk(caller: Caller, id: string, to: "delivered" | "rto" | "cancelled") {
  const path = { delivered: ["confirmed", "packed", "shipped", "delivered"], rto: ["confirmed", "packed", "shipped", "rto"], cancelled: ["cancelled"] }[to];
  for (const s of path) await caller.orders.updateOrder({ id, status: s as never });
}

const setFee = (id: string, fee: number) => Order.updateOne({ _id: id }, { $set: { "logistics.courierFee": fee } });
const unitCosts = async (id: string) => (await Order.findById(id).lean())!.items.map((i) => i.unitCost);

let keySeq = 0;
const idem = () => `acct-${Date.now()}-${++keySeq}-abcdefgh`;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date());

/** Audit rows are written fire-and-forget; wait until `n` exist. */
async function auditRows(subjectId: string, n: number) {
  for (let i = 0; i < 50; i++) {
    if ((await AuditLog.countDocuments({ subjectId: new Types.ObjectId(subjectId) })) >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`expected ${n} audit rows`);
}

describe("P&L: gross and net profit", () => {
  it("refunds are contra-revenue; software & other marketing are their own lines; gross and net reconcile", async () => {
    const { m, caller } = await merchant();
    await Product.create({ merchantId: m._id, name: "Shirt", sku: "SHIRT-1", price: 1000, costPrice: 400 });
    const o = await order(caller, [{ name: "Shirt", sku: "SHIRT-1", quantity: 1, price: 1000 }]);
    await walk(caller, o.id, "delivered");
    await setFee(o.id, 80);

    const add = (category: string, amount: number, type: "income" | "expense" = "expense") =>
      caller.finance.create({ type, category, amount, occurredOn: today(), idempotencyKey: idem() });
    await add("customer_refund", 100);
    await add("software", 50);
    await add("marketing_other", 30);
    await add("ads_meta", 200);
    await add("salary", 500);
    await add("other_income", 25, "income");

    const s = await caller.finance.summary({ period: ALL });
    expect(s.revenue.realized).toBe(1000);
    expect(s.refunds).toBe(100);
    expect(s.netRevenue).toBe(900);
    expect(s.productCost.total).toBe(400);
    expect(s.courierCost.total).toBe(80);
    expect(s.grossProfit).toBe(420);
    expect(s.advertising).toBe(200);
    expect(s.marketing).toBe(30);
    expect(s.software).toBe(50);
    expect(s.operatingExpenses).toBe(550); // office 0 + software 50 + salary 500 + other 0
    expect(s.totalExpenses).toBe(100 + 400 + 80 + 200 + 30 + 550);
    expect(s.netProfit).toBe(s.grossProfit - s.advertising - s.marketing - s.operatingExpenses + s.otherIncome);
    expect(s.netProfit).toBe(-335);
    expect(s.costComplete).toBe(true);
    // Refunds are not counted as "other expenses" too.
    expect(s.otherExpenses).toBe(0);
  });

  it("missing costs are flagged, never zero-filled into a complete profit", async () => {
    const { caller } = await merchant();
    const o = await order(caller, [{ name: "Free text item", quantity: 2, price: 300 }]);
    await walk(caller, o.id, "delivered");
    const s = await caller.finance.summary({ period: ALL });
    expect(s.productCost.ordersMissingCost).toBe(1);
    expect(s.courierCost.ordersMissingFee).toBe(1);
    expect(s.costComplete).toBe(false);
    expect(s.grossProfit).toBe(600); // what is known — and flagged incomplete
  });

  it("the year's totals equal the sum of its months, and carry completeness", async () => {
    const { caller } = await merchant();
    await caller.finance.create({ type: "expense", category: "software", amount: 40, occurredOn: "2026-02-10", idempotencyKey: idem() });
    await caller.finance.create({ type: "expense", category: "customer_refund", amount: 70, occurredOn: "2026-05-01", idempotencyKey: idem() });
    await caller.finance.create({ type: "income", category: "other_income", amount: 15, occurredOn: "2026-05-02", idempotencyKey: idem() });
    const o = await order(caller, [{ name: "Item", quantity: 1, price: 900 }]);
    await walk(caller, o.id, "delivered");
    await Order.updateOne({ _id: o.id }, { $set: { "logistics.deliveredAt": new Date("2026-05-10T06:00:00Z") } });

    const y = await caller.finance.monthly({ year: 2026 });
    expect(y.months).toHaveLength(12);
    for (const k of ["revenue", "refunds", "netRevenue", "grossProfit", "software", "otherIncome", "expenses", "netProfit"] as const) {
      expect(y.totals[k]).toBeCloseTo(y.months.reduce((a, m) => a + m[k], 0), 2);
    }
    const may = y.months.find((m) => m.month === "2026-05")!;
    expect(may).toMatchObject({ revenue: 900, refunds: 70, netRevenue: 830, deliveredOrders: 1, costComplete: false });
    expect(y.totals.costComplete).toBe(false);
    expect(y.totals.software).toBe(40);
  });
});

describe("order cost snapshot (dashboard & integration orders)", () => {
  it("snapshots unitCost from an unambiguous SKU match only, and never rewrites it later", async () => {
    const { m, caller } = await merchant();
    const other = await createMerchant();
    const shirt = await Product.create({ merchantId: m._id, name: "Shirt", sku: "SHIRT-1", price: 1000, costPrice: 400 });
    await Product.create({
      merchantId: m._id,
      name: "Mug",
      price: 300,
      costPrice: 120,
      options: [{ name: "Color", values: ["Red", "Blue"] }],
      variants: [
        { optionValues: ["Red"], sku: "MUG-RED", costPrice: 150 },
        { optionValues: ["Blue"], sku: "MUG-BLUE" }, // no own cost → product's
      ],
    });
    // "DUP" is a product SKU and another product's variant SKU → ambiguous.
    await Product.create({ merchantId: m._id, name: "Cap", sku: "DUP", price: 200, costPrice: 10 });
    await Product.create({ merchantId: m._id, name: "Hat", price: 200, costPrice: 20, options: [{ name: "Size", values: ["M"] }], variants: [{ optionValues: ["M"], sku: "DUP" }] });
    await Product.create({ merchantId: m._id, name: "Pen", sku: "NOCOST", price: 50 });
    await Product.create({ merchantId: other._id, name: "Theirs", sku: "THEIRS", price: 10, costPrice: 5 });

    const o = await order(caller, [
      { name: "Shirt", sku: "SHIRT-1", quantity: 2, price: 1000 },
      { name: "Mug red", sku: "MUG-RED", quantity: 1, price: 300 },
      { name: "Mug blue", sku: "MUG-BLUE", quantity: 1, price: 300 },
      { name: "Dup", sku: "DUP", quantity: 1, price: 200 },
      { name: "Pen", sku: "NOCOST", quantity: 1, price: 50 },
      { name: "Not mine", sku: "THEIRS", quantity: 1, price: 10 },
      { name: "Free text", quantity: 1, price: 10 },
    ]);
    expect(await unitCosts(o.id)).toEqual([400, 150, 120, undefined, undefined, undefined, undefined]);
    expect((await Order.findById(o.id).lean())!.items[0]!.productId).toBeUndefined(); // no product link is invented

    // A later cost change applies to new orders only.
    await Product.updateOne({ _id: shirt._id }, { $set: { costPrice: 999 } });
    expect((await unitCosts(o.id))[0]).toBe(400);
    const later = await order(caller, [{ name: "Shirt", sku: "SHIRT-1", quantity: 1, price: 1000 }]);
    expect(await unitCosts(later.id)).toEqual([999]);
  });

  it("integration-ingested orders snapshot by SKU the same way", async () => {
    const { m } = await merchant();
    await Product.create({ merchantId: m._id, name: "Shirt", sku: "SHIRT-1", price: 1000, costPrice: 400 });
    const r = await ingestNormalizedOrder(
      {
        externalId: "ext-acct-1",
        customer: { name: "Karim", phone: "+8801712345699", address: "House 1, Road 2", district: "Dhaka" },
        items: [
          { name: "Shirt", sku: "SHIRT-1", quantity: 1, price: 1000 },
          { name: "Unknown", sku: "NOPE", quantity: 1, price: 100 },
        ],
        cod: 1100,
        total: 1100,
      },
      { merchantId: m._id as Types.ObjectId, source: "custom_api", channel: "api" },
    );
    expect(r.ok).toBe(true);
    expect(await unitCosts(r.orderId!)).toEqual([400, undefined]);
  });
});

describe("order-level profit", () => {
  async function fixture() {
    const a = await merchant();
    await Product.create({ merchantId: a.m._id, name: "Shirt", sku: "SHIRT-1", price: 1000, costPrice: 400 });
    const complete = await order(a.caller, [{ name: "Shirt", sku: "SHIRT-1", quantity: 1, price: 1000 }]);
    await walk(a.caller, complete.id, "delivered");
    await setFee(complete.id, 80);
    const noCost = await order(a.caller, [{ name: "Free text", quantity: 1, price: 500 }]);
    await walk(a.caller, noCost.id, "delivered");
    await setFee(noCost.id, 60);
    const rtoFee = await order(a.caller, [{ name: "Shirt", sku: "SHIRT-1", quantity: 1, price: 1000 }]);
    await walk(a.caller, rtoFee.id, "rto");
    await setFee(rtoFee.id, 90);
    const rtoNoFee = await order(a.caller, [{ name: "Free text", quantity: 1, price: 700 }]);
    await walk(a.caller, rtoNoFee.id, "rto");
    const cancelled = await order(a.caller, [{ name: "Shirt", sku: "SHIRT-1", quantity: 1, price: 1000 }]);
    await walk(a.caller, cancelled.id, "cancelled");
    const open = await order(a.caller, [{ name: "Shirt", sku: "SHIRT-1", quantity: 1, price: 1000 }]);
    return { ...a, ids: { complete: complete.id, noCost: noCost.id, rtoFee: rtoFee.id, rtoNoFee: rtoNoFee.id, cancelled: cancelled.id, open: open.id } };
  }

  it("lists delivered and returned orders with profit; unknown costs give unknown profit", async () => {
    const { caller, ids } = await fixture();
    const list = await caller.finance.orderProfit({ period: ALL });
    const byId = new Map(list.items.map((i) => [i.id, i]));
    expect(list.items).toHaveLength(4);
    expect(byId.has(ids.cancelled) || byId.has(ids.open)).toBe(false);
    expect(byId.get(ids.complete)).toMatchObject({ status: "delivered", revenue: 1000, productCost: 400, courierFee: 80, profit: 520, missing: [] });
    expect(byId.get(ids.noCost)).toMatchObject({ revenue: 500, productCost: null, courierFee: 60, profit: null, missing: ["product_cost"] });
    expect(byId.get(ids.rtoFee)).toMatchObject({ status: "rto", revenue: 0, productCost: 0, courierFee: 90, profit: -90 });
    expect(byId.get(ids.rtoNoFee)).toMatchObject({ profit: null, missing: ["courier_fee"] });

    const missing = await caller.finance.orderProfit({ period: ALL, missingOnly: true });
    expect(missing.items.map((i) => i.id).sort()).toEqual([ids.noCost, ids.rtoNoFee].sort());

    // The known order profits match the P&L's per-order components.
    const s = await caller.finance.summary({ period: ALL });
    expect(s.courierCost.total).toBe(80 + 60 + 90);
    expect(s.productCost.total).toBe(400);
  });

  it("pages with a stable cursor and is merchant-scoped", async () => {
    const { caller } = await fixture();
    const p1 = await caller.finance.orderProfit({ period: ALL, limit: 3 });
    expect(p1.items).toHaveLength(3);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await caller.finance.orderProfit({ period: ALL, limit: 3, cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(4);
    // A garbage cursor is ignored, not an error.
    expect((await caller.finance.orderProfit({ period: ALL, cursor: "garbage" })).items).toHaveLength(4);

    const b = await merchant();
    expect((await b.caller.finance.orderProfit({ period: ALL })).items).toHaveLength(0);
  });

  it("the order view shows the same profit", async () => {
    const { caller, ids } = await fixture();
    expect((await caller.orders.getOrder({ id: ids.complete })).commerce!.profit).toMatchObject({ realized: true, profit: 520 });
    expect((await caller.orders.getOrder({ id: ids.noCost })).commerce!.profit).toMatchObject({ profit: null, missing: ["product_cost"] });
    expect((await caller.orders.getOrder({ id: ids.open })).commerce!.profit).toMatchObject({ realized: false, profit: null });
    expect((await caller.orders.getOrder({ id: ids.cancelled })).commerce!.profit).toMatchObject({ realized: false });
  });
});

describe("entry change history", () => {
  it("records create, edit (field changes) and void with reason; other merchants can't read it", async () => {
    const { caller } = await merchant();
    const e = await caller.finance.create({ type: "expense", category: "office_rent", amount: 500, occurredOn: "2026-09-01", idempotencyKey: idem() });
    await auditRows(e.id, 1);
    await caller.finance.update({ id: e.id, amount: 650, description: "September rent" });
    await auditRows(e.id, 2);
    await caller.finance.void({ id: e.id, reason: "entered twice" });
    await auditRows(e.id, 3);

    const h = await caller.finance.entryHistory({ id: e.id });
    expect(h.map((r) => r.action)).toEqual(["created", "updated", "voided"]);
    expect(h[1]!.changes).toEqual(
      expect.arrayContaining([
        { field: "amount", from: 500, to: 650 },
        { field: "description", from: "", to: "September rent" },
      ]),
    );
    expect(h[1]!.changes.find((c) => c.field === "category")).toBeUndefined(); // unchanged fields are not listed
    expect(h[2]!.reason).toBe("entered twice");

    // The entry itself is kept (void, not deleted) with its edited values.
    expect(await FinanceEntry.findById(e.id).lean()).toMatchObject({ status: "void", amount: 650 });

    const b = await merchant();
    await expect(b.caller.finance.entryHistory({ id: e.id })).rejects.toThrow(/not found/i);
  });
});
