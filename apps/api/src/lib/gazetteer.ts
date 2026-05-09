import { Geography, type Geography as GeographyDoc } from "@ecom/db";
import {
  ADDRESS_PIPELINE_VERSION,
  type GazetteerEntry,
  type GazetteerLookup,
  type AddressGeoLevel,
} from "./address-canonical.js";

/**
 * In-memory gazetteer loader for the address canonicalisation pipeline.
 *
 * Per-process cache: one Map<aliasLower, entry> built from the Geography
 * collection. Refreshed every TTL (default 5 minutes); a background refresh
 * pattern guarantees readers never block on a Mongo round-trip — they always
 * see the current snapshot, even while a refresh is in flight.
 *
 * Hard rules:
 *   - NEVER blocks ingest. A failed load produces (or keeps) an empty
 *     lookup; canonicalisation degrades to "no gazetteer match" and the
 *     existing addressHash continues to work as before.
 *   - NEVER mixes pipeline versions. Rows whose `pipelineVersion` does not
 *     match `ADDRESS_PIPELINE_VERSION` are silently filtered out at load
 *     time. A future schema bump produces a new in-memory snapshot scoped
 *     to the new version; old rows remain readable in the DB.
 *   - Alias map prefers the most-specific level on collision (district >
 *     division when both expose alias "dhaka"). Mirrors what the test
 *     gazetteer in `tests/address-canonical.test.ts` does.
 *   - Fuzzy lookup is OPTIONAL and OFF BY DEFAULT. Enabled via
 *     `getGazetteer({ fuzzy: true })`. Edit-distance ≤ 1 across the loaded
 *     alias map; bounded by alias-length bucketing so the worst case is
 *     `O(bucketSize)` per query, not `O(N)`.
 */

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface GazetteerOptions {
  /** Enable edit-distance ≤1 fallback. Default false. */
  fuzzy?: boolean;
}

export interface GazetteerSnapshot {
  /** Total alias entries indexed. */
  size: number;
  /** Loaded at (epoch ms). */
  loadedAt: number;
  /** Pipeline version this snapshot is scoped to. */
  pipelineVersion: string;
  /** True if the snapshot is the empty fallback (DB load never succeeded). */
  empty: boolean;
}

const TTL_MS = 5 * 60 * 1000;
const FUZZY_LENGTH_BUCKET_RADIUS = 1; // candidates of length len ± 1

interface CacheState {
  byAlias: Map<string, GazetteerEntry>;
  byLength: Map<number, string[]>; // for fuzzy lookup
  loadedAt: number;
  pipelineVersion: string;
  empty: boolean;
}

let _state: CacheState | null = null;
let _refreshing: Promise<CacheState> | null = null;

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

const LEVEL_RANK: Record<AddressGeoLevel, number> = {
  division: 1,
  district: 2,
  thana: 3,
  area: 4,
  road: 5,
  house: 6,
  block: 7,
  flat: 8,
};

function makeEmpty(): CacheState {
  return {
    byAlias: new Map(),
    byLength: new Map(),
    loadedAt: Date.now(),
    pipelineVersion: ADDRESS_PIPELINE_VERSION,
    empty: true,
  };
}

function buildState(rows: GeographyDoc[]): CacheState {
  const byAlias = new Map<string, GazetteerEntry>();
  for (const r of rows) {
    if (r.pipelineVersion !== ADDRESS_PIPELINE_VERSION) continue;
    const entry: GazetteerEntry = {
      level: r.level as AddressGeoLevel,
      canonical: r.canonical,
      parent: r.parent ?? undefined,
      aliases: Array.isArray(r.aliases) ? [...r.aliases] : [],
    };
    const claim = (key: string) => {
      if (!key) return;
      const existing = byAlias.get(key);
      if (
        !existing ||
        (LEVEL_RANK[entry.level] ?? 0) > (LEVEL_RANK[existing.level] ?? 0)
      ) {
        byAlias.set(key, entry);
      }
    };
    for (const a of entry.aliases) claim(a.toLowerCase().trim());
    claim(entry.canonical.toLowerCase().trim());
  }
  const byLength = new Map<number, string[]>();
  for (const key of byAlias.keys()) {
    const bucket = byLength.get(key.length) ?? [];
    bucket.push(key);
    byLength.set(key.length, bucket);
  }
  return {
    byAlias,
    byLength,
    loadedAt: Date.now(),
    pipelineVersion: ADDRESS_PIPELINE_VERSION,
    empty: byAlias.size === 0,
  };
}

