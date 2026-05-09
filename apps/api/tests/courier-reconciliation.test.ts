import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import {
  AreaReliability,
  COURIER_PERF_GLOBAL_DISTRICT,
  CourierLane,
  CourierPerformance,
  Order,
} from "@ecom/db";
import {
  reconcileAreaReliabilitySlice,
  reconcileCourierLaneSlice,
  reconcileCourierPerformanceSlice,
} from "../src/lib/courier-reconciliation.js";
import { ADDRESS_PIPELINE_VERSION } from "../src/lib/address-canonical.js";
import { disconnectDb, ensureDb, resetDb } from "./helpers.js";

const MERCHANT = new Types.ObjectId("507f1f77bcf86cd799439033");
const NOW = new Date("2026-05-09T12:00:00Z");

async function seedOrder(args: {
  status: "delivered" | "rto" | "cancelled";
  courier: string;
  district: string;
  thana?: string;
  division?: string;
  daysAgo?: number;
}) {
  const terminalAt = new Date(NOW.getTime() - (args.daysAgo ?? 1) * 86400_000);
  await Order.create({
    merchantId: MERCHANT,
    orderNumber: `ON-${Math.random().toString(36).slice(2, 8)}`,
    customer: {
      name: "Buyer",
      phone: "+8801712345678",
      address: "House 1 Road 1",
      district: args.district,
      ...(args.thana ? { thana: args.thana } : {}),
    },
    items: [{ name: "Widget", quantity: 1, price: 100 }],
    order: { cod: 100, total: 100, status: args.status },
    logistics: {
      courier: args.courier,
      ...(args.status === "delivered" ? { deliveredAt: terminalAt } : {}),
      ...(args.status === "rto" ? { returnedAt: terminalAt } : {}),
    },
    ...(args.thana
      ? {
          source: {
            canonicalAddress: {
              thana: args.thana,
              district: args.district.toLowerCase(),
              division: args.division ?? args.district.toLowerCase(),
              pipelineVersion: ADDRESS_PIPELINE_VERSION,
            },
          },
        }
      : {}),
    updatedAt: terminalAt,
    version: 0,
  });
}

