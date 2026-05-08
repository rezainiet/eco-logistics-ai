import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import {
  AddressReliability,
  ADDRESS_RELIABILITY_DISTINCT_PHONES_CAP,
  CourierPerformance,
  CustomerReliability,
  FraudPrediction,
  FraudSignal,
  Order,
} from "@ecom/db";
import {
  recordAddressOutcome,
  recordCustomerOutcome,
} from "../src/lib/delivery-reliability-writers.js";
import { ensureDb, disconnectDb, resetDb } from "./helpers.js";

/**
 * Delivery-reliability writers — integration tests against the
 * mongodb-memory-server instance booted by `tests/globalSetup.ts`.
 *
 * Covers:
 *   A. recordCustomerOutcome happy paths
 *   B. recordCustomerOutcome monotonic lastOutcomeAt
 *   C. recordCustomerOutcome invalid input + never-throws
 *   D. recordAddressOutcome happy paths
 *   E. recordAddressOutcome distinctPhoneHashes cap behavior
 *   F. recordAddressOutcome aggregation-pipeline integrity
 *   G. recordAddressOutcome monotonic lastOutcomeAt
 *   H. recordAddressOutcome invalid input + never-throws
 *   I. additive isolation — helpers don't touch other collections
 */

beforeEach(async () => {
  await ensureDb();
  await resetDb();
});

afterAll(async () => {
  await disconnectDb();
});

const PHONE_HASH = "ph_" + "a".repeat(29); // 32 chars total
const PHONE_HASH_2 = "ph_" + "b".repeat(29);
const ADDRESS_HASH = "ad_" + "c".repeat(29);
const ADDRESS_HASH_2 = "ad_" + "d".repeat(29);

const T0 = new Date("2026-05-01T10:00:00Z");
const T1 = new Date("2026-05-01T11:00:00Z");
const T2 = new Date("2026-05-01T12:00:00Z");

/* ========================================================================== */
/* GROUP A — recordCustomerOutcome happy paths                                */
/* ========================================================================== */

