import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { FinanceEntry, InventoryMovement, Merchant, Order, Product, RecoveryTask, TrackingEvent, TrackingSession } from "@ecom/db";
import { __resetTemplateCacheForTests } from "../src/lib/landing/templates.js";
import { resolvePeriod } from "../src/lib/finance/period.js";
import { landingCartSnapshot, recordLandingActivity, visitTouch } from "../src/lib/recovery/landing.js";
import { recordServerTrackingEvents } from "../src/server/tracking/collector.js";
import { disconnectDb, ensureDb, resetDb } from "./helpers.js";
import { deliver, key, shop, touch } from "./landing-shop-fixture.js";

/**
 * Marketing funnel: landing-page visits (first-party, per visitor session)
 * → cart → checkout → orders → delivered revenue, by page and by channel;
 * traffic-type classification; content/term breakdowns; profit only when
 * every cost is recorded; Cart Recovery attribution; missing-data warnings.
 */

const ALL = { preset: "custom" as const, from: "2024-01-01", to: "2030-12-31" };

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Product.syncIndexes(), InventoryMovement.syncIndexes(), Order.syncIndexes(), FinanceEntry.syncIndexes(), TrackingEvent.syncIndexes()]);
});
afterAll(disconnectDb);
beforeEach(async () => {
  await resetDb();
  __resetTemplateCacheForTests();
});

type Shop = Awaited<ReturnType<typeof shop>>;

const visit = (s: Shop, sessionId: string, t: unknown, clientEventId = randomUUID()) =>
  recordLandingActivity({ host: s.host, locale: null, sessionId, type: "page_view", clientEventId, cart: [], touch: t });

const act = (s: Shop, sessionId: string, type: string, extra: Record<string, unknown> = {}) =>
  recordLandingActivity({
    host: s.host,
    locale: null,
    sessionId,
    type,
    clientEventId: randomUUID(),
    cart: [{ productId: s.shirt.id, quantity: 1 }],
    item: { productId: s.shirt.id, quantity: 1 },
    ...extra,
  });

const META_AD = { source: "facebook", medium: "cpc", campaign: "eid-sale", content: "video-a", term: "panjabi", clickIdType: "fbclid" };

describe("landing-page visits", () => {
  it("store where the visit came from — classified on the server, no personal data", async () => {
    const s = await shop();
    const sid = randomUUID();
    const r = await visit(s, sid, touch({ ...META_AD, fbclid: "RAW-CLICK-ID", phone: "01711111111", email: "x@y.test", landingPath: "/?phone=017" }));
    expect(r).toEqual({ ok: true, recorded: true });
    const ev = (await TrackingEvent.findOne({ sessionId: sid, type: "page_view" }).lean())!;
    expect(ev.properties).toMatchObject({
      source: "landing_page",
      touch: { source: "facebook", medium: "cpc", campaign: "eid-sale", content: "video-a", term: "panjabi", clickIdType: "fbclid", channel: "meta", paid: true },
    });
    const raw = JSON.stringify(ev);
    for (const secret of ["RAW-CLICK-ID", "01711111111", "x@y.test", "phone="]) expect(raw).not.toContain(secret);
    expect(ev.phone ?? null).toBeNull();
    expect(ev.email ?? null).toBeNull();
    // The session carries its entry campaign (the same field the storefront tracker uses).
    expect((await TrackingSession.findOne({ sessionId: sid }).lean())?.campaign).toMatchObject({ source: "facebook", medium: "cpc", name: "eid-sale" });
  });

  it("a visit with nothing attributable is direct; junk is dropped", async () => {
    expect(visitTouch(undefined)).toEqual({ channel: "direct", paid: false });
    expect(visitTouch({ at: new Date().toISOString(), source: "<script>" })).toMatchObject({ channel: "other" });
    expect(visitTouch({ at: new Date().toISOString(), referrerHost: "www.google.com" })).toEqual({ referrerHost: "www.google.com", channel: "organic", paid: false });
  });

  it("page views never replace the saved cart Cart Recovery restores", async () => {
    const s = await shop();
    const sid = randomUUID();
    await act(s, sid, "add_to_cart");
    await visit(s, sid, undefined); // e.g. a reload in the same session
    const snap = await landingCartSnapshot(s.merchant._id as Types.ObjectId, sid);
    expect(snap?.lines.map((l) => [l.productId, l.quantity])).toEqual([[s.shirt.id, 1]]);
  });
});