describe("courier-reconciliation — reconcileCourierPerformanceSlice", () => {
  beforeAll(ensureDb);
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("clean slice — aggregate matches expected → no drift", async () => {
    // Seed 3 delivered + 1 rto for pathao in dhaka.
    for (let i = 0; i < 3; i++)
      await seedOrder({ status: "delivered", courier: "pathao", district: "dhaka", daysAgo: 5 });
    await seedOrder({ status: "rto", courier: "pathao", district: "dhaka", daysAgo: 5 });

    await CourierPerformance.create({
      merchantId: MERCHANT,
      courier: "pathao",
      district: "dhaka",
      deliveredCount: 3,
      rtoCount: 1,
      cancelledCount: 0,
      lastOutcomeAt: NOW,
    });
    await CourierPerformance.create({
      merchantId: MERCHANT,
      courier: "pathao",
      district: COURIER_PERF_GLOBAL_DISTRICT,
      deliveredCount: 3,
      rtoCount: 1,
      cancelledCount: 0,
      lastOutcomeAt: NOW,
    });

    const r = await reconcileCourierPerformanceSlice({
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(r.driftedKeys).toHaveLength(0);
    expect(r.entries).toHaveLength(2); // district + _GLOBAL_
    for (const e of r.entries) expect(e.driftMagnitude).toBe(0);
  });

  it("flags drift when aggregate undercounts by more than tolerance", async () => {
    for (let i = 0; i < 10; i++)
      await seedOrder({ status: "delivered", courier: "pathao", district: "dhaka", daysAgo: 5 });

    // Aggregate has only 5 delivered — drift of 5
    await CourierPerformance.create({
      merchantId: MERCHANT,
      courier: "pathao",
      district: "dhaka",
      deliveredCount: 5,
      rtoCount: 0,
      cancelledCount: 0,
      lastOutcomeAt: NOW,
    });
    const r = await reconcileCourierPerformanceSlice({
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(r.driftedKeys).toContain("pathao|dhaka");
    const entry = r.entries.find((e) => e.key === "pathao|dhaka")!;
    expect(entry.expected.delivered).toBe(10);
    expect(entry.aggregate.delivered).toBe(5);
    expect(entry.drift.delivered).toBe(5);
  });

  it("filters by courier when supplied", async () => {
    for (let i = 0; i < 3; i++)
      await seedOrder({ status: "delivered", courier: "redx", district: "dhaka", daysAgo: 5 });

    await CourierPerformance.create({
      merchantId: MERCHANT,
      courier: "pathao",
      district: "dhaka",
      deliveredCount: 99,
      rtoCount: 0,
      cancelledCount: 0,
    });
    await CourierPerformance.create({
      merchantId: MERCHANT,
      courier: "redx",
      district: "dhaka",
      deliveredCount: 3,
      rtoCount: 0,
      cancelledCount: 0,
    });

    const r = await reconcileCourierPerformanceSlice({
      merchantId: MERCHANT,
      courier: "redx",
      now: NOW,
    });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.key).toBe("redx|dhaka");
    expect(r.driftedKeys).toHaveLength(0);
  });
});

describe("courier-reconciliation — reconcileCourierLaneSlice", () => {
  beforeAll(ensureDb);
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("matches aggregate to terminal orders by (courier, district, thana)", async () => {
    for (let i = 0; i < 5; i++)
      await seedOrder({
        status: "delivered",
        courier: "pathao",
        district: "Dhaka",
        thana: "dhanmondi",
        daysAgo: 3,
      });
    await seedOrder({
      status: "rto",
      courier: "pathao",
      district: "Dhaka",
      thana: "dhanmondi",
      daysAgo: 2,
    });

    await CourierLane.create({
      merchantId: MERCHANT,
      courier: "pathao",
      district: "dhaka",
      thana: "dhanmondi",
      deliveredCount: 5,
      rtoCount: 1,
      cancelledCount: 0,
      pipelineVersion: ADDRESS_PIPELINE_VERSION,
      firstOutcomeAt: new Date(NOW.getTime() - 10 * 86400_000),
    });

    const r = await reconcileCourierLaneSlice({
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(r.entries).toHaveLength(1);
    expect(r.driftedKeys).toHaveLength(0);
  });

  it("drift surfaces when CourierLane undercounts vs orders", async () => {
    for (let i = 0; i < 8; i++)
      await seedOrder({
        status: "delivered",
        courier: "pathao",
        district: "Dhaka",
        thana: "dhanmondi",
        daysAgo: 2,
      });
    await CourierLane.create({
      merchantId: MERCHANT,
      courier: "pathao",
      district: "dhaka",
      thana: "dhanmondi",
      deliveredCount: 4, // drift of 4
      rtoCount: 0,
      cancelledCount: 0,
      pipelineVersion: ADDRESS_PIPELINE_VERSION,
      firstOutcomeAt: new Date(NOW.getTime() - 5 * 86400_000),
    });
    const r = await reconcileCourierLaneSlice({
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(r.driftedKeys).toContain("pathao|dhaka|dhanmondi");
  });

  it("respects per-lane firstOutcomeAt window — pre-flag orders are NOT drift", async () => {
    // Lane was first observed only 2 days ago; an order from 5 days ago
    // is pre-flag and must NOT count toward drift.
    await CourierLane.create({
      merchantId: MERCHANT,
      courier: "pathao",
      district: "dhaka",
      thana: "dhanmondi",
      deliveredCount: 1,
      rtoCount: 0,
      cancelledCount: 0,
      pipelineVersion: ADDRESS_PIPELINE_VERSION,
      firstOutcomeAt: new Date(NOW.getTime() - 2 * 86400_000),
    });
    // Order from 5 days ago — pre-flag.
    await seedOrder({
      status: "delivered",
      courier: "pathao",
      district: "Dhaka",
      thana: "dhanmondi",
      daysAgo: 5,
    });
    // Order from 1 day ago — in window.
    await seedOrder({
      status: "delivered",
      courier: "pathao",
      district: "Dhaka",
      thana: "dhanmondi",
      daysAgo: 1,
    });
    const r = await reconcileCourierLaneSlice({
      merchantId: MERCHANT,
      now: NOW,
    });
    const entry = r.entries[0]!;
    expect(entry.expected.delivered).toBe(1); // only the in-window order
    expect(entry.aggregate.delivered).toBe(1);
    expect(entry.driftMagnitude).toBe(0);
  });
});

describe("courier-reconciliation — reconcileAreaReliabilitySlice", () => {
  beforeAll(ensureDb);
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("matches aggregate to terminal orders by (division, district, thana)", async () => {
    for (let i = 0; i < 4; i++)
      await seedOrder({
        status: "delivered",
        courier: "pathao",
        district: "Dhaka",
        thana: "dhanmondi",
        division: "dhaka",
        daysAgo: 2,
      });
    await seedOrder({
      status: "rto",
      courier: "pathao",
      district: "Dhaka",
      thana: "dhanmondi",
      division: "dhaka",
      daysAgo: 1,
    });

    await AreaReliability.create({
      merchantId: MERCHANT,
      division: "dhaka",
      district: "dhaka",
      thana: "dhanmondi",
      deliveredCount: 4,
      rtoCount: 1,
      cancelledCount: 0,
      pipelineVersion: ADDRESS_PIPELINE_VERSION,
      firstOutcomeAt: new Date(NOW.getTime() - 5 * 86400_000),
      recent7dWindowStartedAt: new Date(NOW.getTime() - 5 * 86400_000),
    });

    const r = await reconcileAreaReliabilitySlice({
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(r.entries).toHaveLength(1);
    expect(r.driftedKeys).toHaveLength(0);
  });

  it("drift surfaces when area undercounts", async () => {
    for (let i = 0; i < 6; i++)
      await seedOrder({
        status: "delivered",
        courier: "pathao",
        district: "Dhaka",
        thana: "dhanmondi",
        division: "dhaka",
        daysAgo: 2,
      });
    await AreaReliability.create({
      merchantId: MERCHANT,
      division: "dhaka",
      district: "dhaka",
      thana: "dhanmondi",
      deliveredCount: 1,
      rtoCount: 0,
      cancelledCount: 0,
      pipelineVersion: ADDRESS_PIPELINE_VERSION,
      firstOutcomeAt: new Date(NOW.getTime() - 5 * 86400_000),
      recent7dWindowStartedAt: new Date(NOW.getTime() - 5 * 86400_000),
    });
    const r = await reconcileAreaReliabilitySlice({
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(r.driftedKeys).toContain("dhaka|dhaka|dhanmondi");
  });

  it("returns empty (no entries) when merchant has no aggregates", async () => {
    const r = await reconcileAreaReliabilitySlice({
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(r.entries).toHaveLength(0);
    expect(r.driftedKeys).toHaveLength(0);
  });
});
