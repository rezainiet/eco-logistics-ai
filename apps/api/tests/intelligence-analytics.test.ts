import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { Order, TrackingSession } from "@ecom/db";
import {
  ensureDb,
  disconnectDb,
  resetDb,
  createMerchant,
  callerFor,
  authUserFor,
} from "./helpers.js";

/**
 * RTO Intelligence Dashboard v1 — analytics aggregation tests.
 *
 * Verifies:
 *  - Each procedure returns the expected bucket shape across known order
 *    distributions.
 *  - Resolved-vs-inflight rate computation (in-flight orders excluded from
 *    rate denominator).
 *  - Null/legacy compatibility — orders without intent / address.quality /
 *    customer.thana don't crash and aren't mis-bucketed.
 *  - Merchant scoping — another merchant's orders never leak into the
 *    aggregate.
 *  - Time-window bound — orders outside the window aren't counted.
 *  - Two-stage join correctness for campaign + repeat-visitor procedures.
 *  - Empty / no-data dataset returns well-formed response (no crashes).
 */

beforeEach(async () => {
  await ensureDb();
  await resetDb();
});

afterAll(async () => {
  await disconnectDb();
});

interface SeedOrderArgs {
  merchantId: Types.ObjectId;
  status?: string;
  intentTier?: "verified" | "implicit" | "unverified" | "no_data";
  addressCompleteness?: "complete" | "partial" | "incomplete";
  thana?: string;
  createdAt?: Date;
}

let orderCounter = 0;

async function seedOrder(args: SeedOrderArgs) {
  orderCounter += 1;
  const order = await Order.create({
    merchantId: args.merchantId,
    orderNumber: `T-${args.merchantId.toString().slice(-4)}-${orderCounter}`,
    customer: {
      name: "Buyer",
      phone: "+8801711111111",
      address: "House 14, Road 7, Dhaka",
      district: "Dhaka",
      ...(args.thana ? { thana: args.thana } : {}),
    },
    items: [{ name: "Item", quantity: 1, price: 1000 }],
    order: { cod: 1000, total: 1000, status: args.status ?? "pending" },
    ...(args.intentTier
      ? {
          intent: {
            score: 50,
            tier: args.intentTier,
            signals: [],
            sessionsConsidered: 0,
            computedAt: new Date(),
          },
        }
      : {}),
    ...(args.addressCompleteness
      ? {
          address: {
            quality: {
              score: 60,
              completeness: args.addressCompleteness,
              landmarks: [],
              hasNumber: true,
              tokenCount: 5,
              scriptMix: "latin",
              missingHints: [],
              computedAt: new Date(),
            },
          },
        }
      : {}),
  });
  if (args.createdAt) {
    // Bypass Mongoose middleware (timestamps plugin would reset our backdate)
    // by going through the raw driver collection.
    await Order.collection.updateOne(
      { _id: order._id },
      { $set: { createdAt: args.createdAt } },
    );
  }
  return order;
}

