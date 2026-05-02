import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Merchant } from "@ecom/db";
import { authUserFor, callerFor, createMerchant, disconnectDb, resetDb } from "./helpers.js";
import {
  __resetSmsTransport,
  __setSmsTransport,
} from "../src/lib/sms/index.js";

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

  describe("sendTestSms", () => {
    it("sends to the merchant's stored phone and returns a masked suffix", async () => {
      const m = await createMerchant();
      // createMerchant defaults phone to +8801700000000 — last 4 = "0000".
      const caller = callerFor(authUserFor(m));
      const sent: Array<{ to: string; body: string }> = [];
      __setSmsTransport({
        async send({ to, body }) {
          sent.push({ to, body });
          return { ok: true, providerMessageId: "test-mid", providerStatus: "ok" };
        },
      });
      try {
        const result = await caller.merchants.sendTestSms();
        expect(result.ok).toBe(true);
        expect(result.phoneSuffix).toBe("0000");
        expect(sent).toHaveLength(1);
        expect(sent[0]!.body).toMatch(/SMS pipeline working/i);
      } finally {
        __resetSmsTransport();
      }
    });

    it("rejects when the merchant has no phone configured", async () => {
      const m = await createMerchant();
      await Merchant.updateOne({ _id: m._id }, { $unset: { phone: "" } });
      const caller = callerFor(authUserFor(m));
      await expect(caller.merchants.sendTestSms()).rejects.toThrow(/phone/i);
    });

    it("surfaces provider failures as a 5xx-class error", async () => {
      const m = await createMerchant();
      const caller = callerFor(authUserFor(m));
      __setSmsTransport({
        async send() {
          return { ok: false, error: "carrier rejected", providerStatus: "err" };
        },
      });
      try {
        await expect(caller.merchants.sendTestSms()).rejects.toThrow(/carrier rejected/);
      } finally {
        __resetSmsTransport();
      }
    });
  });
});
