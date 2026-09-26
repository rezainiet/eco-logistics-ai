import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import express from "express";
import { Types } from "mongoose";
import { AuditLog, InventoryMovement, LandingPage, Merchant, Order, Product } from "@ecom/db";
import { ensureSystemTemplates, __resetTemplateCacheForTests } from "../src/lib/landing/templates.js";
import { resolveLandingPageByHost } from "../src/lib/landing/resolve.js";
import { placeLandingOrder, type PlaceOrderInput } from "../src/lib/commerce/landing-orders.js";
import { applyTrackingEvents } from "../src/server/tracking.js";
import { landingOrdersRouter } from "../src/server/landing-orders.js";
import { courierWebhookRouter } from "../src/server/webhooks/courier.js";
import { encryptSecret } from "../src/lib/crypto.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Landing page → products → cart → order, end to end on the API:
 * product links, the live public catalog, server-side order validation
 * (tampering, tenant isolation), stock reservation under concurrency,
 * idempotent submission, cancellation restoring stock and courier
 * outcomes moving stock exactly once.
 */

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Product.syncIndexes(), InventoryMovement.syncIndexes(), Order.syncIndexes()]);
});
afterAll(disconnectDb);

let keySeq = 0;
const key = () => `test-key-${Date.now()}-${++keySeq}-abcdef`;

const customer = { name: "রহিম উদ্দিন", phone: "01712345678", address: "বাড়ি ১২, রোড ৫, ধানমন্ডি", district: "ঢাকা" };

async function shopWithProducts(slug: string, email = `${slug}@shop.test`) {
  await ensureSystemTemplates();
  const merchant = await createMerchant({ email });
  const caller = callerFor(authUserFor(merchant));
  const shirt = await caller.products.create({ name: "Premium Cotton Shirt", price: 1290, sku: "SHIRT-01", initialStock: 23 });
  const knife = await caller.products.create({ name: "Kitchen Knife Set", price: 890, initialStock: 8 });
  const watch = await caller.products.create({ name: "Smart Watch", price: 2490, initialStock: 0 });
  const unlinked = await caller.products.create({ name: "Not on page", price: 100, initialStock: 5 });

  const tpl = (await caller.landingPages.templates()).find((t) => t.key === "bd-modern-shop")!;
  const page = await caller.landingPages.create({ templateId: tpl.id, name: "Shop" });
  const got = await caller.landingPages.get({ id: page.id });
  const bn = (got.draftContent as Record<string, Record<string, Record<string, unknown>>>).bn!;
  bn.order!.cta = { label: "অর্ডার", action: { kind: "whatsapp", phone: "+8801711000000", message: "" } };
  const saved = await caller.landingPages.saveDraft({ id: page.id, content: { bn }, expectedRevision: 1 });
  const linked = await caller.landingPages.setProducts({
    id: page.id,
    expectedRevision: saved.page.draftRevision,
    products: [{ productId: shirt.id, badge: "নতুন" }, { productId: knife.id }, { productId: watch.id }],
  });
  await caller.landingPages.setSlug({ id: page.id, slug });
  await caller.landingPages.publish({ id: page.id, expectedRevision: linked.page.draftRevision });
  const resolved = await resolveLandingPageByHost(`${slug}.localhost`, { rootDomain: "localhost", useCache: false });
  if (resolved.kind !== "ok") throw new Error("page not published");
  return { merchant, caller, page, shirt, knife, watch, unlinked, host: `${slug}.localhost`, resolved };
}

function order(host: string, items: PlaceOrderInput["items"], extra: Partial<PlaceOrderInput> = {}, delivery?: string): PlaceOrderInput {
  return { host, locale: null, idempotencyKey: key(), items, customer, deliveryOptionId: delivery ?? null, ...extra };
}

const stockOf = async (id: string) => (await Product.findById(id).lean())!.inventory;