describe("landing funnel", () => {
  it("visits → cart → checkout → orders → delivered, per session (no double counting), by page and channel", async () => {
    const s = await shop();
    // Meta visitor: all the way to a delivered order.
    const a = randomUUID();
    await visit(s, a, touch(META_AD));
    await act(s, a, "add_to_cart");
    await act(s, a, "checkout_start");
    await act(s, a, "checkout_submit");
    const placed = await s.place({ firstTouch: touch(META_AD), lastTouch: touch(META_AD) }, "01711111201");
    if (!placed.ok) throw new Error("order failed");
    await deliver(s.caller, placed.orderNumber);
    // Direct visitor: adds to cart and leaves.
    const b = randomUUID();
    await visit(s, b, undefined);
    await act(s, b, "add_to_cart");
    // Google visitor: reloads twice and a page_view is retried — still one visit.
    const c = randomUUID();
    const retried = randomUUID();
    await visit(s, c, touch({ source: "google", medium: "cpc", clickIdType: "gclid" }), retried);
    await visit(s, c, touch({ source: "google", medium: "cpc", clickIdType: "gclid" }), retried);
    await visit(s, c, touch({ source: "google", medium: "cpc", clickIdType: "gclid" }));

    const f = await s.caller.marketing.funnel({ period: ALL, landingPageId: null });
    expect(f.collecting).toBe(true);
    expect(f.totals).toMatchObject({ visits: 3, addedToCart: 2, checkoutStarted: 1, ordersPlaced: 1, deliveredOrders: 1, deliveredRevenue: placed.total });
    expect(f.rates).toEqual({ visitToCart: 66.7, cartToCheckout: 50, visitToOrder: 33.3 });
    expect(f.pages).toEqual([{ id: s.page.id, name: "Shop", visits: 3, addedToCart: 2, checkoutStarted: 1, ordersPlaced: 1, deliveredOrders: 1, deliveredRevenue: placed.total }]);
    const byChannel = Object.fromEntries(f.channels.map((r) => [r.channel, r]));
    expect(byChannel.meta).toMatchObject({ visits: 1, addedToCart: 1, checkoutStarted: 1, checkoutSubmitted: 1 });
    expect(byChannel.direct).toMatchObject({ visits: 1, addedToCart: 1, checkoutStarted: 0 });
    expect(byChannel.google).toMatchObject({ visits: 1, addedToCart: 0 });

    // Filtered to this page: same numbers.
    const one = await s.caller.marketing.funnel({ period: ALL, landingPageId: s.page.id });
    expect(one.totals.visits).toBe(3);
  });

  it("is merchant-scoped: another merchant (or their page id) sees nothing", async () => {
    const a = await shop();
    const b = await shop();
    await visit(a, randomUUID(), touch(META_AD));
    await a.place(undefined, "01711111202");
    const theirs = await b.caller.marketing.funnel({ period: ALL, landingPageId: null });
    expect(theirs.totals).toMatchObject({ visits: 0, ordersPlaced: 0 });
    const peek = await b.caller.marketing.funnel({ period: ALL, landingPageId: a.page.id });
    expect(peek.totals).toMatchObject({ visits: 0, ordersPlaced: 0 });
    expect(peek.pages).toEqual([]);
  });

  it("Starter: visits aren't collected (said plainly); orders still count", async () => {
    const s = await shop();
    await Merchant.updateOne({ _id: s.merchant._id }, { $set: { "subscription.tier": "starter" } });
    expect(await visit(s, randomUUID(), touch(META_AD))).toEqual({ ok: true, recorded: false });
    const o = await s.place(undefined, "01711111203");
    expect(o.ok).toBe(true);
    const f = await s.caller.marketing.funnel({ period: ALL, landingPageId: null });
    expect(f.collecting).toBe(false);
    expect(f.totals).toMatchObject({ visits: 0, ordersPlaced: 1 });
    expect(f.rates.visitToOrder).toBeNull();
  });
});

