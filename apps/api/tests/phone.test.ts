import { describe, expect, it } from "vitest";
import {
  normalizePhone,
  normalizePhoneOrRaw,
  phoneLookupVariants,
} from "../src/lib/phone.js";

describe("normalizePhone", () => {
  it("normalizes BD national 11-digit (01711…) to E.164", () => {
    expect(normalizePhone("01711111111")).toBe("+8801711111111");
  });

  it("preserves already-E.164 BD numbers", () => {
    expect(normalizePhone("+8801711111111")).toBe("+8801711111111");
  });

  it("normalizes BD with country code but no plus", () => {
    expect(normalizePhone("8801711111111")).toBe("+8801711111111");
  });

  it("handles BD with spaces, dashes, parentheses", () => {
    expect(normalizePhone("+88 (017) 1111-1111")).toBe("+8801711111111");
  });

  it("returns null for inputs that can't be normalized to E.164", () => {
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it("normalizes IN 10-digit national with default country", () => {
    expect(normalizePhone("9876543210", "IN")).toBe("+919876543210");
  });

  it("respects an already-prefixed +91 even when default is BD", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("+919876543210");
  });

  it("rejects too-short E.164 inputs", () => {
    expect(normalizePhone("+1234")).toBeNull();
  });

  it("rejects too-long E.164 inputs", () => {
    expect(normalizePhone("+99999999999999999")).toBeNull();
  });
});

describe("normalizePhoneOrRaw", () => {
  it("returns canonical when possible", () => {
    expect(normalizePhoneOrRaw("01711111111")).toBe("+8801711111111");
  });

  it("falls back to cleaned digits when the input is too short to E.164-normalize", () => {
    // 6 digits — under E.164 minimum, so normalizePhone returns null and the
    // OrRaw helper drops to the cleaned form rather than dropping the value.
    expect(normalizePhoneOrRaw("123-456")).toBe("123456");
  });
});

describe("phoneLookupVariants", () => {
  it("expands a BD canonical number into all common write-forms", () => {
    const v = phoneLookupVariants("+8801711111111");
    expect(v).toEqual(
      expect.arrayContaining([
        "+8801711111111",
        "01711111111",
        "1711111111",
        "8801711111111",
      ]),
    );
  });

  it("returns empty for missing input", () => {
    expect(phoneLookupVariants(null)).toEqual([]);
  });
});