describe("recordCustomerOutcome — happy paths", () => {
  it("inserts a fresh row with deliveredCount=1 and stamps firstOutcomeAt + lastOutcomeAt", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({
      merchantId,
      phoneHash: PHONE_HASH,
      outcome: "delivered",
      now: T1,
    });
    const row = await CustomerReliability.findOne({
      merchantId,
      phoneHash: PHONE_HASH,
    }).lean();
    expect(row).not.toBeNull();
    expect(row!.deliveredCount).toBe(1);
    expect(row!.rtoCount).toBe(0);
    expect(row!.cancelledCount).toBe(0);
    expect(row!.firstOutcomeAt?.getTime()).toBe(T1.getTime());
    expect(row!.lastOutcomeAt?.getTime()).toBe(T1.getTime());
  });

  it("second call $incs the matching counter to 2 and freezes firstOutcomeAt", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({
      merchantId,
      phoneHash: PHONE_HASH,
      outcome: "delivered",
      now: T0,
    });
    await recordCustomerOutcome({
      merchantId,
      phoneHash: PHONE_HASH,
      outcome: "delivered",
      now: T1,
    });
    const row = await CustomerReliability.findOne({
      merchantId,
      phoneHash: PHONE_HASH,
    }).lean();
    expect(row!.deliveredCount).toBe(2);
    expect(row!.firstOutcomeAt?.getTime()).toBe(T0.getTime());
    expect(row!.lastOutcomeAt?.getTime()).toBe(T1.getTime());
  });

  it("rto outcome increments only rtoCount", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({
      merchantId,
      phoneHash: PHONE_HASH,
      outcome: "rto",
      now: T1,
    });
    const row = await CustomerReliability.findOne({
      merchantId,
      phoneHash: PHONE_HASH,
    }).lean();
    expect(row!.deliveredCount).toBe(0);
    expect(row!.rtoCount).toBe(1);
    expect(row!.cancelledCount).toBe(0);
  });

  it("cancelled outcome increments only cancelledCount", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({
      merchantId,
      phoneHash: PHONE_HASH,
      outcome: "cancelled",
      now: T1,
    });
    const row = await CustomerReliability.findOne({
      merchantId,
      phoneHash: PHONE_HASH,
    }).lean();
    expect(row!.cancelledCount).toBe(1);
    expect(row!.deliveredCount).toBe(0);
    expect(row!.rtoCount).toBe(0);
  });

  it("mixed outcomes accumulate independently", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({ merchantId, phoneHash: PHONE_HASH, outcome: "delivered", now: T0 });
    await recordCustomerOutcome({ merchantId, phoneHash: PHONE_HASH, outcome: "delivered", now: T0 });
    await recordCustomerOutcome({ merchantId, phoneHash: PHONE_HASH, outcome: "rto", now: T0 });
    await recordCustomerOutcome({ merchantId, phoneHash: PHONE_HASH, outcome: "cancelled", now: T0 });
    const row = await CustomerReliability.findOne({ merchantId, phoneHash: PHONE_HASH }).lean();
    expect(row!.deliveredCount).toBe(2);
    expect(row!.rtoCount).toBe(1);
    expect(row!.cancelledCount).toBe(1);
  });

  it("stamps lastDistrict and lastOrderId when supplied", async () => {
    const merchantId = new Types.ObjectId();
    const orderId = new Types.ObjectId();
    await recordCustomerOutcome({
      merchantId,
      phoneHash: PHONE_HASH,
      outcome: "delivered",
      district: "Dhaka",
      orderId,
      now: T1,
    });
    const row = await CustomerReliability.findOne({ merchantId, phoneHash: PHONE_HASH }).lean();
    expect(row!.lastDistrict).toBe("Dhaka");
    expect(String(row!.lastOrderId)).toBe(String(orderId));
  });

  it("subsequent call updates lastDistrict and lastOrderId", async () => {
    const merchantId = new Types.ObjectId();
    const orderA = new Types.ObjectId();
    const orderB = new Types.ObjectId();
    await recordCustomerOutcome({
      merchantId,
      phoneHash: PHONE_HASH,
      outcome: "delivered",
      district: "Dhaka",
      orderId: orderA,
      now: T0,
    });
    await recordCustomerOutcome({
      merchantId,
      phoneHash: PHONE_HASH,
      outcome: "rto",
      district: "Sylhet",
      orderId: orderB,
      now: T1,
    });
    const row = await CustomerReliability.findOne({ merchantId, phoneHash: PHONE_HASH }).lean();
    expect(row!.lastDistrict).toBe("Sylhet");
    expect(String(row!.lastOrderId)).toBe(String(orderB));
  });

  it("accepts merchantId as a string", async () => {
    const merchantOid = new Types.ObjectId();
    await recordCustomerOutcome({
      merchantId: merchantOid.toHexString(),
      phoneHash: PHONE_HASH,
      outcome: "delivered",
      now: T1,
    });
    const row = await CustomerReliability.findOne({
      merchantId: merchantOid,
      phoneHash: PHONE_HASH,
    }).lean();
    expect(row).not.toBeNull();
  });

  it("50 parallel calls produce exactly 50 increments (concurrent-write safety)", async () => {
    const merchantId = new Types.ObjectId();
    await Promise.all(
      Array.from({ length: 50 }, () =>
        recordCustomerOutcome({
          merchantId,
          phoneHash: PHONE_HASH,
          outcome: "delivered",
          now: T1,
        }),
      ),
    );
    const row = await CustomerReliability.findOne({ merchantId, phoneHash: PHONE_HASH }).lean();
    expect(row!.deliveredCount).toBe(50);
  });
});

/* ========================================================================== */
/* GROUP B — recordCustomerOutcome monotonic lastOutcomeAt                    */
/* ========================================================================== */