describe("overview: traffic types, profit, recovery, warnings", () => {
  it("classifies paid / organic / direct / other / untracked", async () => {
    const s = await shop();
    await s.place({ lastTouch: touch(META_AD) }, "01711111301");
    await s.place({ lastTouch: touch({ referrerHost: "www.google.com" }) }, "01711111302");
    await s.place(undefined, "01711111303");
    await s.place({ lastTouch: touch({ source: "newsletter", medium: "email" }) }, "01711111304");
    await s.caller.orders.createOrder({
      customer: { name: "Jane", phone: "+8801712345699", address: "House 5, Road 3", district: "Dhaka" },
      items: [{ name: "Item", quantity: 1, price: 700 }],
      cod: 700,
    });
    const r = await s.caller.marketing.overview({ period: ALL, touch: "last" });
    expect(Object.fromEntries(r.trafficTypes.map((t) => [t.type, t.ordersPlaced]))).toEqual({ paid: 1, organic: 1, direct: 1, other: 1, untracked: 1 });
  });

  it("profit only when every cost is recorded; warnings say what is missing", async () => {
    const s = await shop();
    const o = await s.place({ lastTouch: touch(META_AD) }, "01711111401");
    if (!o.ok) throw new Error("order failed");
    await deliver(s.caller, o.orderNumber);

    let r = await s.caller.marketing.overview({ period: ALL, touch: "last" });
    let meta = r.channels.find((c) => c.channel === "meta")!;
    expect(meta.profit).toBeNull();
    expect(r.totals.profit).toBeNull();
    expect(r.warnings.map((w) => w.code).sort()).toEqual(["cost_missing", "courier_fee_missing", "paid_without_spend"].sort());

    // Record the product cost and courier fee (as the booking/product data would), and Meta spend.
    await Order.updateOne({ _id: o.orderId }, { $set: { "items.0.unitCost": 400, "logistics.courierFee": 60 } });
    const today = resolvePeriod({ preset: "today" }).fromDay;
    await s.caller.finance.create({ type: "expense", category: "ads_meta", amount: 200, occurredOn: today, idempotencyKey: key() });
    await s.caller.finance.create({ type: "expense", category: "ads_tiktok", amount: 150, occurredOn: today, idempotencyKey: key() });

    r = await s.caller.marketing.overview({ period: ALL, touch: "last" });
    meta = r.channels.find((c) => c.channel === "meta")!;
    expect(meta).toMatchObject({ productCost: 400, courierCost: 60, spend: 200, costPerDeliveredOrder: 200, profit: o.total - 400 - 60 - 200 });
    expect(r.warnings).toEqual([{ code: "spend_without_orders", channel: "tiktok" }]);
    // Same revenue as Accounting — attribution never creates revenue.
    expect(r.totals.deliveredRevenue).toBe((await s.caller.finance.summary({ period: ALL })).revenue.realized);
  });

  it("orders won back by Cart Recovery are reported (and keep their ad attribution)", async () => {
    const s = await shop();
    const o = await s.place(
      { firstTouch: touch(META_AD), lastTouch: touch({ source: "confirmx", medium: "email", campaign: "cart_recovery" }) },
      "01711111501",
    );
    if (!o.ok) throw new Error("order failed");
    await RecoveryTask.create({
      merchantId: s.merchant._id,
      sessionId: randomUUID(),
      abandonedAt: new Date(),
      status: "recovered",
      recoveredOrderId: new Types.ObjectId(o.orderId),
      recoveredAt: new Date(),
    });
    let r = await s.caller.marketing.overview({ period: ALL, touch: "first" });
    expect(r.recovery).toEqual({ recoveredOrders: 1, deliveredOrders: 0, deliveredRevenue: 0 });
    expect(r.channels.find((c) => c.channel === "meta")?.ordersPlaced).toBe(1);
    await deliver(s.caller, o.orderNumber);
    r = await s.caller.marketing.overview({ period: ALL, touch: "last" });
    expect(r.recovery).toEqual({ recoveredOrders: 1, deliveredOrders: 1, deliveredRevenue: o.total });
    const camp = await s.caller.marketing.breakdown({ period: ALL, touch: "last", dimension: "campaign" });
    expect(camp.rows.find((x) => x.value === "cart_recovery")).toMatchObject({ channel: "other", deliveredOrders: 1 });
  });

  it("breaks down by ad content and keyword term", async () => {
    const s = await shop();
    await s.place({ lastTouch: touch(META_AD) }, "01711111601");
    await s.place({ lastTouch: touch({ ...META_AD, content: "carousel-b" }) }, "01711111602");
    const content = await s.caller.marketing.breakdown({ period: ALL, touch: "last", dimension: "content" });
    expect(content.rows.map((r) => [r.value, r.ordersPlaced]).sort()).toEqual([["carousel-b", 1], ["video-a", 1]]);
    const term = await s.caller.marketing.breakdown({ period: ALL, touch: "last", dimension: "term" });
    expect(term.rows).toEqual([expect.objectContaining({ value: "panjabi", channel: "meta", ordersPlaced: 2 })]);
  });
});

describe("storefront vs landing funnels", () => {
  it("the storefront-SDK funnel counts SDK sessions only; landing visits stay in the landing funnel", async () => {
    const s = await shop();
    await visit(s, randomUUID(), touch(META_AD));
    let r = await s.caller.marketing.overview({ period: ALL, touch: "last" });
    expect(r.funnel).toBeNull();
    // A storefront-SDK session (the SDK always sends an anonymous visitor id).
    const sid = randomUUID();
    await recordServerTrackingEvents(s.merchant._id as Types.ObjectId, [
      { sessionId: sid, type: "page_view", clientEventId: randomUUID(), occurredAt: new Date(), properties: {} },
    ]);
    await TrackingSession.updateOne({ sessionId: sid }, { $set: { anonId: "anon-123" } });
    r = await s.caller.marketing.overview({ period: ALL, touch: "last" });
    expect(r.funnel).toMatchObject({ source: "storefront_tracker", sessions: 1 });
  });
});
