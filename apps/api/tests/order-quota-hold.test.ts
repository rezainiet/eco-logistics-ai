import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { Merchant, Notification, Order, Usage, WebhookInbox, currentUsagePeriod } from "@ecom/db";
import {
  enqueueInboundWebhook,
  processWebhookOnce,
  replayWebhookInbox,
  WEBHOOK_RETRY_MAX_ATTEMPTS,
} from "../src/server/ingest.js";
import { shopifyAdapter } from "../src/lib/integrations/shopify.js";
import { ORDER_QUOTA_EXCEEDED, orderQuotaHeldCount } from "../src/lib/order-quota.js";
import { PLANS } from "../src/lib/plans.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Store orders that arrive after the monthly order quota is used up are
 * HELD — received and kept in the webhook inbox, never created past the
 * quota, never retried into a dead letter — and replayed once there is
 * capacity, without ever creating a second order.
 */

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Order.syncIndexes(), WebhookInbox.syncIndexes(), Notification.syncIndexes()]);
});
afterAll(disconnectDb);
beforeEach(resetDb);

const STARTER_LIMIT = PLANS.starter.features.orderQuota;

async function starterShop() {
  const m = await createMerchant({ tier: "starter" });
  return { mid: m._id as Types.ObjectId, caller: callerFor(authUserFor(m)), integrationId: new Types.ObjectId() };
}
/** Use up the month's order quota (the counter `reserveQuota` reads). */
const exhaust = (mid: Types.ObjectId, used = STARTER_LIMIT) =>
  Usage.updateOne({ merchantId: mid, period: currentUsagePeriod() }, { $set: { ordersCreated: used } }, { upsert: true });
const ordersUsed = async (mid: Types.ObjectId) =>
  (await Usage.findOne({ merchantId: mid, period: currentUsagePeriod() }).lean())?.ordersCreated ?? 0;

let phoneSeq = 0;
const shopifyOrder = (id: number) => {
  const phone = `+88017${String(40000000 + ++phoneSeq)}`;
  return {
    id,
    name: `#${id}`,
    total_price: "1500",
    created_at: "2026-10-05T10:00:00.000Z",
    customer: { first_name: "Shop", last_name: "Buyer", phone },
    shipping_address: { name: "Shop Buyer", phone, address1: "House 1", city: "Dhaka" },
    line_items: [{ id: 1, title: "Achar", quantity: 1, price: "1500" }],
    payment_gateway_names: ["Cash on Delivery"],
  };
};

/** A Shopify order webhook through the synchronous path. `eventId` is the delivery id (X-Shopify-Webhook-Id). */
function deliver(shop: { mid: Types.ObjectId; integrationId: Types.ObjectId }, payload: ReturnType<typeof shopifyOrder>, eventId = `evt-${payload.id}`, topic = "orders/create") {
  return processWebhookOnce({
    merchantId: shop.mid,
    integrationId: shop.integrationId,
    provider: "shopify",
    topic,
    externalId: eventId,
    rawPayload: payload,
    payloadBytes: 100,
    normalized: shopifyAdapter.normalizeWebhookPayload(topic, payload),
    source: "shopify",
  });
}
/** The production path: stamp the inbox row, then the worker runs it. */
async function deliverAsync(shop: { mid: Types.ObjectId; integrationId: Types.ObjectId }, payload: ReturnType<typeof shopifyOrder>, eventId: string, topic = "orders/create") {
  const stamped = await enqueueInboundWebhook({
    merchantId: shop.mid,
    integrationId: shop.integrationId,
    provider: "shopify",
    topic,
    externalId: eventId,
    rawPayload: payload,
    payloadBytes: 100,
  });
  if (stamped.duplicate) return { stamped, result: null };
  return { stamped, result: await replayWebhookInbox({ inboxId: stamped.inboxId }) };
}
const quotaNotices = (mid: Types.ObjectId) => Notification.find({ merchantId: mid, kind: "subscription.order_quota_reached" }).lean();

describe("quota available — unchanged", () => {
  it("a store order is created exactly as before and counted once", async () => {
    const shop = await starterShop();
    const r = await deliver(shop, shopifyOrder(5001));
    expect(r).toMatchObject({ ok: true });
    expect(r.code).toBeUndefined();
    expect(await Order.countDocuments({ merchantId: shop.mid, "source.externalId": "5001" })).toBe(1);
    expect((await WebhookInbox.findOne({ externalId: "evt-5001" }).lean())?.status).toBe("succeeded");
    expect(await ordersUsed(shop.mid)).toBe(1);
    expect(await quotaNotices(shop.mid)).toHaveLength(0);
  });
});

