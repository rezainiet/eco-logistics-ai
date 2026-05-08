import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { Order, TrackingSession } from "@ecom/db";
import { ingestNormalizedOrder } from "../src/server/ingest.js";
import { scoreIntentForOrder } from "../src/lib/intent.js";
import { ensureDb, disconnectDb, resetDb, createMerchant } from "./helpers.js";
import type { NormalizedOrder } from "../src/lib/integrations/types.js";

/**
 * Passive RTO Engine pipeline integration tests.
 *
 * Verifies:
 *  - Address Intelligence v1 stamps `Order.address.quality` at ingest
 *  - thana extraction stamps `Order.customer.thana` at ingest
 *  - Intent Intelligence v1 stamps `Order.intent` after identity-resolution
 *    when matching TrackingSessions exist
 *  - Intent stamps `no_data` tier when no session matches
 *  - Existing fraud + automation paths are NOT mutated by the new code
 *  - Schema deserializes legacy orders that were created without these
 *    subdocs (forward compatibility)
 */

beforeEach(async () => {
  await ensureDb();
  await resetDb();
});

afterAll(async () => {
  await disconnectDb();
});

function buildNormalized(overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
  return {
    externalId: `ext-${Date.now()}-${Math.random()}`,
    customer: {
      name: "Test Buyer",
      phone: "+8801711111111",
      address: "House 14, Road 7, Block C, Mirpur DOHS, Dhaka",
      district: "Dhaka",
    },
    items: [{ name: "Item", quantity: 1, price: 1000 }],
    cod: 1000,
    total: 1000,
    placedAt: new Date(),
    ...overrides,
  };
}

describe("Address Intelligence v1 — stamped at ingest", () => {
  it("stamps Order.address.quality when env flag is on (default)", async () => {
    const merchant = await createMerchant();
    const result = await ingestNormalizedOrder(buildNormalized(), {
      merchantId: merchant._id,
      source: "dashboard",
      channel: "dashboard",
    });
    expect(result.ok).toBe(true);
    const order = await Order.findById(result.orderId).lean();
    expect(order!.address?.quality).toBeDefined();
    expect(order!.address!.quality!.completeness).toBe("complete");
    expect(order!.address!.quality!.score).toBeGreaterThanOrEqual(70);
    expect(order!.address!.quality!.landmarks).toEqual(
      expect.arrayContaining(["road", "house"]),
    );
    expect(order!.address!.quality!.hasNumber).toBe(true);
  });

  it("stamps customer.thana when address contains a recognizable thana", async () => {
    const merchant = await createMerchant();
    const result = await ingestNormalizedOrder(
      buildNormalized({
        customer: {
          name: "Test Buyer",
          phone: "+8801711111111",
          address: "House 14, Road 7, Dhanmondi, Dhaka",
          district: "Dhaka",
        },
      }),
      { merchantId: merchant._id, source: "dashboard", channel: "dashboard" },
    );
    const order = await Order.findById(result.orderId).lean();
    expect(order!.customer.thana).toBe("dhanmondi");
  });

  it("leaves customer.thana undefined when no thana matches", async () => {
    const merchant = await createMerchant();
    const result = await ingestNormalizedOrder(
      buildNormalized({
        customer: {
          name: "Test Buyer",
          phone: "+8801711111111",
          address: "Some random building, no thana name here",
          district: "Dhaka",
        },
      }),
      { merchantId: merchant._id, source: "dashboard", channel: "dashboard" },
    );
    const order = await Order.findById(result.orderId).lean();
    expect(order!.customer.thana).toBeUndefined();
  });

  it("scores incomplete addresses as 'incomplete' with hints", async () => {
    const merchant = await createMerchant();
    const result = await ingestNormalizedOrder(
      buildNormalized({
        customer: {
          name: "Test Buyer",
          phone: "+8801711111111",
          address: "x y", // too short, too few tokens, no anchor
          district: "Dhaka",
        },
      }),
      { merchantId: merchant._id, source: "dashboard", channel: "dashboard" },
    );
    const order = await Order.findById(result.orderId).lean();
    expect(order!.address?.quality?.completeness).toBe("incomplete");
    expect(order!.address!.quality!.missingHints.length).toBeGreaterThan(0);
  });
});

