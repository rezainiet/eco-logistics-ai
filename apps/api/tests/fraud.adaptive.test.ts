import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { FraudPrediction, Merchant, Order } from "@ecom/db";
import { __TEST, classifyCustomerTier, computeRisk } from "../src/server/risk.js";
import {
  __resetMerchantValueRollupCache,
  getMerchantValueRollup,
} from "../src/lib/merchantValueRollup.js";
import { tuneMerchantFraudWeights } from "../src/workers/fraudWeightTuning.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";

const cleanCustomer = {
  name: "Rahim Uddin",
  phone: "+8801711111111",
  district: "Dhaka",
};
const zeroHistory = {
  phoneOrdersCount: 0,
  phoneReturnedCount: 0,
  phoneCancelledCount: 0,
  phoneUnreachableCount: 0,
  ipRecentCount: 0,
  phoneVelocityCount: 0,
  addressDistinctPhones: 0,
  addressReturnedCount: 0,
};

describe("dynamic thresholds (p75 / avg)", () => {
  it("derives high/extreme COD thresholds from p75 when no merchant override is set", () => {
    const r = computeRisk(
      { cod: 5000, customer: cleanCustomer },
      zeroHistory,
      { p75OrderValue: 2000 },
    );
    // p75=2000 → high=3000 (1.5×), extreme=6000 (3×). 5000 should be high_cod.
    expect(r.dynamicThresholds.source).toBe("merchant_p75");
    expect(r.dynamicThresholds.highCod).toBe(3000);
    expect(r.dynamicThresholds.extremeCod).toBe(6000);
    expect(r.signals.map((s) => s.key)).toContain("high_cod");
    expect(r.signals.map((s) => s.key)).not.toContain("extreme_cod");
  });

  it("falls back to avg when p75 is absent", () => {
    const r = computeRisk(
      { cod: 500, customer: cleanCustomer },
      zeroHistory,
      { avgOrderValue: 1000 },
    );
    expect(r.dynamicThresholds.source).toBe("merchant_avg");
  });

  it("respects floor so a tiny merchant doesn't get a 300 BDT high-COD threshold", () => {
    const r = computeRisk(
      { cod: 1000, customer: cleanCustomer },
      zeroHistory,
      { p75OrderValue: 200 },
    );
    expect(r.dynamicThresholds.highCod).toBeGreaterThanOrEqual(__TEST.HIGH_COD_FLOOR);
  });

  it("merchant explicit override beats both p75 and avg", () => {
    const r = computeRisk(
      { cod: 5000, customer: cleanCustomer },
      zeroHistory,
      { highCodBdt: 50_000, extremeCodBdt: 100_000, p75OrderValue: 200 },
    );
    expect(r.dynamicThresholds.source).toBe("merchant_override");
    expect(r.signals.map((s) => s.key)).not.toContain("high_cod");
  });
});

describe("customer trust tiers", () => {
  it("classifyCustomerTier promotes to gold at 5+ delivered with >85% success", () => {
    expect(
      classifyCustomerTier({
        ...zeroHistory,
        phoneTotalRaw: 6,
        phoneDeliveredRaw: 6,
        phoneReturnedRaw: 0,
        phoneCancelledRaw: 0,
      }),
    ).toBe("gold");
    // 5/6 delivered = 83.3% — under the 85% bar.
    expect(
      classifyCustomerTier({
        ...zeroHistory,
        phoneTotalRaw: 6,
        phoneDeliveredRaw: 5,
        phoneReturnedRaw: 1,
        phoneCancelledRaw: 0,
      }),
    ).toBe("silver");
  });

  it("gold buyer bypasses velocity and fake_name signals", () => {
    const goldHistory = {
      ...zeroHistory,
      phoneVelocityCount: 5,
      phoneTotalRaw: 10,
      phoneDeliveredRaw: 10,
      phoneReturnedRaw: 0,
      phoneCancelledRaw: 0,
    };
    const r = computeRisk(
      { cod: 500, customer: { ...cleanCustomer, name: "xxx" } },
      goldHistory,
      { velocityThreshold: 3 },
    );
    expect(r.customerTier).toBe("gold");
    expect(r.signals.map((s) => s.key)).not.toContain("velocity_breach");
    expect(r.signals.map((s) => s.key)).not.toContain("fake_name_pattern");
  });

  it("standard buyer still trips velocity + fake_name signals", () => {
    const standardHistory = {
      ...zeroHistory,
      phoneVelocityCount: 5,
      phoneTotalRaw: 4,
      phoneDeliveredRaw: 1,
      phoneReturnedRaw: 2,
      phoneCancelledRaw: 1,
    };
    const r = computeRisk(
      { cod: 500, customer: { ...cleanCustomer, name: "xxx" } },
      standardHistory,
      { velocityThreshold: 3 },
    );
    expect(r.customerTier).not.toBe("gold");
    expect(r.signals.map((s) => s.key)).toContain("velocity_breach");
    expect(r.signals.map((s) => s.key)).toContain("fake_name_pattern");
  });

  it("gold bypass does not laundry blocked_phone (hard blocks still fire)", () => {
    const goldHistory = {
      ...zeroHistory,
      phoneTotalRaw: 10,
      phoneDeliveredRaw: 10,
    };
    const r = computeRisk(
      { cod: 500, customer: cleanCustomer },
      goldHistory,
      { blockedPhones: [cleanCustomer.phone] },
    );
    expect(r.customerTier).toBe("gold");
    expect(r.signals.map((s) => s.key)).toContain("blocked_phone");
    expect(r.level).toBe("high");
  });
});

