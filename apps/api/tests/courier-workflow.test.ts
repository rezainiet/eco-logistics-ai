import type { AddressInfo } from "node:net";
import express from "express";
import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InventoryMovement, Merchant, MerchantStats, Notification, Order, PendingAwb, Product, WebhookInbox } from "@ecom/db";
import { encryptSecret } from "../src/lib/crypto.js";
import { inTransaction, reserveOrderStock } from "../src/lib/inventory.js";
import { __clearPathaoTokenCache, MockPathaoTransport, parsePathaoWebhook } from "../src/lib/couriers/pathao.js";
import { MockSteadfastTransport, parseSteadfastWebhook } from "../src/lib/couriers/steadfast.js";
import { courierChargeOf } from "../src/lib/couriers/types.js";
import { courierHealth } from "../src/lib/couriers/health.js";
import { syncOrderTracking } from "../src/server/tracking.js";
import { courierWebhookRouter } from "../src/server/webhooks/courier.js";
import { __TEST as AUTO_BOOK } from "../src/workers/automationBook.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Courier workflow end to end, against the couriers' mock transports (no
 * real courier API is ever called): verified order → booking → courier
 * events (webhook and polling) → delivered / returned, with the order
 * lifecycle, stock, accounting and merchant notifications each moving
 * exactly once however often the courier repeats itself.
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

async function merchant() {
  const m = await createMerchant();
  const mid = m._id as Types.ObjectId;
  // Steadfast webhooks need the merchant's secret (Authorization: Bearer).
  await Merchant.updateOne({ _id: mid, "couriers.name": "steadfast" }, { $set: { "couriers.$.apiSecret": encryptSecret(SF_SECRET) } });
  return { mid, caller: callerFor(authUserFor(m)) };
}

/** A confirmed order holding one unit of a stocked product. */
async function confirmedOrder(mid: Types.ObjectId, opts: { review?: string } = {}) {
  const product = await Product.create({ merchantId: mid, name: "Premium Achar", price: 1250, costPrice: 700, inventory: { onHand: 10, reserved: 0 } });
  const orderId = new Types.ObjectId();
  await Order.create({
    _id: orderId,
    merchantId: mid,
    orderNumber: `ORD-${orderId.toHexString().slice(-8)}`,
    customer: { name: "Rahim", phone: "+8801711111111", address: "House 1, Road 2", district: "Dhaka" },
    items: [{ name: "Premium Achar", quantity: 1, price: 1250, unitCost: 700, productId: product._id }],
    order: { cod: 1330, total: 1330, status: "confirmed" },
    inventory: { state: "reserved", cycle: 1, reservedAt: new Date() },
    ...(opts.review ? { fraud: { reviewStatus: opts.review } } : {}),
  });
  await inTransaction((s) => reserveOrderStock(s, { merchantId: mid, orderId, items: [{ productId: product._id as Types.ObjectId, quantity: 1 }] }));
  return { id: String(orderId), orderId, productId: product._id as Types.ObjectId };
}

const post = (path: string, body: object, headers: Record<string, string>) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const pathaoHook = (mid: Types.ObjectId, body: object) => post(`/pathao/${mid}`, body, { "X-PATHAO-Signature": PH_SECRET });
const steadfastHook = (mid: Types.ObjectId, body: object) => post(`/steadfast/${mid}`, body, { authorization: `Bearer ${SF_SECRET}` });

async function snapshot(orderId: Types.ObjectId, productId: Types.ObjectId, mid: Types.ObjectId) {
  const o = (await Order.findById(orderId).lean())!;
  const p = (await Product.findById(productId).lean())!;
  return {
    status: o.order.status,
    deliveredAt: o.logistics?.deliveredAt ?? null,
    returnedAt: o.logistics?.returnedAt ?? null,
    fee: o.logistics?.courierFee ?? null,
    events: o.logistics?.trackingEvents?.length ?? 0,
    stock: { onHand: p.inventory.onHand, reserved: p.inventory.reserved },
    moves: (await InventoryMovement.find({ orderId }).sort({ createdAt: 1, _id: 1 }).lean()).map((m) => m.type),
    issues: await Notification.countDocuments({ merchantId: mid, kind: "order.delivery_issue" }),
    returns: await Notification.countDocuments({ merchantId: mid, kind: "order.returned" }),
  };
}

const ALL = { preset: "custom" as const, from: "2024-01-01", to: "2030-12-31" };

