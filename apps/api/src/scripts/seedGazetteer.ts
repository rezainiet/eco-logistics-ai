/**
 * Idempotent gazetteer bootstrap for Phase 2 address canonicalisation.
 *
 * Sources:
 *   1. Eight BD divisions (hardcoded — they're stable national geography).
 *   2. Districts derived from `THANAS[*].district` plus their canonical
 *      Bangla aliases (mirrors `lib/district.ts`'s ALIASES table).
 *   3. Thanas / upazilas from `lib/thana-lexicon.ts:THANAS`.
 *
 * Idempotency:
 *   - Every write is an `updateOne(filter, $setOnInsert+$addToSet, upsert)`.
 *   - Re-running this script:
 *       - Does NOT overwrite existing aliases (additive set union).
 *       - Does NOT overwrite operator-supplied edits to canonical/parent.
 *       - DOES advance any aliases the seed lexicon adds in a future PR.
 *   - Cap on aliases (GEOGRAPHY_ALIAS_CAP) is enforced at schema level —
 *     a cap-hit fails the row's update loudly rather than truncating.
 *
 * Replay-safety:
 *   - Gazetteer is a derivation source; CanonicalAddress rows are pinned
 *     to their pipelineVersion at write time. Adding aliases here cannot
 *     retroactively change any prior canonical hash.
 *
 * Usage:
 *   - Boot-time: imported and called from `src/index.ts` after connectDb().
 *   - Manual:    `npx tsx src/scripts/seedGazetteer.ts`
 */

import { Geography, GEOGRAPHY_ALIAS_CAP } from "@ecom/db";
import { THANAS } from "../lib/thana-lexicon.js";
import { ADDRESS_PIPELINE_VERSION } from "../lib/address-canonical.js";

/* -------------------------------------------------------------------------- */
/* Source data                                                                */
/* -------------------------------------------------------------------------- */

interface SeedRow {
  level: "division" | "district" | "thana" | "area";
  canonical: string;
  parent?: string;
  aliases: string[];
}

const DIVISIONS: SeedRow[] = [
  { level: "division", canonical: "dhaka", aliases: ["dhaka", "dhaka division", "ঢাকা"] },
  {
    level: "division",
    canonical: "chittagong",
    aliases: [
      "chittagong",
      "chattogram",
      "ctg",
      "chittagong division",
      "chattogram division",
      "চট্টগ্রাম",
    ],
  },
  { level: "division", canonical: "sylhet", aliases: ["sylhet", "sylhet division", "সিলেট"] },
  { level: "division", canonical: "khulna", aliases: ["khulna", "khulna division", "খুলনা"] },
  { level: "division", canonical: "rajshahi", aliases: ["rajshahi", "rajshahi division", "রাজশাহী"] },
  {
    level: "division",
    canonical: "barisal",
    aliases: ["barisal", "barishal", "barisal division", "বরিশাল"],
  },
  { level: "division", canonical: "rangpur", aliases: ["rangpur", "rangpur division", "রংপুর"] },
  {
    level: "division",
    canonical: "mymensingh",
    aliases: ["mymensingh", "mymensingh division", "ময়মনসিংহ"],
  },
];

/**
 * District alias seed — mirrors `lib/district.ts`'s ALIASES so that
 * `address-canonical.ts`'s gazetteer matcher and the existing district
 * normalizer agree. Districts derive their parent from the matching division
 * (collapsed mapping below).
 */
const DISTRICT_PARENTS: Record<string, string> = {
  dhaka: "dhaka",
  gazipur: "dhaka",
  narayanganj: "dhaka",
  savar: "dhaka",
  chittagong: "chittagong",
  comilla: "chittagong",
  sylhet: "sylhet",
  khulna: "khulna",
  rajshahi: "rajshahi",
  barisal: "barisal",
  rangpur: "rangpur",
  mymensingh: "mymensingh",
};

