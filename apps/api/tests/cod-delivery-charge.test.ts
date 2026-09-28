import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { FinanceEntry, InventoryMovement, Order, Product } from "@ecom/db";
import { ensureSystemTemplates, __resetTemplateCacheForTests } from "../src/lib/landing/templates.js";
import { resolveLandingPageByHost } from "../src/lib/landing/resolve.js";
import { placeLandingOrder, type PlaceOrderInput } from "../src/lib/commerce/landing-orders.js";
import { landingOrdersRouter } from "../src/server/landing-orders.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Cash-on-delivery charge by area: the merchant sets each delivery area's
 * charge on the landing page (the "Delivery & payment" section); the server
 * charges the published page's value for the chosen area and never the
 * browser's. Orders keep the charge they were placed with, and accounting
 * reports it as a split of delivered revenue — never as extra income.
 */

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Product.syncIndexes(), InventoryMovement.syncIndexes(), Order.syncIndexes(), FinanceEntry.syncIndexes()]);
});
afterAll(disconnectDb);
beforeEach(async () => {
  await resetDb();
  __resetTemplateCacheForTests();
});

let seq = 0;
const key = () => `cod-key-${Date.now()}-${++seq}-abcdef`;
const customer = { name: "Rahim", phone: "01712345678", address: "House 12, Road 5, Dhanmondi", district: "Dhaka" };

type Zone = { area: string; time?: string; charge?: number | null };
type Content = Record<string, Record<string, Record<string, unknown>>>;

/** Sets the delivery areas of every locale's delivery section in `content`. */
function withZones(content: Content, zones: Zone[]): Content {
  for (const locale of Object.values(content)) {
    for (const section of Object.values(locale)) {
      if (section && Array.isArray(section.zones)) section.zones = zones.map((z) => ({ time: "", charge: null, ...z }));
    }
  }
  return content;
}

async function shop(slug: string, zones: Zone[]) {
  await ensureSystemTemplates();
  const merchant = await createMerchant({ email: `${slug}@shop.test` });
  const caller = callerFor(authUserFor(merchant));
  const shirt = await caller.products.create({ name: "Shirt", price: 1000, costPrice: 400, initialStock: 20 });
  const tpl = (await caller.landingPages.templates()).find((t) => t.key === "bd-modern-shop")!;
  const page = await caller.landingPages.create({ templateId: tpl.id, name: "Shop" });
  const got = await caller.landingPages.get({ id: page.id });
  const content = withZones(got.draftContent as Content, zones);
  content.bn!.order!.cta = { label: "অর্ডার", action: { kind: "whatsapp", phone: "+8801711000000", message: "" } };
  const saved = await caller.landingPages.saveDraft({ id: page.id, content, expectedRevision: 1 });
  const linked = await caller.landingPages.setProducts({ id: page.id, expectedRevision: saved.page.draftRevision, products: [{ productId: shirt.id }] });
  await caller.landingPages.setSlug({ id: page.id, slug });
  await caller.landingPages.publish({ id: page.id, expectedRevision: linked.page.draftRevision });
  const host = `${slug}.localhost`;
  return { merchant, caller, page, shirt, host, delivery: await zonesOf(host) };
}

async function zonesOf(host: string) {
  const r = await resolveLandingPageByHost(host, { rootDomain: "localhost", useCache: false });
  if (r.kind !== "ok") throw new Error("page not published");
  return r.commerce!.delivery;
}

/** Edits the page's delivery areas and publishes again. */
async function republishZones(s: Awaited<ReturnType<typeof shop>>, zones: Zone[]) {
  const got = await s.caller.landingPages.get({ id: s.page.id });
  const saved = await s.caller.landingPages.saveDraft({ id: s.page.id, content: withZones(got.draftContent as Content, zones), expectedRevision: got.page.draftRevision });
  await s.caller.landingPages.publish({ id: s.page.id, expectedRevision: saved.page.draftRevision });
  return zonesOf(s.host);
}

const order = (host: string, productId: string, extra: Partial<PlaceOrderInput> = {}): PlaceOrderInput => ({
  host,
  locale: null,
  idempotencyKey: key(),
  items: [{ productId, quantity: 1 }],
  customer,
  ...extra,
});