describe("intentDistribution", () => {
  it("buckets orders by intent.tier × order.status; excludes in-flight from rates", async () => {
    const merchant = await createMerchant();
    // 3 verified-tier orders: 2 delivered, 1 RTO → deliveredRate 2/3, rtoRate 1/3
    await seedOrder({ merchantId: merchant._id, intentTier: "verified", status: "delivered" });
    await seedOrder({ merchantId: merchant._id, intentTier: "verified", status: "delivered" });
    await seedOrder({ merchantId: merchant._id, intentTier: "verified", status: "rto" });
    // 2 unverified-tier orders: both in-flight (pending) — resolved=0 → rates null
    await seedOrder({ merchantId: merchant._id, intentTier: "unverified", status: "pending" });
    await seedOrder({ merchantId: merchant._id, intentTier: "unverified", status: "confirmed" });

    const caller = callerFor(authUserFor(merchant));
    const r = await caller.analytics.intentDistribution({ days: 30 });

    expect(r.windowDays).toBe(30);
    expect(r.totalOrders).toBe(5);

    const verified = r.buckets.find((b) => b.tier === "verified")!;
    expect(verified.total).toBe(3);
    expect(verified.delivered).toBe(2);
    expect(verified.rto).toBe(1);
    expect(verified.resolved).toBe(3);
    expect(verified.deliveredRate).toBeCloseTo(2 / 3);
    expect(verified.rtoRate).toBeCloseTo(1 / 3);

    const unverified = r.buckets.find((b) => b.tier === "unverified")!;
    expect(unverified.total).toBe(2);
    expect(unverified.inFlight).toBe(2);
    expect(unverified.resolved).toBe(0);
    expect(unverified.deliveredRate).toBeNull();
    expect(unverified.rtoRate).toBeNull();
  });

  it("excludes orders without an intent subdoc (legacy compatibility)", async () => {
    const merchant = await createMerchant();
    await seedOrder({ merchantId: merchant._id, intentTier: "verified", status: "delivered" });
    await seedOrder({ merchantId: merchant._id, status: "delivered" }); // no intent

    const caller = callerFor(authUserFor(merchant));
    const r = await caller.analytics.intentDistribution({ days: 30 });

    expect(r.totalOrders).toBe(1);
    const verified = r.buckets.find((b) => b.tier === "verified")!;
    expect(verified.total).toBe(1);
  });

  it("returns well-formed empty response when no orders exist", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    const r = await caller.analytics.intentDistribution({ days: 30 });
    expect(r.totalOrders).toBe(0);
    expect(r.buckets).toHaveLength(4);
    for (const b of r.buckets) {
      expect(b.total).toBe(0);
      expect(b.deliveredRate).toBeNull();
      expect(b.rtoRate).toBeNull();
    }
  });

  it("does not leak another merchant's data", async () => {
    const a = await createMerchant({ email: "a@a.com" });
    const b = await createMerchant({ email: "b@b.com" });
    await seedOrder({ merchantId: a._id, intentTier: "verified", status: "delivered" });
    await seedOrder({ merchantId: b._id, intentTier: "verified", status: "delivered" });

    const aCaller = callerFor(authUserFor(a));
    const aResult = await aCaller.analytics.intentDistribution({ days: 30 });
    expect(aResult.totalOrders).toBe(1);
  });

  it("excludes orders outside the time window", async () => {
    const merchant = await createMerchant();
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    await seedOrder({
      merchantId: merchant._id,
      intentTier: "verified",
      status: "delivered",
      createdAt: old,
    });
    await seedOrder({
      merchantId: merchant._id,
      intentTier: "verified",
      status: "delivered",
    });

    const caller = callerFor(authUserFor(merchant));
    // 30-day window should NOT include the 60-day-old order
    const r = await caller.analytics.intentDistribution({ days: 30 });
    expect(r.totalOrders).toBe(1);
    // 90-day window includes both
    const r90 = await caller.analytics.intentDistribution({ days: 90 });
    expect(r90.totalOrders).toBe(2);
  });
});

describe("addressQualityDistribution", () => {
  it("buckets by address.quality.completeness × status with rates", async () => {
    const merchant = await createMerchant();
    await seedOrder({
      merchantId: merchant._id,
      addressCompleteness: "complete",
      status: "delivered",
    });
    await seedOrder({
      merchantId: merchant._id,
      addressCompleteness: "complete",
      status: "delivered",
    });
    await seedOrder({
      merchantId: merchant._id,
      addressCompleteness: "incomplete",
      status: "rto",
    });
    await seedOrder({
      merchantId: merchant._id,
      addressCompleteness: "incomplete",
      status: "rto",
    });
    await seedOrder({
      merchantId: merchant._id,
      addressCompleteness: "incomplete",
      status: "delivered",
    });

    const caller = callerFor(authUserFor(merchant));
    const r = await caller.analytics.addressQualityDistribution({ days: 30 });

    expect(r.totalOrders).toBe(5);
    const complete = r.buckets.find((b) => b.completeness === "complete")!;
    expect(complete.total).toBe(2);
    expect(complete.delivered).toBe(2);
    expect(complete.deliveredRate).toBe(1);
    expect(complete.rtoRate).toBe(0);

    const incomplete = r.buckets.find((b) => b.completeness === "incomplete")!;
    expect(incomplete.total).toBe(3);
    expect(incomplete.rto).toBe(2);
    expect(incomplete.delivered).toBe(1);
    expect(incomplete.rtoRate).toBeCloseTo(2 / 3);
  });

  it("ignores legacy orders without address.quality", async () => {
    const merchant = await createMerchant();
    await seedOrder({ merchantId: merchant._id, addressCompleteness: "complete" });
    await seedOrder({ merchantId: merchant._id }); // legacy
    await seedOrder({ merchantId: merchant._id }); // legacy

    const caller = callerFor(authUserFor(merchant));
    const r = await caller.analytics.addressQualityDistribution({ days: 30 });
    expect(r.totalOrders).toBe(1);
  });
});

