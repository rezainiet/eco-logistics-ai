import { describe, it, expect } from "vitest";
import {
  computeAddressQuality,
  ADDRESS_HINT_CODES,
  type AddressHintCode,
} from "../src/lib/address-intelligence.js";

/**
 * Address Intelligence v1 unit tests.
 *
 * No DB. No mocks. Pure-function coverage:
 *  - input edge cases (null / empty / whitespace)
 *  - tier classification across the spectrum
 *  - landmark detection (Latin + Bangla + multi-category)
 *  - script-mix detection
 *  - hint generation (mutually exclusive critical-vs-individual)
 *  - score clamping
 */

describe("computeAddressQuality — input handling", () => {
  it("returns null for missing / null input", () => {
    expect(computeAddressQuality(null)).toBeNull();
    expect(computeAddressQuality(undefined)).toBeNull();
    expect(computeAddressQuality("")).toBeNull();
    expect(computeAddressQuality("   \t\n   ")).toBeNull();
  });

  it("returns a result for any non-empty trimmed input", () => {
    const r = computeAddressQuality("xyz");
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThanOrEqual(0);
    expect(r!.score).toBeLessThanOrEqual(100);
  });
});

describe("computeAddressQuality — tier mapping", () => {
  it("scores a complete BD address (number + landmark + multi-token) as 'complete'", () => {
    const r = computeAddressQuality(
      "House 14, Road 7, Block C, Mirpur DOHS, Dhaka",
      "Dhaka",
    );
    expect(r).not.toBeNull();
    expect(r!.completeness).toBe("complete");
    expect(r!.score).toBeGreaterThanOrEqual(70);
    expect(r!.hasNumber).toBe(true);
    expect(r!.landmarks.length).toBeGreaterThan(0);
  });

  it("scores a landmark-only address (no number) as at least 'partial'", () => {
    const r = computeAddressQuality(
      "Behind Green Mosque, next to chairman house, Mirpur",
      "Dhaka",
    );
    expect(r).not.toBeNull();
    expect(["partial", "complete"]).toContain(r!.completeness);
    expect(r!.landmarks).toContain("worship");
  });

  it("scores a too-short address as 'incomplete'", () => {
    const r = computeAddressQuality("Dhaka", "Dhaka");
    expect(r).not.toBeNull();
    expect(r!.completeness).toBe("incomplete");
    expect(r!.missingHints).toContain("too_short");
  });

  it("scores empty-token-count input as 'incomplete' with multiple hints", () => {
    const r = computeAddressQuality("a b", "Dhaka");
    expect(r).not.toBeNull();
    expect(r!.completeness).toBe("incomplete");
    expect(r!.missingHints).toContain("too_few_tokens");
    expect(r!.missingHints).toContain("too_short");
  });
});

describe("computeAddressQuality — landmark detection", () => {
  it("detects Latin landmark words across categories", () => {
    const r = computeAddressQuality(
      "Beside the school on the road past the bazar tower",
    );
    expect(r!.landmarks).toEqual(
      expect.arrayContaining(["education", "road", "market", "house"]),
    );
  });

  it("detects Bangla landmark glyphs", () => {
    const r = computeAddressQuality("মসজিদের পাশে, ৩ নং রোড, ঢাকা");
    expect(r).not.toBeNull();
    expect(r!.landmarks).toEqual(expect.arrayContaining(["worship", "road"]));
  });

  it("multi-category landmarks earn the 5-point bonus", () => {
    const single = computeAddressQuality(
      "Near the green masjid in Banani residential area",
    );
    const multi = computeAddressQuality(
      "Near the green masjid past the school on Banani road",
    );
    // Same length-bracket inputs; the multi-category one must score higher
    // because of the +5 multi-category bonus.
    expect(multi!.score).toBeGreaterThan(single!.score);
  });

  it("collapses duplicated landmark words within a category (no-game)", () => {
    const r = computeAddressQuality("Mosque Mosque Mosque Mosque, somewhere");
    // worship category counted once even with four hits.
    expect(r!.landmarks.filter((c) => c === "worship").length).toBe(1);
  });
});

