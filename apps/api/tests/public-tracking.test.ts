import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { Merchant, Order } from "@ecom/db";
import {
  fetchPublicTimeline,
  maskDeliveryAddress,
} from "../src/lib/public-tracking.js";
import { createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

async function makeOrder(
  merchantId: Types.ObjectId,
  trackingNumber: string,
  overrides: { status?: string; address?: string; district?: string; cod?: number } = {},
) {
  return Order.create({
    merchantId,
    orderNumber: `ORD-PT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    customer: {
      name: "Customer X",
      phone: "+8801711111111",
      address: overrides.address ?? "House 12, Road 4, Banani",
      district: overrides.district ?? "Dhaka",
    },
    items: [{ name: "T-Shirt", quantity: 1, price: 500 }],
    order: { cod: overrides.cod ?? 500, total: overrides.cod ?? 500, status: overrides.status ?? "shipped" },
    logistics: {
      courier: "steadfast",
      trackingNumber,
      trackingEvents: [
        {
          at: new Date("2026-01-01T08:00:00Z"),
          providerStatus: "in_transit",
          normalizedStatus: "in_transit",
          description: "Departed Dhaka hub",
          location: "Dhaka Hub",
          dedupeKey: "k1",
        },
        {
          at: new Date("2026-01-01T06:00:00Z"),
          providerStatus: "picked_up",
          normalizedStatus: "picked_up",
          description: "Picked up from merchant",
          dedupeKey: "k2",
        },
      ],
    },
  });
}

describe("maskDeliveryAddress", () => {
  it("masks all but the trailing area+district when 3+ parts present", () => {
    expect(maskDeliveryAddress("House 12, Road 4, Banani, Dhaka", "Dhaka")).toBe("***, Banani, Dhaka");
    expect(maskDeliveryAddress("123 Main St, Apartment 4B, Mirpur 10, Dhaka", "Dhaka")).toBe("***, Mirpur 10, Dhaka");
  });

  it("returns just the district for single-line addresses", () => {
    expect(maskDeliveryAddress("Banani", "Dhaka")).toBe("Dhaka");
    expect(maskDeliveryAddress("", "Dhaka")).toBe("Dhaka");
  });

  it("handles two-part addresses by district-only", () => {
    expect(maskDeliveryAddress("House 1, Banani", "Dhaka")).toBe("Dhaka");
  });
});

describe("fetchPublicTimeline", () => {
  beforeEach(async () => {
    await ensureDb();
    await resetDb();
  });
  afterAll(disconnectDb);

  it("returns null on miss + handles too-short codes", async () => {
    expect(await fetchPublicTimeline("xx")).toBeNull();
    expect(await fetchPublicTimeline("MISSING-CODE")).toBeNull();
  });

  it("returns the safe-shape timeline for a real order", async () => {
    const m = await createMerchant({ businessName: "Acme Mart" });
    await Merchant.updateOne(
      { _id: m._id },
      {
        $set: {
          branding: {
            displayName: "Acme",
            primaryColor: "#0f766e",
            supportPhone: "+8801700000000",
            supportEmail: "help@acme.test",
            logoUrl: "https://cdn.example.com/acme.png",
          },
        },
      },
    );
    await makeOrder(m._id as Types.ObjectId, "SF-PUB-1");

    const r = await fetchPublicTimeline("SF-PUB-1");
    expect(r).not.toBeNull();
    expect(r!.orderNumber).toMatch(/^ORD-PT-/);
    expect(r!.status).toBe("shipped");
    expect(r!.cod).toBe(500);
    expect(r!.courier).toBe("steadfast");
    expect(r!.trackingNumber).toBe("SF-PUB-1");
    expect(r!.maskedAddress).toBe("***, Road 4, Banani"); // address masked
    expect(r!.branding.displayName).toBe("Acme");
    expect(r!.branding.primaryColor).toBe("#0f766e");
    expect(r!.branding.logoUrl).toBe("https://cdn.example.com/acme.png");
  });

  it("never leaks customer phone, full address, or fraud signals", async () => {
    const m = await createMerchant();
    await makeOrder(m._id as Types.ObjectId, "SF-PUB-2");
    const r = await fetchPublicTimeline("SF-PUB-2");
    const json = JSON.stringify(r);
    // Phone never surfaces.
    expect(json).not.toContain("+8801711111111");
    // Internal merchant id never surfaces.
    expect(json).not.toContain(String(m._id));
    // House numbers from the unmasked address never surface.
    expect(json).not.toContain("House 12");
    // No fraud / risk fields.
    expect(json).not.toContain("riskScore");
    expect(json).not.toContain("fraud");
  });

  it("rejects a hostile primaryColor (not 7-char hex) and serves nothing for it", async () => {
    const m = await createMerchant();
    await Merchant.updateOne(
      { _id: m._id },
      {
        $set: {
          // Stored without strict-mode validation — simulates a value that
          // somehow bypassed the schema validator (e.g. legacy import).
          "branding.primaryColor": "javascript:alert(1)",
        },
      },
      { strict: false },
    );
    await makeOrder(m._id as Types.ObjectId, "SF-PUB-3");
    const r = await fetchPublicTimeline("SF-PUB-3");
    expect(r!.branding.primaryColor).toBeUndefined();
  });

  it("rejects a non-https logoUrl", async () => {
    const m = await createMerchant();
    await Merchant.updateOne(
      { _id: m._id },
      { $set: { "branding.logoUrl": "javascript:alert(1)" } },
      { strict: false },
    );
    await makeOrder(m._id as Types.ObjectId, "SF-PUB-4");
    const r = await fetchPublicTimeline("SF-PUB-4");
    expect(r!.branding.logoUrl).toBeUndefined();
  });

  it("orders events newest-first", async () => {
    const m = await createMerchant();
    await makeOrder(m._id as Types.ObjectId, "SF-PUB-5");
    const r = await fetchPublicTimeline("SF-PUB-5");
    // First two events are in_transit (newer) then picked_up (older); a
    // synthetic "placed" event is appended at the end.
    expect(r!.events.length).toBeGreaterThanOrEqual(2);
    expect(r!.events[0]!.status).toBe("in_transit");
  });
});
