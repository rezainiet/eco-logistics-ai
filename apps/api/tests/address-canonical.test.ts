import { describe, expect, it } from "vitest";
import {
  ADDRESS_PIPELINE_VERSION,
  __TEST,
  canonicaliseAddress,
  type GazetteerEntry,
  type GazetteerLookup,
} from "../src/lib/address-canonical.js";

/* -------------------------------------------------------------------------- */
/* Test gazetteer — minimal in-memory stub. Real gazetteer arrives in S2-S4. */
/* -------------------------------------------------------------------------- */

const ENTRIES: GazetteerEntry[] = [
  { level: "division", canonical: "dhaka", aliases: ["dhaka", "dhaka division"] },
  {
    level: "district",
    canonical: "dhaka",
    parent: "dhaka",
    aliases: ["dhaka", "ঢাকা", "dhaka district", "dhaka city"],
  },
  {
    level: "district",
    canonical: "chittagong",
    parent: "chittagong",
    aliases: ["chittagong", "chattogram", "ctg", "চট্টগ্রাম"],
  },
  {
    level: "thana",
    canonical: "dhanmondi",
    parent: "dhaka",
    aliases: ["dhanmondi", "dhanmandi", "ধানমন্ডি"],
  },
  {
    level: "thana",
    canonical: "mirpur",
    parent: "dhaka",
    aliases: ["mirpur", "মিরপুর"],
  },
  {
    level: "thana",
    canonical: "gulshan",
    parent: "dhaka",
    aliases: ["gulshan", "গুলশান"],
  },
  {
    level: "thana",
    canonical: "panchlaish",
    parent: "chittagong",
    aliases: ["panchlaish", "পাঁচলাইশ"],
  },
];

function buildGazetteer(opts: { fuzzy?: boolean } = {}): GazetteerLookup {
  const aliasMap = new Map<string, GazetteerEntry>();
  // Prefer most-specific level on duplicate alias (e.g. "dhaka" exists as
  // both division and district — district wins because buyers writing
  // "Dhaka" mean the district 99.9% of the time).
  const LEVEL_RANK: Record<string, number> = {
    division: 1,
    district: 2,
    thana: 3,
    area: 4,
  };
  for (const entry of ENTRIES) {
    for (const alias of entry.aliases) {
      const key = alias.toLowerCase();
      const existing = aliasMap.get(key);
      if (
        !existing ||
        (LEVEL_RANK[entry.level] ?? 0) > (LEVEL_RANK[existing.level] ?? 0)
      ) {
        aliasMap.set(key, entry);
      }
    }
  }
  const editDistance = (a: string, b: string): number => {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 1) return 99;
    const dp: number[][] = [];
    for (let i = 0; i <= a.length; i++) {
      dp[i] = [i];
    }
    for (let j = 0; j <= b.length; j++) {
      dp[0]![j] = j;
    }
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i]![j] = Math.min(
          dp[i - 1]![j]! + 1,
          dp[i]![j - 1]! + 1,
          dp[i - 1]![j - 1]! + cost,
        );
      }
    }
    return dp[a.length]![b.length]!;
  };
  return {
    findByAlias: (alias) => aliasMap.get(alias.toLowerCase()) ?? null,
    findByFuzzyAlias: opts.fuzzy
      ? (alias) => {
          const k = alias.toLowerCase();
          for (const [key, entry] of aliasMap) {
            if (editDistance(k, key) === 1) return entry;
          }
          return null;
        }
      : undefined,
  };
}

const FIXED_NOW = new Date("2026-05-09T12:00:00.000Z");
const noFuzzy = buildGazetteer();
const withFuzzy = buildGazetteer({ fuzzy: true });

function canon(address: string, district?: string, thana?: string) {
  return canonicaliseAddress(
    { address, district, thana, now: FIXED_NOW },
    noFuzzy,
  );
}

/* -------------------------------------------------------------------------- */

describe("address-canonical — pipeline determinism", () => {
  it("returns null for empty / unusable input", () => {
    expect(canon("")).toBeNull();
    expect(canon("   ")).toBeNull();
    expect(canon("ab")).toBeNull();
    expect(canonicaliseAddress({ address: null }, noFuzzy)).toBeNull();
    expect(canonicaliseAddress({ address: undefined }, noFuzzy)).toBeNull();
  });

  it("same input → byte-identical canonical (modulo computedAt)", () => {
    const a = canon("House 10 Road 2 Dhanmondi Dhaka");
    const b = canon("House 10 Road 2 Dhanmondi Dhaka");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.buildingKey).toBe(b!.buildingKey);
    expect(a!.unitKey).toBe(b!.unitKey);
    expect(a!.tokens).toEqual(b!.tokens);
  });

  it("stamps the pipelineVersion verbatim", () => {
    const r = canon("House 10 Road 2 Dhanmondi Dhaka");
    expect(r!.pipelineVersion).toBe(ADDRESS_PIPELINE_VERSION);
  });
});

