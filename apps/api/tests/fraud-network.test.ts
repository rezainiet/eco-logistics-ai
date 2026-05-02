import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { FraudSignal } from "@ecom/db";
import {
  __TEST,
  contributeOutcome,
  hashPhoneForNetwork,
  lookupNetworkRisk,
  normalizeAddressHash,
} from "../src/lib/fraud-network.js";
import { ensureDb, disconnectDb, resetDb } from "./helpers.js";

const { computeBonus, NETWORK_BONUS_CAP } = __TEST;

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

describe("hashPhoneForNetwork", () => {
  it("hashes consistently for the same input", () => {
    expect(hashPhoneForNetwork("+8801711111111")).toBe(hashPhoneForNetwork("+8801711111111"));
  });
  it("returns null for empty inputs", () => {
    expect(hashPhoneForNetwork("")).toBeNull();
    expect(hashPhoneForNetwork(null)).toBeNull();
    expect(hashPhoneForNetwork(undefined)).toBeNull();
  });
  it("yields different hashes for different inputs", () => {
    expect(hashPhoneForNetwork("+8801711111111")).not.toBe(hashPhoneForNetwork("+8801722222222"));
  });
  it("never returns the raw phone in the hash", () => {
    const h = hashPhoneForNetwork("+8801711111111")!;
    expect(h).not.toContain("8801711111111");
  });
});

describe("normalizeAddressHash", () => {
  it("trims and rejects empty strings", () => {
    expect(normalizeAddressHash(" abc ")).toBe("abc");
    expect(normalizeAddressHash("")).toBeNull();
    expect(normalizeAddressHash(null)).toBeNull();
  });
});

describe("computeBonus", () => {
  it("returns 0 when nothing notable", () => {
    expect(
      computeBonus({ merchantCount: 1, rtoCount: 0, cancelledCount: 0, rtoRate: 0 }),
    ).toBe(0);
  });
  it("adds for high RTO rate when ≥2 merchants", () => {
    const b = computeBonus({ merchantCount: 3, rtoCount: 4, cancelledCount: 0, rtoRate: 0.8 });
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThanOrEqual(NETWORK_BONUS_CAP);
  });
  it("ignores high RTO rate when only 1 merchant has reported", () => {
    expect(
      computeBonus({ merchantCount: 1, rtoCount: 5, cancelledCount: 0, rtoRate: 1 }),
    ).toBe(8); // only the absolute-rto bonus (≥3 RTOs), no rate bonus
  });
  it("never exceeds the cap", () => {
    const b = computeBonus({ merchantCount: 50, rtoCount: 50, cancelledCount: 50, rtoRate: 1.0 });
    expect(b).toBe(NETWORK_BONUS_CAP);
  });
});

/* -------------------------------------------------------------------------- */
/* DB-backed                                                                   */
/* -------------------------------------------------------------------------- */

