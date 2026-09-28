import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FinanceEntry, InventoryMovement, Order, Product } from "@ecom/db";
import { __resetTemplateCacheForTests } from "../src/lib/landing/templates.js";
import { disconnectDb, ensureDb, resetDb } from "./helpers.js";
import { LandingPage } from "@ecom/db";
import { Types } from "mongoose";
import { resolvePeriod } from "../src/lib/finance/period.js";
import { authUserFor, callerFor, createMerchant } from "./helpers.js";
import { deliver, key, shop, touch } from "./landing-shop-fixture.js";

/**
 * Merchant marketing reports: orders by channel/source/medium/campaign,
 * delivered revenue by Accounting's exact rule, ad spend only as entered.
 */

const ALL = { preset: "custom" as const, from: "2024-01-01", to: "2030-12-31" };

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Product.syncIndexes(), InventoryMovement.syncIndexes(), Order.syncIndexes(), FinanceEntry.syncIndexes()]);
});
afterAll(disconnectDb);
beforeEach(async () => {
  await resetDb();
  __resetTemplateCacheForTests();
});

describe("marketing reports", () => {
  it("orders by channel; delivered revenue follows Accounting exactly; untracked vs direct", async () => {
    const { caller, place } = await shop();
    const meta = await place({ firstTouch: touch({ source: "facebook", medium: "cpc" }), lastTouch: touch({ source: "tiktok", clickIdType: "ttclid" }) }, "01711111101");
    const google = await place({ lastTouch: touch({ source: "google", medium: "cpc", clickIdType: "gclid" }) }, "01711111102");
    const direct = await place(undefined, "01711111103");
    if (!meta.ok || !google.ok || !direct.ok) throw new Error("placement failed");
    await deliver(caller, meta.orderNumber);
    await deliver(caller, direct.orderNumber);
    const dashboard = await caller.orders.createOrder({
      customer: { name: "Jane", phone: "+8801712345699", address: "House 5, Road 3", district: "Dhaka" },
      items: [{ name: "Item", quantity: 1, price: 700 }],
      cod: 700,
    });
    for (const s of ["confirmed", "packed", "shipped", "delivered"]) await caller.orders.updateOrder({ id: dashboard.id, status: s as never });

    const last = await caller.marketing.overview({ period: ALL, touch: "last" });
    const row = (c: string) => last.channels.find((r) => r.channel === c);
    expect(row("tiktok")).toMatchObject({ ordersPlaced: 1, deliveredOrders: 1 });
    expect(row("google")).toMatchObject({ ordersPlaced: 1, deliveredOrders: 0, deliveredRevenue: 0 });
    expect(row("direct")).toMatchObject({ ordersPlaced: 1, deliveredOrders: 1 });
    expect(row("untracked")).toMatchObject({ ordersPlaced: 1, deliveredOrders: 1, deliveredRevenue: 700 });
    expect(last.totals.ordersPlaced).toBe(4);

    const first = await caller.marketing.overview({ period: ALL, touch: "first" });
    expect(first.channels.find((r) => r.channel === "meta")).toMatchObject({ ordersPlaced: 1, deliveredOrders: 1 });
    expect(first.channels.find((r) => r.channel === "tiktok")).toBeUndefined();

    // Same revenue rule as Accounting: attribution is a label, never a second revenue source.
    const acct = await caller.finance.summary({ period: ALL });
    expect(last.totals.deliveredRevenue).toBe(acct.revenue.realized);
    expect(first.totals.deliveredRevenue).toBe(acct.revenue.realized);
    expect(last.totals.deliveredOrders).toBe(acct.revenue.deliveredOrders);
  });

  it("no ad spend is invented: cost per order and ROAS appear only for entered spend", async () => {
    const { caller, place } = await shop();
    const o = await place({ lastTouch: touch({ source: "facebook", medium: "cpc" }) }, "01711111104");
    if (!o.ok) throw new Error("placement failed");
    await deliver(caller, o.orderNumber);
    let r = await caller.marketing.overview({ period: ALL, touch: "last" });
    expect(r.channels.find((c) => c.channel === "meta")).toMatchObject({ spend: null, costPerOrder: null, roas: null });
    expect(r.totals.roas).toBeNull();
    expect(r.spendSource).toBe("manual_accounting_entries");

    const today = resolvePeriod({ preset: "today" }).fromDay;
    await caller.finance.create({ type: "expense", category: "ads_meta", amount: 500, occurredOn: today, idempotencyKey: key() });
    r = await caller.marketing.overview({ period: ALL, touch: "last" });
    const m = r.channels.find((c) => c.channel === "meta")!;
    expect(m.spend).toBe(500);
    expect(m.costPerOrder).toBe(500);
    expect(m.roas).toBe(Math.round((m.deliveredRevenue / 500) * 100) / 100);
    expect(r.channels.find((c) => c.channel === "google")).toBeUndefined(); // no spend, no orders → no row
  });

  it("breakdown by campaign / source / medium, attributed orders only", async () => {
    const { caller, place } = await shop();
    const a = await place({ lastTouch: touch({ source: "facebook", medium: "cpc", campaign: "eid" }) }, "01711111105");
    const b = await place({ lastTouch: touch({ source: "facebook", medium: "cpc", campaign: "eid" }) }, "01711111106");
    const c = await place({ lastTouch: touch({ source: "google", medium: "cpc", campaign: "search" }) }, "01711111107");
    await place(undefined, "01711111108");
    if (!a.ok || !b.ok || !c.ok) throw new Error("placement failed");
    await deliver(caller, a.orderNumber);
    const byCampaign = await caller.marketing.breakdown({ period: ALL, touch: "last", dimension: "campaign" });
    expect(byCampaign.rows).toEqual([
      { value: "eid", channel: "meta", ordersPlaced: 2, deliveredOrders: 1, deliveredRevenue: expect.any(Number) },
      { value: "search", channel: "google", ordersPlaced: 1, deliveredOrders: 0, deliveredRevenue: 0 },
    ]);
    const bySource = await caller.marketing.breakdown({ period: ALL, touch: "last", dimension: "source" });
    expect(bySource.rows.map((r) => r.value).sort()).toEqual(["facebook", "google"]);
  });

  it("merchant B sees none of merchant A's orders, attribution or campaigns", async () => {
    const a = await shop();
    const o = await a.place({ lastTouch: touch({ source: "facebook", campaign: "secret-campaign" }) }, "01711111109");
    if (!o.ok) throw new Error("placement failed");
    await deliver(a.caller, o.orderNumber);
    const b = callerFor(authUserFor(await createMerchant()));
    const ov = await b.marketing.overview({ period: ALL, touch: "last" });
    expect(ov.channels).toEqual([]);
    expect(ov.totals).toMatchObject({ ordersPlaced: 0, deliveredRevenue: 0 });
    const br = await b.marketing.breakdown({ period: ALL, touch: "last", dimension: "campaign" });
    expect(br.rows).toEqual([]);
    expect(JSON.stringify(br)).not.toContain("secret-campaign");
    // A still sees it.
    const mine = await a.caller.marketing.breakdown({ period: ALL, touch: "last", dimension: "campaign" });
    expect(mine.rows[0]!.value).toBe("secret-campaign");
  });

  it("attribution on a public response never leaks: checkout returns no attribution or cost fields", async () => {
    const { place } = await shop();
    const r = await place({ lastTouch: touch({ source: "facebook", campaign: "c1" }) }, "01711111110");
    expect(JSON.stringify(r)).not.toMatch(/attribution|facebook|c1"|unitCost|costPrice/);
    expect(await LandingPage.countDocuments({})).toBeGreaterThan(0);
    expect(Types.ObjectId.isValid(String((r as { orderId?: string }).orderId))).toBe(true);
  });
});
