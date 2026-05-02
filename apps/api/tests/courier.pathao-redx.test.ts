import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  parsePathaoWebhook,
  verifyPathaoWebhookSignature,
} from "../src/lib/couriers/pathao.js";
import {
  parseRedxWebhook,
  verifyRedxWebhookSignature,
} from "../src/lib/couriers/redx.js";

/* -------------------------------------------------------------------------- */
/* Pathao                                                                      */
/* -------------------------------------------------------------------------- */

describe("verifyPathaoWebhookSignature", () => {
  const secret = "pathao-secret";
  const body = JSON.stringify({ consignment_id: "P-1", order_status: "Delivered" });
  const sig = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts matching signature", () => {
    expect(verifyPathaoWebhookSignature(body, sig, secret)).toBe(true);
  });

  it("accepts array-form header", () => {
    expect(verifyPathaoWebhookSignature(body, [sig], secret)).toBe(true);
  });

  it("rejects missing secret", () => {
    expect(verifyPathaoWebhookSignature(body, sig, undefined)).toBe(false);
  });

  it("rejects wrong secret", () => {
    expect(verifyPathaoWebhookSignature(body, sig, "other")).toBe(false);
  });

  it("rejects tampered body", () => {
    const tampered = JSON.stringify({ consignment_id: "P-1", order_status: "Returned" });
    expect(verifyPathaoWebhookSignature(tampered, sig, secret)).toBe(false);
  });

  it("rejects empty signature", () => {
    expect(verifyPathaoWebhookSignature(body, "", secret)).toBe(false);
  });
});

describe("parsePathaoWebhook", () => {
  it("normalizes a delivered payload", () => {
    const r = parsePathaoWebhook({
      consignment_id: "P-42",
      order_status: "Delivered",
      updated_at: "2026-01-01T10:00:00Z",
      delivered_at: "2026-01-01T10:30:00Z",
      reason: "Handed to customer",
    });
    expect(r).not.toBeNull();
    expect(r!.trackingCode).toBe("P-42");
    expect(r!.normalizedStatus).toBe("delivered");
    expect(r!.providerStatus).toBe("Delivered");
    expect(r!.deliveredAt?.toISOString()).toBe("2026-01-01T10:30:00.000Z");
  });

  it("returns null when consignment_id is absent", () => {
    expect(parsePathaoWebhook({ order_status: "ping" })).toBeNull();
  });

  it("falls back to order_status_slug when order_status is absent", () => {
    const r = parsePathaoWebhook({ consignment_id: "P-1", order_status_slug: "in_transit" });
    expect(r!.providerStatus).toBe("in_transit");
    expect(r!.normalizedStatus).toBe("in_transit");
  });

  it("normalizes RTO synonyms", () => {
    expect(
      parsePathaoWebhook({ consignment_id: "P-1", order_status: "Returned to merchant" })!
        .normalizedStatus,
    ).toBe("rto");
  });

  it("falls back to now() when delivered_at is invalid", () => {
    const r = parsePathaoWebhook({
      consignment_id: "P-1",
      order_status: "Delivered",
      delivered_at: "not a date",
    });
    expect(r!.deliveredAt).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* RedX                                                                        */
/* -------------------------------------------------------------------------- */

describe("verifyRedxWebhookSignature", () => {
  const secret = "redx-secret";
  const body = JSON.stringify({ tracking_id: "R-1", status: "delivered" });
  const sig = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts matching signature", () => {
    expect(verifyRedxWebhookSignature(body, sig, secret)).toBe(true);
  });

  it("rejects bogus signature", () => {
    expect(verifyRedxWebhookSignature(body, "not-hex", secret)).toBe(false);
  });
});

describe("parseRedxWebhook", () => {
  it("normalizes a delivery payload", () => {
    const r = parseRedxWebhook({
      tracking_id: "R-42",
      status: "delivered",
      status_change_time: "2026-01-01T08:00:00Z",
      hub: "Mirpur Hub",
      status_message: "Delivery completed",
    });
    expect(r!.trackingCode).toBe("R-42");
    expect(r!.normalizedStatus).toBe("delivered");
    expect(r!.location).toBe("Mirpur Hub");
    expect(r!.description).toBe("Delivery completed");
  });

  it("falls back to parcel_tracking_id when tracking_id is absent", () => {
    const r = parseRedxWebhook({ parcel_tracking_id: "RX-99", status: "out-for-delivery" });
    expect(r!.trackingCode).toBe("RX-99");
    expect(r!.normalizedStatus).toBe("out_for_delivery");
  });

  it("returns null when no tracking id is present", () => {
    expect(parseRedxWebhook({ status: "test" })).toBeNull();
  });

  it("recognises redx-specific status names", () => {
    expect(parseRedxWebhook({ tracking_id: "X", status: "pickup-success" })!.normalizedStatus)
      .toBe("picked_up");
    expect(parseRedxWebhook({ tracking_id: "X", status: "in-hub" })!.normalizedStatus)
      .toBe("in_transit");
  });
});
