import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AreaReliability, CourierLane, type CourierLane as CourierLaneDoc } from "@ecom/db";
import {
  recordAreaOutcome,
  recordCourierLaneOutcome,
} from "../src/lib/courier-lane-writers.js";
import { ADDRESS_PIPELINE_VERSION } from "../src/lib/address-canonical.js";
import { Types } from "mongoose";
import { disconnectDb, ensureDb, resetDb } from "./helpers.js";

const MERCHANT = new Types.ObjectId("507f1f77bcf86cd799439011");

describe("courier-lane-writers — recordCourierLaneOutcome", () => {
  beforeAll(ensureDb);
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("upserts a fresh CourierLane row with first/lastOutcomeAt + pipelineVersion", async () => {
    const now = new Date("2026-05-09T10:00:00Z");
    await recordCourierLaneOutcome({
      merchantId: MERCHANT,
      courier: "Pathao",
      district: "Dhaka",
      thana: "dhanmondi",
      outcome: "delivered",
      deliveryHours: 12,
      attemptIndex: 1,
      now,
    });

    const row = (await CourierLane.findOne({}).lean()) as CourierLaneDoc | null;
    expect(row).not.toBeNull();
    expect(row!.courier).toBe("pathao");
    expect(row!.district).toBe("dhaka");
    expect(row!.thana).toBe("dhanmondi");
    expect(row!.deliveredCount).toBe(1);
    expect(row!.totalDeliveryHours).toBe(12);
    expect(row!.attempt1Delivered).toBe(1);
    expect(row!.attempt2Delivered).toBe(0);
    expect(row!.attempt3PlusDelivered).toBe(0);
    expect(row!.firstOutcomeAt?.toISOString()).toBe(now.toISOString());
    expect(row!.lastOutcomeAt?.toISOString()).toBe(now.toISOString());
    expect(row!.pipelineVersion).toBe(ADDRESS_PIPELINE_VERSION);
  });

  it("subsequent writes accumulate counters and advance lastOutcomeAt monotonically", async () => {
    const t1 = new Date("2026-05-09T10:00:00Z");
    const t2 = new Date("2026-05-09T11:00:00Z");
    const t0 = new Date("2026-05-09T08:00:00Z");
    for (const [t, outcome] of [
      [t1, "delivered"],
      [t2, "rto"],
      [t0, "delivered"], // out-of-order — must NOT pull lastOutcomeAt back
    ] as const) {
      await recordCourierLaneOutcome({
        merchantId: MERCHANT,
        courier: "pathao",
        district: "dhaka",
        thana: "dhanmondi",
        outcome,
        attemptIndex: 1,
        now: t,
      });
    }
    const row = (await CourierLane.findOne({}).lean()) as CourierLaneDoc | null;
    expect(row!.deliveredCount).toBe(2);
    expect(row!.rtoCount).toBe(1);
    // $max — never pulled back by the out-of-order write.
    expect(row!.lastOutcomeAt?.toISOString()).toBe(t2.toISOString());
  });

  it("buckets attempt indices: 1, 2, 3+ correctly", async () => {
    const now = new Date();
    for (const idx of [1, 2, 3, 4] as const) {
      await recordCourierLaneOutcome({
        merchantId: MERCHANT,
        courier: "pathao",
        district: "dhaka",
        thana: "dhanmondi",
        outcome: "delivered",
        attemptIndex: idx > 3 ? 3 : (idx as 1 | 2 | 3),
        now,
      });
    }
    const row = (await CourierLane.findOne({}).lean()) as CourierLaneDoc | null;
    expect(row!.attempt1Delivered).toBe(1);
    expect(row!.attempt2Delivered).toBe(1);
    expect(row!.attempt3PlusDelivered).toBe(2); // attempt 3 + attempt-clamped-to-3
  });

  it("cancelled outcomes do NOT increment per-attempt counters (no rider engaged)", async () => {
    await recordCourierLaneOutcome({
      merchantId: MERCHANT,
      courier: "pathao",
      district: "dhaka",
      thana: "dhanmondi",
      outcome: "cancelled",
      attemptIndex: 1,
      now: new Date(),
    });
    const row = (await CourierLane.findOne({}).lean()) as CourierLaneDoc | null;
    expect(row!.cancelledCount).toBe(1);
    expect(row!.attempt1Delivered).toBe(0);
    expect(row!.attempt1Rto).toBe(0);
  });

  it("requires thana — skips silently when missing", async () => {
    await recordCourierLaneOutcome({
      merchantId: MERCHANT,
      courier: "pathao",
      district: "dhaka",
      thana: "",
      outcome: "delivered",
      now: new Date(),
    });
    expect(await CourierLane.countDocuments({})).toBe(0);
  });

  it("normalizes district aliases (CTG → chittagong)", async () => {
    await recordCourierLaneOutcome({
      merchantId: MERCHANT,
      courier: "redx",
      district: "CTG",
      thana: "panchlaish",
      outcome: "delivered",
      now: new Date(),
    });
    const row = (await CourierLane.findOne({}).lean()) as CourierLaneDoc | null;
    expect(row!.district).toBe("chittagong");
  });
});

