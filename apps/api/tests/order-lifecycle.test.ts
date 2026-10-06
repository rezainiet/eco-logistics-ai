import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FraudPrediction, InventoryMovement, Merchant, Notification, Order, Product, Usage, WebhookInbox, currentUsagePeriod } from "@ecom/db";
import { enqueueOrderConfirmationSms } from "../src/workers/automationSms.js";
import { __TEST as book, enqueueAutoBook } from "../src/workers/automationBook.js";
import { processOrderAfterCreate, storeOrderLifecycle, MAX_LIVE_ORDER_AGE_MS } from "../src/lib/order-lifecycle.js";
import { ingestNormalizedOrder, processWebhookOnce } from "../src/server/ingest.js";
import { placeLandingOrder, type PlaceOrderInput } from "../src/lib/commerce/landing-orders.js";
import { ensureSystemTemplates, __resetTemplateCacheForTests } from "../src/lib/landing/templates.js";
import { resolveLandingPageByHost } from "../src/lib/landing/resolve.js";
import type { NormalizedOrder } from "../src/lib/integrations/types.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Every LIVE order — landing checkout, dashboard order, Shopify /
 * WooCommerce / custom-API store order — enters the same post-create
 * pipeline once, after the order is committed. Historical imports (store
 * history import, CSV upload, store orders that arrive long after they were
 * placed) never run live automation.
 *
 * Only the two queue boundaries are stubbed (no Redis in tests): the
 * confirmation-SMS and auto-book enqueues. Everything else is the real
 * code against the database.
 */
vi.mock("../src/workers/automationSms.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/workers/automationSms.js")>()),
  enqueueOrderConfirmationSms: vi.fn(async () => {}),
}));
vi.mock("../src/workers/automationBook.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/workers/automationBook.js")>()),
  enqueueAutoBook: vi.fn(async () => {}),
}));
const smsJobs = vi.mocked(enqueueOrderConfirmationSms);
const bookJobs = vi.mocked(enqueueAutoBook);

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Order.syncIndexes(), Product.syncIndexes(), InventoryMovement.syncIndexes(), WebhookInbox.syncIndexes(), Notification.syncIndexes()]);
});
afterAll(disconnectDb);
beforeEach(async () => {
  await resetDb();
  __resetTemplateCacheForTests();
  smsJobs.mockReset();
  smsJobs.mockImplementation(async () => {});
  bookJobs.mockReset();
  bookJobs.mockImplementation(async () => {});
});

type Mode = "manual" | "semi_auto" | "full_auto";
/** A merchant with automation set up (auto-confirm ceiling 100 so a fresh low-risk order confirms). */
async function shop(opts: { tier?: "starter" | "growth"; mode?: Mode | "off"; autoBook?: boolean } = {}) {
  const m = await createMerchant({ tier: opts.tier ?? "growth" });
  const mode = opts.mode ?? "semi_auto";
  await Merchant.collection.updateOne(
    { _id: m._id },
    {
      $set: {
        automationConfig: {
          enabled: mode !== "off",
          mode: mode === "off" ? "manual" : mode,
          maxRiskForAutoConfirm: 100,
          autoBookEnabled: !!opts.autoBook,
          ...(opts.autoBook ? { autoBookCourier: "steadfast" } : {}),
        },
      },
    },
  );
  return { mid: m._id as Types.ObjectId, caller: callerFor(authUserFor(m)), integrationId: new Types.ObjectId() };
}

let seq = 0;
const phone = () => `+88017${String(50000000 + ++seq)}`;
const normalized = (over: Partial<NormalizedOrder> = {}): NormalizedOrder => ({
  externalId: `ext-${++seq}`,
  customer: { name: "Rahim Uddin", phone: phone(), address: "House 5, Road 3, Dhanmondi", district: "Dhaka" },
  items: [{ name: "Achar", quantity: 1, price: 900 }],
  cod: 900,
  total: 900,
  placedAt: new Date(),
  ...over,
});
/** A store webhook delivery through the real inbox + ingest path. */
const webhook = (s: { mid: Types.ObjectId; integrationId: Types.ObjectId }, provider: "shopify" | "woocommerce" | "custom_api", n: NormalizedOrder, eventId = `evt-${n.externalId}`) =>
  processWebhookOnce({
    merchantId: s.mid,
    integrationId: s.integrationId,
    provider,
    topic: provider === "custom_api" ? "order.created" : "orders/create",
    externalId: eventId,
    rawPayload: { id: n.externalId },
    payloadBytes: 10,
    normalized: n,
    source: provider,
  });