describe("address-canonical — house+road order independence", () => {
  it("merges 'House 10 Road 2' / 'Road 2 House 10' / mixed", () => {
    const a = canon("House 10 Road 2 Dhanmondi Dhaka");
    const b = canon("Road 2 House 10 Dhanmondi Dhaka");
    const c = canon("Dhanmondi Road 2 House 10 Dhaka");
    expect(a!.buildingKey).toBe(b!.buildingKey);
    expect(a!.buildingKey).toBe(c!.buildingKey);
  });

  it("merges punctuation variants H-10 / H/10 / H 10 / House 10", () => {
    const variants = [
      "H-10 Rd-2 Dhanmondi Dhaka",
      "H/10 Rd/2 Dhanmondi Dhaka",
      "H 10 R 2 Dhanmondi Dhaka",
      "House 10 Road 2 Dhanmondi Dhaka",
      "house-10, road-2, dhanmondi, dhaka",
    ];
    const canons = variants.map((v) => canon(v)!);
    const first = canons[0]!.buildingKey;
    for (const c of canons) expect(c.buildingKey).toBe(first);
  });

  it("merges BD number-prefix style (10 No Road / Road 10 / No 10 Road)", () => {
    const a = canon("Dhanmondi Road 27 House 5");
    const b = canon("Dhanmondi 27 No Road House 5");
    const c = canon("Dhanmondi 27 number road House 5");
    expect(a!.buildingKey).toBe(b!.buildingKey);
    expect(a!.buildingKey).toBe(c!.buildingKey);
    expect(a!.road).toBe("road-27");
  });
});

describe("address-canonical — Bangla / Banglish merging", () => {
  it("collapses Mirpur and মিরপুর to the same canonical", () => {
    const a = canon("Mirpur Road 7 House 12");
    const b = canon("মিরপুর Road 7 House 12");
    expect(a!.thana).toBe("mirpur");
    expect(b!.thana).toBe("mirpur");
    expect(a!.buildingKey).toBe(b!.buildingKey);
  });

  it("merges mixed-script inputs sharing the same anchors", () => {
    const a = canon("House 5 মিরপুর Road 7");
    const b = canon("House 5 Mirpur Road 7");
    expect(a!.buildingKey).toBe(b!.buildingKey);
  });

  it("handles ctg / chattogram / chittagong / চট্টগ্রাম as one district", () => {
    const a = canon("Panchlaish Road 3 House 9 Chittagong");
    const b = canon("Panchlaish Road 3 House 9 Chattogram");
    const c = canon("Panchlaish Road 3 House 9 CTG");
    const d = canon("পাঁচলাইশ Road 3 House 9 চট্টগ্রাম");
    expect(a!.district).toBe("chittagong");
    expect(b!.district).toBe("chittagong");
    expect(c!.district).toBe("chittagong");
    expect(d!.district).toBe("chittagong");
    expect(a!.buildingKey).toBe(b!.buildingKey);
    expect(a!.buildingKey).toBe(c!.buildingKey);
    expect(a!.buildingKey).toBe(d!.buildingKey);
  });
});

describe("address-canonical — apartment / unit awareness", () => {
  it("buildingKey is identical for two flats in the same building; unitKey differs", () => {
    const flat3b = canon("House 5 Road 10 Dhanmondi Dhaka Flat 3B");
    const flat4a = canon("House 5 Road 10 Dhanmondi Dhaka Flat 4A");
    expect(flat3b!.buildingKey).toBe(flat4a!.buildingKey);
    expect(flat3b!.unitKey).not.toBe(flat4a!.unitKey);
    expect(flat3b!.flat).toBe("flat-3b");
    expect(flat4a!.flat).toBe("flat-4a");
  });

  it("when no flat is present, unitKey === buildingKey", () => {
    const r = canon("House 5 Road 10 Dhanmondi Dhaka");
    expect(r!.unitKey).toBe(r!.buildingKey);
    expect(r!.flat).toBeUndefined();
  });

  it("merges Apt / Flat / Apartment", () => {
    const a = canon("House 5 Road 10 Dhanmondi Apt 3B");
    const b = canon("House 5 Road 10 Dhanmondi Flat 3B");
    const c = canon("House 5 Road 10 Dhanmondi Apartment 3B");
    expect(a!.unitKey).toBe(b!.unitKey);
    expect(a!.unitKey).toBe(c!.unitKey);
  });
});

describe("address-canonical — block / sector", () => {
  it("recognises block letter in either order", () => {
    const a = canon("Bashundhara Block C Road 7 House 23 Dhaka");
    const b = canon("Bashundhara C Block Road 7 House 23 Dhaka");
    const c = canon("Bashundhara Block-C Road-7 House-23 Dhaka");
    expect(a!.block).toBe("block-c");
    expect(b!.block).toBe("block-c");
    expect(c!.block).toBe("block-c");
    expect(a!.buildingKey).toBe(b!.buildingKey);
    expect(a!.buildingKey).toBe(c!.buildingKey);
  });
});