describe("Intent Intelligence v1 — stamped post-identity-resolution", () => {
  it("scoreIntentForOrder writes 'no_data' tier when no session matches", async () => {
    const merchant = await createMerchant();
    const order = await Order.create({
      merchantId: merchant._id,
      orderNumber: "TEST-1",
      customer: {
        name: "Buyer",
        phone: "+8801711111111",
        address: "House 14, Road 7, Dhanmondi, Dhaka",
        district: "Dhaka",
      },
      items: [{ name: "Item", quantity: 1, price: 1000 }],
      order: { cod: 1000, total: 1000, status: "pending" },
    });

    const r = await scoreIntentForOrder({
      merchantId: merchant._id,
      orderId: order._id as Types.ObjectId,
    });
    expect(r).not.toBeNull();
    expect(r!.tier).toBe("no_data");

    const reloaded = await Order.findById(order._id).lean();
    expect(reloaded!.intent?.tier).toBe("no_data");
    expect(reloaded!.intent?.signals.length).toBeGreaterThan(0);
  });

  it("scoreIntentForOrder reads the stitched session and computes a real tier", async () => {
    const merchant = await createMerchant();

    // Create order first, then plant a TrackingSession resolving to it.
    const order = await Order.create({
      merchantId: merchant._id,
      orderNumber: "TEST-2",
      customer: {
        name: "Buyer",
        phone: "+8801711111111",
        address: "House 14, Road 7, Dhanmondi, Dhaka",
        district: "Dhaka",
      },
      items: [{ name: "Item", quantity: 1, price: 1000 }],
      order: { cod: 1000, total: 1000, status: "pending" },
    });

    // Plant TWO sessions across multiple days so multi_session_converter
    // fires alongside organic_landing — that's the configuration that
    // crosses into the verified band by design.
    const earlier = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const later = new Date();
    await TrackingSession.create({
      merchantId: merchant._id,
      sessionId: "sess-1",
      pageViews: 4,
      productViews: 4,
      checkoutStartCount: 1,
      checkoutSubmitCount: 0,
      maxScrollDepth: 80,
      durationMs: 90_000,
      repeatVisitor: true,
      campaign: { source: "google", medium: "organic" },
      firstSeenAt: earlier,
      lastSeenAt: earlier,
      resolvedOrderId: order._id,
    });
    await TrackingSession.create({
      merchantId: merchant._id,
      sessionId: "sess-2",
      pageViews: 1,
      productViews: 1,
      checkoutStartCount: 1,
      checkoutSubmitCount: 1,
      durationMs: 30_000,
      repeatVisitor: true,
      campaign: { source: "google", medium: "organic" },
      firstSeenAt: later,
      lastSeenAt: later,
      resolvedOrderId: order._id,
    });

    const r = await scoreIntentForOrder({
      merchantId: merchant._id,
      orderId: order._id as Types.ObjectId,
    });
    expect(r).not.toBeNull();
    expect(r!.tier).toBe("verified");
    expect(r!.score).toBeGreaterThanOrEqual(70);

    const reloaded = await Order.findById(order._id).lean();
    expect(reloaded!.intent?.tier).toBe("verified");
    expect(reloaded!.intent?.sessionsConsidered).toBe(2);
  });
});

describe("Schema compatibility — additive only", () => {
  it("an order created WITHOUT intent / address subdocs deserializes cleanly", async () => {
    const merchant = await createMerchant();
    const order = await Order.create({
      merchantId: merchant._id,
      orderNumber: "LEGACY-1",
      customer: {
        name: "Buyer",
        phone: "+8801711111111",
        address: "Some address, Dhaka",
        district: "Dhaka",
      },
      items: [{ name: "Item", quantity: 1, price: 1000 }],
      order: { cod: 1000, total: 1000, status: "pending" },
    });

    const reloaded = await Order.findById(order._id).lean();
    expect(reloaded).not.toBeNull();
    // Subdocs declared with `default: undefined` must not auto-create as `{}`.
    expect(reloaded!.intent).toBeUndefined();
    expect(reloaded!.address).toBeUndefined();
    // customer.thana stays undefined when not set.
    expect(reloaded!.customer.thana).toBeUndefined();
  });

  it("does NOT modify fraud / automation / order.status during stamping", async () => {
    const merchant = await createMerchant();
    const result = await ingestNormalizedOrder(buildNormalized(), {
      merchantId: merchant._id,
      source: "dashboard",
      channel: "dashboard",
    });
    const order = await Order.findById(result.orderId).lean();
    // Fraud subdoc should be untouched by intent / address layers.
    expect(order!.fraud).toBeDefined();
    expect(order!.fraud!.reviewStatus).toBeDefined();
    // Automation subdoc untouched.
    expect(order!.automation).toBeDefined();
    // Order status follows the existing ingest path — `pending` for fresh orders.
    expect(order!.order!.status).toBe("pending");
  });
});