const orderOf = (id: string | undefined) => Order.findById(id).lean();
const lifecycleOf = async (id: string | undefined) => (await orderOf(id))?.lifecycle;
const newOrderNotices = (mid: Types.ObjectId) => Notification.countDocuments({ merchantId: mid, kind: "order.new" });

describe("live classification", () => {
  it("a store order is live while fresh, a backfill once older than the auto-book window", () => {
    const now = Date.now();
    expect(storeOrderLifecycle(new Date(now - 60_000), now)).toBe("live");
    expect(storeOrderLifecycle(undefined, now)).toBe("live");
    expect(storeOrderLifecycle(new Date(now - MAX_LIVE_ORDER_AGE_MS - 60_000), now)).toBe("historical_import");
  });
});

describe("every live source reaches the canonical pipeline exactly once", () => {
  it("landing checkout: live, automation applied, stock reserved once, merchant told", async () => {
    const s = await shop();
    await ensureSystemTemplates();
    const product = await s.caller.products.create({ name: "Premium Shirt", price: 1290, sku: "SHIRT-L", initialStock: 5 });
    const tpl = (await s.caller.landingPages.templates()).find((t) => t.key === "bd-modern-shop")!;
    const page = await s.caller.landingPages.create({ templateId: tpl.id, name: "Shop" });
    const got = await s.caller.landingPages.get({ id: page.id });
    const bn = (got.draftContent as Record<string, Record<string, Record<string, unknown>>>).bn!;
    bn.order!.cta = { label: "অর্ডার", action: { kind: "whatsapp", phone: "+8801711000000", message: "" } };
    const saved = await s.caller.landingPages.saveDraft({ id: page.id, content: { bn }, expectedRevision: 1 });
    const linked = await s.caller.landingPages.setProducts({ id: page.id, expectedRevision: saved.page.draftRevision, products: [{ productId: product.id }] });
    await s.caller.landingPages.setSlug({ id: page.id, slug: "life-shop" });
    await s.caller.landingPages.publish({ id: page.id, expectedRevision: linked.page.draftRevision });
    const resolved = await resolveLandingPageByHost("life-shop.localhost", { rootDomain: "localhost", useCache: false });
    if (resolved.kind !== "ok") throw new Error("page not published");
    const input: PlaceOrderInput = {
      host: "life-shop.localhost",
      locale: null,
      idempotencyKey: `life-key-${Date.now()}-abcdef`,
      items: [{ productId: product.id, quantity: 1 }],
      customer: { name: "Karim", phone: "01712345690", address: "House 1, Road 2", district: "Dhaka" },
      deliveryOptionId: resolved.commerce!.delivery[0]!.id,
    };
    const r = await placeLandingOrder(input);
    expect(r.ok).toBe(true);
    const id = r.ok ? r.orderId : "";
    const o = await orderOf(id);
    expect(o!.lifecycle).toMatchObject({ kind: "live", source: "landing_page" });
    expect(o!.automation?.state).toBe("auto_confirmed");
    expect(o!.inventory?.state).toBe("reserved");
    expect((await Product.findById(product.id).lean())!.inventory).toEqual({ onHand: 5, reserved: 1 });
    expect(await newOrderNotices(s.mid)).toBe(1);
    // A double-submit is the same order: no second pipeline, no second reservation.
    const again = await placeLandingOrder(input);
    expect(again.ok && again.duplicate).toBe(true);
    expect((await Product.findById(product.id).lean())!.inventory).toEqual({ onHand: 5, reserved: 1 });
    expect(await FraudPrediction.countDocuments({ orderId: o!._id })).toBe(1);
  });

  it("dashboard order: live, automation applied, no 'new order' notice for the merchant's own order", async () => {
    const s = await shop();
    const created = await s.caller.orders.createOrder({
      customer: { name: "Rahim", phone: phone(), address: "House 1, Road 2", district: "Dhaka" },
      items: [{ name: "Item", quantity: 1, price: 700 }],
      cod: 700,
    });
    const o = await orderOf(created.id);
    expect(o!.lifecycle).toMatchObject({ kind: "live", source: "dashboard" });
    expect(o!.automation?.state).toBe("auto_confirmed");
    expect(await newOrderNotices(s.mid)).toBe(0);
  });

  for (const provider of ["shopify", "woocommerce", "custom_api"] as const) {
    it(`${provider} live order: now runs the same automation as checkout orders`, async () => {
      const s = await shop();
      const r = await webhook(s, provider, normalized());
      expect(r.ok).toBe(true);
      const o = await orderOf(r.orderId);
      expect(o!.lifecycle).toMatchObject({ kind: "live", source: provider });
      expect(o!.automation?.state).toBe("auto_confirmed");
      expect(o!.order.status).toBe("confirmed");
      expect(await newOrderNotices(s.mid)).toBe(1);
      expect(await FraudPrediction.countDocuments({ orderId: o!._id })).toBe(1);
    });
  }
});