describe("contributeOutcome + lookupNetworkRisk", () => {
  beforeEach(async () => {
    await ensureDb();
    await resetDb();
  });
  afterAll(disconnectDb);

  const phoneHash = hashPhoneForNetwork("+8801711111111")!;
  const addressHash = "addr-hash-123";

  it("creates the row on first contribution and increments on second", async () => {
    const m1 = new Types.ObjectId();
    await contributeOutcome({ merchantId: m1, phoneHash, addressHash, outcome: "rto" });
    const row1 = await FraudSignal.findOne({ phoneHash, addressHash }).lean();
    expect(row1!.rtoCount).toBe(1);
    expect(row1!.merchantIds).toHaveLength(1);

    await contributeOutcome({ merchantId: m1, phoneHash, addressHash, outcome: "rto" });
    const row2 = await FraudSignal.findOne({ phoneHash, addressHash }).lean();
    expect(row2!.rtoCount).toBe(2);
    // Same merchant, $addToSet does not duplicate
    expect(row2!.merchantIds).toHaveLength(1);
  });

  it("tracks distinct merchant ids", async () => {
    const m1 = new Types.ObjectId();
    const m2 = new Types.ObjectId();
    await contributeOutcome({ merchantId: m1, phoneHash, addressHash, outcome: "rto" });
    await contributeOutcome({ merchantId: m2, phoneHash, addressHash, outcome: "rto" });
    const row = await FraudSignal.findOne({ phoneHash, addressHash }).lean();
    expect(row!.merchantIds).toHaveLength(2);
  });

  it("skips silently when both hashes are absent", async () => {
    const m1 = new Types.ObjectId();
    await contributeOutcome({ merchantId: m1, phoneHash: null, addressHash: null, outcome: "rto" });
    expect(await FraudSignal.countDocuments()).toBe(0);
  });

  it("EMPTY result when no signal exists", async () => {
    const r = await lookupNetworkRisk({ phoneHash, addressHash, merchantId: new Types.ObjectId() });
    expect(r.bonus).toBe(0);
    expect(r.merchantCount).toBe(0);
    expect(r.matchedOn).toBe("none");
  });

  it("EMPTY result for single-merchant signals (no network confidence)", async () => {
    const m1 = new Types.ObjectId();
    await contributeOutcome({ merchantId: m1, phoneHash, addressHash, outcome: "rto" });
    await contributeOutcome({ merchantId: m1, phoneHash, addressHash, outcome: "rto" });

    const r = await lookupNetworkRisk({ phoneHash, addressHash, merchantId: new Types.ObjectId() });
    // 1 merchant in the network, below threshold — surface nothing
    expect(r.bonus).toBe(0);
    expect(r.merchantCount).toBe(0);
  });

  it("surfaces signal when ≥2 distinct merchants have observed it", async () => {
    const m1 = new Types.ObjectId();
    const m2 = new Types.ObjectId();
    const m3 = new Types.ObjectId();
    await contributeOutcome({ merchantId: m1, phoneHash, addressHash, outcome: "rto" });
    await contributeOutcome({ merchantId: m2, phoneHash, addressHash, outcome: "rto" });
    await contributeOutcome({ merchantId: m1, phoneHash, addressHash, outcome: "delivered" });

    // Querying as a fresh merchant — sees the network signal.
    const r = await lookupNetworkRisk({ phoneHash, addressHash, merchantId: m3 });
    expect(r.merchantCount).toBe(2);
    expect(r.rtoCount).toBe(2);
    expect(r.deliveredCount).toBe(1);
    expect(r.rtoRate).toBeCloseTo(2 / 3, 5);
    expect(r.bonus).toBeGreaterThan(0);
    expect(r.matchedOn).toBe("phone+address");
  });

  it("excludes the calling merchant from merchantCount (so a merchant doesn't see itself)", async () => {
    const m1 = new Types.ObjectId();
    const m2 = new Types.ObjectId();
    const m3 = new Types.ObjectId();
    await contributeOutcome({ merchantId: m1, phoneHash, addressHash, outcome: "rto" });
    await contributeOutcome({ merchantId: m2, phoneHash, addressHash, outcome: "rto" });
    await contributeOutcome({ merchantId: m3, phoneHash, addressHash, outcome: "rto" });

    const r = await lookupNetworkRisk({ phoneHash, addressHash, merchantId: m1 });
    // Three contributors total; the caller (m1) is excluded → count = 2.
    expect(r.merchantCount).toBe(2);
  });

  it("falls back to phone-only signal when address+phone composite has no row", async () => {
    const m1 = new Types.ObjectId();
    const m2 = new Types.ObjectId();
    // Contribute with phone-only (no address)
    await contributeOutcome({ merchantId: m1, phoneHash, addressHash: null, outcome: "rto" });
    await contributeOutcome({ merchantId: m2, phoneHash, addressHash: null, outcome: "rto" });
    await contributeOutcome({ merchantId: m1, phoneHash, addressHash: null, outcome: "delivered" });

    const r = await lookupNetworkRisk({
      phoneHash,
      addressHash: "different-address",
      merchantId: new Types.ObjectId(),
    });
    expect(r.matchedOn).toBe("phone");
    expect(r.merchantCount).toBe(2);
    expect(r.bonus).toBeGreaterThan(0);
  });

  it("never returns the merchantIds array to the caller", async () => {
    const m1 = new Types.ObjectId();
    const m2 = new Types.ObjectId();
    await contributeOutcome({ merchantId: m1, phoneHash, addressHash, outcome: "rto" });
    await contributeOutcome({ merchantId: m2, phoneHash, addressHash, outcome: "rto" });

    const r = await lookupNetworkRisk({ phoneHash, addressHash, merchantId: new Types.ObjectId() });
    // Privacy contract: merchantIds is not in the result shape.
    expect(r).not.toHaveProperty("merchantIds");
    expect(JSON.stringify(r)).not.toContain(String(m1));
    expect(JSON.stringify(r)).not.toContain(String(m2));
  });

  it("EMPTY when merchantCount ≥ 2 but completed observations < 2 (false-positive guard)", async () => {
    const m1 = new Types.ObjectId();
    const m2 = new Types.ObjectId();
    // Two contributors but only 1 completed event — under the floor.
    await contributeOutcome({ merchantId: m1, phoneHash, addressHash, outcome: "rto" });
    // m2 hasn't completed a terminal yet — wait, every contributeOutcome IS a
    // terminal. Adjust: artificially reset the second row to simulate a row
    // that has 2 merchants but only 1 observation total.
    await FraudSignal.updateOne(
      { phoneHash, addressHash },
      { $set: { rtoCount: 0, deliveredCount: 1, cancelledCount: 0, merchantIds: [m1, m2] } },
    );

    const r = await lookupNetworkRisk({ phoneHash, addressHash, merchantId: new Types.ObjectId() });
    expect(r.bonus).toBe(0);
  });
});