describe("quota exhausted — the order is held, never lost, never created", () => {
  it("returns the typed quota error and holds the delivery with its payload (sync path)", async () => {
    const shop = await starterShop();
    await exhaust(shop.mid);
    const r = await deliver(shop, shopifyOrder(5002));
    expect(r).toMatchObject({
      ok: false,
      code: ORDER_QUOTA_EXCEEDED,
      quota: { metric: "ordersCreated", used: STARTER_LIMIT, limit: STARTER_LIMIT, tier: "starter" },
    });
    expect(await Order.countDocuments({ merchantId: shop.mid })).toBe(0);
    expect(await ordersUsed(shop.mid)).toBe(STARTER_LIMIT); // the quota is not bypassed or over-counted

    const row = await WebhookInbox.findOne({ merchantId: shop.mid, externalId: "evt-5002" }).lean();
    expect(row).toMatchObject({
      status: "needs_attention",
      skipReason: ORDER_QUOTA_EXCEEDED,
      provider: "shopify",
      topic: "orders/create",
      orderExternalId: "5002",
      attempts: 0,
    });
    expect(row?.integrationId?.toString()).toBe(shop.integrationId.toString());
    expect(row?.lastError).toMatch(/^order_quota_exceeded: monthly order quota reached/);
    expect((row?.payload as { id?: number }).id).toBe(5002); // recoverable
    expect(row?.nextRetryAt ?? null).toBeNull(); // no endless retry
    expect(row?.deadLetteredAt ?? null).toBeNull();
  });

  it("the worker path holds it too — not 'failed', never dead-lettered as a webhook failure", async () => {
    const shop = await starterShop();
    await exhaust(shop.mid);
    const { result } = await deliverAsync(shop, shopifyOrder(5003), "evt-5003");
    expect(result).toMatchObject({ ok: false, status: "needs_attention", skipReason: ORDER_QUOTA_EXCEEDED, attempts: 0 });
    // The retry sweep never picks it up again; only a manual replay does.
    const swept = await replayWebhookInbox({ inboxId: (await WebhookInbox.findOne({ externalId: "evt-5003" }))!._id as Types.ObjectId });
    expect(swept.status).toBe("skipped");
    expect(await Notification.countDocuments({ merchantId: shop.mid, kind: "integration.webhook_failed" })).toBe(0);
    expect(await WebhookInbox.countDocuments({ merchantId: shop.mid, status: "failed" })).toBe(0);
  });

  it("the same delivery twice, and the same order under another event id, leave ONE held row", async () => {
    const shop = await starterShop();
    await exhaust(shop.mid);
    const payload = shopifyOrder(5004);
    await deliver(shop, payload, "evt-5004");
    const again = await deliver(shop, payload, "evt-5004"); // platform redelivery: same event id
    expect(again).toMatchObject({ ok: true, duplicate: true });
    const { result: update } = await deliverAsync(shop, payload, "evt-5004-update", "orders/updated"); // same order, new event
    expect(update).toMatchObject({ ok: true, duplicate: true, status: "succeeded" });

    expect(await orderQuotaHeldCount(shop.mid)).toBe(1);
    expect(await WebhookInbox.countDocuments({ merchantId: shop.mid, status: "needs_attention" })).toBe(1);
    expect((await WebhookInbox.findOne({ externalId: "evt-5004-update" }).lean())?.lastError).toMatch(/^duplicate of held order/);
    expect(await Order.countDocuments({ merchantId: shop.mid })).toBe(0);
  });
});