describe("recordCustomerOutcome — monotonic lastOutcomeAt via $max", () => {
  it("a later call advances lastOutcomeAt", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({ merchantId, phoneHash: PHONE_HASH, outcome: "delivered", now: T0 });
    await recordCustomerOutcome({ merchantId, phoneHash: PHONE_HASH, outcome: "delivered", now: T2 });
    const row = await CustomerReliability.findOne({ merchantId, phoneHash: PHONE_HASH }).lean();
    expect(row!.lastOutcomeAt?.getTime()).toBe(T2.getTime());
  });

  it("an earlier (replay-style) call does NOT pull lastOutcomeAt backward", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({ merchantId, phoneHash: PHONE_HASH, outcome: "delivered", now: T2 });
    await recordCustomerOutcome({ merchantId, phoneHash: PHONE_HASH, outcome: "delivered", now: T0 });
    const row = await CustomerReliability.findOne({ merchantId, phoneHash: PHONE_HASH }).lean();
    expect(row!.lastOutcomeAt?.getTime()).toBe(T2.getTime());
    // Counter still advances — the replay arrived; we just don't pull the timestamp back.
    expect(row!.deliveredCount).toBe(2);
  });

  it("missing `now` falls back to the system clock without throwing", async () => {
    const merchantId = new Types.ObjectId();
    const before = Date.now();
    await recordCustomerOutcome({ merchantId, phoneHash: PHONE_HASH, outcome: "delivered" });
    const after = Date.now();
    const row = await CustomerReliability.findOne({ merchantId, phoneHash: PHONE_HASH }).lean();
    expect(row!.lastOutcomeAt).toBeInstanceOf(Date);
    const t = row!.lastOutcomeAt!.getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after + 1);
  });
});

/* ========================================================================== */
/* GROUP C — recordCustomerOutcome invalid / null inputs                      */
/* ========================================================================== */

describe("recordCustomerOutcome — invalid / null inputs", () => {
  it("returns silently and writes nothing when merchantId is missing", async () => {
    await recordCustomerOutcome({
      // @ts-expect-error — exercising defensive runtime handling
      merchantId: undefined,
      phoneHash: PHONE_HASH,
      outcome: "delivered",
    });
    expect(await CustomerReliability.countDocuments({})).toBe(0);
  });

  it("returns silently when merchantId is an invalid ObjectId string", async () => {
    await recordCustomerOutcome({
      merchantId: "not-an-objectid",
      phoneHash: PHONE_HASH,
      outcome: "delivered",
    });
    expect(await CustomerReliability.countDocuments({})).toBe(0);
  });

  it("returns silently when phoneHash is empty string", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({ merchantId, phoneHash: "", outcome: "delivered" });
    expect(await CustomerReliability.countDocuments({})).toBe(0);
  });

  it("returns silently when phoneHash is whitespace-only", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({ merchantId, phoneHash: "   ", outcome: "delivered" });
    expect(await CustomerReliability.countDocuments({})).toBe(0);
  });

  it("returns silently when phoneHash exceeds 64 characters", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({
      merchantId,
      phoneHash: "x".repeat(65),
      outcome: "delivered",
    });
    expect(await CustomerReliability.countDocuments({})).toBe(0);
  });

  it("returns silently when outcome is not one of {delivered, rto, cancelled}", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({
      merchantId,
      phoneHash: PHONE_HASH,
      // @ts-expect-error
      outcome: "shipped",
    });
    expect(await CustomerReliability.countDocuments({})).toBe(0);
  });

  it("returns silently when input is null/undefined (no throw)", async () => {
    await expect(
      // @ts-expect-error
      recordCustomerOutcome(null),
    ).resolves.toBeUndefined();
    await expect(
      // @ts-expect-error
      recordCustomerOutcome(undefined),
    ).resolves.toBeUndefined();
    expect(await CustomerReliability.countDocuments({})).toBe(0);
  });

  it("ignores invalid orderId without throwing or rejecting the write", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({
      merchantId,
      phoneHash: PHONE_HASH,
      outcome: "delivered",
      orderId: "not-an-id",
      now: T1,
    });
    const row = await CustomerReliability.findOne({ merchantId, phoneHash: PHONE_HASH }).lean();
    expect(row).not.toBeNull();
    expect(row!.lastOrderId).toBeUndefined();
  });

  it("ignores district that is whitespace-only", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({
      merchantId,
      phoneHash: PHONE_HASH,
      outcome: "delivered",
      district: "   ",
      now: T1,
    });
    const row = await CustomerReliability.findOne({ merchantId, phoneHash: PHONE_HASH }).lean();
    expect(row!.lastDistrict).toBeUndefined();
  });
});

/* ========================================================================== */
/* GROUP D — recordAddressOutcome happy paths                                 */
/* ========================================================================== */