async function loadFromDb(): Promise<CacheState> {
  try {
    const rows = (await Geography.find({
      pipelineVersion: ADDRESS_PIPELINE_VERSION,
    })
      .lean()
      .exec()) as GeographyDoc[];
    return buildState(rows);
  } catch (err) {
    console.error(
      "[gazetteer] load failed — falling back to empty snapshot:",
      (err as Error).message,
    );
    return makeEmpty();
  }
}

/**
 * Force a synchronous reload (for boot-time or admin "reload" actions).
 * Does NOT throw — a load failure produces an empty snapshot and the
 * canonicalisation pipeline degrades to "no gazetteer match" until the
 * next successful refresh.
 */
export async function reloadGazetteer(): Promise<GazetteerSnapshot> {
  const next = await loadFromDb();
  _state = next;
  return snapshotOf(next);
}

function snapshotOf(s: CacheState): GazetteerSnapshot {
  return {
    size: s.byAlias.size,
    loadedAt: s.loadedAt,
    pipelineVersion: s.pipelineVersion,
    empty: s.empty,
  };
}

/* -------------------------------------------------------------------------- */
/* Background refresh — never blocks readers                                  */
/* -------------------------------------------------------------------------- */

function maybeRefresh(): void {
  if (!_state) return; // first call goes through getGazetteer's lazy path
  if (Date.now() - _state.loadedAt < TTL_MS) return;
  if (_refreshing) return; // refresh already in flight
  _refreshing = loadFromDb()
    .then((next) => {
      _state = next;
      return next;
    })
    .catch(() => _state ?? makeEmpty())
    .finally(() => {
      _refreshing = null;
    });
}

/* -------------------------------------------------------------------------- */
/* Edit distance ≤ 1 (bounded)                                                */
/* -------------------------------------------------------------------------- */

function withinEditDistance1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  // Same length: count substitutions
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diff += 1;
        if (diff > 1) return false;
      }
    }
    return diff === 1;
  }
  // Length differs by 1: one insertion/deletion
  const [shorter, longer] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
    } else {
      edits += 1;
      if (edits > 1) return false;
      j += 1;
    }
  }
  return true;
}

function fuzzyLookup(state: CacheState, alias: string): GazetteerEntry | null {
  const key = alias.toLowerCase();
  const len = key.length;
  for (
    let l = Math.max(1, len - FUZZY_LENGTH_BUCKET_RADIUS);
    l <= len + FUZZY_LENGTH_BUCKET_RADIUS;
    l++
  ) {
    const bucket = state.byLength.get(l);
    if (!bucket) continue;
    for (const candidate of bucket) {
      if (withinEditDistance1(key, candidate)) {
        return state.byAlias.get(candidate) ?? null;
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Public lookup                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Get a `GazetteerLookup` backed by the in-process snapshot.
 *
 * - Synchronous interface (matches the `address-canonical` consumer
 *   contract). The first call after process start lazily loads the
 *   snapshot — `awaitLoad()` should be called once at boot to prime
 *   the cache so the first ingest doesn't pay a DB round-trip.
 * - Subsequent calls reuse the cached state. After TTL expiry the
 *   refresh runs in the background; readers continue to see the
 *   current (slightly stale) snapshot until the refresh lands.
 */
export function getGazetteer(opts: GazetteerOptions = {}): GazetteerLookup {
  // Lazy initial population — uses an empty snapshot until awaitLoad runs.
  if (!_state) _state = makeEmpty();
  maybeRefresh();
  const stateRef = _state;
  return {
    findByAlias: (alias) =>
      stateRef.byAlias.get(alias.toLowerCase().trim()) ?? null,
    findByFuzzyAlias: opts.fuzzy
      ? (alias) => fuzzyLookup(stateRef, alias)
      : undefined,
  };
}

/**
 * Boot-time prime. Call ONCE after `connectDb()` and before the HTTP
 * server starts accepting traffic. Never throws.
 */
export async function awaitLoad(): Promise<GazetteerSnapshot> {
  return reloadGazetteer();
}

/** Snapshot for admin observability. */
export function getGazetteerSnapshot(): GazetteerSnapshot {
  if (!_state) return snapshotOf(makeEmpty());
  return snapshotOf(_state);
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

/** Test-only: drop the in-process cache so tests can rebuild from a fresh
 *  collection state. Never call from production code paths. */
export function __resetGazetteerCache(): void {
  _state = null;
  _refreshing = null;
}

export const __TEST = {
  TTL_MS,
  withinEditDistance1,
  buildState,
  fuzzyLookup,
};