describe("P(RTO) probability output", () => {
  it("low-risk clean order → low pRto", () => {
    const r = computeRisk({ cod: 500, customer: cleanCustomer }, zeroHistory);
    expect(r.pRto).toBeGreaterThan(0);
    expect(r.pRto).toBeLessThan(0.3);
    expect(r.pRtoPct).toBe(Math.round(r.pRto * 1000) / 10);
  });

  it("hard-blocked order pins pRto to ≥95%", () => {
    const r = computeRisk(
      { cod: 500, customer: cleanCustomer },
      zeroHistory,
      { blockedPhones: [cleanCustomer.phone] },
    );
    expect(r.hardBlocked).toBe(true);
    expect(r.pRto).toBeGreaterThanOrEqual(0.95);
  });

  it("higher score monotonically increases pRto", () => {
    const lo = computeRisk({ cod: 100, customer: cleanCustomer }, zeroHistory);
    const hi = computeRisk(
      { cod: 100, customer: { ...cleanCustomer, name: "xxx", district: "unknown" } },
      { ...zeroHistory, phoneOrdersCount: __TEST.DUP_PHONE_HEAVY, phoneReturnedCount: 2 },
    );
    expect(hi.pRto).toBeGreaterThan(lo.pRto);
  });

  it("base RTO rate shifts the calibration point", () => {
    const score = 50;
    const low = __TEST.scoreToProbability(score, 0.05);
    const high = __TEST.scoreToProbability(score, 0.30);
    expect(high).toBeGreaterThan(low);
    expect(low).toBeCloseTo(0.05, 2);
    expect(high).toBeCloseTo(0.30, 2);
  });
});

describe("per-merchant value rollup", () => {
  beforeEach(async () => {
    await resetDb();
    __resetMerchantValueRollupCache();
  });
  afterAll(disconnectDb);

  it("computes p75 + avg from resolved orders only", async () => {
    const m = await createMerchant({ tier: "growth" });
    const cods = [200, 300, 500, 800, 1200, 1500, 2000, 2200, 2500, 3000,
                  3500, 4000, 4500, 5000, 6000, 7000, 8000, 9000, 10000, 12000];
    for (let i = 0; i < cods.length; i++) {
      await Order.create({
        merchantId: m._id,
        orderNumber: `R-${i}`,
        customer: {
          name: "Buyer",
          phone: `+880170000${String(i).padStart(4, "0")}`,
          address: "X",
          district: "Dhaka",
        },
        items: [{ name: "X", quantity: 1, price: cods[i] }],
        order: { cod: cods[i], total: cods[i], status: "delivered" },
      });
    }
    // A pending order at 99999 must NOT pull the rollup up.
    await Order.create({
      merchantId: m._id,
      orderNumber: "P-1",
      customer: { name: "B", phone: "+8801799999999", address: "X", district: "Dhaka" },
      items: [{ name: "X", quantity: 1, price: 99999 }],
      order: { cod: 99999, total: 99999, status: "pending" },
    });

    const rollup = await getMerchantValueRollup(m._id as Types.ObjectId);
    expect(rollup.resolvedSampleSize).toBe(20);
    expect(rollup.p75OrderValue).toBeGreaterThan(rollup.avgOrderValue!);
    expect(rollup.p75OrderValue).toBeLessThan(99999);
  });

  it("returns no p75 below the 20-order minimum sample", async () => {
    const m = await createMerchant({ tier: "growth" });
    for (let i = 0; i < 5; i++) {
      await Order.create({
        merchantId: m._id,
        orderNumber: `R-${i}`,
        customer: { name: "B", phone: `+880170000000${i}`, address: "X", district: "Dhaka" },
        items: [{ name: "X", quantity: 1, price: 1000 }],
        order: { cod: 1000, total: 1000, status: "delivered" },
      });
    }
    const rollup = await getMerchantValueRollup(m._id as Types.ObjectId);
    expect(rollup.resolvedSampleSize).toBe(5);
    expect(rollup.p75OrderValue).toBeUndefined();
    expect(rollup.avgOrderValue).toBe(1000);
  });
});