describe("topThanas", () => {
  it("ranks thanas by total volume with resolved/in-flight breakdown", async () => {
    const merchant = await createMerchant();
    // dhanmondi: 5 orders → biggest
    for (let i = 0; i < 3; i++)
      await seedOrder({ merchantId: merchant._id, thana: "dhanmondi", status: "delivered" });
    await seedOrder({ merchantId: merchant._id, thana: "dhanmondi", status: "rto" });
    await seedOrder({ merchantId: merchant._id, thana: "dhanmondi", status: "pending" });
    // mirpur: 2 orders
    await seedOrder({ merchantId: merchant._id, thana: "mirpur", status: "delivered" });
    await seedOrder({ merchantId: merchant._id, thana: "mirpur", status: "rto" });

    const caller = callerFor(authUserFor(merchant));
    const r = await caller.analytics.topThanas({ days: 30, limit: 10 });

    expect(r.thanas[0]!.thana).toBe("dhanmondi");
    expect(r.thanas[0]!.total).toBe(5);
    expect(r.thanas[0]!.delivered).toBe(3);
    expect(r.thanas[0]!.rto).toBe(1);
    expect(r.thanas[0]!.inFlight).toBe(1);
    expect(r.thanas[0]!.resolved).toBe(4);
    expect(r.thanas[0]!.deliveredRate).toBeCloseTo(3 / 4);
    expect(r.thanas[0]!.rtoRate).toBeCloseTo(1 / 4);
    expect(r.thanas[0]!.pendingRate).toBeCloseTo(1 / 5);

    expect(r.thanas[1]!.thana).toBe("mirpur");
    expect(r.thanas[1]!.total).toBe(2);
  });

  it("respects limit", async () => {
    const merchant = await createMerchant();
    for (const t of ["a", "b", "c", "d", "e"]) {
      await seedOrder({ merchantId: merchant._id, thana: t });
    }
    const caller = callerFor(authUserFor(merchant));
    const r = await caller.analytics.topThanas({ days: 30, limit: 3 });
    expect(r.thanas).toHaveLength(3);
  });

  it("ignores orders without a thana stamp", async () => {
    const merchant = await createMerchant();
    await seedOrder({ merchantId: merchant._id, thana: "dhanmondi" });
    await seedOrder({ merchantId: merchant._id }); // no thana
    const caller = callerFor(authUserFor(merchant));
    const r = await caller.analytics.topThanas({ days: 30, limit: 10 });
    expect(r.thanas).toHaveLength(1);
    expect(r.thanas[0]!.thana).toBe("dhanmondi");
  });
});