describe("historical imports never run live automation", () => {
  it("CSV upload: created as before (stock reserved), no pipeline, no automation/SMS/auto-book", async () => {
    const s = await shop({ mode: "full_auto", autoBook: true });
    const csv = [
      "orderNumber,customerName,customerPhone,customerAddress,customerDistrict,itemName,quantity,price,cod",
      `CSV-1,Karim,${phone()},House 3 Road 4,Dhaka,Shirt,1,500,500`,
    ].join("\n");
    expect((await s.caller.orders.bulkUpload({ csv })).inserted).toBe(1);
    const o = await Order.findOne({ merchantId: s.mid, orderNumber: "CSV-1" }).lean();
    expect(o!.lifecycle).toBeUndefined();
    expect(o!.automation?.state ?? "not_evaluated").toBe("not_evaluated");
    expect(o!.order.status).toBe("pending");
    expect(smsJobs).not.toHaveBeenCalled();
    expect(bookJobs).not.toHaveBeenCalled();
  });

  it("store history import and late store orders: recorded and scored, never automated or announced", async () => {
    const s = await shop({ mode: "full_auto", autoBook: true });
    // What commerceImport does for a store's recent history.
    const imported = await ingestNormalizedOrder(normalized(), {
      merchantId: s.mid,
      source: "shopify",
      lifecycle: "historical_import",
      channel: "api",
      integrationId: s.integrationId,
    });
    // A store order arriving days after it was placed (first sync poll, replay of a held order).
    const late = await webhook(s, "shopify", normalized({ placedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000) }));
    for (const r of [imported, late]) {
      const o = await orderOf(r.orderId);
      expect(o!.lifecycle).toMatchObject({ kind: "historical_import", source: "shopify" });
      expect(o!.automation?.state ?? "not_evaluated").toBe("not_evaluated");
      expect(o!.order.status).toBe("pending");
      expect(await FraudPrediction.countDocuments({ orderId: o!._id })).toBe(1); // still scored
    }
    expect(smsJobs).not.toHaveBeenCalled();
    expect(bookJobs).not.toHaveBeenCalled();
    expect(await newOrderNotices(s.mid)).toBe(0);
  });
});

