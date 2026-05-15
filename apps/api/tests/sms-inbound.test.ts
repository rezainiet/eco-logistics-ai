import { describe, expect, it } from "vitest";
import { parseSmsInbound } from "../src/lib/sms-inbound.js";

describe("parseSmsInbound", () => {
  it("recognises plain YES + code", () => {
    const r = parseSmsInbound("YES 123456");
    expect(r.kind).toBe("confirm");
    if (r.kind === "confirm") expect(r.code).toBe("123456");
  });

  it("recognises NO and CANCEL with a code", () => {
    expect(parseSmsInbound("NO 123456").kind).toBe("reject");
    expect(parseSmsInbound("cancel 999999").kind).toBe("reject");
  });

  it("recognises transliterations and single letters", () => {
    expect(parseSmsInbound("Ha 123456").kind).toBe("confirm");
    expect(parseSmsInbound("na 123456").kind).toBe("reject");
    expect(parseSmsInbound("Y 123456").kind).toBe("confirm");
    expect(parseSmsInbound("N 123456").kind).toBe("reject");
  });

  // BD reality: most replies are informal and carry NO code. The parser
  // must surface the intent (code:null) and let the webhook bind it only
  // when the phone has a single pending order.
  it("recognises informal confirmations WITHOUT a code", () => {
    for (const msg of ["yes please", "OK", "okay", "done", "ji", "hmm"]) {
      const r = parseSmsInbound(msg);
      expect(r.kind, msg).toBe("confirm");
      if (r.kind === "confirm") expect(r.code).toBeNull();
    }
  });

  it("recognises Bangla-script confirmations", () => {
    for (const msg of ["হ্যাঁ", "হ্যা", "জি", "ঠিক আছে", "👍"]) {
      expect(parseSmsInbound(msg).kind, msg).toBe("confirm");
    }
  });

  it("recognises Bangla-script / phrase rejections", () => {
    for (const msg of ["না", "লাগবে না", "চাই না", "বাতিল", "👎"]) {
      expect(parseSmsInbound(msg).kind, msg).toBe("reject");
    }
  });

  it("does NOT fire reject on না as an incidental substring", () => {
    // "জানা" / "মানা" contain না but are not a rejection.
    expect(parseSmsInbound("জানা নেই 123456").kind).not.toBe("reject");
  });

  it("ignores conflicting intent (a confirm AND a reject word)", () => {
    expect(parseSmsInbound("YES 123456 actually NO").kind).toBe("ignore");
    expect(parseSmsInbound("ha na").kind).toBe("ignore");
  });

  it("ignores empty/garbage input", () => {
    expect(parseSmsInbound("").kind).toBe("ignore");
    expect(parseSmsInbound("   ").kind).toBe("ignore");
    // @ts-expect-error -- testing defensive null path
    expect(parseSmsInbound(null).kind).toBe("ignore");
  });

  it("ignores a bare code with no intent word (never assumes yes)", () => {
    expect(parseSmsInbound("call me 123456").kind).toBe("ignore");
    expect(parseSmsInbound("123456").kind).toBe("ignore");
  });

  it("extracts the code when present alongside informal intent", () => {
    const r = parseSmsInbound("  Yes,  Code: 123456");
    expect(r.kind).toBe("confirm");
    if (r.kind === "confirm") expect(r.code).toBe("123456");
    const five = parseSmsInbound("yes 12345"); // 5-digit ≠ code
    expect(five.kind).toBe("confirm");
    if (five.kind === "confirm") expect(five.code).toBeNull();
  });

  it("returns matchedOn for audit", () => {
    const r = parseSmsInbound("okay");
    if (r.kind === "confirm") expect(typeof r.matchedOn).toBe("string");
  });
});
