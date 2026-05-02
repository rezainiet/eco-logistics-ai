import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { Types } from "mongoose";
import { Order } from "@ecom/db";
import {
  parseSteadfastWebhook,
  verifySteadfastWebhookSignature,
} from "../src/lib/couriers/steadfast.js";
import { applyTrackingEvents } from "../src/server/tracking.js";
import { createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/* -------------------------------------------------------------------------- */
/* Pure HMAC + parser tests                                                    */
/* -------------------------------------------------------------------------- */

describe("verifySteadfastWebhookSignature", () => {
  const secret = "shared-secret";
  const body = JSON.stringify({ tracking_code: "SF1", status: "delivered" });
  const sig = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a matching signature", () => {
    expect(verifySteadfastWebhookSignature(body, sig, secret)).toBe(true);
  });

  it("accepts the signature when passed inside an array (multi-header form)", () => {
    expect(verifySteadfastWebhookSignature(body, [sig], secret)).toBe(true);
  });

  it("rejects when secret is missing", () => {
    expect(verifySteadfastWebhookSignature(body, sig, undefined)).toBe(false);
  });

  it("rejects when signature is missing", () => {
    expect(verifySteadfastWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it("rejects when body has been tampered with", () => {
    const tampered = JSON.stringify({ tracking_code: "SF1", status: "rto" });
    expect(verifySteadfastWebhookSignature(tampered, sig, secret)).toBe(false);
  });

  it("rejects when using the wrong secret", () => {
    expect(verifySteadfastWebhookSignature(body, sig, "other-secret")).toBe(false);
  });

  it("rejects empty signature without crashing", () => {
    expect(verifySteadfastWebhookSignature(body, "", secret)).toBe(false);
  });
});

describe("parseSteadfastWebhook", () => {
  it("normalizes a delivered payload", () => {
    const r = parseSteadfastWebhook({
      tracking_code: "SF42",
      status: "Delivered",
      updated_at: "2026-01-01T10:00:00Z",
      note: "Package handed to customer",
    });
    expect(r).not.toBeNull();
    expect(r!.trackingCode).toBe("SF42");
    expect(r!.normalizedStatus).toBe("delivered");
    expect(r!.providerStatus).toBe("Delivered");
    expect(r!.at.toISOString()).toBe("2026-01-01T10:00:00.000Z");
    expect(r!.description).toBe("Package handed to customer");
  });

  it("falls back to consignment_id when tracking_code is absent", () => {
    const r = parseSteadfastWebhook({ consignment_id: 12345, status: "in_transit" });
    expect(r!.trackingCode).toBe("12345");
    expect(r!.normalizedStatus).toBe("in_transit");
  });

  it("returns null when neither tracking_code nor consignment_id is present", () => {
    expect(parseSteadfastWebhook({ status: "test_ping" })).toBeNull();
  });

  it("falls back to now() when updated_at is invalid", () => {
    const before = Date.now();
    const r = parseSteadfastWebhook({
      tracking_code: "SF1",
      status: "delivered",
      updated_at: "not a real date",
    });
    expect(r!.at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("normalizes RTO synonyms", () => {
    expect(parseSteadfastWebhook({ tracking_code: "X", status: "Returned" })!.normalizedStatus)
      .toBe("rto");
    expect(parseSteadfastWebhook({ tracking_code: "X", status: "partial_delivered" })!.normalizedStatus)
      .toBe("delivered");
  });
});

/* -------------------------------------------------------------------------- */
/* DB-backed tests for applyTrackingEvents (the shared helper)                 */
/* -------------------------------------------------------------------------- */

async function makeShippedOrder(merchantId: Types.ObjectId, trackingNumber: string) {
  return Order.create({
    merchantId,
    orderNumber: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    customer: {
      name: "Customer",
      phone: "+8801711111111",
      address: "House 1",
      district: "Dhaka",
    },
    items: [{ name: "Item", quantity: 1, price: 500 }],
    order: { cod: 500, total: 500, status: "shipped" },
    logistics: { courier: "steadfast", trackingNumber },
  });
}

describe("applyTrackingEvents", () => {
  beforeEach(async () => {
    await ensureDb();
    await resetDb();
  });
  afterAll(disconnectDb);

  it("appends a new event and stamps lastWebhookAt when source=webhook", async () => {
    const m = await createMerchant();
    const o = await makeShippedOrder(m._id as Types.ObjectId, "SF-WH-1");

    const before = Date.now();
    const r = await applyTrackingEvents(
      {
        _id: o._id as Types.ObjectId,
        merchantId: o.merchantId as Types.ObjectId,
        order: o.order as never,
        logistics: o.logistics as never,
      },
      "in_transit",
      [{ at: new Date(), providerStatus: "in_transit", description: "out from hub" }],
      { source: "webhook" },
    );

    expect(r.newEvents).toBe(1);
    const refreshed = await Order.findById(o._id).lean();
    expect(refreshed!.logistics?.trackingEvents?.length).toBe(1);
    expect(refreshed!.logistics?.lastWebhookAt!.getTime()).toBeGreaterThanOrEqual(before);
    // Polling timestamp must be untouched on a webhook write.
    expect(refreshed!.logistics?.lastPolledAt).toBeFalsy();
  });

  it("flips order.status on a delivered event and records deliveredAt", async () => {
    const m = await createMerchant();
    const o = await makeShippedOrder(m._id as Types.ObjectId, "SF-WH-DEL");

    const r = await applyTrackingEvents(
      {
        _id: o._id as Types.ObjectId,
        merchantId: o.merchantId as Types.ObjectId,
        order: o.order as never,
        logistics: o.logistics as never,
      },
      "delivered",
      [{ at: new Date(), providerStatus: "Delivered" }],
      { source: "webhook" },
    );

    expect(r.statusTransition).toEqual({ from: "shipped", to: "delivered" });
    const refreshed = await Order.findById(o._id).lean();
    expect(refreshed!.order.status).toBe("delivered");
    expect(refreshed!.logistics?.deliveredAt).toBeTruthy();
  });

  it("is idempotent for replayed events with the same content", async () => {
    const m = await createMerchant();
    const o = await makeShippedOrder(m._id as Types.ObjectId, "SF-WH-DUP");

    const event = { at: new Date(), providerStatus: "in_transit", description: "X" };
    const orderArg = {
      _id: o._id as Types.ObjectId,
      merchantId: o.merchantId as Types.ObjectId,
      order: o.order as never,
      logistics: o.logistics as never,
    };

    const r1 = await applyTrackingEvents(orderArg, "in_transit", [event], { source: "webhook" });
    expect(r1.newEvents).toBe(1);

    // Re-read so the in-memory `logistics.trackingEvents` reflects the first
    // write — the dedupe set is built from the order argument, not the DB.
    const refreshed = await Order.findById(o._id).lean();
    const r2 = await applyTrackingEvents(
      {
        _id: refreshed!._id as Types.ObjectId,
        merchantId: refreshed!.merchantId as Types.ObjectId,
        order: refreshed!.order as never,
        logistics: refreshed!.logistics as never,
      },
      "in_transit",
      [event],
      { source: "webhook" },
    );
    expect(r2.newEvents).toBe(0);

    const final = await Order.findById(o._id).lean();
    expect(final!.logistics?.trackingEvents?.length).toBe(1);
  });

  it("source=poll stamps lastPolledAt and clears pollError, not lastWebhookAt", async () => {
    const m = await createMerchant();
    const o = await makeShippedOrder(m._id as Types.ObjectId, "SF-POLL");
    // simulate prior poll error
    await Order.updateOne(
      { _id: o._id },
      { $set: { "logistics.pollError": "previous", "logistics.pollErrorCount": 3 } },
    );

    const r = await applyTrackingEvents(
      {
        _id: o._id as Types.ObjectId,
        merchantId: o.merchantId as Types.ObjectId,
        order: o.order as never,
        logistics: o.logistics as never,
      },
      "in_transit",
      [{ at: new Date(), providerStatus: "in_transit" }],
      { source: "poll" },
    );

    expect(r.newEvents).toBe(1);
    const refreshed = await Order.findById(o._id).lean();
    expect(refreshed!.logistics?.lastPolledAt).toBeTruthy();
    expect(refreshed!.logistics?.lastWebhookAt).toBeFalsy();
    expect(refreshed!.logistics?.pollError).toBeNull();
    expect(refreshed!.logistics?.pollErrorCount).toBe(0);
  });
});
