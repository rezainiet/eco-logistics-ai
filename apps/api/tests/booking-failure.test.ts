import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLog, Merchant, Notification, Order, WebhookInbox } from "@ecom/db";
import { CourierError } from "../src/lib/couriers/types.js";
import { __TEST as book } from "../src/workers/automationBook.js";
import { runAutomationWatchdog } from "../src/workers/automationWatchdog.js";
import { replayWebhookInbox, WEBHOOK_RETRY_MAX_ATTEMPTS } from "../src/server/ingest.js";
import { bookingFailedCopy, bookingFailureReason } from "../src/lib/booking-failure.js";
import { encryptSecret } from "../src/lib/crypto.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * A courier refusing a booking is a courier BOOKING failure
 * (`order.booking_failed`) — never an integration/webhook failure. Automatic
 * booking falls back across couriers and tells the merchant once, about the
 * final outcome only.
 */

// Courier adapters run on their deterministic mock transport in tests; this
// makes chosen couriers refuse bookings with a given CourierError.
const refusing = new Map<string, CourierError>();
vi.mock("../src/lib/couriers/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/couriers/index.js")>();
  return {
    ...real,
    adapterFor: (config: Parameters<typeof real.adapterFor>[0]) => {
      const adapter = real.adapterFor(config);
      const err = refusing.get(config.name);
      if (!err) return adapter;
      return new Proxy(adapter, {
        get: (target, prop, recv) =>
          prop === "createAWB" ? async () => { throw err; } : Reflect.get(target, prop, recv),
      });
    },
  };
});

beforeAll(ensureDb);
afterAll(disconnectDb);
beforeEach(async () => {
  await resetDb();
  refusing.clear();
});

const rejectDetails = (provider: "pathao" | "steadfast" | "redx") =>
  new CourierError("invalid_input", `${provider}: recipient phone is invalid`, { provider });

/** A merchant with Steadfast + Pathao (+ RedX), auto-book on, and a fresh confirmed order. */
async function shop(opts: { redx?: boolean } = {}) {
  const m = await createMerchant();
  const set: Record<string, unknown> = {
    "automationConfig.enabled": true,
    "automationConfig.mode": "full_auto",
    "automationConfig.autoBookEnabled": true,
  };
  await Merchant.updateOne({ _id: m._id }, { $set: set });
  if (opts.redx) {
    await Merchant.updateOne({ _id: m._id }, { $push: { couriers: { name: "redx", accountId: "acc-rx", apiKey: encryptSecret("sk_test_rx") } } });
  }
  const order = await Order.create({
    merchantId: m._id,
    orderNumber: `ORD-${new Types.ObjectId().toHexString().slice(-6)}`,
    customer: { name: "C", phone: "+8801711111111", address: "House 1, Road 2", district: "Dhaka" },
    items: [{ name: "Item", quantity: 1, price: 500 }],
    order: { cod: 500, total: 500, status: "confirmed" },
    automation: { state: "confirmed", confirmedAt: new Date() },
  });
  return { mid: m._id as Types.ObjectId, caller: callerFor(authUserFor(m)), order, orderId: String(order._id) };
}
const autoBook = (s: { mid: Types.ObjectId; orderId: string }, courier?: string, attempted?: string[]) =>
  book.bookOrThrow({ orderId: s.orderId, merchantId: String(s.mid), userId: String(s.mid), ...(courier ? { courier } : {}), ...(attempted ? { attempted } : {}) });
const bookingAlerts = (mid: Types.ObjectId) => Notification.find({ merchantId: mid, kind: "order.booking_failed" }).lean();
const webhookAlerts = (mid: Types.ObjectId) => Notification.countDocuments({ merchantId: mid, kind: "integration.webhook_failed" });
/** Audit rows are written fire-and-forget. */
async function auditRows(mid: Types.ObjectId, action: string, n: number) {
  for (let i = 0; i < 50; i++) {
    const rows = await AuditLog.find({ merchantId: mid, action }).lean();
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`expected ${n} ${action} audit rows`);
}

describe("reason wording", () => {
  it("comes from the courier error taxonomy; order-detail rejections keep the courier's short message", () => {
    expect(bookingFailureReason("auth_failed")).toContain("check them in Settings → Couriers");
    expect(bookingFailureReason("timeout")).toBe("the courier didn't respond in time");
    expect(bookingFailureReason("invalid_input", "recipient phone is invalid")).toBe("the courier rejected the order details: recipient phone is invalid");
    expect(bookingFailureReason(undefined, "secret token xyz")).toBe("the courier returned an unexpected error"); // raw text only for invalid_input
    expect(bookingFailedCopy({ orderNumber: "ORD-1", couriers: ["pathao", "steadfast", "redx"], code: "timeout" })).toEqual({
      title: "Courier booking failed — order ORD-1",
      body: "Order ORD-1 could not be booked — tried Pathao, Steadfast and RedX. RedX: the courier didn't respond in time. Open the order to book it manually or pick another courier.",
    });
  });
});

