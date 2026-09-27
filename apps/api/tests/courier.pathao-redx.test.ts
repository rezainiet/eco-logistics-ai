import { describe, expect, it } from "vitest";
import {
  parsePathaoWebhook,
  verifyPathaoWebhookSecret,
} from "../src/lib/couriers/pathao.js";
import {
  parseRedxWebhook,
  verifyRedxWebhookToken,
} from "../src/lib/couriers/redx.js";

/* -------------------------------------------------------------------------- */
/* Pathao                                                                      */
/* -------------------------------------------------------------------------- */

// Pathao's X-PATHAO-Signature carries the webhook secret itself (official plugin).
describe("verifyPathaoWebhookSecret", () => {
  const secret = "pathao-secret";

  it("accepts the configured secret", () => {
    expect(verifyPathaoWebhookSecret(secret, secret)).toBe(true);
  });

  it("accepts array-form header", () => {
    expect(verifyPathaoWebhookSecret([secret], secret)).toBe(true);
  });

  it("rejects when no secret is configured", () => {
    expect(verifyPathaoWebhookSecret(secret, undefined)).toBe(false);
  });

  it("rejects a wrong secret, including a prefix of the right one", () => {
    expect(verifyPathaoWebhookSecret("other", secret)).toBe(false);
    expect(verifyPathaoWebhookSecret(secret.slice(0, -1), secret)).toBe(false);
  });

  it("rejects a missing or empty header", () => {
    expect(verifyPathaoWebhookSecret(undefined, secret)).toBe(false);
    expect(verifyPathaoWebhookSecret("", secret)).toBe(false);
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

// RedX puts the credential in the callback URL's query string (official docs).
describe("verifyRedxWebhookToken", () => {
  const secret = "redx-secret";

  it("accepts the configured token", () => {
    expect(verifyRedxWebhookToken(secret, secret)).toBe(true);
  });

  it("rejects a wrong, missing or non-string token", () => {
    expect(verifyRedxWebhookToken("nope", secret)).toBe(false);
    expect(verifyRedxWebhookToken(undefined, secret)).toBe(false);
    expect(verifyRedxWebhookToken({ token: secret }, secret)).toBe(false);
    expect(verifyRedxWebhookToken(secret, undefined)).toBe(false);
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