describe("merchant notification", () => {
  it("one critical 'quota reached' notification, deep-linked to the held orders, with the live held count", async () => {
    const shop = await starterShop();
    await exhaust(shop.mid);
    await deliver(shop, shopifyOrder(5101));
    const [n] = await quotaNotices(shop.mid);
    expect(n).toMatchObject({
      severity: "critical",
      title: "Monthly order quota reached — new orders on hold",
      link: "/dashboard/settings/integrations/issues",
      meta: { held: 1, limit: STARTER_LIMIT, used: STARTER_LIMIT, tier: "starter" },
    });
    expect(n!.body).toContain(`Starter plan's ${STARTER_LIMIT.toLocaleString("en-US")} orders for this month are used up`);
    expect(n!.body).toContain("1 store order is held safely — received, not lost");
    expect(n!.body).toContain("Upgrade your plan or wait for the monthly reset, then replay held orders");
    expect(n!.body).not.toMatch(/webhook (permanently )?failed/i);

    const [item] = (await shop.caller.notifications.inbox()).items;
    expect(item).toMatchObject({ kind: "subscription.order_quota_reached", category: "account", href: "/dashboard/settings/integrations/issues" });
  });

  it("20 redeliveries and more held orders never add a second notification — the counts update instead", async () => {
    const shop = await starterShop();
    await exhaust(shop.mid);
    const payload = shopifyOrder(5102);
    for (let i = 0; i < 20; i++) await deliver(shop, payload, "evt-5102");
    expect(await quotaNotices(shop.mid)).toHaveLength(1);
    await deliver(shop, shopifyOrder(5103));
    await deliverAsync(shop, shopifyOrder(5104), "evt-5104");
    const notices = await quotaNotices(shop.mid);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.meta).toMatchObject({ held: 3 });
    expect(notices[0]!.body).toContain("3 store orders are held safely");
  });
});

describe("replay", () => {
  async function heldShop() {
    const shop = await starterShop();
    await exhaust(shop.mid);
    await deliver(shop, shopifyOrder(5201));
    const row = (await WebhookInbox.findOne({ merchantId: shop.mid, externalId: "evt-5201" }))!;
    return { ...shop, inboxId: row._id as Types.ObjectId };
  }

  it("while the quota is still used up: stays held, no order, no attempt spent", async () => {
    const shop = await heldShop();
    const r = await replayWebhookInbox({ inboxId: shop.inboxId, manual: true });
    expect(r).toMatchObject({ ok: false, status: "needs_attention", skipReason: ORDER_QUOTA_EXCEEDED, attempts: 0 });
    const viaUi = await shop.caller.integrations.replayWebhook({ id: String(shop.inboxId) });
    expect(viaUi).toMatchObject({ ok: false, status: "needs_attention", skipReason: ORDER_QUOTA_EXCEEDED });
    expect(await Order.countDocuments({ merchantId: shop.mid })).toBe(0);
    expect(await WebhookInbox.findById(shop.inboxId).lean()).toMatchObject({ status: "needs_attention", attempts: 0 });
    expect(await ordersUsed(shop.mid)).toBe(STARTER_LIMIT);
    expect(await quotaNotices(shop.mid)).toHaveLength(1);
  });

  it("after an upgrade: exactly one order, original source + external id, row resolved; replaying again changes nothing", async () => {
    const shop = await heldShop();
    await Merchant.updateOne({ _id: shop.mid }, { $set: { "subscription.tier": "growth" } });
    const r = await replayWebhookInbox({ inboxId: shop.inboxId, manual: true });
    expect(r).toMatchObject({ ok: true, status: "succeeded" });
    const order = await Order.findOne({ merchantId: shop.mid }).lean();
    expect(order?.source).toMatchObject({ externalId: "5201", integrationId: shop.integrationId });
    expect(await WebhookInbox.findById(shop.inboxId).lean()).toMatchObject({ status: "succeeded", resolvedOrderId: order!._id });
    expect(await ordersUsed(shop.mid)).toBe(STARTER_LIMIT + 1);

    const twice = await replayWebhookInbox({ inboxId: shop.inboxId, manual: true });
    expect(twice).toMatchObject({ ok: true, duplicate: true, status: "skipped" });
    const viaUi = await shop.caller.integrations.replayWebhook({ id: String(shop.inboxId) });
    expect(viaUi.status).toBe("skipped");
    // A late redelivery of the same order is a duplicate, not a new order.
    expect(await deliver(shop, (await WebhookInbox.findById(shop.inboxId).lean())!.payload as ReturnType<typeof shopifyOrder>, "evt-5201-late")).toMatchObject({ ok: true, duplicate: true });
    expect(await Order.countDocuments({ merchantId: shop.mid })).toBe(1);
    expect(await ordersUsed(shop.mid)).toBe(STARTER_LIMIT + 1);
  });

  it("after the monthly reset: bulk replay creates each held order once; a second bulk replay creates none", async () => {
    const shop = await heldShop();
    await deliver(shop, shopifyOrder(5202));
    let issues = await shop.caller.integrations.listIssues({ limit: 100 });
    expect(issues.reasonsCount[ORDER_QUOTA_EXCEEDED]).toBe(2);
    expect(issues.orderQuota).toMatchObject({ available: false, used: STARTER_LIMIT, limit: STARTER_LIMIT, planName: "Starter" });
    expect(issues.rows.every((r) => r.skipReason === ORDER_QUOTA_EXCEEDED && r.status === "needs_attention")).toBe(true);

    await exhaust(shop.mid, 0); // the new period's counter
    const first = await shop.caller.integrations.bulkReplayIssues({});
    expect(first).toMatchObject({ attempted: 2, succeeded: 2, stillHeldForQuota: 0 });
    const second = await shop.caller.integrations.bulkReplayIssues({});
    expect(second).toMatchObject({ attempted: 0, succeeded: 0 });
    expect((await Order.find({ merchantId: shop.mid }).lean()).map((o) => o.source?.externalId).sort()).toEqual(["5201", "5202"]);
    expect(await ordersUsed(shop.mid)).toBe(2);
    issues = await shop.caller.integrations.listIssues({ limit: 100 });
    expect(issues.reasonsCount[ORDER_QUOTA_EXCEEDED] ?? 0).toBe(0);
    expect(issues.orderQuota.available).toBe(true);
  });

  it("partial capacity: replays as many as fit, the rest stay held (bulk counters say so)", async () => {
    const shop = await heldShop();
    await deliver(shop, shopifyOrder(5203));
    await exhaust(shop.mid, STARTER_LIMIT - 1); // room for exactly one
    const r = await shop.caller.integrations.bulkReplayIssues({});
    expect(r).toMatchObject({ attempted: 2, succeeded: 1, stillStuck: 1, stillHeldForQuota: 1 });
    expect(await Order.countDocuments({ merchantId: shop.mid })).toBe(1);
    expect(await orderQuotaHeldCount(shop.mid)).toBe(1);
    expect(await ordersUsed(shop.mid)).toBe(STARTER_LIMIT);
  });

  it("a replay that fails for another reason keeps the existing failure semantics", async () => {
    const shop = await heldShop();
    await Merchant.updateOne({ _id: shop.mid }, { $set: { "subscription.tier": "growth" } });
    // The stored payload has become unprocessable (no phone) → the existing missing-phone classification.
    await WebhookInbox.updateOne(
      { _id: shop.inboxId },
      { $set: { "payload.customer.phone": null, "payload.shipping_address.phone": null, "payload.phone": null } },
    );
    const r = await replayWebhookInbox({ inboxId: shop.inboxId, manual: true });
    expect(r).toMatchObject({ ok: false, status: "needs_attention", skipReason: "missing_phone" });
    expect(await Order.countDocuments({ merchantId: shop.mid })).toBe(0);
  });
});