describe("computeAddressQuality — script-mix detection", () => {
  it("flags 'mixed' when both Latin and Bangla characters are present", () => {
    const r = computeAddressQuality("Road 7, ধানমন্ডি, Dhaka");
    expect(r!.scriptMix).toBe("mixed");
    expect(r!.missingHints).toContain("mixed_script");
  });

  it("flags 'bangla' when only Bangla glyphs are present", () => {
    const r = computeAddressQuality("ধানমন্ডি ৩২ নম্বর, ঢাকা");
    expect(r!.scriptMix).toBe("bangla");
    expect(r!.missingHints).not.toContain("mixed_script");
  });

  it("flags 'latin' for ASCII-only input", () => {
    const r = computeAddressQuality("House 21, Road 2, Dhanmondi, Dhaka");
    expect(r!.scriptMix).toBe("latin");
    expect(r!.missingHints).not.toContain("mixed_script");
  });
});

describe("computeAddressQuality — hint generation", () => {
  it("emits 'no_anchor' (NOT 'no_landmark' / 'no_number') when both missing", () => {
    const r = computeAddressQuality("just a description without anchors over here");
    expect(r!.missingHints).toContain("no_anchor");
    expect(r!.missingHints).not.toContain("no_landmark");
    expect(r!.missingHints).not.toContain("no_number");
  });

  it("emits 'no_landmark' alone when number present but no landmark", () => {
    const r = computeAddressQuality("221b some place near the area");
    expect(r!.missingHints).toContain("no_landmark");
    expect(r!.missingHints).not.toContain("no_anchor");
    expect(r!.missingHints).not.toContain("no_number");
  });

  it("emits 'no_number' alone when landmark present but no number", () => {
    const r = computeAddressQuality(
      "Near the green mosque past the chairman office",
    );
    expect(r!.missingHints).toContain("no_number");
    expect(r!.missingHints).not.toContain("no_anchor");
    expect(r!.missingHints).not.toContain("no_landmark");
  });

  it("every emitted hint is a known stable code", () => {
    const r = computeAddressQuality("test");
    for (const h of r!.missingHints) {
      expect(ADDRESS_HINT_CODES).toContain(h as AddressHintCode);
    }
  });
});

describe("computeAddressQuality — score clamping", () => {
  it("clamps a multi-feature address to 100 max", () => {
    // Pile every positive contribution: 5+ tokens, 8+ tokens, number,
    // landmark, multi-landmark, district given. Even with no penalties
    // base 50 + 10 + 5 + 10 + 10 + 5 + 5 = 95 — under 100, so no real
    // clamp needed. Defensive test that the clamp never returns >100.
    const r = computeAddressQuality(
      "House 14, Flat 3B, Road 7, Block C, Sector 12, Mirpur DOHS, near Mosque, Dhaka",
      "Dhaka",
    );
    expect(r!.score).toBeLessThanOrEqual(100);
  });

  it("clamps near-empty input to 0 minimum", () => {
    const r = computeAddressQuality("xy");
    expect(r!.score).toBeGreaterThanOrEqual(0);
  });
});

describe("computeAddressQuality — determinism", () => {
  it("returns the same score for the same input across calls", () => {
    const a = computeAddressQuality("House 1, Road 2, Dhanmondi, Dhaka", "Dhaka");
    const b = computeAddressQuality("House 1, Road 2, Dhanmondi, Dhaka", "Dhaka");
    expect(a!.score).toBe(b!.score);
    expect(a!.completeness).toBe(b!.completeness);
    expect(a!.landmarks).toEqual(b!.landmarks);
    expect(a!.missingHints).toEqual(b!.missingHints);
    // computedAt differs by design — don't compare it
  });
});
