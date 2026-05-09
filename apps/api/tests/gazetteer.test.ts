import { describe, expect, it } from "vitest";
import { __TEST } from "../src/lib/gazetteer.js";
import { ADDRESS_PIPELINE_VERSION } from "../src/lib/address-canonical.js";

/* -------------------------------------------------------------------------- */
/* Pure-state tests — exercise the loader's snapshot logic without Mongo.    */
/* -------------------------------------------------------------------------- */

function row(
  level: "division" | "district" | "thana" | "area",
  canonical: string,
  aliases: string[],
  parent?: string,
  pipelineVersion: string = ADDRESS_PIPELINE_VERSION,
) {
  return {
    level,
    canonical,
    aliases,
    parent,
    pipelineVersion,
    source: "seed",
  };
}

describe("gazetteer — buildState (alias indexing)", () => {
  it("indexes all aliases plus the canonical key", () => {
    const s = __TEST.buildState([
      row("thana", "dhanmondi", ["dhanmondi", "dhanmandi", "ধানমন্ডি"], "dhaka"),
    ] as never);
    expect(s.byAlias.size).toBe(3);
    expect(s.byAlias.get("dhanmondi")?.canonical).toBe("dhanmondi");
    expect(s.byAlias.get("dhanmandi")?.canonical).toBe("dhanmondi");
    expect(s.byAlias.get("ধানমন্ডি")?.canonical).toBe("dhanmondi");
  });

  it("most-specific level wins on alias collision (district > division)", () => {
    const s = __TEST.buildState([
      row("division", "dhaka", ["dhaka", "ঢাকা"]),
      row("district", "dhaka", ["dhaka", "dhaka city", "ঢাকা"], "dhaka"),
    ] as never);
    const hit = s.byAlias.get("dhaka");
    expect(hit).toBeDefined();
    expect(hit!.level).toBe("district");
  });

  it("filters out rows with mismatched pipelineVersion", () => {
    const s = __TEST.buildState([
      row("thana", "mirpur", ["mirpur"], "dhaka", "v1"),
      row("thana", "futurville", ["futurville"], "dhaka", "v999"),
    ] as never);
    expect(s.byAlias.has("mirpur")).toBe(true);
    expect(s.byAlias.has("futurville")).toBe(false);
  });

  it("byLength buckets are populated for fuzzy lookup", () => {
    const s = __TEST.buildState([
      row("thana", "dhanmondi", ["dhanmondi"], "dhaka"),
      row("thana", "mirpur", ["mirpur"], "dhaka"),
    ] as never);
    expect(s.byLength.get("dhanmondi".length)).toContain("dhanmondi");
    expect(s.byLength.get("mirpur".length)).toContain("mirpur");
  });

  it("empty input → empty snapshot flagged true", () => {
    const s = __TEST.buildState([]);
    expect(s.empty).toBe(true);
    expect(s.byAlias.size).toBe(0);
  });
});

describe("gazetteer — withinEditDistance1", () => {
  it("identical strings return true", () => {
    expect(__TEST.withinEditDistance1("dhanmondi", "dhanmondi")).toBe(true);
  });

  it("single substitution returns true", () => {
    expect(__TEST.withinEditDistance1("dhanmondi", "dhonmondi")).toBe(true);
    expect(__TEST.withinEditDistance1("mirpur", "mirpor")).toBe(true);
  });

  it("single insertion returns true", () => {
    expect(__TEST.withinEditDistance1("dhanmondi", "dhanmondhi")).toBe(true);
    expect(__TEST.withinEditDistance1("mirpur", "mirpurr")).toBe(true);
  });

  it("single deletion returns true", () => {
    expect(__TEST.withinEditDistance1("dhanmondi", "dhanmond")).toBe(true);
  });

  it("two substitutions return false", () => {
    expect(__TEST.withinEditDistance1("dhanmondi", "dhanmoondj")).toBe(false);
  });

  it("length difference > 1 returns false", () => {
    expect(__TEST.withinEditDistance1("a", "abc")).toBe(false);
    expect(__TEST.withinEditDistance1("dhaka", "dhakaaaa")).toBe(false);
  });
});

describe("gazetteer — fuzzyLookup", () => {
  it("returns the matching entry within edit-distance 1", () => {
    const s = __TEST.buildState([
      row("thana", "dhanmondi", ["dhanmondi"], "dhaka"),
    ] as never);
    const hit = __TEST.fuzzyLookup(s, "dhanmondhi");
    expect(hit?.canonical).toBe("dhanmondi");
  });

  it("returns null when no candidate is within distance 1", () => {
    const s = __TEST.buildState([
      row("thana", "dhanmondi", ["dhanmondi"], "dhaka"),
    ] as never);
    expect(__TEST.fuzzyLookup(s, "totallyunrelated")).toBeNull();
  });

  it("only considers candidates of length len ± 1 (bucketed)", () => {
    const s = __TEST.buildState([
      row("thana", "mirpur", ["mirpur"], "dhaka"), // length 6
      row("thana", "mxpr", ["mxpr"], "dhaka"), // length 4 — outside ±1
    ] as never);
    // "mirpor" is len 6 → matches mirpur (1 substitution); "mxpr" is len 4
    // and would be edit-distance 2 anyway, but the bucket filter keeps the
    // worst case bounded.
    const hit = __TEST.fuzzyLookup(s, "mirpor");
    expect(hit?.canonical).toBe("mirpur");
  });
});