describe("recordAddressOutcome — happy paths", () => {
  it("inserts a fresh row with all three counters initialised to numeric values", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      outcome: "delivered",
      now: T1,
    });
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row).not.toBeNull();
    expect(row!.deliveredCount).toBe(1);
    expect(row!.rtoCount).toBe(0);
    expect(row!.cancelledCount).toBe(0);
    // Aggregation-pipeline upserts skip Mongoose defaults — assert they are
    // explicit numeric 0 (NOT undefined) thanks to the $ifNull guard.
    expect(typeof row!.rtoCount).toBe("number");
    expect(typeof row!.cancelledCount).toBe("number");
  });

  it("inserts with empty distinctPhoneHashes when no phoneHash supplied", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      outcome: "delivered",
      now: T1,
    });
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row!.distinctPhoneHashes).toEqual([]);
  });

  it("inserts with single phoneHash when supplied", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      outcome: "delivered",
      phoneHash: PHONE_HASH,
      now: T1,
    });
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row!.distinctPhoneHashes).toEqual([PHONE_HASH]);
  });

  it("repeated phoneHash does not duplicate the entry in distinctPhoneHashes", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({ merchantId, addressHash: ADDRESS_HASH, outcome: "delivered", phoneHash: PHONE_HASH, now: T0 });
    await recordAddressOutcome({ merchantId, addressHash: ADDRESS_HASH, outcome: "rto", phoneHash: PHONE_HASH, now: T1 });
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row!.distinctPhoneHashes).toHaveLength(1);
    expect(row!.deliveredCount).toBe(1);
    expect(row!.rtoCount).toBe(1);
  });

  it("two distinct phoneHashes produce a 2-element set", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({ merchantId, addressHash: ADDRESS_HASH, outcome: "delivered", phoneHash: PHONE_HASH, now: T0 });
    await recordAddressOutcome({ merchantId, addressHash: ADDRESS_HASH, outcome: "delivered", phoneHash: PHONE_HASH_2, now: T1 });
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row!.distinctPhoneHashes).toHaveLength(2);
    expect(new Set(row!.distinctPhoneHashes)).toEqual(new Set([PHONE_HASH, PHONE_HASH_2]));
    expect(row!.deliveredCount).toBe(2);
  });

  it("stamps lastDistrict and lastOrderId when supplied", async () => {
    const merchantId = new Types.ObjectId();
    const orderId = new Types.ObjectId();
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      outcome: "delivered",
      district: "Dhaka",
      orderId,
      now: T1,
    });
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row!.lastDistrict).toBe("Dhaka");
    expect(String(row!.lastOrderId)).toBe(String(orderId));
  });

  it("50 parallel calls with distinct keys land 50 increments per row", async () => {
    const merchantId = new Types.ObjectId();
    await Promise.all(
      Array.from({ length: 50 }, () =>
        recordAddressOutcome({
          merchantId,
          addressHash: ADDRESS_HASH,
          outcome: "delivered",
          phoneHash: PHONE_HASH,
          now: T1,
        }),
      ),
    );
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row!.deliveredCount).toBe(50);
    expect(row!.distinctPhoneHashes).toHaveLength(1);
  });
});

/* ========================================================================== */
/* GROUP E — recordAddressOutcome distinctPhoneHashes cap                     */
/* ========================================================================== */

