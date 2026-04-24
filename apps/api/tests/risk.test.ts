import { describe, expect, it } from "vitest";
import { __TEST, computeRisk, RISK_TIERS } from "../src/server/risk.js";

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

describe("risk engine — computeRisk", () => {
  it("returns low level + not_required for a clean order", () => {
    const r = computeRisk({ cod: 500, customer: cleanCustomer }, zeroHistory);
    expect(r.level).toBe("low");
    expect(r.riskScore).toBeLessThanOrEqual(RISK_TIERS.lowMax);
    expect(r.reviewStatus).toBe("not_required");
    expect(r.signals).toEqual([]);
  });

  it("is deterministic — same inputs produce identical output", () => {
    const args = { cod: 9500, customer: cleanCustomer };
    const a = computeRisk(args, zeroHistory);
    const b = computeRisk(args, zeroHistory);
    expect(a).toEqual(b);
  });

  it("adds high_cod signal when COD crosses threshold", () => {
    const r = computeRisk(
      { cod: __TEST.HIGH_COD_BDT + 1, customer: cleanCustomer },
      zeroHistory,
    );
    expect(r.signals.map((s) => s.key)).toContain("high_cod");
    expect(r.signals.map((s) => s.key)).not.toContain("extreme_cod");
  });

  it("extreme_cod replaces high_cod at extreme threshold", () => {
    const r = computeRisk(
      { cod: __TEST.EXTREME_COD_BDT, customer: cleanCustomer },
      zeroHistory,
    );
    expect(r.signals.map((s) => s.key)).toContain("extreme_cod");
    expect(r.signals.map((s) => s.key)).not.toContain("high_cod");
  });

  it("flags fake/gibberish names", () => {
    const cases = ["xxx", "aaaa", "test", "asdf"];
    for (const name of cases) {
      const r = computeRisk(
        { cod: 500, customer: { ...cleanCustomer, name } },
        zeroHistory,
      );
      expect(r.signals.map((s) => s.key)).toContain("fake_name_pattern");
    }
  });

  it("flags missing / suspicious districts", () => {
    const r1 = computeRisk(
      { cod: 500, customer: { ...cleanCustomer, district: "unknown" } },
      zeroHistory,
    );
    expect(r1.signals.map((s) => s.key)).toContain("suspicious_district");

    const r2 = computeRisk(
      { cod: 500, customer: { ...cleanCustomer, district: "" } },
      zeroHistory,
    );
    expect(r2.signals.map((s) => s.key)).toContain("suspicious_district");
  });

  it("honors merchant-supplied suspicious district list", () => {
    const r = computeRisk(
      { cod: 500, customer: { ...cleanCustomer, district: "Sandwip" } },
      zeroHistory,
      { suspiciousDistricts: ["Sandwip"] },
    );
    expect(r.signals.map((s) => s.key)).toContain("suspicious_district");
  });

  it("escalates duplicate phone signal by heaviness", () => {
    const warn = computeRisk(
      { cod: 500, customer: cleanCustomer },
      { ...zeroHistory, phoneOrdersCount: __TEST.DUP_PHONE_WARN },
    );
    expect(warn.signals.map((s) => s.key)).toContain("duplicate_phone");

    const heavy = computeRisk(
      { cod: 500, customer: cleanCustomer },
      { ...zeroHistory, phoneOrdersCount: __TEST.DUP_PHONE_HEAVY },
    );
    expect(heavy.signals.map((s) => s.key)).toContain("duplicate_phone_heavy");
    expect(heavy.riskScore).toBeGreaterThan(warn.riskScore);
  });

  it("promotes to high level + pending_call when signals compound", () => {
    const r = computeRisk(
      {
        cod: __TEST.EXTREME_COD_BDT,
        customer: { ...cleanCustomer, name: "xxx", district: "unknown" },
      },
      {
        ...zeroHistory,
        phoneOrdersCount: __TEST.DUP_PHONE_HEAVY,
        phoneReturnedCount: 3,
      },
    );
    expect(r.level).toBe("high");
    expect(r.reviewStatus).toBe("pending_call");
    expect(r.riskScore).toBeGreaterThan(RISK_TIERS.mediumMax);
  });

  it("caps score at 100 even with every signal firing", () => {
    const r = computeRisk(
      {
        cod: __TEST.EXTREME_COD_BDT,
        customer: { ...cleanCustomer, name: "xxx", district: "unknown" },
      },
      {
        phoneOrdersCount: 20,
        phoneReturnedCount: 5,
        phoneCancelledCount: 4,
        phoneUnreachableCount: 5,
        ipRecentCount: __TEST.IP_VELOCITY_THRESHOLD,
        phoneVelocityCount: 0,
        addressDistinctPhones: 0,
        addressReturnedCount: 0,
      },
    );
    expect(r.riskScore).toBe(100);
    expect(r.level).toBe("high");
  });

  it("ip velocity signal only fires above threshold", () => {
    const below = computeRisk(
      { cod: 500, customer: cleanCustomer, ip: "1.2.3.4" },
      { ...zeroHistory, ipRecentCount: __TEST.IP_VELOCITY_THRESHOLD - 1 },
    );
    expect(below.signals.map((s) => s.key)).not.toContain("ip_velocity");

    const at = computeRisk(
      { cod: 500, customer: cleanCustomer, ip: "1.2.3.4" },
      { ...zeroHistory, ipRecentCount: __TEST.IP_VELOCITY_THRESHOLD },
    );
    expect(at.signals.map((s) => s.key)).toContain("ip_velocity");
  });

  it("classifyLevel respects tier thresholds", () => {
    expect(__TEST.classifyLevel(0)).toBe("low");
    expect(__TEST.classifyLevel(RISK_TIERS.lowMax)).toBe("low");
    expect(__TEST.classifyLevel(RISK_TIERS.lowMax + 1)).toBe("medium");
    expect(__TEST.classifyLevel(RISK_TIERS.mediumMax)).toBe("medium");
    expect(__TEST.classifyLevel(RISK_TIERS.mediumMax + 1)).toBe("high");
    expect(__TEST.classifyLevel(100)).toBe("high");
  });
});
