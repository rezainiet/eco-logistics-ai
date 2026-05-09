import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Geography } from "@ecom/db";
import {
  ADDRESS_PIPELINE_VERSION,
  canonicaliseAddress,
} from "../src/lib/address-canonical.js";
import {
  __resetGazetteerCache,
  awaitLoad,
  getGazetteer,
  getGazetteerSnapshot,
  reloadGazetteer,
} from "../src/lib/gazetteer.js";
import { seedGazetteer } from "../src/scripts/seedGazetteer.js";
import { disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Phase 2 staging-smoke verification for the BD address canonicalisation
 * boot pipeline. Exercises the same path the API server runs at startup:
 *
 *   1. seedGazetteer()    — idempotent upserts from thana-lexicon.
 *   2. awaitLoad()        — primes the in-process gazetteer cache from
 *                           the freshly-seeded Geography collection.
 *   3. canonicaliseAddress()
 *                          — runs the deterministic pipeline against
 *                           the loaded gazetteer for representative BD
 *                           input shapes.
 *
 * Replay-safety surface verified:
 *
 *   - re-running seedGazetteer is additive (alias union, no clobber).
 *   - re-running awaitLoad produces a snapshot scoped to
 *     ADDRESS_PIPELINE_VERSION; rows of other versions are excluded.
 *   - canonical hashes are stable across boots (same input → same hash).
 */

describe("Phase 2 staging smoke — gazetteer boot pipeline", () => {
  beforeAll(async () => {
    await ensureDb();
  });
  beforeEach(async () => {
    await resetDb();
    __resetGazetteerCache();
  });
  afterAll(disconnectDb);

  it("seeds the gazetteer with divisions + districts + thanas", async () => {
    const stats = await seedGazetteer();
    expect(stats.errors).toBe(0);
    // 8 divisions, 12 districts, plus every thana from thana-lexicon
    // whose parent district is in the seed list.
    expect(stats.inserted + stats.updated + stats.skipped).toBeGreaterThan(8 + 12);
    const divisions = await Geography.countDocuments({ level: "division" });
    expect(divisions).toBe(8);
    const districts = await Geography.countDocuments({ level: "district" });
    expect(districts).toBeGreaterThanOrEqual(12);
    const thanas = await Geography.countDocuments({ level: "thana" });
    expect(thanas).toBeGreaterThan(50);
  });

  it("re-running the seed is idempotent (no duplicates, alias set unioned)", async () => {
    await seedGazetteer();
    const before = await Geography.countDocuments({});
    await seedGazetteer();
    const after = await Geography.countDocuments({});
    expect(after).toBe(before);
  });

  it("loader builds an in-memory snapshot scoped to the current pipelineVersion", async () => {
    await seedGazetteer();
    const snap = await awaitLoad();
    expect(snap.empty).toBe(false);
    expect(snap.pipelineVersion).toBe(ADDRESS_PIPELINE_VERSION);
    expect(snap.size).toBeGreaterThan(50);

    // Insert a future-version row; loader must NOT pick it up under v1.
    await Geography.create({
      level: "thana",
      canonical: "futurville",
      parent: "dhaka",
      aliases: ["futurville"],
      pipelineVersion: "v999",
      source: "operator",
    });
    const snap2 = await reloadGazetteer();
    const lookup = getGazetteer();
    expect(snap2.size).toBe(snap.size); // unchanged
    expect(lookup.findByAlias("futurville")).toBeNull();
  });

  it("canonicalises representative BD inputs against the seeded gazetteer", async () => {
    await seedGazetteer();
    await awaitLoad();
    const lookup = getGazetteer();

    const a = canonicaliseAddress(
      { address: "House 10 Road 2 Dhanmondi Dhaka" },
      lookup,
    );
    expect(a).not.toBeNull();
    expect(a!.district).toBe("dhaka");
    expect(a!.thana).toBe("dhanmondi");
    expect(a!.road).toBe("road-2");
    expect(a!.house).toBe("house-10");
    expect(a!.confidence).toBe("high");
    expect(a!.pipelineVersion).toBe(ADDRESS_PIPELINE_VERSION);
    expect(a!.buildingKey).toMatch(/^[a-f0-9]{32}$/);

    // Punctuation / abbreviation variant collapses to the same buildingKey.
    const b = canonicaliseAddress(
      { address: "H-10 Rd-2 Dhanmondi, Dhaka" },
      lookup,
    );
    expect(b!.buildingKey).toBe(a!.buildingKey);

    // Bangla input collapses to the same Latin canonical.
    const c = canonicaliseAddress(
      { address: "House 10 Road 2 ধানমন্ডি ঢাকা" },
      lookup,
    );
    expect(c!.thana).toBe("dhanmondi");
    expect(c!.district).toBe("dhaka");
    expect(c!.buildingKey).toBe(a!.buildingKey);
  });

  it("apartment-aware unitKey: same building, different flats → distinct unit but identical building", async () => {
    await seedGazetteer();
    await awaitLoad();
    const lookup = getGazetteer();
    const flat3b = canonicaliseAddress(
      { address: "House 5 Road 10 Dhanmondi Dhaka Flat 3B" },
      lookup,
    );
    const flat4a = canonicaliseAddress(
      { address: "House 5 Road 10 Dhanmondi Dhaka Apt 4A" },
      lookup,
    );
    expect(flat3b!.buildingKey).toBe(flat4a!.buildingKey);
    expect(flat3b!.unitKey).not.toBe(flat4a!.unitKey);
  });

  it("graceful degradation: empty gazetteer → low-confidence output, never throws", async () => {
    // Skip seed; reload picks up an empty collection.
    await reloadGazetteer();
    const snap = getGazetteerSnapshot();
    expect(snap.empty).toBe(true);
    const lookup = getGazetteer();
    const r = canonicaliseAddress(
      { address: "House 10 Road 2 Dhanmondi Dhaka" },
      lookup,
    );
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe("low");
    // Anchors still extract — the pipeline degrades to "no gazetteer match"
    // but doesn't lose the structural information.
    expect(r!.road).toBe("road-2");
    expect(r!.house).toBe("house-10");
  });
});
