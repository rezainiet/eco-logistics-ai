import { describe, expect, it } from "vitest";
import { buildPatch, formFromConfig, splitList, type FraudConfigView } from "./rules-form";

const base: FraudConfigView = {
  highCodThreshold: null,
  extremeCodThreshold: null,
  suspiciousDistricts: [],
  blockedPhones: ["8801711000000"],
  blockedAddresses: ["abc123abc123abc1"],
  velocityThreshold: 0,
  velocityWindowMin: 10,
  alertOnPendingReview: true,
};

describe("verification rules form", () => {
  it("round-trips the saved config with no changes", () => {
    expect(buildPatch(formFromConfig(base), base)).toEqual({ patch: {}, errors: {} });
  });

  it("sends only what changed", () => {
    const form = { ...formFromConfig(base), highCod: "5,000", extremeCod: "15000", districts: "Dhaka\nCox's Bazar, Dhaka", alertOnPendingReview: false };
    const { patch, errors } = buildPatch(form, base);
    expect(errors).toEqual({});
    expect(patch).toEqual({
      highCodThreshold: 5000,
      extremeCodThreshold: 15000,
      suspiciousDistricts: ["Dhaka", "Cox's Bazar"],
      alertOnPendingReview: false,
    });
  });

  it("clears a threshold back to automatic", () => {
    const withHigh = { ...base, highCodThreshold: 4000 };
    const { patch } = buildPatch({ ...formFromConfig(withHigh), highCod: "" }, withHigh);
    expect(patch).toEqual({ highCodThreshold: null });
  });

  it("validates amounts, phones, velocity and threshold order", () => {
    const { errors } = buildPatch(
      { ...formFromConfig(base), highCod: "abc", extremeCod: "100", phones: "017\n01711000001", velocity: "-1", velocityWindow: "0" },
      base,
    );
    expect(Object.keys(errors).sort()).toEqual(["highCod", "phones", "velocity", "velocityWindow"].sort());
    const order = buildPatch({ ...formFromConfig(base), highCod: "9000", extremeCod: "5000" }, base);
    expect(order.errors.extremeCod).toMatch(/higher/);
  });

  it("adds new addresses (with optional district) and keeps the existing hashes", () => {
    const { patch } = buildPatch({ ...formFromConfig(base), newAddresses: "House 12, Road 5, Dhanmondi, Dhaka\nVillage Bazar Road" }, base);
    expect(patch.blockedAddresses).toEqual(["abc123abc123abc1"]);
    expect(patch.blockedAddressesRaw).toEqual([
      { address: "House 12, Road 5, Dhanmondi", district: "Dhaka" },
      { address: "Village Bazar Road" },
    ]);
  });

  it("can clear every blocked address", () => {
    const { patch } = buildPatch({ ...formFromConfig(base), clearAddresses: true }, base);
    expect(patch).toEqual({ blockedAddresses: [] });
  });

  it("splits lists on new lines and commas, de-duplicated", () => {
    expect(splitList(" a, b\n\nb ,c ")).toEqual(["a", "b", "c"]);
    expect(splitList("x, y\nz", { commas: false })).toEqual(["x, y", "z"]);
  });
});