describe("landing page ↔ products", () => {
  beforeEach(async () => {
    await resetDb();
    __resetTemplateCacheForTests();
  });

  it("publishes product references and serves live catalog data — never a copy", async () => {
    const { resolved, shirt, knife, watch, caller, host } = await shopWithProducts("shop-a");
    const c = resolved.commerce!;
    expect(c.currency).toBe("BDT");
    expect(c.products.map((p) => p.name)).toEqual(["Premium Cotton Shirt", "Kitchen Knife Set", "Smart Watch"]);
    expect(c.products[0]).toMatchObject({ id: shirt.id, price: 1290, available: true, stockStatus: "in_stock", maxQuantity: 10, badge: "নতুন" });
    expect(c.products[2]).toMatchObject({ id: watch.id, available: false, stockStatus: "out_of_stock", maxQuantity: 0 });
    expect(c.delivery.length).toBeGreaterThan(0);
    // Internal references never reach the public payload.
    const json = JSON.stringify(resolved);
    expect(json).not.toContain("productScope");
    expect(json).not.toContain(String((await Product.findById(shirt.id).lean())!.merchantId));

    // Price change shows up without republishing (stored page holds no price).
    await caller.products.update({ id: knife.id, price: 990 });
    const again = await resolveLandingPageByHost(host, { rootDomain: "localhost" });
    expect(again.kind === "ok" && again.commerce!.products[1]!.price).toBe(990);
    const stored = await LandingPage.findOne({ slug: "shop-a" }).lean();
    expect(JSON.stringify(stored!.draftProducts)).not.toContain("990");

    // Inactive → shown as unavailable; draft/archived → hidden.
    await caller.products.update({ id: knife.id, status: "inactive" });
    await caller.products.archive({ id: shirt.id });
    const later = await resolveLandingPageByHost(host, { rootDomain: "localhost" });
    const names = later.kind === "ok" ? later.commerce!.products.map((p) => `${p.name}:${p.available}`) : [];
    expect(names).toEqual(["Kitchen Knife Set:false", "Smart Watch:false"]);
  });

  it("only the merchant's own, non-archived products can be linked", async () => {
    const a = await shopWithProducts("shop-a");
    const b = await shopWithProducts("shop-b");
    const page = await a.caller.landingPages.get({ id: a.page.id });
    await expect(
      a.caller.landingPages.setProducts({ id: a.page.id, expectedRevision: page.page.draftRevision, products: [{ productId: b.shirt.id }] }),
    ).rejects.toThrow(/not found/i);
    // B cannot touch A's page at all.
    await expect(b.caller.landingPages.products({ id: a.page.id })).rejects.toThrow(/not found/i);
    await expect(
      b.caller.landingPages.setProducts({ id: a.page.id, expectedRevision: page.page.draftRevision, products: [{ productId: b.shirt.id }] }),
    ).rejects.toThrow(/not found/i);
    // Overrides are plain text only; duplicates rejected.
    await expect(
      a.caller.landingPages.setProducts({ id: a.page.id, expectedRevision: page.page.draftRevision, products: [{ productId: a.shirt.id }, { productId: a.shirt.id }] }),
    ).rejects.toThrow(/Invalid product/);
    const r = await a.caller.landingPages.setProducts({
      id: a.page.id,
      expectedRevision: page.page.draftRevision,
      products: [{ productId: a.shirt.id, ctaText: "Buy\u0000 <b>now</b>\n\n" }],
    });
    expect(r.items[0]!.ctaText).toBe("Buy <b>now</b>"); // text, rendered escaped by React
    expect(r.page.hasUnpublishedChanges).toBe(true);
  });
});