describe("booking → courier updates → delivered (Pathao, webhooks)", () => {
  it("moves the order, stock, accounting and notifications exactly once", async () => {
    const { mid, caller } = await merchant();
    const { id, orderId, productId } = await confirmedOrder(mid);

    const booked = await caller.orders.bookShipment({ orderId: id, courier: "pathao" });
    expect(booked).toMatchObject({ status: "shipped", fee: 80 });
    // Idempotent booking: a repeat returns the same parcel, no second AWB.
    expect(await caller.orders.bookShipment({ orderId: id, courier: "pathao" })).toMatchObject({ trackingNumber: booked.trackingNumber });
    expect(await PendingAwb.countDocuments({ orderId })).toBe(1);
    const tn = booked.trackingNumber;
    expect(await snapshot(orderId, productId, mid)).toMatchObject({ status: "shipped", fee: 80, stock: { onHand: 10, reserved: 1 } });

    expect((await pathaoHook(mid, { consignment_id: tn, order_status: "In Transit", updated_at: "2026-09-30T08:00:00Z" })).status).toBe(200);
    expect((await snapshot(orderId, productId, mid)).status).toBe("in_transit");

    // A failed attempt: the parcel is still with the courier — no status
    // change, stock stays reserved, the merchant is told once.
    const failed = { consignment_id: tn, order_status: "Delivery_Failed", reason: "Customer not reachable", updated_at: "2026-09-30T12:00:00Z" };
    await pathaoHook(mid, failed);
    await pathaoHook(mid, failed); // courier retry
    await pathaoHook(mid, { ...failed, updated_at: "2026-09-30T12:05:00Z" }); // same event re-sent later
    let s = await snapshot(orderId, productId, mid);
    expect(s).toMatchObject({ status: "in_transit", issues: 1, stock: { onHand: 10, reserved: 1 } });
    const issue = (await Notification.findOne({ merchantId: mid, kind: "order.delivery_issue" }).lean())!;
    expect(issue.title).toContain(`ORD-${orderId.toHexString().slice(-8)}`);
    expect(issue.body).toContain('"Delivery_Failed"');
    expect(issue.link).toBe(`/dashboard/orders?focus=${id}`);

    const delivered = { consignment_id: tn, order_status: "Delivered", delivery_fee: 95, updated_at: "2026-10-01T09:00:00Z", delivered_at: "2026-10-01T09:00:00Z" };
    expect(await (await pathaoHook(mid, delivered)).json()).toMatchObject({ statusTransition: { from: "in_transit", to: "delivered" } });
    s = await snapshot(orderId, productId, mid);
    expect(s).toMatchObject({ status: "delivered", stock: { onHand: 9, reserved: 0 } });
    expect(s.deliveredAt?.toISOString()).toBe("2026-10-01T09:00:00.000Z");
    expect(s.fee).toBe(80); // the booked fee is never overwritten by a later event
    const movesAfterDelivery = s.moves;

    // Replays and stale events change nothing.
    await pathaoHook(mid, delivered);
    await pathaoHook(mid, { ...delivered, updated_at: "2026-10-01T10:00:00Z" });
    await pathaoHook(mid, { consignment_id: tn, order_status: "Returned", updated_at: "2026-10-02T09:00:00Z" });
    // A late failed-attempt event for a delivered parcel is history, not a problem to act on.
    await pathaoHook(mid, { consignment_id: tn, order_status: "Delivery_Failed", reason: "late scan", updated_at: "2026-10-02T10:00:00Z" });
    const after = await snapshot(orderId, productId, mid);
    expect(after).toMatchObject({ status: "delivered", fee: 80, stock: { onHand: 9, reserved: 0 }, issues: 1, returns: 0, returnedAt: null });
    expect(after.moves).toEqual(movesAfterDelivery);

    const stats = (await MerchantStats.findOne({ merchantId: mid }).lean())!;
    expect(stats).toMatchObject({ delivered: 1, shipped: 0, in_transit: 0, confirmed: 0 });

    // The bell drawer reads courier notices by kind from the inbox.
    await Notification.create({ merchantId: mid, kind: "fraud.pending_review", severity: "warning", title: "other kind" });
    const inbox = await caller.notifications.list({ onlyUnread: true, kinds: ["order.delivery_issue", "order.returned"], limit: 20, cursor: null });
    expect(inbox.items.map((n) => n.kind)).toEqual(["order.delivery_issue"]);

    const pnl = await caller.finance.summary({ period: ALL });
    expect(pnl.revenue.realized).toBe(1330);
    expect(pnl.revenue.deliveredOrders).toBe(1);
    expect(pnl.productCost.total).toBe(700);
    expect(pnl.courierCost.total).toBe(80);
  });
});