describe("non-quota failures are unchanged", () => {
  it("a transient ingest failure is still 'failed' with a retry, then dead-lettered as webhook_failed", async () => {
    const shop = await starterShop();
    const normalized = {
      externalId: "broken-q1",
      customer: { name: "x", phone: "", address: "y", district: "Dhaka" },
      items: [{ name: "Item", quantity: 1, price: 100 }],
      cod: 100,
      total: 100,
    };
    const r = await processWebhookOnce({
      merchantId: shop.mid,
      integrationId: shop.integrationId,
      provider: "custom_api",
      topic: "order.created",
      externalId: "broken-q1",
      rawPayload: normalized,
      payloadBytes: 50,
      normalized,
      source: "custom_api",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBeUndefined();
    const row = await WebhookInbox.findOne({ externalId: "broken-q1" });
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(row?.nextRetryAt).toBeTruthy();
    expect(row?.skipReason ?? null).toBeNull();

    // On the worker's replay the adapter classifies the stored payload as
    // before (no phone → missing_phone); nothing about it is quota-related.
    // (Dead-lettering after the retry cap is covered in integrations.test.ts.)
    row!.attempts = WEBHOOK_RETRY_MAX_ATTEMPTS - 1;
    await row!.save();
    const last = await replayWebhookInbox({ inboxId: row!._id as Types.ObjectId });
    expect(last).toMatchObject({ status: "needs_attention", skipReason: "missing_phone" });
    expect(await quotaNotices(shop.mid)).toHaveLength(0);
    expect(await orderQuotaHeldCount(shop.mid)).toBe(0);
  });
});