describe("placing a landing-page order", () => {
  beforeEach(async () => {
    await resetDb();
    __resetTemplateCacheForTests();
  });

  it("creates a pending COD order with server prices, delivery charge, source and a stock reservation", async () => {
    const { host, shirt, knife, resolved, merchant, page } = await shopWithProducts("shop-a");
    const zone = resolved.commerce!.delivery[0]!;
    const r = await placeLandingOrder(
      order(host, [
        { productId: shirt.id, quantity: 2, unitPrice: 1290 },
        { productId: knife.id, quantity: 1 },
      ], {}, zone.id),
      { ip: "203.0.113.9", userAgent: "vitest" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ subtotal: 2 * 1290 + 890, deliveryCharge: zone.charge, total: 2 * 1290 + 890 + zone.charge, currency: "BDT", duplicate: false });

    const o = (await Order.findById(r.orderId).lean())!;
    expect(String(o.merchantId)).toBe(String(merchant._id));
    expect(o.order).toMatchObject({ status: "pending", cod: r.total, total: r.total, subtotal: r.subtotal, deliveryCharge: zone.charge, currency: "BDT", deliveryArea: zone.label });
    expect(o.customer).toMatchObject({ name: customer.name, phone: "+8801712345678", district: "ঢাকা" });
    expect(o.items.map((i) => [String(i.productId), i.quantity, i.price])).toEqual([
      [shirt.id, 2, 1290],
      [knife.id, 1, 890],
    ]);
    expect(o.source).toMatchObject({ channel: "landing_page", sourceProvider: "landing_page", landingSlug: "shop-a", locale: "bn", ip: "203.0.113.9" });
    expect(String(o.source!.landingPageId)).toBe(page.id);
    expect(o.inventory).toMatchObject({ state: "reserved", cycle: 1 });
    expect(o.fraud?.level).toBeDefined();

    expect(await stockOf(shirt.id)).toEqual({ onHand: 23, reserved: 2 });
    expect(await stockOf(knife.id)).toEqual({ onHand: 8, reserved: 1 });
    expect(await InventoryMovement.countDocuments({ orderId: o._id, type: "ORDER_RESERVED" })).toBe(2);
    expect(await AuditLog.countDocuments({ action: "order.landing_placed", subjectId: o._id })).toBe(1);

    // Price snapshot: a later price change never alters the order.
    const { caller } = { caller: callerFor(authUserFor(merchant)) };
    await caller.products.update({ id: shirt.id, price: 1500 });
    expect((await Order.findById(r.orderId).lean())!.items[0]!.price).toBe(1290);
  });

  it("rejects tampering: foreign / unlinked products, prices, quantities, delivery, hosts", async () => {
    const a = await shopWithProducts("shop-a");
    const b = await shopWithProducts("shop-b");
    const zone = a.resolved.commerce!.delivery[0]!.id;
    const bad = async (input: PlaceOrderInput) => placeLandingOrder(input);

    expect(await bad(order(a.host, [{ productId: b.shirt.id, quantity: 1 }], {}, zone))).toMatchObject({ ok: false, code: "not_on_page" });
    expect(await bad(order(a.host, [{ productId: a.unlinked.id, quantity: 1 }], {}, zone))).toMatchObject({ ok: false, code: "not_on_page" });
    expect(await bad(order(a.host, [{ productId: a.shirt.id, quantity: 1, unitPrice: 1 }], {}, zone))).toMatchObject({ ok: false, code: "price_changed" });
    expect(await bad(order(a.host, [{ productId: a.watch.id, quantity: 1 }], {}, zone))).toMatchObject({ ok: false, code: "unavailable" });
    expect(await bad(order(a.host, [{ productId: a.knife.id, quantity: 9 }], {}, zone))).toMatchObject({ ok: false, code: "insufficient_stock", available: 8 });
    for (const quantity of [0, -1, 1.5, 11, Number.NaN]) {
      expect(await bad(order(a.host, [{ productId: a.shirt.id, quantity }], {}, zone))).toMatchObject({ ok: false, code: "invalid_request" });
    }
    // Same product split over lines still capped.
    expect(await bad(order(a.host, [{ productId: a.shirt.id, quantity: 6 }, { productId: a.shirt.id, quantity: 6 }], {}, zone))).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await bad(order(a.host, [{ productId: "not-an-id", quantity: 1 }], {}, zone))).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await bad(order(a.host, [{ productId: a.shirt.id, quantity: 1 }], {}, "made-up-zone"))).toMatchObject({ ok: false, code: "invalid_delivery" });
    expect(await bad(order("nope.localhost", [{ productId: a.shirt.id, quantity: 1 }], {}, zone))).toMatchObject({ ok: false, code: "page_unavailable" });
    expect(await bad(order(a.host, [{ productId: a.shirt.id, quantity: 1 }], { idempotencyKey: "short" }, zone))).toMatchObject({ ok: false, code: "invalid_request" });
    expect(
      await bad(order(a.host, [{ productId: a.shirt.id, quantity: 1 }], { customer: { ...customer, phone: "12345" } }, zone)),
    ).toMatchObject({ ok: false, code: "invalid_customer", fields: ["phone"] });
    expect(
      await bad(order(a.host, [{ productId: a.shirt.id, quantity: 1 }], { customer: { name: "", phone: "", address: "", district: "", email: "x@" } }, zone)),
    ).toMatchObject({ ok: false, code: "invalid_customer", fields: ["name", "phone", "address", "district", "email"] });

    // Unpublished page takes no orders.
    await a.caller.landingPages.unpublish({ id: a.page.id });
    expect(await bad(order(a.host, [{ productId: a.shirt.id, quantity: 1 }], {}, zone))).toMatchObject({ ok: false, code: "page_unavailable" });

    // Nothing was created or reserved by any of the above.
    expect(await Order.countDocuments({})).toBe(0);
    expect(await stockOf(a.shirt.id)).toEqual({ onHand: 23, reserved: 0 });
  });

  it("stores customer text as plain text (no control characters) and accepts Bangla digits in phone numbers", async () => {
    const { host, shirt, resolved } = await shopWithProducts("shop-a");
    const r = await placeLandingOrder(
      order(host, [{ productId: shirt.id, quantity: 1 }], {
        customer: { name: '<img src=x onerror="alert(1)">\u0007', phone: "০১৭১২৩৪৫৬৭৮", address: "House 1\u0000, Road 2", district: "Dhaka", notes: "<script>alert(1)</script>" },
      }, resolved.commerce!.delivery[0]!.id),
    );
    expect(r.ok).toBe(true);
    const o = (await Order.findById(r.ok ? r.orderId : "").lean())!;
    expect(o.customer.name).toBe('<img src=x onerror="alert(1)">');
    expect(o.customer.phone).toBe("+8801712345678");
    expect(o.customer.address).toBe("House 1 , Road 2");
    expect(o.order.customerNote).toBe("<script>alert(1)</script>");
  });

  it("a double-submitted order (same key) creates exactly one order and one reservation", async () => {
    const { host, shirt, resolved } = await shopWithProducts("shop-a");
    const input = order(host, [{ productId: shirt.id, quantity: 1 }], {}, resolved.commerce!.delivery[0]!.id);
    const results = await Promise.all([placeLandingOrder(input), placeLandingOrder(input), placeLandingOrder(input)]);
    expect(results.every((r) => r.ok)).toBe(true);
    const ids = new Set(results.map((r) => (r.ok ? r.orderId : "")));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
    expect(await Order.countDocuments({})).toBe(1);
    expect(await stockOf(shirt.id)).toEqual({ onHand: 23, reserved: 1 });
    // A later retry returns the same order too.
    const retry = await placeLandingOrder(input);
    expect(retry.ok && retry.duplicate && retry.orderId).toBe([...ids][0]);
  });

  it("stock 1, two customers at once → exactly one order", async () => {
    const { host, knife, caller, resolved } = await shopWithProducts("shop-a");
    await caller.products.adjustStock({ id: knife.id, type: "MANUAL_ADJUSTMENT", delta: -7 });
    const zone = resolved.commerce!.delivery[0]!.id;
    const other = { ...customer, phone: "01812345678" };
    const results = await Promise.all([
      placeLandingOrder(order(host, [{ productId: knife.id, quantity: 1 }], {}, zone)),
      placeLandingOrder(order(host, [{ productId: knife.id, quantity: 1 }], { customer: other }, zone)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(loser).toMatchObject({ ok: false, code: "insufficient_stock", available: 0 });
    expect(await Order.countDocuments({})).toBe(1);
    expect(await stockOf(knife.id)).toEqual({ onHand: 1, reserved: 1 });
    // Now out of stock on the public page.
    const after = await resolveLandingPageByHost(host, { rootDomain: "localhost" });
    expect(after.kind === "ok" && after.commerce!.products[1]).toMatchObject({ available: false, stockStatus: "out_of_stock" });
  });

  it("limits how often one phone can order", async () => {
    const { host, shirt, resolved } = await shopWithProducts("shop-a");
    const zone = resolved.commerce!.delivery[0]!.id;
    for (let i = 0; i < 5; i++) expect((await placeLandingOrder(order(host, [{ productId: shirt.id, quantity: 1 }], {}, zone))).ok).toBe(true);
    expect(await placeLandingOrder(order(host, [{ productId: shirt.id, quantity: 1 }], {}, zone))).toMatchObject({ ok: false, code: "rate_limited" });
  });
});

describe("order lifecycle moves stock exactly once", () => {
  beforeEach(async () => {
    await resetDb();
    __resetTemplateCacheForTests();
  });

  async function placed() {
    const shop = await shopWithProducts("shop-a");
    const r = await placeLandingOrder(order(shop.host, [{ productId: shop.shirt.id, quantity: 3 }], {}, shop.resolved.commerce!.delivery[0]!.id));
    if (!r.ok) throw new Error(r.code);
    return { ...shop, orderId: r.orderId };
  }

  it("merchant cancel restores stock; a repeated cancel does not double-restore", async () => {
    const { caller, orderId, shirt } = await placed();
    expect(await stockOf(shirt.id)).toEqual({ onHand: 23, reserved: 3 });
    await caller.orders.updateOrder({ id: orderId, status: "cancelled" });
    expect(await stockOf(shirt.id)).toEqual({ onHand: 23, reserved: 0 });
    await expect(caller.orders.updateOrder({ id: orderId, status: "cancelled" })).resolves.toBeDefined();
    expect(await stockOf(shirt.id)).toEqual({ onHand: 23, reserved: 0 });
    expect(await InventoryMovement.countDocuments({ orderId, type: "ORDER_CANCELLED" })).toBe(1);
  });

  it("reject → restore → reject keeps stock consistent", async () => {
    const { caller, orderId, shirt } = await placed();
    await caller.orders.rejectOrder({ id: orderId, reason: "fake" });
    expect(await stockOf(shirt.id)).toEqual({ onHand: 23, reserved: 0 });
    await caller.orders.restoreOrder({ id: orderId });
    expect(await stockOf(shirt.id)).toEqual({ onHand: 23, reserved: 3 });
    await caller.orders.rejectOrder({ id: orderId, reason: "fake again" });
    expect(await stockOf(shirt.id)).toEqual({ onHand: 23, reserved: 0 });
  });

  it("deleting an order gives its stock back", async () => {
    const { caller, orderId, shirt } = await placed();
    await caller.orders.deleteOrder({ id: orderId });
    expect(await stockOf(shirt.id)).toEqual({ onHand: 23, reserved: 0 });
  });

  it("another merchant cannot change the order (or its stock)", async () => {
    const { orderId, shirt } = await placed();
    const intruder = callerFor(authUserFor(await createMerchant({ email: "evil@shop.test" })));
    await expect(intruder.orders.updateOrder({ id: orderId, status: "cancelled" })).rejects.toThrow(/not found/i);
    await expect(intruder.orders.deleteOrder({ id: orderId })).rejects.toThrow(/not found/i);
    await expect(intruder.orders.getOrder({ id: orderId })).rejects.toThrow(/not found/i);
    expect(await stockOf(shirt.id)).toEqual({ onHand: 23, reserved: 3 });
  });

  it("courier delivered (repeated webhook) fulfils once; RTO returns reserved stock once", async () => {
    const { orderId, shirt, caller } = await placed();
    await Order.updateOne({ _id: orderId }, { $set: { "order.status": "shipped", "logistics.courier": "steadfast", "logistics.trackingNumber": "SF1" } });
    const load = async () => (await Order.findById(orderId).lean()) as never;
    const ev = { providerStatus: "delivered", description: "Delivered", at: new Date() };
    await applyTrackingEvents(await load(), "delivered", [ev]);
    await applyTrackingEvents(await load(), "delivered", [ev]);
    await applyTrackingEvents(await load(), "delivered", [{ ...ev, description: "Delivered (dup with new text)" }]);
    expect(await stockOf(shirt.id)).toEqual({ onHand: 20, reserved: 0 });
    expect(await InventoryMovement.countDocuments({ orderId, type: "ORDER_FULFILLED" })).toBe(1);

    // Second order returned by the courier.
    const shop = { host: "shop-a.localhost" };
    const zone = (await resolveLandingPageByHost(shop.host, { rootDomain: "localhost" }));
    const r2 = await placeLandingOrder(order(shop.host, [{ productId: shirt.id, quantity: 2 }], {}, zone.kind === "ok" ? zone.commerce!.delivery[0]!.id : ""));
    if (!r2.ok) throw new Error(r2.code);
    await Order.updateOne({ _id: r2.orderId }, { $set: { "order.status": "in_transit", "logistics.courier": "steadfast", "logistics.trackingNumber": "SF2" } });
    const load2 = async () => (await Order.findById(r2.orderId).lean()) as never;
    await applyTrackingEvents(await load2(), "rto", [{ providerStatus: "returned", description: "Returned", at: new Date() }]);
    await applyTrackingEvents(await load2(), "rto", [{ providerStatus: "returned", description: "Returned", at: new Date() }]);
    expect(await stockOf(shirt.id)).toEqual({ onHand: 20, reserved: 0 });
    expect(await InventoryMovement.countDocuments({ orderId: new Types.ObjectId(r2.orderId), type: "RETURNED" })).toBe(1);
    void caller;
  });
});

describe("POST /api/landing/orders", () => {
  beforeEach(async () => {
    await resetDb();
    __resetTemplateCacheForTests();
  });

  async function post(body: unknown, headers: Record<string, string> = {}) {
    const app = express();
    app.use(express.json());
    app.use("/api/landing/orders", landingOrdersRouter);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/landing/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    } finally {
      server.close();
    }
  }

  it("ignores any merchant id, price or page id in the body; the order belongs to the page's merchant", async () => {
    const a = await shopWithProducts("shop-a");
    const b = await shopWithProducts("shop-b");
    const zone = a.resolved.commerce!.delivery[0]!.id;
    const r = await post({
      ...order(a.host, [{ productId: a.shirt.id, quantity: 1 }], {}, zone),
      merchantId: String(b.merchant._id),
      landingPageId: b.page.id,
      total: 1,
      price: 1,
    });
    expect(r.status).toBe(201);
    const o = (await Order.findById(r.body.orderId).lean())!;
    expect(String(o.merchantId)).toBe(String(a.merchant._id));
    expect(String(o.source!.landingPageId)).toBe(a.page.id);
    expect(o.order.total).toBe(1290 + a.resolved.commerce!.delivery[0]!.charge);
  });

  it("maps failures to HTTP statuses without leaking internals", async () => {
    const a = await shopWithProducts("shop-a");
    expect((await post({ host: "x.localhost" })).status).toBe(400);
    const nf = await post(order("ghost.localhost", [{ productId: a.shirt.id, quantity: 1 }]));
    expect(nf).toMatchObject({ status: 404, body: { ok: false, code: "page_unavailable" } });
    const oos = await post(order(a.host, [{ productId: a.watch.id, quantity: 1 }], {}, a.resolved.commerce!.delivery[0]!.id));
    expect(oos.status).toBe(409);
    expect(JSON.stringify(oos.body)).not.toMatch(/merchant|stack/i);
  });

  it("does not trust a spoofed client-IP header without the proxy secret", async () => {
    const a = await shopWithProducts("shop-a");
    const r = await post(order(a.host, [{ productId: a.shirt.id, quantity: 1 }], {}, a.resolved.commerce!.delivery[0]!.id), {
      "x-landing-client-ip": "198.51.100.77",
      "x-landing-proxy-secret": "wrong-secret-wrong-secret-wrong",
    });
    expect(r.status).toBe(201);
    const o = (await Order.findById(r.body.orderId).lean())!;
    expect(o.source!.ip).not.toBe("198.51.100.77");
  });
});