describe("returned parcel (Steadfast, fee from the courier's webhook)", () => {
  it("rto releases the stock once, records the stated charge once, and notifies once", async () => {
    const { mid, caller } = await merchant();
    const { id, orderId, productId } = await confirmedOrder(mid);
    const booked = await caller.orders.bookShipment({ orderId: id, courier: "steadfast" });
    expect(booked.fee).toBeUndefined(); // Steadfast's booking response states no fee
    const consignment = (await Order.findById(orderId).lean())!.logistics!.providerOrderId!;
    expect(consignment).toBeTruthy();

    // Steadfast "cancelled" = return in progress: still with the courier.
    await steadfastHook(mid, { consignment_id: consignment, status: "cancelled", updated_at: "2026-09-30T10:00:00Z" });
    let s = await snapshot(orderId, productId, mid);
    expect(s).toMatchObject({ status: "shipped", issues: 1, returns: 0, fee: null, stock: { onHand: 10, reserved: 1 } });

    await steadfastHook(mid, { consignment_id: consignment, status: "returned", delivery_charge: "60", updated_at: "2026-10-01T10:00:00Z" });
    s = await snapshot(orderId, productId, mid);
    expect(s).toMatchObject({ status: "rto", fee: 60, returns: 1, stock: { onHand: 10, reserved: 0 } });
    expect(s.returnedAt).toBeInstanceOf(Date);

    await steadfastHook(mid, { consignment_id: consignment, status: "returned", delivery_charge: 999, updated_at: "2026-10-01T11:00:00Z" });
    const after = await snapshot(orderId, productId, mid);
    expect(after).toMatchObject({ status: "rto", fee: 60, returns: 1, stock: { onHand: 10, reserved: 0 } });
    expect(after.moves).toEqual(s.moves);

    const pnl = await caller.finance.summary({ period: ALL });
    expect(pnl.revenue.realized).toBe(0);
    expect(pnl.courierCost).toMatchObject({ total: 60, fromReturned: 60 });
  });
});

describe("polling (Steadfast status_by_cid on the mock transport)", () => {
  it("syncs status from the courier, and repeated polls add nothing", async () => {
    const { mid, caller } = await merchant();
    const { id, orderId, productId } = await confirmedOrder(mid);
    await caller.orders.bookShipment({ orderId: id, courier: "steadfast" });
    const load = async () => (await Order.findById(orderId).select("_id merchantId order logistics").lean())!;

    // Freshly booked parcel: "in_review" is pending — nothing moves.
    await syncOrderTracking(await load());
    expect((await snapshot(orderId, productId, mid)).status).toBe("shipped");

    const consignment = (await load()).logistics!.providerOrderId!;
    const store = (MockSteadfastTransport as unknown as { store: Map<string, { status: string }> }).store;
    store.get(consignment)!.status = "delivered";
    expect(await syncOrderTracking(await load())).toMatchObject({ statusTransition: { from: "shipped", to: "delivered" } });
    const once = await snapshot(orderId, productId, mid);
    await syncOrderTracking(await load());
    await syncOrderTracking(await load());
    const again = await snapshot(orderId, productId, mid);
    expect(again).toEqual(once);
    expect(once).toMatchObject({ status: "delivered", stock: { onHand: 9, reserved: 0 }, fee: null });
    expect(once.deliveredAt).toBeInstanceOf(Date);
  });
});

describe("never fabricates courier facts", () => {
  it("an unknown status only reaches the timeline; no fee is invented", async () => {
    const { mid, caller } = await merchant();
    const { id, orderId, productId } = await confirmedOrder(mid);
    const { trackingNumber } = await caller.orders.bookShipment({ orderId: id, courier: "pathao" });
    await Order.updateOne({ _id: orderId }, { $unset: { "logistics.courierFee": "" } });
    await pathaoHook(mid, { consignment_id: trackingNumber, order_status: "Brand_New_Status", updated_at: "2026-10-01T09:00:00Z" });
    expect(await snapshot(orderId, productId, mid)).toMatchObject({ status: "shipped", events: 1, fee: null, issues: 0, returns: 0 });
  });

  it("only a stated, valid charge is read from a payload", () => {
    expect(courierChargeOf(110)).toBe(110);
    expect(courierChargeOf("60.5")).toBe(60.5);
    for (const bad of [undefined, null, "", "abc", -5, Number.NaN, Infinity, {}]) expect(courierChargeOf(bad)).toBeUndefined();
    expect(parseSteadfastWebhook({ consignment_id: 1, status: "delivered" })!.fee).toBeUndefined();
    expect(parseSteadfastWebhook({ consignment_id: 1, status: "delivered", delivery_charge: 100 })!.fee).toBe(100);
    expect(parsePathaoWebhook({ consignment_id: "P1", order_status: "Delivered" })!.fee).toBeUndefined();
    expect(parsePathaoWebhook({ consignment_id: "P1", order_status: "Delivered", delivery_fee: "75" })!.fee).toBe(75);
  });
});