describe("feedback loop + monthly tuning", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("ingest writes a FraudPrediction row at scoring time", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder({
      customer: {
        name: "Karim",
        phone: "+8801712345678",
        address: "House 1",
        district: "Dhaka",
      },
      items: [{ name: "X", quantity: 1, price: 500 }],
      cod: 500,
    });
    const pred = await FraudPrediction.findOne({ orderId: created.id }).lean();
    expect(pred).toBeTruthy();
    expect(pred?.weightsVersion).toBeTruthy();
    expect(pred?.pRto).toBeGreaterThan(0);
    expect(pred?.outcome).toBeFalsy();
  });

  it("tuning amplifies signals that correlate with RTO and dampens those that don't", async () => {
    const m = await createMerchant({ tier: "growth" });
    const merchantId = m._id as Types.ObjectId;

    // Synthesize 80 resolved predictions:
    //   - 40 fired "extreme_cod" → 32 became RTO (80% precision, very predictive)
    //   - 40 fired "fake_name_pattern" → 8 became RTO (20% precision, not predictive)
    // Goal: extreme_cod multiplier > 1, fake_name multiplier < 1.
    const now = Date.now();
    const rows: Array<Promise<unknown>> = [];
    for (let i = 0; i < 40; i++) {
      rows.push(
        FraudPrediction.create({
          merchantId,
          orderId: new Types.ObjectId(),
          riskScore: 70,
          pRto: 0.7,
          levelPredicted: "high",
          customerTier: "standard",
          signals: [{ key: "extreme_cod", weight: 40 }],
          weightsVersion: "v2.0",
          outcome: i < 32 ? "rto" : "delivered",
          outcomeAt: new Date(now - 86400_000),
        }),
      );
    }
    for (let i = 0; i < 40; i++) {
      rows.push(
        FraudPrediction.create({
          merchantId,
          orderId: new Types.ObjectId(),
          riskScore: 35,
          pRto: 0.2,
          levelPredicted: "low",
          customerTier: "standard",
          signals: [{ key: "fake_name_pattern", weight: 25 }],
          weightsVersion: "v2.0",
          outcome: i < 8 ? "rto" : "delivered",
          outcomeAt: new Date(now - 86400_000),
        }),
      );
    }
    await Promise.all(rows);

    const result = await tuneMerchantFraudWeights(merchantId);
    expect(result.skipped).toBeUndefined();
    expect(result.sampleSize).toBe(80);
    expect(result.perSignal.extreme_cod!.multiplier).toBeGreaterThan(1.0);
    expect(result.perSignal.fake_name_pattern!.multiplier).toBeLessThan(1.0);

    // Persisted on the merchant.
    const after = await Merchant.findById(merchantId).select("fraudConfig").lean();
    expect(after?.fraudConfig?.weightsVersion).toMatch(/^tuned-/);
    expect(after?.fraudConfig?.lastTunedAt).toBeTruthy();
    expect(after?.fraudConfig?.baseRtoRate).toBeGreaterThan(0);
  });

  it("skips merchants with too few resolved predictions", async () => {
    const m = await createMerchant({ tier: "growth" });
    const merchantId = m._id as Types.ObjectId;
    for (let i = 0; i < 5; i++) {
      await FraudPrediction.create({
        merchantId,
        orderId: new Types.ObjectId(),
        riskScore: 50,
        pRto: 0.3,
        levelPredicted: "medium",
        customerTier: "standard",
        signals: [{ key: "high_cod", weight: 18 }],
        weightsVersion: "v2.0",
        outcome: "delivered",
        outcomeAt: new Date(),
      });
    }
    const result = await tuneMerchantFraudWeights(merchantId);
    expect(result.skipped).toBe("insufficient_sample");
  });
});
