import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { Order, WebhookInbox } from "@ecom/db";
import { replayCourierInbox } from "../src/server/courier-replay.js";
import { __resetCourierWebhookCounters } from "../src/lib/observability/courier-webhook.js";
import {
  createMerchant,
  disconnectDb,
  ensureDb,
  resetDb,
} from "./helpers.js";

async function makeOrder(merchantId: Types.ObjectId, trackingNumber: string) {
  return Order.create({
    merchantId,
    orderNumber: `ORD-RT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    customer: {
      name: "C",
      phone: "+8801711111111",
      address: "House 1",
      district: "Dhaka",
    },
    items: [{ name: "Item", quantity: 1, price: 500 }],
    order: { cod: 500, total: 500, status: "shipped" },
    logistics: { courier: "steadfast", trackingNumber },
  });
}

async function makeFailedInbox(args: {
  merchantId: Types.ObjectId;
  resolvedOrderId?: Types.ObjectId;
  payload: Record<string, unknown>;
  attempts?: number;
  externalId?: string;
}) {
  return WebhookInbox.create({
    merchantId: args.merchantId,
    provider: "steadfast",
    topic: "tracking.update",
    externalId: args.externalId ?? `ext-${Date.now()}-${Math.random()}`,
    payload: args.payload,
    payloadBytes: JSON.stringify(args.payload).length,
    status: "failed",
    attempts: args.attempts ?? 1,
    nextRetryAt: new Date(Date.now() - 1000),
    lastError: "previous failure",
    resolvedOrderId: args.resolvedOrderId,
  });
}

describe("replayCourierInbox", () => {
  beforeEach(async () => {
    await ensureDb();
    await resetDb();
    __resetCourierWebhookCounters();
  });
  afterAll(disconnectDb);

  it("replays a failed Steadfast row to success and bumps the tracking timeline", async () => {
    const m = await createMerchant();
    const o = await makeOrder(m._id as Types.ObjectId, "SF-RETRY-1");
    const inbox = await makeFailedInbox({
      merchantId: m._id as Types.ObjectId,
      payload: {
        tracking_code: "SF-RETRY-1",
        status: "delivered",
        updated_at: "2026-01-01T08:00:00Z",
      },
    });

    const r = await replayCourierInbox({ inboxId: inbox._id as Types.ObjectId });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("succeeded");

    const refreshed = await Order.findById(o._id).lean();
    expect(refreshed!.order.status).toBe("delivered");
    expect(refreshed!.logistics?.trackingEvents?.length).toBe(1);

    const inboxAfter = await WebhookInbox.findById(inbox._id).lean();
    expect(inboxAfter!.status).toBe("succeeded");
  });

  it("marks the row succeeded silently when the order has been deleted", async () => {
    const m = await createMerchant();
    const inbox = await makeFailedInbox({
      merchantId: m._id as Types.ObjectId,
      payload: {
        tracking_code: "SF-DELETED",
        status: "delivered",
        updated_at: "2026-01-01T08:00:00Z",
      },
    });
    const r = await replayCourierInbox({ inboxId: inbox._id as Types.ObjectId });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("succeeded");
    const inboxAfter = await WebhookInbox.findById(inbox._id).lean();
    expect(inboxAfter!.lastError).toBe("order not found on replay");
  });

  it("refuses to replay when the order belongs to a different merchant (defence-in-depth)", async () => {
    const m1 = await createMerchant();
    const m2 = await createMerchant();
    // order is for m2…
    const o = await makeOrder(m2._id as Types.ObjectId, "SF-CROSS");
    // …but inbox row says m1 (corruption)
    const inbox = await makeFailedInbox({
      merchantId: m1._id as Types.ObjectId,
      payload: {
        tracking_code: "SF-CROSS",
        status: "delivered",
        updated_at: "2026-01-01T08:00:00Z",
      },
    });

    const r = await replayCourierInbox({ inboxId: inbox._id as Types.ObjectId });
    // The order lookup is scoped to inbox.merchantId (m1), so it's "not found"
    // — replay marks succeeded without writing. The other-merchant order is
    // untouched.
    const otherOrder = await Order.findById(o._id).lean();
    expect(otherOrder!.order.status).toBe("shipped");
    expect(r.ok).toBe(true);
  });

  it("ignores rows whose payload no longer parses (no tracking code)", async () => {
    const m = await createMerchant();
    const inbox = await makeFailedInbox({
      merchantId: m._id as Types.ObjectId,
      payload: { something: "else" },
    });
    const r = await replayCourierInbox({ inboxId: inbox._id as Types.ObjectId });
    expect(r.ok).toBe(true);
    const inboxAfter = await WebhookInbox.findById(inbox._id).lean();
    expect(inboxAfter!.status).toBe("succeeded");
    expect(inboxAfter!.lastError).toBe("ignored on replay");
  });

  it("returns skipped=true and does NOT re-apply for already-succeeded rows", async () => {
    const m = await createMerchant();
    const o = await makeOrder(m._id as Types.ObjectId, "SF-DONE");
    const inbox = await WebhookInbox.create({
      merchantId: m._id as Types.ObjectId,
      provider: "steadfast",
      topic: "tracking.update",
      externalId: "ext-done",
      payload: { tracking_code: "SF-DONE", status: "delivered" },
      payloadBytes: 50,
      status: "succeeded",
      processedAt: new Date(),
      resolvedOrderId: o._id as Types.ObjectId,
    });
    const r = await replayCourierInbox({ inboxId: inbox._id as Types.ObjectId });
    expect(r.status).toBe("skipped");
    expect(r.duplicate).toBe(true);
  });
});