describe("idempotency", () => {
  it("duplicate webhooks: one order, one pipeline run, one auto-book job, one notice", async () => {
    const s = await shop({ mode: "full_auto", autoBook: true });
    const n = normalized();
    const first = await webhook(s, "shopify", n);
    await webhook(s, "shopify", n); // platform redelivery (same event id)
    await webhook(s, "shopify", n, "evt-update"); // same order, another event
    expect(await Order.countDocuments({ merchantId: s.mid })).toBe(1);
    expect(bookJobs).toHaveBeenCalledTimes(1);
    expect(bookJobs).toHaveBeenCalledWith(expect.objectContaining({ orderId: first.orderId, courier: "steadfast" }));
    expect(await newOrderNotices(s.mid)).toBe(1);
  });

  it("calling the pipeline again for the same order does nothing", async () => {
    const s = await shop({ mode: "full_auto", autoBook: true });
    const r = await webhook(s, "custom_api", normalized());
    const o = (await orderOf(r.orderId))!;
    const stamp = o.lifecycle!.processedAt;
    const again = await processOrderAfterCreate({
      merchantId: s.mid,
      orderId: o._id as Types.ObjectId,
      lifecycle: "live",
      source: "custom_api",
      customerPlaced: true,
      risk: { level: "low", riskScore: 5, reasons: [], signals: [], pRto: 0.1, customerTier: "new", weightsVersion: "v1" } as never,
      userId: String(s.mid),
    });
    expect(again).toEqual({ ran: false });
    expect(bookJobs).toHaveBeenCalledTimes(1);
    expect((await orderOf(r.orderId))!.lifecycle!.processedAt).toEqual(stamp);
    expect(await FraudPrediction.countDocuments({ orderId: o._id })).toBe(1);
    expect(await newOrderNotices(s.mid)).toBe(1);
  });

  it("a medium-risk order gets ONE confirmation SMS, however often the pipeline is called", async () => {
    const s = await shop();
    const order = await Order.create({
      merchantId: s.mid,
      orderNumber: "MED-1",
      customer: { name: "C", phone: phone(), address: "House 1", district: "Dhaka" },
      items: [{ name: "X", quantity: 1, price: 500 }],
      order: { cod: 500, total: 500, status: "pending" },
      source: { channel: "webhook", sourceProvider: "woocommerce" },
    });
    const ctx = {
      merchantId: s.mid,
      orderId: order._id as Types.ObjectId,
      lifecycle: "live" as const,
      source: "woocommerce" as const,
      customerPlaced: true,
      risk: { level: "medium", riskScore: 50, reasons: ["new address"], signals: [], pRto: 0.3, customerTier: "new", weightsVersion: "v1" } as never,
      userId: String(s.mid),
    };
    expect(await processOrderAfterCreate(ctx)).toMatchObject({ ran: true, automation: "await_confirmation" });
    expect(await processOrderAfterCreate(ctx)).toEqual({ ran: false });
    expect(smsJobs).toHaveBeenCalledTimes(1);
    const o = (await Order.findById(order._id).lean())!;
    expect(o.automation).toMatchObject({ state: "pending_confirmation", confirmationChannel: "sms" });
    expect(smsJobs).toHaveBeenCalledWith(expect.objectContaining({ orderId: String(order._id), confirmationCode: o.automation!.confirmationCode }));
  });
});

describe("quota exhausted: no order, no pipeline", () => {
  it("the store order is held (Phase 0.3) and nothing downstream runs", async () => {
    const s = await shop({ tier: "starter", mode: "full_auto", autoBook: true });
    await Usage.updateOne({ merchantId: s.mid, period: currentUsagePeriod() }, { $set: { ordersCreated: 300 } }, { upsert: true });
    const r = await webhook(s, "shopify", normalized());
    expect(r).toMatchObject({ ok: false, code: "order_quota_exceeded" });
    expect(await Order.countDocuments({ merchantId: s.mid })).toBe(0);
    expect(await FraudPrediction.countDocuments({ merchantId: s.mid })).toBe(0);
    expect(smsJobs).not.toHaveBeenCalled();
    expect(bookJobs).not.toHaveBeenCalled();
    expect(await newOrderNotices(s.mid)).toBe(0);
  });
});