describe("signed courier webhook → order → stock", () => {
  beforeEach(async () => {
    await resetDb();
    __resetTemplateCacheForTests();
  });

  async function webhook(merchantId: string, body: unknown, secret: string | null) {
    const app = express();
    app.use("/api/webhooks/courier", courierWebhookRouter);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret) headers["x-steadfast-signature"] = createHmac("sha256", secret).update(raw).digest("hex");
    else headers["x-steadfast-signature"] = "0".repeat(64);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/webhooks/courier/steadfast/${merchantId}`, { method: "POST", headers, body: raw });
      return r.status;
    } finally {
      server.close();
    }
  }

  it("verifies the signature, maps by tracking code within the merchant, and moves stock exactly once", async () => {
    const shop = await shopWithProducts("shop-a");
    const other = await shopWithProducts("shop-b");
    const SECRET = "steadfast-webhook-secret-for-tests";
    for (const m of [shop.merchant, other.merchant]) {
      // The test merchant already has a Steadfast account; give it a webhook secret.
      await Merchant.updateOne({ _id: m._id, "couriers.name": "steadfast" }, { $set: { "couriers.$.apiSecret": encryptSecret(SECRET) } });
    }
    const r = await placeLandingOrder(order(shop.host, [{ productId: shop.shirt.id, quantity: 2 }], {}, shop.resolved.commerce!.delivery[0]!.id));
    if (!r.ok) throw new Error(r.code);
    await Order.updateOne({ _id: r.orderId }, { $set: { "order.status": "shipped", "logistics.courier": "steadfast", "logistics.trackingNumber": "SF-LP-1" } });
    const delivered = { tracking_code: "SF-LP-1", status: "delivered", updated_at: "2026-09-26T10:00:00Z", note: "Handed over" };

    // Spoofed: wrong signature → rejected, nothing changes.
    expect(await webhook(String(shop.merchant._id), delivered, null)).toBe(401);
    // Another merchant's endpoint cannot reach this order (tracking code is looked up within that merchant only).
    expect(await webhook(String(other.merchant._id), delivered, SECRET)).toBeLessThan(500);
    expect((await Order.findById(r.orderId).lean())!.order.status).toBe("shipped");
    expect(await stockOf(shop.shirt.id)).toEqual({ onHand: 23, reserved: 2 });

    // Genuine, delivered twice (courier retry) → fulfilled once.
    expect(await webhook(String(shop.merchant._id), delivered, SECRET)).toBe(200);
    expect(await webhook(String(shop.merchant._id), delivered, SECRET)).toBe(200);
    expect((await Order.findById(r.orderId).lean())!.order.status).toBe("delivered");
    expect(await stockOf(shop.shirt.id)).toEqual({ onHand: 21, reserved: 0 });
    expect(await InventoryMovement.countDocuments({ orderId: new Types.ObjectId(r.orderId), type: "ORDER_FULFILLED" })).toBe(1);
  });
});
