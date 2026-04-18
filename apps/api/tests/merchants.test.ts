import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";

describe("merchantsRouter", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("getProfile returns the authenticated merchant", async () => {
    const m = await createMerchant({ businessName: "Acme" });
    const caller = callerFor(authUserFor(m));

    const profile = await caller.merchants.getProfile();
    expect(profile.businessName).toBe("Acme");
    expect(profile.country).toBe("BD");
    expect(profile.subscription?.tier).toBe("starter");
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

  it("getCouriers returns configured couriers without apiKey", async () => {
    const m = await createMerchant();
    const caller = callerFor(authUserFor(m));

    const couriers = await caller.merchants.getCouriers();
    expect(couriers).toHaveLength(2);
    expect(couriers[0]).toMatchObject({ name: "Steadfast", preferredDistricts: ["Dhaka", "Chattogram"] });
    expect(couriers[0]).not.toHaveProperty("apiKey");
  });
});