async function post(body: unknown) {
  const app = express();
  app.use(express.json());
  app.use("/api/landing/orders", landingOrdersRouter);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/landing/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

const ZONES: Zone[] = [
  { area: "Inside Dhaka", time: "1-2 days", charge: 60 },
  { area: "Outside Dhaka", time: "3-5 days", charge: 130 },
];

describe("COD delivery charge by area", () => {
  it("each area charges the merchant's configured amount; the order stores charge, area and total", async () => {
    const s = await shop("cod-areas", ZONES);
    expect(s.delivery.map((d) => [d.label, d.charge])).toEqual([
      ["Inside Dhaka", 60],
      ["Outside Dhaka", 130],
    ]);
    for (const zone of s.delivery) {
      const r = await placeLandingOrder(order(s.host, s.shirt.id, { deliveryOptionId: zone.id }));
      if (!r.ok) throw new Error(r.code);
      expect(r).toMatchObject({ subtotal: 1000, deliveryCharge: zone.charge, total: 1000 + zone.charge });
      const o = (await Order.findById(r.orderId).lean())!;
      expect(o.order).toMatchObject({ subtotal: 1000, deliveryCharge: zone.charge, deliveryArea: zone.label, total: 1000 + zone.charge, cod: 1000 + zone.charge });
    }
  });

  it("the browser can't set the charge: a charge in the body is ignored or refused, never used", async () => {
    const s = await shop("cod-tamper", ZONES);
    const outside = s.delivery[1]!;

    // A stale / forged "shown" charge is refused with the current areas — no order.
    const forged = await post({ ...order(s.host, s.shirt.id, { deliveryOptionId: outside.id }), deliveryCharge: 0 });
    expect(forged.status).toBe(409);
    expect(forged.body).toMatchObject({ ok: false, code: "delivery_changed" });
    expect((forged.body.delivery as Array<{ charge: number }>).map((d) => d.charge)).toEqual([60, 130]);
    expect(await Order.countDocuments({ merchantId: s.merchant._id })).toBe(0);

    // Fields that look like order totals are not read at all.
    const extra = await post({ ...order(s.host, s.shirt.id, { deliveryOptionId: outside.id }), total: 1, order: { deliveryCharge: 0, total: 1 }, delivery: { charge: 0 } });
    expect(extra.status).toBe(201);
    expect(extra.body).toMatchObject({ deliveryCharge: 130, total: 1130 });

    // Matching what was shown → placed at the server's charge.
    const ok = await post({ ...order(s.host, s.shirt.id, { deliveryOptionId: outside.id }), deliveryCharge: 130 });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ deliveryCharge: 130, total: 1130 });
  });

  it("an unknown or missing area is refused when the page has areas", async () => {
    const s = await shop("cod-invalid", ZONES);
    expect(await placeLandingOrder(order(s.host, s.shirt.id, { deliveryOptionId: "made-up" }))).toMatchObject({ ok: false, code: "invalid_delivery" });
    expect(await placeLandingOrder(order(s.host, s.shirt.id, { deliveryOptionId: null }))).toMatchObject({ ok: false, code: "invalid_delivery" });
    expect(await Order.countDocuments({ merchantId: s.merchant._id })).toBe(0);
  });

  it("no areas configured → the existing rule: no charge added, confirmed by the seller (never a guessed amount)", async () => {
    const s = await shop("cod-none", []);
    expect(s.delivery).toEqual([]);
    const r = await placeLandingOrder(order(s.host, s.shirt.id, { deliveryOptionId: "anything", deliveryCharge: 999 }));
    if (!r.ok) throw new Error(r.code);
    expect(r).toMatchObject({ deliveryCharge: 0, total: 1000 });
    const o = (await Order.findById(r.orderId).lean())!;
    expect(o.order.deliveryArea).toBeUndefined();
  });

  it("an area without a charge value charges 0 only because the merchant left it empty", async () => {
    const s = await shop("cod-free", [{ area: "Pickup point" }]);
    expect(s.delivery).toEqual([expect.objectContaining({ label: "Pickup point", charge: 0 })]);
    const r = await placeLandingOrder(order(s.host, s.shirt.id, { deliveryOptionId: s.delivery[0]!.id }));
    expect(r).toMatchObject({ ok: true, deliveryCharge: 0, total: 1000 });
  });

  it("changing the charges later leaves placed orders unchanged; a customer still seeing the old charge is asked to review", async () => {
    const s = await shop("cod-history", ZONES);
    const first = await placeLandingOrder(order(s.host, s.shirt.id, { deliveryOptionId: s.delivery[0]!.id, deliveryCharge: 60 }));
    if (!first.ok) throw new Error(first.code);

    const now = await republishZones(s, [
      { area: "Inside Dhaka", charge: 80 },
      { area: "Outside Dhaka", charge: 150 },
    ]);
    expect(now.map((d) => d.charge)).toEqual([80, 150]);

    const before = (await Order.findById(first.orderId).lean())!;
    expect(before.order).toMatchObject({ deliveryCharge: 60, total: 1060, deliveryArea: "Inside Dhaka" });

    expect(await placeLandingOrder(order(s.host, s.shirt.id, { deliveryOptionId: now[0]!.id, deliveryCharge: 60 }))).toMatchObject({
      ok: false,
      code: "delivery_changed",
      delivery: [expect.objectContaining({ charge: 80 }), expect.objectContaining({ charge: 150 })],
    });
    expect(await placeLandingOrder(order(s.host, s.shirt.id, { deliveryOptionId: now[0]!.id, deliveryCharge: 80 }))).toMatchObject({ ok: true, deliveryCharge: 80, total: 1080 });
  });

  it("the charge always comes from the page's own merchant (same area ids on another shop don't leak)", async () => {
    const a = await shop("cod-shop-a", ZONES);
    const b = await shop("cod-shop-b", [{ area: "Inside Dhaka", charge: 5 }]);
    expect(a.delivery[0]!.id).toBe(b.delivery[0]!.id); // same template → same area ids
    const r = await placeLandingOrder(order(a.host, a.shirt.id, { deliveryOptionId: b.delivery[0]!.id }));
    if (!r.ok) throw new Error(r.code);
    expect(r.deliveryCharge).toBe(60);
    expect((await Order.findById(r.orderId).lean())!.merchantId.toString()).toBe(String(a.merchant._id));
    // B's product through A's page is refused outright.
    expect(await placeLandingOrder(order(a.host, b.shirt.id, { deliveryOptionId: a.delivery[0]!.id }))).toMatchObject({ ok: false });
  });

  it("accounting: delivered revenue = product sales + delivery charges (split, not doubled); courier fee is a separate cost", async () => {
    const s = await shop("cod-accounting", ZONES);
    const placed = [];
    for (const zone of s.delivery) {
      const r = await placeLandingOrder(order(s.host, s.shirt.id, { deliveryOptionId: zone.id }));
      if (!r.ok) throw new Error(r.code);
      placed.push(r);
    }
    // One delivered with a recorded courier fee; the other stays pending (not revenue).
    for (const st of ["confirmed", "packed", "shipped", "delivered"]) await s.caller.orders.updateOrder({ id: placed[1]!.orderId, status: st as never });
    await Order.updateOne({ _id: placed[1]!.orderId }, { $set: { "logistics.courierFee": 110 } });

    const sum = await s.caller.finance.summary({ period: { preset: "month" } });
    expect(sum.revenue).toMatchObject({ realized: 1130, productSales: 1000, deliveryCharges: 130, deliveredOrders: 1 });
    expect(sum.revenue.productSales + sum.revenue.deliveryCharges).toBe(sum.revenue.realized);
    expect(sum.courierCost.fromDelivered).toBe(110);
    expect(sum.productCost.fromOrders).toBe(400);
    expect(sum.netProfit).toBe(1130 - 400 - 110);

    const month = new Date().toLocaleString("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit" }).slice(0, 7);
    const monthly = await s.caller.finance.monthly({ year: Number(month.slice(0, 4)) });
    expect(monthly.months.find((m) => m.month === month)).toMatchObject({ revenue: 1130, deliveryCharges: 130 });
  });
});
