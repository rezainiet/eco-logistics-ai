import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { CourierLane, CourierPerformance } from "@ecom/db";
import { selectBestCourier } from "../src/lib/courier-intelligence.js";
import { ADDRESS_PIPELINE_VERSION } from "../src/lib/address-canonical.js";
import { env } from "../src/env.js";
import { disconnectDb, ensureDb, resetDb } from "./helpers.js";

type MutableEnv = { LANE_INTELLIGENCE_READ_ENABLED: boolean };
const MERCHANT = new Types.ObjectId("507f1f77bcf86cd799439022");
let originalRead: boolean;

async function seedDistrictRow(
  courier: string,
  district: string,
  delivered: number,
  rto: number,
  totalHours = 24,
) {
  await CourierPerformance.create({
    merchantId: MERCHANT,
    courier,
    district,
    deliveredCount: delivered,
    rtoCount: rto,
    cancelledCount: 0,
    totalDeliveryHours: totalHours * Math.max(1, delivered),
    lastOutcomeAt: new Date(),
  });
}

async function seedThanaRow(
  courier: string,
  district: string,
  thana: string,
  delivered: number,
  rto: number,
  totalHours = 24,
) {
  await CourierLane.create({
    merchantId: MERCHANT,
    courier,
    district,
    thana,
    deliveredCount: delivered,
    rtoCount: rto,
    cancelledCount: 0,
    totalDeliveryHours: totalHours * Math.max(1, delivered),
    attempt1Delivered: delivered,
    attempt1Rto: rto,
    attempt2Delivered: 0,
    attempt2Rto: 0,
    attempt3PlusDelivered: 0,
    attempt3PlusRto: 0,
    pipelineVersion: ADDRESS_PIPELINE_VERSION,
    lastOutcomeAt: new Date(),
    firstOutcomeAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  });
}

describe("selectBestCourier — Phase 3 thana ladder", () => {
  beforeAll(async () => {
    await ensureDb();
    originalRead = env.LANE_INTELLIGENCE_READ_ENABLED;
  });
  beforeEach(resetDb);
  afterAll(async () => {
    (env as unknown as MutableEnv).LANE_INTELLIGENCE_READ_ENABLED = originalRead;
    await disconnectDb();
  });
  afterEach(() => {
    (env as unknown as MutableEnv).LANE_INTELLIGENCE_READ_ENABLED = originalRead;
  });

  it("flag OFF: thana row is ignored even when present (legacy behaviour preserved)", async () => {
    (env as unknown as MutableEnv).LANE_INTELLIGENCE_READ_ENABLED = false;
    // District: pathao mediocre, redx strong
    await seedDistrictRow("pathao", "dhaka", 50, 30);
    await seedDistrictRow("redx", "dhaka", 80, 5);
    // Thana row says pathao is amazing in dhanmondi — but flag off so ignored.
    await seedThanaRow("pathao", "dhaka", "dhanmondi", 100, 1);

    const r = await selectBestCourier({
      merchantId: MERCHANT,
      district: "Dhaka",
      candidates: ["pathao", "redx"],
      thana: "dhanmondi",
    });
    expect(r.best).toBe("redx"); // district ladder wins; thana ignored
  });

  it("flag ON: thana row wins when its observations clear MIN_OBSERVATIONS_THANA", async () => {
    (env as unknown as MutableEnv).LANE_INTELLIGENCE_READ_ENABLED = true;
    await seedDistrictRow("pathao", "dhaka", 50, 30);
    await seedDistrictRow("redx", "dhaka", 80, 5);
    // Thana data flips the verdict: pathao is excellent in this thana.
    await seedThanaRow("pathao", "dhaka", "dhanmondi", 100, 2);

    const r = await selectBestCourier({
      merchantId: MERCHANT,
      district: "Dhaka",
      candidates: ["pathao", "redx"],
      thana: "dhanmondi",
    });
    expect(r.best).toBe("pathao"); // thana ladder elected pathao
  });

  it("flag ON: thana row IGNORED when below MIN_OBSERVATIONS_THANA — falls through to district", async () => {
    (env as unknown as MutableEnv).LANE_INTELLIGENCE_READ_ENABLED = true;
    await seedDistrictRow("pathao", "dhaka", 50, 30);
    await seedDistrictRow("redx", "dhaka", 80, 5);
    // Only 5 thana observations on pathao — below MIN_OBSERVATIONS_THANA (20).
    await seedThanaRow("pathao", "dhaka", "dhanmondi", 5, 0);

    const r = await selectBestCourier({
      merchantId: MERCHANT,
      district: "Dhaka",
      candidates: ["pathao", "redx"],
      thana: "dhanmondi",
    });
    // Falls through to district ladder; redx wins on district evidence.
    expect(r.best).toBe("redx");
  });

  it("flag ON: legacy callers (no thana arg) get exactly the legacy ladder behaviour", async () => {
    (env as unknown as MutableEnv).LANE_INTELLIGENCE_READ_ENABLED = true;
    await seedDistrictRow("pathao", "dhaka", 50, 30);
    await seedDistrictRow("redx", "dhaka", 80, 5);
    await seedThanaRow("pathao", "dhaka", "dhanmondi", 100, 1);

    // Caller doesn't supply thana → ladder collapses to legacy.
    const r = await selectBestCourier({
      merchantId: MERCHANT,
      district: "Dhaka",
      candidates: ["pathao", "redx"],
    });
    expect(r.best).toBe("redx");
  });

  it("flag ON: no thana row exists → thana ladder degrades cleanly to district", async () => {
    (env as unknown as MutableEnv).LANE_INTELLIGENCE_READ_ENABLED = true;
    await seedDistrictRow("pathao", "dhaka", 90, 5);
    await seedDistrictRow("redx", "dhaka", 50, 30);

    const r = await selectBestCourier({
      merchantId: MERCHANT,
      district: "Dhaka",
      candidates: ["pathao", "redx"],
      thana: "dhanmondi", // never seeded
    });
    expect(r.best).toBe("pathao");
  });
});