describe("manual booking", () => {
  it("a courier refusal is recorded as a booking failure on the order — not an integration failure", async () => {
    const s = await shop();
    refusing.set("pathao", rejectDetails("pathao"));
    await expect(s.caller.orders.bookShipment({ orderId: s.orderId, courier: "pathao" })).rejects.toThrow(/recipient phone is invalid/);
    const [row] = await auditRows(s.mid, "order.booking_failed", 1);
    expect(row).toMatchObject({ subjectType: "order", meta: { courier: "pathao", mode: "manual", reasonCode: "invalid_input" } });
    expect(String(row!.subjectId)).toBe(s.orderId);
    expect(await webhookAlerts(s.mid)).toBe(0);
    // The merchant is looking at the error; no inbox alert for their own action.
    expect(await bookingAlerts(s.mid)).toHaveLength(0);
    // The existing retry path still works.
    refusing.clear();
    const ok = await s.caller.orders.bookShipment({ orderId: s.orderId, courier: "pathao" });
    expect(ok.trackingNumber).toBeTruthy();
  });

  it("bulk booking records each courier-refused order the same way", async () => {
    const s = await shop();
    refusing.set("steadfast", new CourierError("timeout", "steadfast timed out", { provider: "steadfast" }));
    const r = await s.caller.orders.bulkBookShipment({ orderIds: [s.orderId], courier: "steadfast" });
    expect(r).toMatchObject({ succeeded: 0, failed: 1 });
    const [row] = await auditRows(s.mid, "order.booking_failed", 1);
    expect(row!.meta).toMatchObject({ mode: "bulk", reasonCode: "timeout", reason: "the courier didn't respond in time" });
  });

  it("a non-courier refusal (order not bookable) is not a booking failure event", async () => {
    const s = await shop();
    await Order.updateOne({ _id: s.order._id }, { $set: { "order.status": "cancelled" } });
    await expect(s.caller.orders.bookShipment({ orderId: s.orderId, courier: "pathao" })).rejects.toThrow(/only pending\/confirmed\/packed/);
    await new Promise((r) => setTimeout(r, 50));
    expect(await AuditLog.countDocuments({ merchantId: s.mid, action: "order.booking_failed" })).toBe(0);
  });
});