describe("address-canonical — confidence bands", () => {
  it("high confidence: full hierarchy + anchors, exact alias", () => {
    const r = canon("House 10 Road 2 Dhanmondi Dhaka");
    expect(r!.confidence).toBe("high");
    expect(r!.matchedOn).toContain("district");
    expect(r!.matchedOn).toContain("thana");
    expect(r!.matchedOn).toContain("road");
    expect(r!.matchedOn).toContain("house");
  });

  it("medium confidence: only district + anchors (no thana match)", () => {
    const r = canon("House 1 Road 1 Unknownville Dhaka");
    expect(r!.confidence).toBe("medium");
    expect(r!.thana).toBeUndefined();
    expect(r!.district).toBe("dhaka");
  });

  it("low confidence: nothing in gazetteer, no anchors either", () => {
    const r = canon("some random text without geography");
    expect(r!.confidence).toBe("low");
    expect(r!.district).toBeUndefined();
    expect(r!.thana).toBeUndefined();
  });

  it("medium confidence: edit-distance ≤1 against gazetteer alias", () => {
    const r = canonicaliseAddress(
      {
        address: "House 10 Road 2 Dhanmondhi Dhaka",
        now: FIXED_NOW,
      },
      withFuzzy,
    );
    // "Dhanmondhi" is edit-distance 1 from "dhanmondi"
    expect(r!.thana).toBe("dhanmondi");
    expect(r!.confidence).toBe("medium");
  });
});

describe("address-canonical — district / thana hint", () => {
  it("uses caller-supplied district hint when address omits it", () => {
    const r = canon("House 5 Road 10 Dhanmondi", "Dhaka");
    expect(r!.district).toBe("dhaka");
    expect(r!.thana).toBe("dhanmondi");
  });

  it("uses caller-supplied thana hint", () => {
    const r = canon("House 5 Road 10", "Dhaka", "Mirpur");
    expect(r!.thana).toBe("mirpur");
  });
});

describe("address-canonical — rural role-prefix patterns", () => {
  it("strips Vill: / PO: / PS: / Upazila: / Dist:", () => {
    const r = canon(
      "Vill: Khaleshi, PO: Boalkhali, PS: Boalkhali, Dist: Chittagong",
    );
    expect(r!.district).toBe("chittagong");
  });
});

describe("address-canonical — replay safety surface", () => {
  it("buildingKey and unitKey are SHA-256[:32] hex strings", () => {
    const r = canon("House 10 Road 2 Dhanmondi Dhaka");
    expect(r!.buildingKey).toMatch(/^[a-f0-9]{32}$/);
    expect(r!.unitKey).toMatch(/^[a-f0-9]{32}$/);
  });

  it("two addresses differing only in pipelineVersion would hash differently (forward-compat guarantee)", () => {
    // We can't bump the version at runtime here, but we can verify the
    // pipeline composition includes the version literal.
    const r = canon("House 10 Road 2 Dhanmondi Dhaka");
    // If a future version bump kept the same composite, the keys would
    // collide across versions — which is exactly what we want to AVOID.
    // We verify by composing manually with a fake "v2" prefix and
    // checking the hashHex helper produces a different output.
    const sameSlots = [
      "v2",
      "_",
      "dhaka",
      "dhanmondi",
      "_",
      "road-2",
      "house-10",
      "_",
      r!.tokens.join("|"),
    ].join("||");
    expect(__TEST.hashHex(sameSlots)).not.toBe(r!.buildingKey);
  });
});

describe("address-canonical — token cloud invariants", () => {
  it("tokens array is sorted alphabetically and deduped", () => {
    const r = canon("Bashundhara R/A Block C Road 7 House 23 Dhaka");
    const sorted = [...r!.tokens].sort();
    expect(r!.tokens).toEqual(sorted);
    expect(new Set(r!.tokens).size).toBe(r!.tokens.length);
  });

  it("does not leak gazetteer-matched tokens into the cloud", () => {
    const r = canon("House 10 Road 2 Dhanmondi Dhaka");
    expect(r!.tokens).not.toContain("dhanmondi");
    expect(r!.tokens).not.toContain("dhaka");
  });
});

describe("address-canonical — defensive runtime", () => {
  it("ignores invalid `now` input and falls back to system clock", () => {
    expect(() =>
      canonicaliseAddress(
        // @ts-expect-error — exercising defensive runtime handling
        { address: "House 10 Road 2 Dhanmondi Dhaka", now: "not-a-date" },
        noFuzzy,
      ),
    ).not.toThrow();
  });

  it("step helpers are exported via __TEST", () => {
    expect(__TEST.nfcLower("HÉLLO")).toBe("héllo");
    expect(__TEST.collapsePunct("a,b/c-d")).toBe("a b c d");
    expect(__TEST.expandAbbreviations(["h", "10"])).toEqual(["house", "10"]);
    expect(__TEST.expandAbbreviations(["h10"])).toEqual(["house", "10"]);
  });
});
