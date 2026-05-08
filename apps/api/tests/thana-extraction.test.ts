import { describe, it, expect } from "vitest";
import { extractThana, __TEST } from "../src/lib/thana-lexicon.js";

/**
 * Thana extraction unit tests.
 *
 * Coverage targets:
 *  - input edge cases
 *  - exact-token match
 *  - multi-token (n-gram) match
 *  - Bangla alias resolution
 *  - "Mirpur 1" / "Mirpur-12" sector variants collapse to canonical
 *  - district disambiguation when multiple thanas share a name
 *  - refusal to guess when district ambiguity remains
 */

describe("extractThana — input handling", () => {
  it("returns null for missing / empty input", () => {
    expect(extractThana(null)).toBeNull();
    expect(extractThana(undefined)).toBeNull();
    expect(extractThana("")).toBeNull();
    expect(extractThana("   ")).toBeNull();
  });

  it("returns null when no thana matches", () => {
    expect(extractThana("Apartment 12, Some Random Building, Nowhere")).toBeNull();
  });
});

describe("extractThana — Latin matching", () => {
  it("matches a single-token thana", () => {
    expect(extractThana("Some lane in Dhanmondi area")).toBe("dhanmondi");
  });

  it("matches a multi-token thana via 2-gram", () => {
    expect(extractThana("Behind New Market, Dhaka")).toBe("new market");
  });

  it("matches a multi-token thana via 3-gram (sher-e-bangla nagar via aliases)", () => {
    expect(
      extractThana("Sher e Bangla Nagar, Dhaka"),
    ).toBe("sher-e-bangla nagar");
  });

  it("normalizes case", () => {
    expect(extractThana("UTTARA Sector 4")).toBe("uttara");
    expect(extractThana("uttara sector 4")).toBe("uttara");
    expect(extractThana("Uttara Sector 4")).toBe("uttara");
  });
});

describe("extractThana — Bangla matching", () => {
  it("matches Bangla alias", () => {
    expect(extractThana("ধানমন্ডি ৩২ নম্বর সড়ক")).toBe("dhanmondi");
  });

  it("matches Bangla alias with district hint", () => {
    expect(extractThana("যাত্রাবাড়ীর মোড়ে", "ঢাকা")).toBe("jatrabari");
  });
});

describe("extractThana — Mirpur sector variants", () => {
  it("collapses 'Mirpur 1' to canonical mirpur", () => {
    expect(extractThana("House 4, Mirpur 1, Dhaka")).toBe("mirpur");
  });

  it("collapses 'Mirpur-12' to canonical mirpur", () => {
    expect(extractThana("House 4, Mirpur-12, Dhaka")).toBe("mirpur");
  });

  it("collapses 'Mirpur14' to canonical mirpur", () => {
    expect(extractThana("Building 3, Mirpur14, Dhaka")).toBe("mirpur");
  });
});

describe("extractThana — district disambiguation", () => {
  it("prefers the candidate matching the order's district", () => {
    // "Lohagara" exists in Chittagong (lexicon entry); a Lohagara also
    // exists in other districts (not in lexicon). With CTG hint we should
    // get the CTG canonical.
    expect(extractThana("Lohagara area", "Chittagong")).toBe("lohagara ctg");
  });

  it("returns the only match when district is unset and only one candidate exists", () => {
    expect(extractThana("In Bashundhara residential area")).toBe("bashundhara");
  });
});

describe("extractThana — non-thana strings", () => {
  it("ignores landmark words like 'school' or 'bazar' (those are landmarks, not thanas)", () => {
    // 'school' is a landmark in lib/address-intelligence.ts but NOT a thana
    // alias; extractThana shouldn't return anything just because the word
    // appears.
    expect(extractThana("Behind the school")).toBeNull();
  });
});

describe("extractThana — lexicon health", () => {
  it("seed lexicon has at least 100 thanas", () => {
    expect(__TEST.thanaCount()).toBeGreaterThanOrEqual(100);
  });

  it("alias index built without dropping all entries", () => {
    expect(__TEST.aliasIndexSize()).toBeGreaterThanOrEqual(__TEST.thanaCount());
  });
});

describe("extractThana — determinism", () => {
  it("same input → same output across calls", () => {
    const a = extractThana("House 14, Mirpur 10, Dhaka", "Dhaka");
    const b = extractThana("House 14, Mirpur 10, Dhaka", "Dhaka");
    expect(a).toBe(b);
  });
});
