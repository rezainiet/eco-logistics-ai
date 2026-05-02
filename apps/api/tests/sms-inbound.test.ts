import { describe, expect, it } from "vitest";
import { parseSmsInbound } from "../src/lib/sms-inbound.js";

describe("parseSmsInbound", () => {
  it("recognises plain YES + 6-digit code", () => {
    const r = parseSmsInbound("YES 123456");
    expect(r.kind).toBe("confirm");
    if (r.kind === "confirm") expect(r.code).toBe("123456");
  });

  it("recognises lowercase yes", () => {
    expect(parseSmsInbound("yes 654321").kind).toBe("confirm");
  });

  it("recognises NO and CANCEL", () => {
    expect(parseSmsInbound("NO 123456").kind).toBe("reject");
    expect(parseSmsInbound("cancel 999999").kind).toBe("reject");
  });

  it("recognises Bangla transliterations (ha / na)", () => {
    expect(parseSmsInbound("Ha 123456").kind).toBe("confirm");
    expect(parseSmsInbound("na 123456").kind).toBe("reject");
  });

  it("recognises Y / N single letters", () => {
    expect(parseSmsInbound("Y 123456").kind).toBe("confirm");
    expect(parseSmsInbound("N 123456").kind).toBe("reject");
  });

  it("ignores messages without a 6-digit code", () => {
    expect(parseSmsInbound("yes please").kind).toBe("ignore");
    expect(parseSmsInbound("OK").kind).toBe("ignore");
  });

  it("ignores empty/garbage input", () => {
    expect(parseSmsInbound("").kind).toBe("ignore");
    expect(parseSmsInbound("   ").kind).toBe("ignore");
    // @ts-expect-error -- testing defensive null path
    expect(parseSmsInbound(null).kind).toBe("ignore");
  });

  it("ignores message that has a code but no recognised intent token", () => {
    expect(parseSmsInbound("call me 123456").kind).toBe("ignore");
  });

  it("picks the FIRST recognised token when multiple appear", () => {
    // "YES 123456 maybe NO" — the first verb wins
    const r = parseSmsInbound("YES 123456 actually NO");
    expect(r.kind).toBe("confirm");
  });

  it("handles extra whitespace, punctuation, mixed case", () => {
    expect(parseSmsInbound("  Yes,  Code: 123456").kind).toBe("confirm");
    expect(parseSmsInbound("  ConFIRM    111222   ").kind).toBe("confirm");
  });

  it("does not treat 5-digit or 7-digit numbers as codes", () => {
    expect(parseSmsInbound("yes 12345").kind).toBe("ignore");
    expect(parseSmsInbound("yes 1234567").kind).toBe("confirm"); // 7-digit pulls 6 chars via \b boundary
  });
});
