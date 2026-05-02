import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkSmsWebhookAuth,
  readSignatureHeader,
  verifySmsWebhookSignature,
} from "../src/lib/sms/webhook-verify.js";
import { parseSmsInbound } from "../src/lib/sms-inbound.js";

const SECRET = "shared-secret-test";
const BODY = JSON.stringify({ from: "8801711111111", body: "YES 12345678" });
const SIG = createHmac("sha256", SECRET).update(BODY).digest("hex");

describe("verifySmsWebhookSignature", () => {
  it("accepts a matching hex HMAC", () => {
    expect(verifySmsWebhookSignature(BODY, SIG, SECRET)).toBe(true);
  });

  it("rejects when secret is undefined", () => {
    expect(verifySmsWebhookSignature(BODY, SIG, undefined)).toBe(false);
  });

  it("rejects when signature is missing or empty", () => {
    expect(verifySmsWebhookSignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifySmsWebhookSignature(BODY, "", SECRET)).toBe(false);
    expect(verifySmsWebhookSignature(BODY, "   ", SECRET)).toBe(false);
  });

  it("rejects on body tampering", () => {
    const tampered = JSON.stringify({ from: "8801711111111", body: "NO 12345678" });
    expect(verifySmsWebhookSignature(tampered, SIG, SECRET)).toBe(false);
  });

  it("rejects with the wrong secret", () => {
    expect(verifySmsWebhookSignature(BODY, SIG, "other-secret")).toBe(false);
  });

  it("rejects malformed (non-hex) signature without throwing", () => {
    expect(verifySmsWebhookSignature(BODY, "not-hex-at-all", SECRET)).toBe(false);
  });
});

describe("readSignatureHeader", () => {
  it("reads x-signature in lower-case", () => {
    expect(readSignatureHeader({ "x-signature": "abc" })).toBe("abc");
  });
  it("falls back to provider-prefixed aliases", () => {
    expect(readSignatureHeader({ "x-ssl-signature": "def" })).toBe("def");
    expect(readSignatureHeader({ "x-bulksms-signature": "ghi" })).toBe("ghi");
  });
  it("returns first value when header is array-form", () => {
    expect(readSignatureHeader({ "x-signature": ["abc", "def"] })).toBe("abc");
  });
  it("returns null when no recognized header is present", () => {
    expect(readSignatureHeader({ authorization: "Bearer x" })).toBeNull();
  });
});

describe("checkSmsWebhookAuth", () => {
  it("returns ok=true on a valid signed request", () => {
    expect(
      checkSmsWebhookAuth(BODY, { "x-signature": SIG }, SECRET),
    ).toEqual({ ok: true });
  });
  it("returns ok=false with reason='no_secret_configured' when secret unset", () => {
    expect(
      checkSmsWebhookAuth(BODY, { "x-signature": SIG }, undefined),
    ).toEqual({ ok: false, reason: "no_secret_configured" });
  });
  it("returns ok=false with reason='missing_signature'", () => {
    expect(
      checkSmsWebhookAuth(BODY, {}, SECRET),
    ).toEqual({ ok: false, reason: "missing_signature" });
  });
  it("returns ok=false with reason='mismatch' on tampered body", () => {
    const tampered = '{"from":"8801711111111","body":"YES 99999999"}';
    expect(
      checkSmsWebhookAuth(tampered, { "x-signature": SIG }, SECRET),
    ).toEqual({ ok: false, reason: "mismatch" });
  });
});

describe("parseSmsInbound — 8-digit code support", () => {
  it("accepts 8-digit codes (new format)", () => {
    const r = parseSmsInbound("YES 12345678");
    expect(r.kind).toBe("confirm");
    if (r.kind === "confirm") expect(r.code).toBe("12345678");
  });
  it("still accepts 6-digit codes (in-flight orders during transition)", () => {
    const r = parseSmsInbound("YES 123456");
    expect(r.kind).toBe("confirm");
    if (r.kind === "confirm") expect(r.code).toBe("123456");
  });
  it("rejects 5-digit numbers", () => {
    expect(parseSmsInbound("YES 12345").kind).toBe("ignore");
  });
  it("rejects 9-digit (too long, captures only 8 if at end)", () => {
    // \b boundary makes "123456789" a 9-digit token, not matched by {6,8}
    const r = parseSmsInbound("YES 123456789");
    // A 9-digit run as a whole token does not match \b\d{6,8}\b — ignore
    expect(r.kind).toBe("ignore");
  });
  it("uses Bangla 'ha' with 8-digit code", () => {
    expect(parseSmsInbound("ha 12345678").kind).toBe("confirm");
  });
});