describe("verification gate on every dispatch path", () => {
  it("an order awaiting verification is not dispatched by any path", async () => {
    const { mid, caller } = await merchant();
    const { id, orderId } = await confirmedOrder(mid, { review: "pending_call" });

    await expect(caller.orders.bookShipment({ orderId: id, courier: "pathao" })).rejects.toThrow(/requires call verification/);
    const bulk = await caller.orders.bulkBookShipment({ orderIds: [id], courier: "pathao" });
    expect(bulk).toMatchObject({ succeeded: 0, failed: 1 });
    const auto = await AUTO_BOOK.bookOrThrow({ orderId: id, merchantId: String(mid), userId: String(mid), courier: "pathao" }).catch((e: Error) => ({ ok: false, error: e.message }));
    expect(auto.ok === false || (auto as { status?: string }).status !== "booked").toBe(true);
    await caller.orders.updateOrder({ id, status: "packed" });
    await expect(caller.orders.updateOrder({ id, status: "shipped" })).rejects.toThrow(/requires call verification/);

    const o = (await Order.findById(orderId).lean())!;
    expect(o.logistics?.trackingNumber ?? null).toBeNull();
    expect(o.order.status).toBe("packed");
    expect(await PendingAwb.countDocuments({ orderId })).toBe(0); // no courier call was even attempted
  });
});

describe("courier health (settings page)", () => {
  it("shows the webhook URL, last update, shipments needing attention and booking failures — merchant-scoped", async () => {
    const { mid, caller } = await merchant();
    const a = await confirmedOrder(mid);
    const b = await confirmedOrder(mid);
    const c = await confirmedOrder(mid);
    const tnA = (await caller.orders.bookShipment({ orderId: a.id, courier: "pathao" })).trackingNumber;
    await caller.orders.bookShipment({ orderId: b.id, courier: "pathao" });
    await caller.orders.bookShipment({ orderId: c.id, courier: "pathao" });
    await pathaoHook(mid, { consignment_id: tnA, order_status: "Delivery_Failed", updated_at: "2026-10-01T09:00:00Z" });
    await Order.updateOne({ _id: b.orderId }, { $set: { "logistics.pollErrorCount": 2, "logistics.pollError": "timeout" } });
    await Order.updateOne({ _id: c.orderId }, { $set: { "logistics.shippedAt": new Date(Date.now() - 9 * 86_400_000) } });
    await PendingAwb.create({ orderId: new Types.ObjectId(), merchantId: mid, courier: "pathao", attempt: 1, idempotencyKey: "k1", status: "failed", lastError: "invalid area" });
    await PendingAwb.create({ orderId: new Types.ObjectId(), merchantId: mid, courier: "pathao", attempt: 1, idempotencyKey: "k2", status: "orphaned" });

    const health = await caller.merchants.courierHealth();
    const ph = health.find((h) => h.name === "pathao")!;
    expect(ph.webhook.callbackUrl).toMatch(new RegExp(`/api/webhooks/courier/pathao/${mid}$`));
    expect(ph.webhook.secretConfigured).toBe(true);
    expect(ph.webhook.lastReceivedAt).toBeInstanceOf(Date);
    expect(ph.shipments).toMatchObject({ active: 3, deliveryIssues: 1, syncErrors: 1, stale: 1 });
    expect(ph.shipments.attention.map((x) => [x.orderId, x.issue]).sort()).toEqual(
      [[a.id, "delivery_issue"], [b.id, "sync_error"], [c.id, "no_update"]].sort(),
    );
    expect(ph.bookings).toMatchObject({ failedLast7d: 1, orphaned: 1, lastFailure: { error: "invalid area" } });
    const sf = health.find((h) => h.name === "steadfast")!;
    expect(sf.shipments.active).toBe(0);
    expect(sf.webhook.lastReceivedAt).toBeNull();

    // Another merchant sees only its own couriers' (empty) health.
    const other = await merchant();
    const theirs = await other.caller.merchants.courierHealth();
    expect(theirs.every((h) => h.shipments.active === 0 && h.bookings.failedLast7d === 0 && h.bookings.orphaned === 0)).toBe(true);
    expect(theirs.every((h) => !h.webhook.callbackUrl?.includes(String(mid)))).toBe(true);
  });

  it("is computed by the library for a merchant with no couriers", async () => {
    expect(await courierHealth(new Types.ObjectId())).toEqual([]);
  });
});
