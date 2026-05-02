import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { MAX_TRACKING_EVENTS, Order } from "@ecom/db";
import { applyTrackingEvents } from "../src/server/tracking.js";
import { createMerchant, disconnectDb, resetDb } from "./helpers.js";

/**
 * Scaling-quality tests — index coverage, document-size caps, fairness.
 * Whole point of these is to catch regressions where someone reverts an
 * `$slice` or drops a compound index without realising the query planner
 * collapsed back to a collscan.
 */

describe("index coverage", () => {
  beforeEach(async () => {
    await resetDb();
    // resetDb wipes documents but preserves the schema-declared indexes
    // mongoose registered at boot. autoIndex is async though, so on a
    // fresh in-memory instance the SORT may still race the index build —
    // syncIndexes blocks until they're up-to-date.
    await Order.syncIndexes();
  });
  afterAll(disconnectDb);

  it("fraud queue list uses the (reviewStatus, riskScore, _id) index — no in-memory sort", async () => {
    const m = await createMerchant({ tier: "growth" });
    // Seed a handful of pending_call orders with varied scores so the planner
    // has to actually traverse the index.
    for (let i = 0; i < 8; i++) {
      await Order.create({
        merchantId: m._id,
        orderNumber: `Q-${i}`,
        customer: {
          name: "Buyer",
          phone: `+88017000000${String(i).padStart(2, "0")}`,
          address: "X",
          district: "Dhaka",
        },
        items: [{ name: "X", quantity: 1, price: 100 }],
        order: { cod: 100, total: 100, status: "pending" },
        fraud: { reviewStatus: "pending_call", riskScore: 50 + i },
      });
    }
    const exp = await Order.find({
      merchantId: m._id,
      "fraud.reviewStatus": "pending_call",
    })
      .sort({ "fraud.riskScore": -1, _id: -1 })
      .explain("queryPlanner");
    const winning = (exp as { queryPlanner?: { winningPlan?: unknown } })
      ?.queryPlanner?.winningPlan as Record<string, unknown> | undefined;
    const planJson = JSON.stringify(winning ?? {});
    expect(planJson).toContain("IXSCAN");
    expect(planJson).not.toContain("SORT");
  });

  it("courier-filtered listOrders uses the (logistics.courier, order.status) index", async () => {
    const m = await createMerchant({ tier: "growth" });
    for (let i = 0; i < 5; i++) {
      await Order.create({
        merchantId: m._id,
        orderNumber: `C-${i}`,
        customer: {
          name: "B",
          phone: `+88017111111${String(i).padStart(2, "0")}`,
          address: "X",
          district: "Dhaka",
        },
        items: [{ name: "X", quantity: 1, price: 100 }],
        order: { cod: 100, total: 100, status: "shipped" },
        logistics: { courier: "pathao", trackingNumber: `T-${i}` },
      });
    }
    const exp = await Order.find({
      merchantId: m._id,
      "logistics.courier": "pathao",
      "order.status": "shipped",
    })
      .sort({ _id: -1 })
      .explain("queryPlanner");
    const winning = (exp as { queryPlanner?: { winningPlan?: unknown } })
      ?.queryPlanner?.winningPlan as Record<string, unknown> | undefined;
    const planJson = JSON.stringify(winning ?? {});
    expect(planJson).toContain("IXSCAN");
    expect(planJson).not.toContain("COLLSCAN");
  });

  it("status + date-range listOrders uses (merchantId, order.status, createdAt:-1) — IXSCAN, no SORT, no COLLSCAN", async () => {
    // The audit's first scaling cliff: dashboard listings filtered by status
    // with a date range. Old index put createdAt before status, so the
    // planner had to scan the entire date window and filter status in
    // memory once a merchant grew past ~50k orders/window. New ESR-ordered
    // index makes status the first key after merchantId, then createdAt:-1
    // serves both the sort and the range — no fetch-and-filter, no
    // in-memory sort.
    const m = await createMerchant({ tier: "growth" });
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      // Stagger timestamps so the createdAt range filter is meaningful.
      const stamp = new Date(now - i * 60_000);
      const status = i % 2 === 0 ? "shipped" : "pending";
      await Order.create({
        merchantId: m._id,
        orderNumber: `S-${i}`,
        customer: {
          name: "B",
          phone: `+88017222222${String(i).padStart(2, "0")}`,
          address: "X",
          district: "Dhaka",
        },
        items: [{ name: "X", quantity: 1, price: 100 }],
        order: { cod: 100, total: 100, status },
        createdAt: stamp,
      });
    }

    const dateFrom = new Date(now - 30 * 60_000);
    const dateTo = new Date(now);
    const exp = (await Order.find({
      merchantId: m._id,
      "order.status": "shipped",
      createdAt: { $gte: dateFrom, $lte: dateTo },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .explain("queryPlanner")) as {
      queryPlanner?: {
        winningPlan?: unknown;
        rejectedPlans?: unknown[];
      };
    };

    const winning = exp.queryPlanner?.winningPlan as Record<string, unknown> | undefined;
    const planJson = JSON.stringify(winning ?? {});

    // Surface the chosen index + plan so the test output IS the explain
    // output the user asked for.
    // eslint-disable-next-line no-console
    console.log(
      "[explain] listOrders status+date winningPlan:",
      JSON.stringify(winning, null, 2),
    );

    expect(planJson).toContain("IXSCAN");
    expect(planJson).not.toContain("COLLSCAN");
    // No in-memory sort — the index supplies createdAt order.
    expect(planJson).not.toContain("SORT");
    // Plan must reference the new index by its key shape, not the legacy
    // (createdAt-before-status) one.
    expect(planJson).toContain("order.status");
    expect(planJson).toContain("createdAt");
  });

  it("the legacy (merchantId, createdAt:-1, order.status) index is NOT defined in-schema", async () => {
    // Regression guard: the schema must not silently re-introduce the old
    // index. Match by KEY ORDER (JSON.stringify preserves insertion order
    // on V8), not just key presence — the new index has the same three
    // keys in a different order, and that order is exactly what matters
    // for ESR. (A live DB may still have the old index from before the
    // migration drop; db.ts:dropLegacyOrderListingIndex handles that.)
    const indexes = Order.schema.indexes();
    const legacyShape = JSON.stringify({
      merchantId: 1,
      createdAt: -1,
      "order.status": 1,
    });
    const legacy = indexes.find(([key]) => JSON.stringify(key) === legacyShape);
    expect(legacy).toBeUndefined();

    // And confirm the NEW shape IS present.
    const newShape = JSON.stringify({
      merchantId: 1,
      "order.status": 1,
      createdAt: -1,
    });
    const present = indexes.find(([key]) => JSON.stringify(key) === newShape);
    expect(present).toBeDefined();
  });
});

describe("trackingEvents $slice cap", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("caps the array at MAX_TRACKING_EVENTS even after >100 pushes", async () => {
    const m = await createMerchant({ tier: "growth" });
    const order = await Order.create({
      merchantId: m._id,
      orderNumber: "T-1",
      customer: { name: "B", phone: "+8801712345678", address: "X", district: "Dhaka" },
      items: [{ name: "X", quantity: 1, price: 100 }],
      order: { cod: 100, total: 100, status: "shipped" },
      logistics: { trackingNumber: "TN-1", courier: "pathao" },
    });

    // Push 150 distinct events one at a time so dedupe doesn't collapse them.
    for (let i = 0; i < 150; i++) {
      await applyTrackingEvents(
        order as never,
        "in_transit",
        [
          {
            providerStatus: `step-${i}`,
            description: `event ${i}`,
            location: `Hub-${i}`,
            at: new Date(Date.now() + i * 1000),
          },
        ],
        { source: "webhook" },
      );
    }

    const after = await Order.findById(order._id).lean();
    const events = after?.logistics?.trackingEvents ?? [];
    expect(events.length).toBe(MAX_TRACKING_EVENTS);
    // The newest 100 are kept — first one in the array should be event 50.
    expect(events[0]!.providerStatus).toBe("step-50");
    expect(events[events.length - 1]!.providerStatus).toBe("step-149");
  });
});

describe("per-merchant token bucket (best-effort, no Redis in tests)", () => {
  it("fails open when Redis is unavailable so dev/test environments aren't blocked", async () => {
    const { consumeMerchantTokens } = await import("../src/lib/merchantRateLimit.js");
    // No REDIS_URL in the test env → getRedis() throws → bucket fails open.
    const result = await consumeMerchantTokens(
      "webhook-process",
      String(new Types.ObjectId()),
    );
    expect(result.allowed).toBe(true);
  });

  it("DEFAULT_BUCKET_BUDGETS publishes per-queue capacities + refill rates", async () => {
    const { DEFAULT_BUCKET_BUDGETS } = await import("../src/lib/merchantRateLimit.js");
    expect(DEFAULT_BUCKET_BUDGETS["webhook-process"]?.capacity).toBeGreaterThan(0);
    expect(DEFAULT_BUCKET_BUDGETS["automation-sms"]?.refillPerSecond).toBeGreaterThan(0);
    expect(DEFAULT_BUCKET_BUDGETS.default!.capacity).toBeGreaterThan(0);
  });
});