describe("recordAddressOutcome — distinctPhoneHashes cap", () => {
  it("exactly CAP distinct phoneHashes results in array length === CAP", async () => {
    const merchantId = new Types.ObjectId();
    for (let i = 0; i < ADDRESS_RELIABILITY_DISTINCT_PHONES_CAP; i++) {
      await recordAddressOutcome({
        merchantId,
        addressHash: ADDRESS_HASH,
        outcome: "delivered",
        phoneHash: `ph_${String(i).padStart(29, "0")}`,
        now: T1,
      });
    }
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row!.distinctPhoneHashes).toHaveLength(ADDRESS_RELIABILITY_DISTINCT_PHONES_CAP);
  });

  it("CAP+10 distinct phoneHashes still result in array length === CAP (overflow truncated)", async () => {
    const merchantId = new Types.ObjectId();
    const totalUnique = ADDRESS_RELIABILITY_DISTINCT_PHONES_CAP + 10;
    for (let i = 0; i < totalUnique; i++) {
      await recordAddressOutcome({
        merchantId,
        addressHash: ADDRESS_HASH,
        outcome: "delivered",
        phoneHash: `ph_${String(i).padStart(29, "0")}`,
        now: T1,
      });
    }
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row!.distinctPhoneHashes).toHaveLength(ADDRESS_RELIABILITY_DISTINCT_PHONES_CAP);
    expect(row!.deliveredCount).toBe(totalUnique);
  });

  it("documents (and accepts) that $slice keeps the LAST CAP entries", async () => {
    // The pipeline is `$slice: [union, -CAP]` ⇒ keep the last CAP entries
    // of the merged set. `$setUnion` does not preserve insertion order in
    // MongoDB; this test asserts the cap is respected, not the eviction
    // order — those are not part of the contract.
    const merchantId = new Types.ObjectId();
    const totalUnique = ADDRESS_RELIABILITY_DISTINCT_PHONES_CAP + 5;
    for (let i = 0; i < totalUnique; i++) {
      await recordAddressOutcome({
        merchantId,
        addressHash: ADDRESS_HASH,
        outcome: "delivered",
        phoneHash: `ph_${String(i).padStart(29, "0")}`,
        now: T1,
      });
    }
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row!.distinctPhoneHashes.length).toBeLessThanOrEqual(
      ADDRESS_RELIABILITY_DISTINCT_PHONES_CAP,
    );
  });
});

/* ========================================================================== */
/* GROUP F — recordAddressOutcome aggregation-pipeline integrity              */
/* ========================================================================== */

describe("recordAddressOutcome — pipeline integrity (no NaN / undefined)", () => {
  it("a freshly-inserted row has every counter as a finite number", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      outcome: "rto",
      now: T1,
    });
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(Number.isFinite(row!.deliveredCount)).toBe(true);
    expect(Number.isFinite(row!.rtoCount)).toBe(true);
    expect(Number.isFinite(row!.cancelledCount)).toBe(true);
    expect(row!.deliveredCount + row!.rtoCount + row!.cancelledCount).toBe(1);
  });

  it("each outcome increments exactly the right counter across many calls", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({ merchantId, addressHash: ADDRESS_HASH, outcome: "delivered", now: T0 });
    await recordAddressOutcome({ merchantId, addressHash: ADDRESS_HASH, outcome: "delivered", now: T0 });
    await recordAddressOutcome({ merchantId, addressHash: ADDRESS_HASH, outcome: "delivered", now: T0 });
    await recordAddressOutcome({ merchantId, addressHash: ADDRESS_HASH, outcome: "rto", now: T0 });
    await recordAddressOutcome({ merchantId, addressHash: ADDRESS_HASH, outcome: "cancelled", now: T0 });
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row!.deliveredCount).toBe(3);
    expect(row!.rtoCount).toBe(1);
    expect(row!.cancelledCount).toBe(1);
  });
});

/* ========================================================================== */
/* GROUP G — recordAddressOutcome monotonic lastOutcomeAt                     */
/* ========================================================================== */

describe("recordAddressOutcome — monotonic lastOutcomeAt", () => {
  it("a later call advances lastOutcomeAt", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({ merchantId, addressHash: ADDRESS_HASH, outcome: "delivered", now: T0 });
    await recordAddressOutcome({ merchantId, addressHash: ADDRESS_HASH, outcome: "delivered", now: T2 });
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row!.lastOutcomeAt?.getTime()).toBe(T2.getTime());
  });

  it("an earlier (replay) call does NOT pull lastOutcomeAt backward", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({ merchantId, addressHash: ADDRESS_HASH, outcome: "delivered", now: T2 });
    await recordAddressOutcome({ merchantId, addressHash: ADDRESS_HASH, outcome: "delivered", now: T0 });
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row!.lastOutcomeAt?.getTime()).toBe(T2.getTime());
    expect(row!.deliveredCount).toBe(2);
  });
});

/* ========================================================================== */
/* GROUP H — recordAddressOutcome invalid / null inputs                       */
/* ========================================================================== */