describe("courier-lane-writers — recordAreaOutcome", () => {
  beforeAll(ensureDb);
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("seeds first/lastOutcomeAt + recent7dWindowStartedAt on first write", async () => {
    const now = new Date("2026-05-09T10:00:00Z");
    await recordAreaOutcome({
      merchantId: MERCHANT,
      division: "dhaka",
      district: "dhaka",
      thana: "dhanmondi",
      outcome: "delivered",
      now,
    });
    const row = await AreaReliability.findOne({}).lean();
    expect(row).not.toBeNull();
    expect(row!.deliveredCount).toBe(1);
    expect(row!.recent7dDelivered).toBe(1);
    expect(row!.firstOutcomeAt?.toISOString()).toBe(now.toISOString());
    expect(row!.lastOutcomeAt?.toISOString()).toBe(now.toISOString());
    expect(row!.recent7dWindowStartedAt?.toISOString()).toBe(now.toISOString());
    expect(row!.pipelineVersion).toBe(ADDRESS_PIPELINE_VERSION);
  });

  it("CAS-style 7d window reset: window start advances when stale; counters zero before $inc", async () => {
    const t0 = new Date("2026-05-01T10:00:00Z");
    const t8d = new Date("2026-05-09T10:00:00Z"); // 8 days later → window stale

    // 3 outcomes inside the original window
    for (let i = 0; i < 3; i++) {
      await recordAreaOutcome({
        merchantId: MERCHANT,
        division: "dhaka",
        district: "dhaka",
        thana: "dhanmondi",
        outcome: "rto",
        now: t0,
      });
    }
    let row = await AreaReliability.findOne({}).lean();
    expect(row!.recent7dRto).toBe(3);
    expect(row!.rtoCount).toBe(3);

    // 4th outcome 8 days later — triggers window reset
    await recordAreaOutcome({
      merchantId: MERCHANT,
      division: "dhaka",
      district: "dhaka",
      thana: "dhanmondi",
      outcome: "rto",
      now: t8d,
    });
    row = await AreaReliability.findOne({}).lean();
    // Cumulative survives:
    expect(row!.rtoCount).toBe(4);
    // Window counter reset to 1 (the new outcome) — not 4.
    expect(row!.recent7dRto).toBe(1);
    expect(row!.recent7dWindowStartedAt?.toISOString()).toBe(t8d.toISOString());
  });

  it("CAS-style window reset is idempotent across replays inside the window", async () => {
    const t0 = new Date("2026-05-09T10:00:00Z");
    for (let i = 0; i < 5; i++) {
      await recordAreaOutcome({
        merchantId: MERCHANT,
        division: "dhaka",
        district: "dhaka",
        thana: "dhanmondi",
        outcome: "delivered",
        now: new Date(t0.getTime() + i * 60_000), // 1 minute apart
      });
    }
    const row = await AreaReliability.findOne({}).lean();
    expect(row!.deliveredCount).toBe(5);
    expect(row!.recent7dDelivered).toBe(5);
    // Window start did NOT advance during fresh writes
    expect(row!.recent7dWindowStartedAt?.toISOString()).toBe(t0.toISOString());
  });

  it("unreachable=true bumps unreachableCount alongside the outcome counter", async () => {
    await recordAreaOutcome({
      merchantId: MERCHANT,
      division: "dhaka",
      district: "dhaka",
      thana: "dhanmondi",
      outcome: "rto",
      unreachable: true,
      now: new Date(),
    });
    const row = await AreaReliability.findOne({}).lean();
    expect(row!.rtoCount).toBe(1);
    expect(row!.unreachableCount).toBe(1);
  });

  it("requires (division, district, thana) — skips silently when any is missing", async () => {
    await recordAreaOutcome({
      merchantId: MERCHANT,
      division: "",
      district: "dhaka",
      thana: "dhanmondi",
      outcome: "delivered",
      now: new Date(),
    });
    expect(await AreaReliability.countDocuments({})).toBe(0);
  });
});