const DISTRICT_ALIASES: Record<string, string[]> = {
  dhaka: ["dhaka", "dhaka city", "dhaka district", "dhaka metropolitan", "ঢাকা", "ঢাকা সিটি"],
  gazipur: ["gazipur", "gazipur district", "গাজীপুর"],
  narayanganj: ["narayanganj", "narayangonj", "narayanganj district", "নারায়ণগঞ্জ"],
  savar: ["savar"],
  chittagong: [
    "chittagong",
    "chattogram",
    "ctg",
    "chittagong district",
    "chattogram district",
    "চট্টগ্রাম",
    "চট্টগ্রাম সিটি",
  ],
  comilla: ["comilla", "cumilla", "comilla district", "কুমিল্লা"],
  sylhet: ["sylhet", "sylhet district", "সিলেট"],
  khulna: ["khulna", "khulna district", "খুলনা"],
  rajshahi: ["rajshahi", "rajshahi district", "রাজশাহী"],
  barisal: ["barisal", "barishal", "barisal district", "বরিশাল"],
  rangpur: ["rangpur", "rangpur district", "রংপুর"],
  mymensingh: ["mymensingh", "mymensingh district", "ময়মনসিংহ"],
};

/* -------------------------------------------------------------------------- */
/* Build canonical seed rows                                                  */
/* -------------------------------------------------------------------------- */

function buildSeedRows(): SeedRow[] {
  const rows: SeedRow[] = [...DIVISIONS];

  // Districts — one row per known district seed.
  for (const [canonical, aliases] of Object.entries(DISTRICT_ALIASES)) {
    rows.push({
      level: "district",
      canonical,
      parent: DISTRICT_PARENTS[canonical],
      aliases: dedupedLower([...aliases, canonical]),
    });
  }

  // Thanas — from the existing lexicon. Skip a thana whose district is not
  // in our DISTRICT_ALIASES table (defence-in-depth — avoids creating
  // dangling parents).
  for (const t of THANAS) {
    const parent = t.district;
    if (!DISTRICT_ALIASES[parent]) continue;
    rows.push({
      level: "thana",
      canonical: t.canonical.toLowerCase().trim(),
      parent,
      aliases: dedupedLower([...t.aliases, t.canonical]),
    });
  }

  return rows;
}

function dedupedLower(arr: string[]): string[] {
  const set = new Set<string>();
  for (const a of arr) {
    const key = a.toLowerCase().trim();
    if (key) set.add(key);
  }
  return [...set];
}

/* -------------------------------------------------------------------------- */
/* Upsert one row                                                             */
/* -------------------------------------------------------------------------- */

interface SeedStats {
  inserted: number;
  updated: number;
  skipped: number;
  capHits: number;
  errors: number;
}

async function upsertOne(row: SeedRow, stats: SeedStats): Promise<void> {
  const aliases = dedupedLower(row.aliases).slice(0, GEOGRAPHY_ALIAS_CAP);
  // Atomic upsert with $setOnInsert (only fills on insert) + $addToSet
  // (additive on update — never clobbers operator edits). The `$each`
  // form makes alias merging idempotent.
  try {
    const res = await Geography.updateOne(
      { level: row.level, canonical: row.canonical },
      {
        $setOnInsert: {
          level: row.level,
          canonical: row.canonical,
          parent: row.parent,
          pipelineVersion: ADDRESS_PIPELINE_VERSION,
          source: "seed",
        },
        $addToSet: { aliases: { $each: aliases } },
      },
      { upsert: true, runValidators: true },
    );
    if (res.upsertedCount && res.upsertedCount > 0) {
      stats.inserted += 1;
    } else if (res.modifiedCount && res.modifiedCount > 0) {
      stats.updated += 1;
    } else {
      stats.skipped += 1;
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // Validation failure (cap exceeded) → log and skip; never abort the run.
    if (message.toLowerCase().includes("aliases cannot exceed")) {
      stats.capHits += 1;
      console.error(
        `[seed-gazetteer] cap reached for ${row.level}/${row.canonical}: ${message}`,
      );
      return;
    }
    stats.errors += 1;
    console.error(
      `[seed-gazetteer] failed ${row.level}/${row.canonical}: ${message}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

export async function seedGazetteer(): Promise<SeedStats> {
  const rows = buildSeedRows();
  const stats: SeedStats = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    capHits: 0,
    errors: 0,
  };
  for (const row of rows) {
    await upsertOne(row, stats);
  }
  console.log(
    `[seed-gazetteer] rows=${rows.length} inserted=${stats.inserted} ` +
      `updated=${stats.updated} skipped=${stats.skipped} ` +
      `capHits=${stats.capHits} errors=${stats.errors}`,
  );
  return stats;
}

// Allow running directly:  npx tsx src/scripts/seedGazetteer.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  const { connectDb, disconnectDb } = await import("../lib/db.js");
  await connectDb();
  try {
    const r = await seedGazetteer();
    console.log(JSON.stringify(r));
  } finally {
    await disconnectDb();
  }
}
