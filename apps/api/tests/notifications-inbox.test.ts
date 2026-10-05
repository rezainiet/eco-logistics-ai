import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import express from "express";
import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Integration, Merchant, Notification, Order, Product, WebhookInbox } from "@ecom/db";
import { env } from "../src/env.js";
import { authRouter } from "../src/server/auth.js";
import { processWebhookOnce } from "../src/server/ingest.js";
import { smsInboundWebhookRouter } from "../src/server/webhooks/sms-inbound.js";
import { shopifyGdprWebhookRouter } from "../src/server/webhooks/shopify-gdpr.js";
import { afterOrderCreated, scoreOrderForCreate, loadMerchantScoring } from "../src/lib/order-create.js";
import { notifyWelcome } from "../src/lib/merchant-notices.js";
import { notifyDeliveryIssue } from "../src/lib/couriers/outcome-notify.js";
import { dispatchNotification } from "../src/lib/notifications.js";
import { INBOX_KINDS, INBOX_ROUTES, resolveInboxLink } from "../src/lib/notification-inbox.js";
import { shopifyAdapter } from "../src/lib/integrations/shopify.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * The merchant inbox on the one notification store: which events reach
 * the bell, where each opens, read state, and exactly-once creation under
 * retries and replays — for every merchant separately.
 */

let base = "";
let server: ReturnType<express.Express["listen"]>;

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Notification.syncIndexes(), Order.syncIndexes(), WebhookInbox.syncIndexes(), Product.syncIndexes(), Merchant.syncIndexes()]);
  const app = express();
  app.use("/auth", express.json(), authRouter);
  app.use("/sms", smsInboundWebhookRouter);
  app.use("/gdpr", shopifyGdprWebhookRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await disconnectDb();
});
beforeEach(resetDb);

type Caller = ReturnType<typeof callerFor>;

async function merchant(tier: "starter" | "growth" | "scale" = "scale") {
  const m = await createMerchant({ tier });
  return { mid: m._id as Types.ObjectId, caller: callerFor(authUserFor(m)) };
}

