import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";

describe("merchantsRouter", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("getProfile returns the authenticated merchant with billing view", async () => {
    const m = await createMerchant({ businessName: "Acme" });
    const caller = callerFor(authUserFor(m));

    const profile = await caller.merchants.getProfile();
    expect(profile.businessName).toBe("Acme");
    expect(profile.country).toBe("BD");
    expect(profile.billing.tier).toBe("scale");
    expect(["trial", "active"]).toContain(profile.billing.status);
  });

  it("updateProfile persists business info changes", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    const updated = await caller.merchants.updateProfile({ businessName: "Renamed Co", language: "bn" });
    expect(updated.businessName).toBe("Renamed Co");
    expect(updated.language).toBe("bn");

    const profile = await caller.merchants.getProfile();
    expect(profile.businessName).toBe("Renamed Co");
  });

  it("getCouriers returns masked credentials only", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    const couriers = await caller.merchants.getCouriers();
    expect(couriers).toHaveLength(2);
    const sf = couriers.find((c) => c.name === "steadfast");
    expect(sf).toBeDefined();
    expect(sf?.preferredDistricts).toEqual(["Dhaka", "Chattogram"]);
    // apiKey is never returned in plaintext — only a mask.
    expect((sf as Record<string, unknown>).apiKey).toBeUndefined();
    expect(typeof sf?.apiKeyMasked).toBe("string");
  });

  it("upsertCourier encrypts the api key and does not leak plaintext", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    const plain = "pk_test_SECRET_xyz1234";
    const result = await caller.merchants.upsertCourier({
      name: "pathao",
      accountId: "acc-new",
      apiKey: plain,
      preferredDistricts: ["Dhaka"],
    });
    expect(result.apiKeyMasked.endsWith("1234")).toBe(true);
    expect(result.apiKeyMasked).not.toContain(plain);

    const couriers = await caller.merchants.getCouriers();
    const pathao = couriers.find((c) => c.name === "pathao");
    expect(pathao?.accountId).toBe("acc-new");
    expect(pathao?.apiKeyMasked.endsWith("1234")).toBe(true);
  });

  it("removeCourier deletes a configured courier", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    await caller.merchants.removeCourier({ name: "pathao" });
    const couriers = await caller.merchants.getCouriers();
    expect(couriers.find((c) => c.name === "pathao")).toBeUndefined();
  });
});