describe("automatic booking + fallback", () => {
  it("first courier fails, second books it: booked, no booking-failed alert", async () => {
    const s = await shop();
    refusing.set("pathao", rejectDetails("pathao"));
    expect(await autoBook(s, "pathao")).toMatchObject({ ok: true, status: "skipped", error: "fallback queued (pathao failed)" });
    expect(await bookingAlerts(s.mid)).toHaveLength(0);
    const second = await autoBook(s, undefined, ["pathao"]);
    expect(second).toMatchObject({ ok: true, status: "booked" });
    expect((await Order.findById(s.order._id).lean())!.logistics).toMatchObject({ courier: "steadfast" });
    expect(await bookingAlerts(s.mid)).toHaveLength(0);
    expect(await webhookAlerts(s.mid)).toBe(0);
  });

  it("every courier fails: ONE critical booking-failed alert naming the couriers and reason, linked to the order", async () => {
    const s = await shop({ redx: true });
    for (const c of ["pathao", "steadfast", "redx"] as const) refusing.set(c, rejectDetails(c));
    await autoBook(s, "pathao");
    await autoBook(s, undefined, ["pathao"]);
    // The third courier is the cap: the job fails for the queue's retry policy, after alerting.
    await expect(autoBook(s, undefined, ["pathao", "steadfast"])).rejects.toThrow(/recipient phone is invalid/);
    const alerts = await bookingAlerts(s.mid);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "critical",
      subjectType: "order",
      link: `/dashboard/orders?focus=${s.orderId}`,
      title: `Courier booking failed — order ${s.order.orderNumber}`,
      meta: { reasonCode: "invalid_input", couriers: ["pathao", "steadfast", "redx"], courier: "redx", fallbackExhausted: true },
    });
    expect(alerts[0]!.body).toContain("tried Pathao, Steadfast and RedX");
    expect(String(alerts[0]!.subjectId)).toBe(s.orderId);
    expect(await webhookAlerts(s.mid)).toBe(0);

    const [item] = (await s.caller.notifications.inbox()).items;
    expect(item).toMatchObject({ kind: "order.booking_failed", category: "courier", href: `/dashboard/orders?focus=${s.orderId}` });
  });

  it("with fewer couriers than the cap, running out of couriers is the final failure too (no silent stop)", async () => {
    const s = await shop(); // steadfast + pathao only
    refusing.set("pathao", rejectDetails("pathao"));
    refusing.set("steadfast", new CourierError("provider_error", "steadfast 500", { provider: "steadfast" }));
    await autoBook(s, "pathao");
    expect(await autoBook(s, undefined, ["pathao"])).toMatchObject({ ok: false, status: "failed" });
    const alerts = await bookingAlerts(s.mid);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.meta).toMatchObject({ reasonCode: "provider_error", couriers: ["pathao", "steadfast"] });
  });

  it("retries, sweeps and the watchdog never add a second alert, nor blur its reason", async () => {
    const s = await shop();
    refusing.set("pathao", rejectDetails("pathao"));
    refusing.set("steadfast", rejectDetails("steadfast"));
    await autoBook(s, "pathao");
    await autoBook(s, undefined, ["pathao"]);
    for (let i = 0; i < 3; i++) await autoBook(s, undefined, ["pathao", "steadfast"]); // re-enqueued jobs: nothing left to try
    await Order.updateOne({ _id: s.order._id }, { $set: { "automation.confirmedAt": new Date(Date.now() - 30 * 60_000), "automation.attemptedCouriers": ["pathao", "steadfast", "redx"] } });
    await runAutomationWatchdog();
    await runAutomationWatchdog();
    const alerts = await bookingAlerts(s.mid);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.meta).toMatchObject({ reasonCode: "invalid_input" });
    expect(await webhookAlerts(s.mid)).toBe(0);
  });

  it("booked later (manual retry) → the stale booking-failed alert is removed", async () => {
    const s = await shop();
    refusing.set("pathao", rejectDetails("pathao"));
    refusing.set("steadfast", rejectDetails("steadfast"));
    await autoBook(s, "pathao");
    await autoBook(s, undefined, ["pathao"]);
    expect(await bookingAlerts(s.mid)).toHaveLength(1);
    refusing.clear();
    await s.caller.orders.bookShipment({ orderId: s.orderId, courier: "steadfast" });
    expect(await bookingAlerts(s.mid)).toHaveLength(0);
  });

  it("a credential rejection is reported as such (fix credentials), still as a booking failure", async () => {
    const s = await shop();
    refusing.set("pathao", new CourierError("auth_failed", "pathao token rejected", { provider: "pathao", status: 401 }));
    refusing.set("steadfast", new CourierError("auth_failed", "steadfast 401", { provider: "steadfast", status: 401 }));
    await autoBook(s, "pathao");
    await autoBook(s, undefined, ["pathao"]);
    const [alert] = await bookingAlerts(s.mid);
    expect(alert!.meta).toMatchObject({ reasonCode: "auth_failed" });
    expect(alert!.body).toContain("rejected your account credentials — check them in Settings → Couriers");
    expect(alert!.body).not.toContain("token"); // raw provider text stays out
    expect(await webhookAlerts(s.mid)).toBe(0);
  });

  it("tenant isolation: one merchant's booking failure never reaches another merchant", async () => {
    const a = await shop();
    const b = await shop();
    refusing.set("pathao", rejectDetails("pathao"));
    refusing.set("steadfast", rejectDetails("steadfast"));
    await autoBook(a, "pathao");
    await autoBook(a, undefined, ["pathao"]);
    expect(await bookingAlerts(a.mid)).toHaveLength(1);
    expect(await bookingAlerts(b.mid)).toHaveLength(0);
    expect((await b.caller.notifications.inbox()).items.filter((i) => i.kind === "order.booking_failed")).toHaveLength(0);
    // Another merchant's job id cannot book or alert across tenants.
    expect(await book.bookOrThrow({ orderId: a.orderId, merchantId: String(b.mid), userId: "u" })).toMatchObject({ status: "skipped", error: "order not found" });
    expect(await bookingAlerts(b.mid)).toHaveLength(0);
  });
});

describe("store webhook failures keep their own classification", () => {
  it("a dead-lettered store webhook is still integration.webhook_failed, never order.booking_failed", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));
    const created = await caller.integrations.connect({ provider: "custom_api" });
    const merchantId = m._id as Types.ObjectId;
    // Same deterministic dead-letter setup as integrations.test.ts: one attempt
    // from the cap, and ingest can no longer find the merchant.
    const inbox = await WebhookInbox.create({
      merchantId,
      integrationId: new Types.ObjectId(created.id),
      provider: "custom_api",
      topic: "order.created",
      externalId: "wh-dead-1",
      payload: {
        externalId: "wh-dead-1",
        customer: { name: "Buyer", phone: "+8801711000000", address: "Road 1", district: "Dhaka" },
        items: [{ name: "X", quantity: 1, price: 100 }],
        cod: 100,
        total: 100,
      },
      payloadBytes: 100,
      status: "failed",
      attempts: WEBHOOK_RETRY_MAX_ATTEMPTS - 1,
      lastError: "transient",
    });
    await Merchant.deleteOne({ _id: merchantId });
    const r = await replayWebhookInbox({ inboxId: inbox._id as Types.ObjectId });
    expect(r.status).toBe("dead_lettered");
    expect(await Notification.countDocuments({ merchantId, kind: "integration.webhook_failed" })).toBe(1);
    expect(await Notification.countDocuments({ merchantId, kind: "order.booking_failed" })).toBe(0);
  });
});