describe("existing policy stays authoritative", () => {
  it("full-auto entitlement: Starter's stored full-auto runs as semi-auto (no auto-book); Growth auto-books", async () => {
    const starter = await shop({ tier: "starter", mode: "full_auto", autoBook: true });
    const growth = await shop({ tier: "growth", mode: "full_auto", autoBook: true });
    const a = await webhook(starter, "shopify", normalized());
    const b = await webhook(growth, "shopify", normalized());
    expect((await orderOf(a.orderId))!.automation?.state).toBe("auto_confirmed");
    expect(bookJobs).toHaveBeenCalledTimes(1);
    expect(bookJobs).toHaveBeenCalledWith(expect.objectContaining({ orderId: b.orderId, merchantId: String(growth.mid) }));
  });

  it("automation off / manual mode leave the order pending; semi-auto confirms without booking", async () => {
    const off = await shop({ mode: "off" });
    const manual = await shop({ mode: "manual" });
    const semi = await shop({ mode: "semi_auto" });
    for (const s of [off, manual]) {
      const o = await orderOf((await webhook(s, "woocommerce", normalized())).orderId);
      expect(o!.automation?.state ?? "not_evaluated").toBe("not_evaluated");
      expect(o!.order.status).toBe("pending");
      expect(o!.lifecycle?.kind).toBe("live");
    }
    const o = await orderOf((await webhook(semi, "woocommerce", normalized())).orderId);
    expect(o!.order.status).toBe("confirmed");
    expect(bookJobs).not.toHaveBeenCalled();
  });

  it("stock: a store order's catalogue line is reserved once, across duplicates and pipeline re-runs", async () => {
    const s = await shop();
    const product = await s.caller.products.create({ name: "Tea", price: 300, sku: "TEA-1", initialStock: 4 });
    const n = normalized({ items: [{ name: "Tea", sku: "TEA-1", quantity: 2, price: 300 }], cod: 600, total: 600 });
    const r = await webhook(s, "shopify", n);
    await webhook(s, "shopify", n, "evt-again");
    await processOrderAfterCreate({
      merchantId: s.mid,
      orderId: new Types.ObjectId(r.orderId),
      lifecycle: "live",
      source: "shopify",
      customerPlaced: true,
      risk: { level: "low", riskScore: 1, reasons: [], signals: [], pRto: 0.1, customerTier: "new", weightsVersion: "v1" } as never,
      userId: String(s.mid),
    });
    expect((await Product.findById(product.id).lean())!.inventory).toEqual({ onHand: 4, reserved: 2 });
    expect(await InventoryMovement.countDocuments({ productId: new Types.ObjectId(product.id), type: "ORDER_RESERVED" })).toBe(1);
  });

  it("courier: the queued auto-book job books the store order through the existing worker", async () => {
    const s = await shop({ mode: "full_auto", autoBook: true });
    const r = await webhook(s, "shopify", normalized());
    expect(bookJobs).toHaveBeenCalledTimes(1);
    const job = bookJobs.mock.calls[0]![0];
    expect(await book.bookOrThrow(job)).toMatchObject({ ok: true, status: "booked" });
    expect((await orderOf(r.orderId))!.logistics).toMatchObject({ courier: "steadfast" });
  });
});

describe("failure isolation and tenancy", () => {
  it("a failing downstream step never undoes the committed order or reaches the caller", async () => {
    const s = await shop({ mode: "full_auto", autoBook: true });
    bookJobs.mockImplementation(() => {
      throw new Error("queue down");
    });
    const r = await webhook(s, "custom_api", normalized());
    expect(r.ok).toBe(true);
    const o = await orderOf(r.orderId);
    expect(o).toBeTruthy();
    expect(o!.lifecycle?.kind).toBe("live");
    expect(await newOrderNotices(s.mid)).toBe(1); // later steps still ran
  });

  it("the pipeline cannot process another merchant's order", async () => {
    const a = await shop({ mode: "full_auto", autoBook: true });
    const b = await shop({ mode: "full_auto", autoBook: true });
    const order = await Order.create({
      merchantId: a.mid,
      orderNumber: "TEN-1",
      customer: { name: "C", phone: phone(), address: "House 1", district: "Dhaka" },
      items: [{ name: "X", quantity: 1, price: 500 }],
      order: { cod: 500, total: 500, status: "pending" },
    });
    const r = await processOrderAfterCreate({
      merchantId: b.mid,
      orderId: order._id as Types.ObjectId,
      lifecycle: "live",
      source: "shopify",
      customerPlaced: true,
      risk: { level: "low", riskScore: 1, reasons: [], signals: [], pRto: 0.1, customerTier: "new", weightsVersion: "v1" } as never,
      userId: String(b.mid),
    });
    expect(r).toEqual({ ran: false });
    const after = (await Order.findById(order._id).lean())!;
    expect(after.lifecycle).toBeUndefined();
    expect(after.automation?.state ?? "not_evaluated").toBe("not_evaluated");
    expect(bookJobs).not.toHaveBeenCalled();
    expect(await Notification.countDocuments({ merchantId: b.mid })).toBe(0);
  });
});
