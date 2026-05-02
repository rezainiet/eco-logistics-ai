import { describe, expect, it } from "vitest";
import { __TEST, parseDlrPayload } from "../src/lib/sms-dlr.js";

const { extractConfirmationCode, normalizeStatusToken } = __TEST;

describe("extractConfirmationCode", () => {
  it("pulls the trailing 6 digits from our minted csmsId", () => {
    expect(extractConfirmationCode("confirm-ORD-XYZ-123456")).toBe("123456");
    expect(extractConfirmationCode("confirm-ORD-A1B2-987654")).toBe("987654");
  });
  it("returns null for missing or malformed csmsId", () => {
    expect(extractConfirmationCode(undefined)).toBeNull();
    expect(extractConfirmationCode(null)).toBeNull();
    expect(extractConfirmationCode("")).toBeNull();
    expect(extractConfirmationCode("garbage")).toBeNull();
    expect(extractConfirmationCode("confirm-ORD-12345")).toBeNull(); // 5 digits
  });
  it("ignores non-trailing 6-digit runs", () => {
    // The order number could contain digits — only trailing 6 count.
    expect(extractConfirmationCode("confirm-9999999-A-555444")).toBe("555444");
  });
});

describe("normalizeStatusToken", () => {
  it("maps SSL Wireless DELIVERED variants", () => {
    expect(normalizeStatusToken("DELIVERED")).toBe("delivered");
    expect(normalizeStatusToken("delivrd")).toBe("delivered");
    expect(normalizeStatusToken("SUCCESS")).toBe("delivered");
  });
  it("maps failure variants", () => {
    expect(normalizeStatusToken("REJECTED")).toBe("failed");
    expect(normalizeStatusToken("Undelivered")).toBe("failed");
    expect(normalizeStatusToken("EXPIRED")).toBe("failed");
    expect(normalizeStatusToken("invalid_number")).toBe("failed");
  });
  it("maps pending variants", () => {
    expect(normalizeStatusToken("PENDING")).toBe("pending");
    expect(normalizeStatusToken("submitted")).toBe("pending");
    expect(normalizeStatusToken("ENROUTE")).toBe("pending");
  });
  it("returns 'unknown' for empty / weird inputs", () => {
    expect(normalizeStatusToken(undefined)).toBe("unknown");
    expect(normalizeStatusToken(null)).toBe("unknown");
    expect(normalizeStatusToken("")).toBe("unknown");
    expect(normalizeStatusToken("UFO_ABDUCTED")).toBe("unknown");
  });
});

describe("parseDlrPayload — provider-shape coverage", () => {
  it("parses a canonical SSL Wireless DELIVERED payload", () => {
    const r = parseDlrPayload({
      smsstatus: "DELIVERED",
      csms_id: "confirm-ORD-42-123456",
      reference_id: "REF-99",
      delivered_at: "2026-01-01T08:00:00Z",
    });
    expect(r.status).toBe("delivered");
    expect(r.code).toBe("123456");
    expect(r.providerRef).toBe("REF-99");
    expect(r.deliveredAt?.toISOString()).toBe("2026-01-01T08:00:00.000Z");
    expect(r.error).toBeNull();
  });

  it("falls back to a synthetic deliveredAt when provider doesn't supply one", () => {
    const before = Date.now();
    const r = parseDlrPayload({
      status: "delivered",
      csms_id: "confirm-ORD-9-654321",
    });
    expect(r.status).toBe("delivered");
    expect(r.code).toBe("654321");
    expect(r.deliveredAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("parses a REJECTED payload with error_message + ref_id", () => {
    const r = parseDlrPayload({
      smsstatus: "REJECTED",
      csms_id: "confirm-ORD-X-111222",
      ref_id: "EVT-7",
      error_message: "Number not in operator network",
    });
    expect(r.status).toBe("failed");
    expect(r.error).toBe("Number not in operator network");
    expect(r.providerRef).toBe("EVT-7");
    expect(r.deliveredAt).toBeNull();
  });

  it("parses a generic gateway shape (status + message_id)", () => {
    const r = parseDlrPayload({
      status: "Undelivered",
      message_id: "msg-confirm-ORD-Q-987654",
      reason: "carrier blocked",
    });
    expect(r.status).toBe("failed");
    expect(r.code).toBe("987654");
    expect(r.error).toBe("carrier blocked");
  });

  it("returns unknown for unrecognised status fields", () => {
    const r = parseDlrPayload({ smsstatus: "BANANA", csms_id: "confirm-ORD-Q-111111" });
    expect(r.status).toBe("unknown");
    expect(r.code).toBe("111111");
  });

  it("returns unknown when payload is null/non-object", () => {
    expect(parseDlrPayload(null).status).toBe("unknown");
    expect(parseDlrPayload(undefined).status).toBe("unknown");
    expect(parseDlrPayload("not a json").status).toBe("unknown");
    expect(parseDlrPayload(42).status).toBe("unknown");
  });

  it("clamps oversized error and providerRef strings", () => {
    const longError = "x".repeat(800);
    const longRef = "y".repeat(400);
    const r = parseDlrPayload({
      status: "FAILED",
      csms_id: "confirm-ORD-1-123456",
      error_message: longError,
      reference_id: longRef,
    });
    expect(r.error!.length).toBe(500);
    expect(r.providerRef!.length).toBe(200);
  });

  it("handles WhatsApp-style camelCase fields", () => {
    const r = parseDlrPayload({
      messageStatus: "delivered",
      messageId: "wa-confirm-ORD-W-444555",
      deliveredAt: "2026-02-01T10:00:00Z",
    });
    expect(r.status).toBe("delivered");
    expect(r.code).toBe("444555");
    expect(r.deliveredAt?.toISOString()).toBe("2026-02-01T10:00:00.000Z");
  });
});