describe("campaignSourceOutcomes", () => {
  it("attributes orders by their resolved session's campaign", async () => {
    const merchant = await createMerchant();

    const orderA = await seedOrder({ merchantId: merchant._id, status: "delivered" });
    const orderB = await seedOrder({ merchantId: merchant._id, status: "rto" });
    const orderC = await seedOrder({ merchantId: merchant._id, status: "delivered" });
    const orderD = await seedOrder({ merchantId: merchant._id, status: "delivered" });

    await TrackingSession.create({
      merchantId: merchant._id,
      sessionId: "s-a",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      campaign: { source: "google", medium: "organic" },
      resolvedOrderId: orderA._id,
    });
    await TrackingSession.create({
      merchantId: merchant._id,
      sessionId: "s-b",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      campaign: { source: "facebook", medium: "cpc" },
      resolvedOrderId: orderB._id,
    });
    await TrackingSession.create({
      merchantId: merchant._id,
      sessionId: "s-c",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      // No campaign captured but session exists → "direct"
      resolvedOrderId: orderC._id,
    });
    // orderD has no session → "no_session"

    const caller = callerFor(authUserFor(merchant));
    const r = await caller.analytics.campaignSourceOutcomes({ days: 30 });

    expect(r.totalOrders).toBe(4);
    const organic = r.buckets.find((b) => b.source === "organic")!;
    expect(organic.total).toBe(1);
    expect(organic.delivered).toBe(1);

    const paid = r.buckets.find((b) => b.source === "paid_social")!;
    expect(paid.total).toBe(1);
    expect(paid.rto).toBe(1);

    const direct = r.buckets.find((b) => b.source === "direct")!;
    expect(direct.total).toBe(1);

    const noSession = r.buckets.find((b) => b.source === "no_session")!;
    expect(noSession.total).toBe(1);
  });

  it("returns well-formed buckets when no orders exist", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    const r = await caller.analytics.campaignSourceOutcomes({ days: 30 });
    expect(r.totalOrders).toBe(0);
    expect(r.buckets).toHaveLength(5);
  });
});

describe("repeatVisitorOutcomes", () => {
  it("buckets orders into repeat / first_time / no_session", async () => {
    const merchant = await createMerchant();

    const repeatOrder = await seedOrder({ merchantId: merchant._id, status: "delivered" });
    const firstOrder = await seedOrder({ merchantId: merchant._id, status: "rto" });
    await seedOrder({ merchantId: merchant._id, status: "delivered" }); // no session

    await TrackingSession.create({
      merchantId: merchant._id,
      sessionId: "s-rep",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      repeatVisitor: true,
      resolvedOrderId: repeatOrder._id,
    });
    await TrackingSession.create({
      merchantId: merchant._id,
      sessionId: "s-first",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      repeatVisitor: false,
      resolvedOrderId: firstOrder._id,
    });

    const caller = callerFor(authUserFor(merchant));
    const r = await caller.analytics.repeatVisitorOutcomes({ days: 30 });

    expect(r.totalOrders).toBe(3);
    const repeat = r.buckets.find((b) => b.kind === "repeat")!;
    expect(repeat.total).toBe(1);
    expect(repeat.delivered).toBe(1);

    const first = r.buckets.find((b) => b.kind === "first_time")!;
    expect(first.total).toBe(1);
    expect(first.rto).toBe(1);

    const none = r.buckets.find((b) => b.kind === "no_session")!;
    expect(none.total).toBe(1);
  });
});

describe("input validation + safety", () => {
  it("rejects days < 1 and days > 90 (window-bound safety)", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    await expect(
      caller.analytics.intentDistribution({ days: 0 } as never),
    ).rejects.toThrow();
    await expect(
      caller.analytics.intentDistribution({ days: 91 } as never),
    ).rejects.toThrow();
  });

  it("rejects topThanas limit > 50 (cap on result-set size)", async () => {
    const merchant = await createMerchant();
    const caller = callerFor(authUserFor(merchant));
    await expect(
      caller.analytics.topThanas({ days: 30, limit: 100 } as never),
    ).rejects.toThrow();
  });

  it("uses default 30-day window when no input is provided", async () => {
    const merchant = await createMerchant();
    await seedOrder({ merchantId: merchant._id, intentTier: "verified", status: "delivered" });
    const caller = callerFor(authUserFor(merchant));
    const r = await caller.analytics.intentDistribution();
    expect(r.windowDays).toBe(30);
    expect(r.totalOrders).toBe(1);
  });
});