/** Every unread row the drawer's Unread view can show, following "Load more". */
async function allUnread(caller: Caller) {
  const items: Array<{ id: string; kind: string; href: string | null; read: boolean }> = [];
  let cursor: string | null = null;
  let unread = -1;
  do {
    const page = await caller.notifications.inbox({ filter: "unread", limit: 7, cursor });
    if (unread < 0) unread = page.unread;
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return { unread, items };
}

let phoneSeq = 0;
const phone = () => `+88017${String(30000000 + ++phoneSeq)}`;

const shopifyOrder = (id: number, opts: { phone?: string } = {}) => ({
  id,
  name: `#${id}`,
  total_price: "1500",
  created_at: "2026-10-05T10:00:00.000Z",
  customer: { first_name: "Shop", last_name: "Buyer", phone: opts.phone ?? phone() },
  shipping_address: { name: "Shop Buyer", phone: opts.phone ?? phone(), address1: "House 1", city: "Dhaka" },
  line_items: [{ id: 1, title: "Achar", quantity: 1, price: "1500" }],
  payment_gateway_names: ["Cash on Delivery"],
});

function webhookOrder(mid: Types.ObjectId, payload: ReturnType<typeof shopifyOrder>) {
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

const kinds = async (mid: Types.ObjectId) => (await Notification.find({ merchantId: mid }).sort({ _id: 1 }).lean()).map((n) => n.kind);

describe("welcome notification", () => {
  it("signup writes exactly one welcome, linking to the setup checklist; repeats add nothing", async () => {
    const res = await fetch(`${base}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@shop.test", password: "password123", businessName: "New Shop" }),
    });
    expect(res.status).toBe(200);
    const m = (await Merchant.findOne({ email: "new@shop.test" }).lean())!;
    // Written by the signup itself…
    expect(await Notification.countDocuments({ merchantId: m._id, kind: "account.welcome" })).toBe(1);
    // …and never again, however often it is attempted (login refresh, retries).
    await notifyWelcome({ merchantId: m._id, businessName: m.businessName });
    await notifyWelcome({ merchantId: m._id, businessName: m.businessName });
    const rows = await Notification.find({ merchantId: m._id, kind: "account.welcome" }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Welcome to ConfirmX, New Shop", link: "/dashboard/getting-started", readAt: null });
    // A second signup with the same email is refused — no second account, no second welcome.
    const again = await fetch(`${base}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@shop.test", password: "password123", businessName: "New Shop" }),
    });
    expect(again.status).toBe(409);
    expect(await Notification.countDocuments({ kind: "account.welcome" })).toBe(1);

    const caller = callerFor(authUserFor({ _id: m._id, email: m.email, role: m.role }));
    const inbox = await caller.notifications.inbox({ filter: "unread" });
    expect(inbox.items.map((i) => [i.kind, i.category, i.href])).toEqual([["account.welcome", "account", "/dashboard/getting-started"]]);
  });
});

describe("new order notifications", () => {
  it("a live store order notifies once (replays add nothing); imports and dashboard orders do not", async () => {
    const { mid, caller } = await merchant();
    const live = await webhookOrder(mid, shopifyOrder(9001));
    expect(live.ok).toBe(true);
    await webhookOrder(mid, shopifyOrder(9001)); // redelivery
    const rows = await Notification.find({ merchantId: mid, kind: "order.new" }).lean();
    expect(rows).toHaveLength(1);
    const order = (await Order.findById(live.orderId).lean())!;
    expect(rows[0]).toMatchObject({ title: `New order ${order.orderNumber}`, severity: "info", link: `/dashboard/orders?focus=${live.orderId}` });
    expect(rows[0]!.body).toBe("৳1,500 · Dhaka · from Shopify");
    expect(rows[0]!.body).not.toMatch(/Shop Buyer|\+880/); // no customer name or phone

    // Merchant-initiated sources: the merchant already knows.
    const { ingestNormalizedOrder } = await import("../src/server/ingest.js");
    await ingestNormalizedOrder(shopifyAdapter.normalizeWebhookPayload("orders/create", shopifyOrder(9002)) as never, {
      merchantId: mid,
      source: "shopify",
      channel: "api",
    });
    await caller.orders.createOrder({
      customer: { name: "Rahim", phone: phone(), address: "House 1, Road 2", district: "Dhaka" },
      items: [{ name: "Achar", quantity: 1, price: 500 }],
      cod: 500,
    });
    expect(await Notification.countDocuments({ merchantId: mid, kind: "order.new" })).toBe(1);
  });

  it("a landing-page order notifies; a flagged order gets the review alert instead (unless review alerts are off)", async () => {
    const { mid } = await merchant();
    const landing = async (p: string) => {
      const customer = { name: "Karim", phone: p, address: "House 9, Road 9", district: "Sylhet" };
      const scoring = await loadMerchantScoring(mid); // current fraud config, as the checkout loads it
      const risk = await scoreOrderForCreate({ merchantId: mid, cod: 900, customer, scoring });
      const order = await Order.create({
        merchantId: mid,
        orderNumber: `LP-${++phoneSeq}`,
        customer,
        items: [{ name: "Achar", quantity: 1, price: 900 }],
        order: { cod: 900, total: 900, status: "pending" },
        source: { channel: "landing_page" },
      });
      await afterOrderCreated({ merchantId: mid, order, risk, userId: String(mid) });
      return order;
    };
    const plain = await landing(phone());
    expect(await Notification.findOne({ merchantId: mid, kind: "order.new" }).lean()).toMatchObject({
      title: `New order ${plain.orderNumber}`,
      body: "৳900 · Sylhet · from landing page",
    });

    // Blocked phone → high risk → review alert, not a second "new order".
    const blocked = phone();
    await Merchant.updateOne({ _id: mid }, { $set: { "fraudConfig.blockedPhones": [blocked] } });
    const flagged = await landing(blocked);
    const forFlagged = await Notification.find({ merchantId: mid, subjectId: flagged._id }).lean();
    expect(forFlagged.map((n) => n.kind)).toEqual(["fraud.pending_review"]);

    // Review alerts turned off: the merchant still hears about the order.
    await Merchant.updateOne({ _id: mid }, { $set: { "fraudConfig.alertOnPendingReview": false } });
    const quiet = await landing(blocked);
    expect((await Notification.find({ merchantId: mid, subjectId: quiet._id }).lean()).map((n) => n.kind)).toEqual(["order.new"]);
  });
});

describe("verification notifications", () => {
  it("review alerts open the review queue on plans that have it, and the order on Starter", async () => {
    const blocked = phone();
    for (const [tier, expected] of [
      ["scale", "/dashboard/fraud-review?id="],
      ["starter", "/dashboard/orders?focus="],
    ] as const) {
      const { mid, caller } = await merchant(tier);
      await Merchant.updateOne({ _id: mid }, { $set: { "fraudConfig.blockedPhones": [blocked] } });
      const r = await webhookOrder(mid, shopifyOrder(tier === "scale" ? 9101 : 9102, { phone: blocked }));
      const [item] = (await caller.notifications.inbox({ filter: "unread" })).items;
      expect(item).toMatchObject({ kind: "fraud.pending_review", category: "verification", href: `${expected}${r.orderId}` });
      // The stored link is left as written; the inbox resolves per plan.
      expect((await Notification.findOne({ merchantId: mid }).lean())!.link).toBe(`/dashboard/fraud-review?id=${r.orderId}`);
    }
  });

  it("a customer's SMS NO cancels the order and notifies the merchant once", async () => {
    const { mid, caller } = await merchant();
    const p = phone();
    const order = await Order.create({
      merchantId: mid,
      orderNumber: "SMS-1",
      customer: { name: "Rahim", phone: p, address: "House 1", district: "Dhaka" },
      items: [{ name: "Achar", quantity: 1, price: 500 }],
      order: { cod: 500, total: 500, status: "pending" },
      automation: { state: "pending_confirmation", confirmationCode: "12345678" },
    });
    const reply = () =>
      fetch(`${base}/sms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: p, body: "NO 12345678" }) });
    expect((await reply()).status).toBe(200);
    expect((await reply()).status).toBe(200); // gateway retry
    expect((await Order.findById(order._id).lean())!.order.status).toBe("cancelled");
    const rows = await Notification.find({ merchantId: mid, kind: "order.customer_rejected" }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Customer cancelled order SMS-1" });
    const [item] = (await caller.notifications.inbox()).items;
    // Nothing left to review: it opens the order itself, on any plan.
    expect(item!.href).toBe(`/dashboard/orders?focus=${order._id}`);
  });
});

describe("courier, stock and integration notices in the inbox", () => {
  it("existing courier and stock notices are listed with their destinations", async () => {
    const { mid, caller } = await merchant();
    const orderId = new Types.ObjectId();
    await Order.create({
      _id: orderId,
      merchantId: mid,
      orderNumber: "CX-1",
      customer: { name: "Rahim", phone: phone(), address: "House 1", district: "Dhaka" },
      items: [{ name: "Achar", quantity: 1, price: 500 }],
      order: { cod: 500, total: 500, status: "in_transit" },
    });
    await notifyDeliveryIssue({ merchantId: mid, orderId, providerStatus: "Delivery_Failed", eventKey: "e1" });
    await notifyDeliveryIssue({ merchantId: mid, orderId, providerStatus: "Delivery_Failed", eventKey: "e1" }); // replay
    const product = await Product.create({ merchantId: mid, name: "Achar", sku: "A-1", price: 500, lowStockThreshold: 0, inventory: { onHand: 1, reserved: 0 } });
    await caller.orders.createOrder({
      customer: { name: "Rahim", phone: phone(), address: "House 1, Road 2", district: "Dhaka" },
      items: [{ name: "Achar", sku: "A-1", quantity: 1, price: 500 }],
      cod: 500,
    });
    const { items, unread } = await allUnread(caller);
    expect(unread).toBe(2);
    expect(items.map((i) => [i.kind, i.href])).toEqual([
      ["stock.out", `/dashboard/products?stock=${product._id}`],
      ["order.delivery_issue", `/dashboard/orders?focus=${orderId}`],
    ]);
  });

  it("integration failures needing action reach the inbox and open the issues page", async () => {
    const { mid, caller } = await merchant();
    const r = await processWebhookOnce({
      merchantId: mid,
      integrationId: new Types.ObjectId(),
      provider: "shopify",
      topic: "orders/create",
      externalId: "9201",
      rawPayload: {},
      payloadBytes: 2,
      normalized: { __skip: true, reason: "missing_phone", externalId: "9201" },
      source: "shopify",
    });
    expect(r.ok).toBe(false);
    const [item] = (await caller.notifications.inbox()).items;
    expect(item).toMatchObject({ kind: "integration.webhook_needs_attention", category: "integration", href: "/dashboard/settings/integrations/issues" });
  });

  it("a GDPR data request without a request id is still recorded once per delivery", async () => {
    const { mid, caller } = await merchant();
    await Integration.create({ merchantId: mid, provider: "shopify", accountKey: "dup-shop.myshopify.com", status: "connected" });
    const saved = env.SHOPIFY_APP_API_SECRET;
    (env as Record<string, unknown>).SHOPIFY_APP_API_SECRET = "gdpr-test-secret";
    try {
      const body = JSON.stringify({ shop_domain: "dup-shop.myshopify.com", customer: { id: 77 } });
      const send = (webhookId?: string) =>
        fetch(`${base}/gdpr`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-shopify-topic": "customers/data_request",
            "x-shopify-hmac-sha256": createHmac("sha256", "gdpr-test-secret").update(body).digest("base64"),
            ...(webhookId ? { "x-shopify-webhook-id": webhookId } : {}),
          },
          body,
        });
      expect((await send("wh-1")).status).toBe(200);
      await send("wh-1"); // Shopify retry of the same delivery
      await send(); // no delivery id: the signed body itself dedupes
      await send();
      expect(await Notification.countDocuments({ merchantId: mid, kind: "gdpr.data_request_received" })).toBe(2);
      const items = (await caller.notifications.inbox()).items;
      expect(items.every((i) => i.category === "compliance" && i.href === null)).toBe(true);
    } finally {
      (env as Record<string, unknown>).SHOPIFY_APP_API_SECRET = saved;
    }
  });
});

describe("deep links", () => {
  const webApp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/src/app");

  it("every destination the inbox can open is an existing dashboard page", () => {
    for (const route of Object.values(INBOX_ROUTES)) {
      expect(fs.existsSync(path.join(webApp, route, "page.tsx")), route).toBe(true);
    }
  });

  it("legacy and broken stored links resolve to the right page; unknown ones to none", () => {
    const id = new Types.ObjectId().toHexString();
    const r = (n: Parameters<typeof resolveInboxLink>[0], fraudReview = true) => resolveInboxLink(n, { fraudReview });
    expect(r({ kind: "order.courier_cancel_required", link: `/dashboard/orders/${id}`, subjectType: "order", subjectId: id })).toBe(`/dashboard/orders?focus=${id}`);
    expect(r({ kind: "integration.webhook_failed", link: `/dashboard/orders?id=${id}`, subjectType: "order", subjectId: id })).toBe(`/dashboard/orders?focus=${id}`);
    expect(r({ kind: "automation.stale_pending", subjectType: "order", subjectId: id }, false)).toBe(`/dashboard/orders?focus=${id}`);
    expect(r({ kind: "integration.webhook_failed", link: `/dashboard/integrations?inboxId=${id}`, subjectType: "integration", subjectId: id })).toBe("/dashboard/settings/integrations/issues");
    expect(r({ kind: "subscription.plan_downgrade_enforced", link: "/dashboard/integrations", subjectType: "merchant" })).toBe("/dashboard/settings/integrations");
    expect(r({ kind: "stock.low", subjectType: "product", subjectId: id })).toBe(`/dashboard/products?stock=${id}`);
    expect(r({ kind: "recovery.cart_pending", link: "/dashboard/recovery", subjectType: "merchant" })).toBe("/dashboard/recovery");
    expect(r({ kind: "gdpr.data_request_received", subjectType: "integration" })).toBeNull();
    expect(r({ kind: "gdpr.data_request_received", link: "https://evil.example/x", subjectType: "integration" })).toBeNull();
    expect(r({ kind: "gdpr.data_request_received", link: "/dashboard/nowhere", subjectType: "integration" })).toBeNull();
  });

  it("every inbox row carries a resolvable link or none — never a guessed one", async () => {
    const { mid, caller } = await merchant();
    const orderId = new Types.ObjectId();
    for (const kind of INBOX_KINDS) {
      await dispatchNotification({ merchantId: mid, kind, title: kind, subjectType: "order", subjectId: orderId, dedupeKey: `t:${kind}`, link: "/dashboard/whatever" });
    }
    const { items } = await allUnread(caller);
    expect(items).toHaveLength(INBOX_KINDS.length);
    for (const i of items) {
      const p = i.href!.split("?")[0]!;
      expect(Object.values(INBOX_ROUTES)).toContain(p);
    }
  });
});

describe("read state, mark-all-read, counts and isolation", () => {
  it("the unread count equals the rows the Unread view lists; infrastructure notices are not in the inbox", async () => {
    const { mid, caller } = await merchant();
    for (let i = 0; i < 23; i++) {
      await dispatchNotification({ merchantId: mid, kind: "order.new", title: `New order ${i}`, subjectType: "order", subjectId: new Types.ObjectId(), dedupeKey: `n:${i}` });
    }
    await dispatchNotification({ merchantId: mid, kind: "queue.enqueue_failed", title: "Background job queue degraded", dedupeKey: "q:1" });
    await dispatchNotification({ merchantId: mid, kind: "admin.alert", title: "platform", dedupeKey: "a:1" });
    const read = await dispatchNotification({ merchantId: mid, kind: "stock.low", title: "Low stock", subjectType: "product", subjectId: new Types.ObjectId(), dedupeKey: "s:1" });
    expect(read.inAppCreated).toBe(true);
    const stockRow = (await Notification.findOne({ merchantId: mid, kind: "stock.low" }).lean())!;
    await caller.notifications.markRead({ id: String(stockRow._id) });

    const { unread, items } = await allUnread(caller);
    expect(unread).toBe(23);
    expect(items).toHaveLength(23);
    expect(items.every((i) => i.kind === "order.new" && !i.read)).toBe(true);
    const all = await caller.notifications.inbox({ filter: "all", limit: 50 });
    expect(all.items).toHaveLength(24);
    expect(all.items.find((i) => i.kind === "stock.low")?.read).toBe(true);
    expect(all.unread).toBe(23);
  });

  it("opening marks read once; a repeated event never makes it unread again", async () => {
    const { mid, caller } = await merchant();
    const send = () => dispatchNotification({ merchantId: mid, kind: "order.returned", title: "Order X returned", subjectType: "order", subjectId: new Types.ObjectId("6ac30eaab67d831c3407d6cf"), dedupeKey: "courier_rto:x" });
    await send();
    const [item] = (await caller.notifications.inbox()).items;
    expect(await caller.notifications.markRead({ id: item!.id })).toEqual({ id: item!.id, marked: true });
    expect(await caller.notifications.markRead({ id: item!.id })).toEqual({ id: item!.id, marked: false });
    expect((await send()).inAppCreated).toBe(false); // webhook replay
    expect((await caller.notifications.inbox()).unread).toBe(0);
    expect(await Notification.countDocuments({ merchantId: mid })).toBe(1);
  });

  it("mark all read covers what the merchant saw, not what arrived after, nor other kinds", async () => {
    const { mid, caller } = await merchant();
    for (let i = 0; i < 3; i++) await dispatchNotification({ merchantId: mid, kind: "order.new", title: `o${i}`, dedupeKey: `o:${i}` });
    await dispatchNotification({ merchantId: mid, kind: "queue.enqueue_failed", title: "infra", dedupeKey: "q" });
    const seen = await caller.notifications.inbox();
    await dispatchNotification({ merchantId: mid, kind: "stock.out", title: "arrived later", dedupeKey: "late" });
    expect(await caller.notifications.markAllRead({ scope: "inbox", upToId: seen.items[0]!.id })).toEqual({ updated: 3 });
    const after = await caller.notifications.inbox();
    expect(after.unread).toBe(1);
    expect(after.items.map((i) => i.title)).toEqual(["arrived later"]);
    expect((await Notification.findOne({ merchantId: mid, kind: "queue.enqueue_failed" }).lean())!.readAt).toBeNull();
  });

  it("one merchant never sees, reads or clears another's notifications", async () => {
    const a = await merchant();
    const b = await merchant();
    await dispatchNotification({ merchantId: a.mid, kind: "order.new", title: "A's order", dedupeKey: "x" });
    await dispatchNotification({ merchantId: b.mid, kind: "order.new", title: "B's order", dedupeKey: "x" }); // same key, other merchant
    const aItem = (await a.caller.notifications.inbox()).items[0]!;
    expect((await b.caller.notifications.inbox()).items.map((i) => i.title)).toEqual(["B's order"]);
    expect(await b.caller.notifications.markRead({ id: aItem.id })).toEqual({ id: aItem.id, marked: false });
    await b.caller.notifications.markAllRead({ scope: "inbox" });
    expect((await a.caller.notifications.inbox()).unread).toBe(1);
    expect((await b.caller.notifications.inbox()).unread).toBe(0);
  });

  it("mark all read without input keeps its old meaning (every notification of the merchant)", async () => {
    const { mid, caller } = await merchant();
    await dispatchNotification({ merchantId: mid, kind: "order.new", title: "o", dedupeKey: "o" });
    await dispatchNotification({ merchantId: mid, kind: "queue.enqueue_failed", title: "q", dedupeKey: "q" });
    expect(await caller.notifications.markAllRead()).toEqual({ updated: 2 });
    expect(await kinds(mid)).toHaveLength(2);
  });
});