describe("recordAddressOutcome — invalid / null inputs", () => {
  it("returns silently when addressHash is missing", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({
      merchantId,
      // @ts-expect-error
      addressHash: undefined,
      outcome: "delivered",
    });
    expect(await AddressReliability.countDocuments({})).toBe(0);
  });

  it("returns silently when addressHash is empty string", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({ merchantId, addressHash: "", outcome: "delivered" });
    expect(await AddressReliability.countDocuments({})).toBe(0);
  });

  it("returns silently when outcome is invalid", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      // @ts-expect-error
      outcome: "shipped",
    });
    expect(await AddressReliability.countDocuments({})).toBe(0);
  });

  it("returns silently when input is null/undefined (no throw)", async () => {
    await expect(
      // @ts-expect-error
      recordAddressOutcome(null),
    ).resolves.toBeUndefined();
    await expect(
      // @ts-expect-error
      recordAddressOutcome(undefined),
    ).resolves.toBeUndefined();
    expect(await AddressReliability.countDocuments({})).toBe(0);
  });

  it("ignores invalid phoneHash without dropping the entire write", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      outcome: "delivered",
      phoneHash: "", // invalid → ignored
      now: T1,
    });
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row).not.toBeNull();
    expect(row!.deliveredCount).toBe(1);
    expect(row!.distinctPhoneHashes).toEqual([]);
  });

  it("ignores phoneHash exceeding 64 chars without dropping the write", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      outcome: "delivered",
      phoneHash: "x".repeat(65),
      now: T1,
    });
    const row = await AddressReliability.findOne({ merchantId, addressHash: ADDRESS_HASH }).lean();
    expect(row!.distinctPhoneHashes).toEqual([]);
  });
});

/* ========================================================================== */
/* GROUP I — additive isolation                                               */
/* ========================================================================== */

describe("writers — additive isolation", () => {
  it("recordCustomerOutcome does not write to other collections", async () => {
    const merchantId = new Types.ObjectId();
    await recordCustomerOutcome({
      merchantId,
      phoneHash: PHONE_HASH,
      outcome: "delivered",
      district: "Dhaka",
      orderId: new Types.ObjectId(),
      now: T1,
    });
    expect(await CustomerReliability.countDocuments({})).toBe(1);
    expect(await AddressReliability.countDocuments({})).toBe(0);
    expect(await CourierPerformance.countDocuments({})).toBe(0);
    expect(await FraudSignal.countDocuments({})).toBe(0);
    expect(await FraudPrediction.countDocuments({})).toBe(0);
    expect(await Order.countDocuments({})).toBe(0);
  });

  it("recordAddressOutcome does not write to other collections", async () => {
    const merchantId = new Types.ObjectId();
    await recordAddressOutcome({
      merchantId,
      addressHash: ADDRESS_HASH,
      outcome: "delivered",
      phoneHash: PHONE_HASH,
      district: "Dhaka",
      orderId: new Types.ObjectId(),
      now: T1,
    });
    expect(await AddressReliability.countDocuments({})).toBe(1);
    expect(await CustomerReliability.countDocuments({})).toBe(0);
    expect(await CourierPerformance.countDocuments({})).toBe(0);
    expect(await FraudSignal.countDocuments({})).toBe(0);
    expect(await FraudPrediction.countDocuments({})).toBe(0);
    expect(await Order.countDocuments({})).toBe(0);
  });

  it("multiple invocations across both helpers stay isolated to their own collections", async () => {
    const merchantId = new Types.ObjectId();
    for (let i = 0; i < 5; i++) {
      await recordCustomerOutcome({
        merchantId,
        phoneHash: PHONE_HASH,
        outcome: "delivered",
        now: T1,
      });
      await recordAddressOutcome({
        merchantId,
        addressHash: ADDRESS_HASH,
        outcome: "delivered",
        phoneHash: PHONE_HASH,
        now: T1,
      });
    }
    expect(await CustomerReliability.countDocuments({})).toBe(1);
    expect(await AddressReliability.countDocuments({})).toBe(1);
    expect(await CourierPerformance.countDocuments({})).toBe(0);
    expect(await FraudSignal.countDocuments({})).toBe(0);
    expect(await FraudPrediction.countDocuments({})).toBe(0);
  });
});
