import { env } from "../../env.js";

/**
 * Phase 3.5 — observability for the courier-lane + area-reliability
 * writers and the canonicalisation pipeline.
 *
 * Mirrors `lib/observability/delivery-reliability.ts`'s shape:
 *   - Closed event enum (extending it requires a deliberate code change).
 *   - In-process counters keyed on the enum.
 *   - Structured-log emit per event (PII-free, bounded scalar metadata).
 *   - Snapshot helper for admin observability surfaces.
 *
 * Hard rules (binding):
 *   - NEVER throws back to the caller. Internal try/catch wraps emit.
 *   - NEVER reads or writes Mongo. No I/O beyond `console.log` / `console.error`.
 *   - NEVER logs raw PII. Callers pass merchantId, courier, district,
 *     thana, reason, durationMs — no buyer fields.
 *   - Gracefully no-ops when DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED=0.
 *   - Hot-key tracker is per-process, bounded; snapshot is for admin
 *     diagnostics only.
 */

/* -------------------------------------------------------------------------- */
/* Closed event enum                                                          */
/* -------------------------------------------------------------------------- */

export type LaneObservabilityEvent =
  /** Successful CourierLane upsert. */
  | "lane_updated"
  /** Successful AreaReliability upsert. */
  | "area_updated"
  /** Caught throw inside the CourierLane writer. */
  | "lane_write_failed"
  /** Caught throw inside the AreaReliability writer. */
  | "area_write_failed"
  /** A (merchant, key) pair crossed the hot-key emit threshold in a window. */
  | "lane_hot_key"
  /** Address canonicalisation produced a high-confidence result. */
  | "lane_canonical_resolved"
  /** Address canonicalisation produced a low-confidence result (or none). */
  | "lane_canonical_low_confidence";

const COUNTER_KEYS: ReadonlyArray<LaneObservabilityEvent> = [
  "lane_updated",
  "area_updated",
  "lane_write_failed",
  "area_write_failed",
  "lane_hot_key",
  "lane_canonical_resolved",
  "lane_canonical_low_confidence",
];

const counters: Record<LaneObservabilityEvent, number> = {
  lane_updated: 0,
  area_updated: 0,
  lane_write_failed: 0,
  area_write_failed: 0,
  lane_hot_key: 0,
  lane_canonical_resolved: 0,
  lane_canonical_low_confidence: 0,
};

const ERROR_EVENTS: ReadonlySet<LaneObservabilityEvent> = new Set([
  "lane_write_failed",
  "area_write_failed",
]);

/* -------------------------------------------------------------------------- */
/* Public input + emit                                                        */
/* -------------------------------------------------------------------------- */

export interface RecordLaneObservabilityInput {
  event: LaneObservabilityEvent;
  merchantId?: string | null;
  /** Canonical lowercase courier name. */
  courier?: string;
  /** Canonical lowercase district. */
  district?: string;
  /** Canonical lowercase thana. */
  thana?: string;
  /** Outcome / branch label ("delivered", "rto", "cancelled", "high",
   *  "low", "medium", etc). Bounded scalar. */
  reason?: string;
  durationMs?: number;
  /** Truncated error message — never raw stack traces. */
  error?: string;
  /**
   * Bounded scalar metadata. Numbers, booleans, short strings only.
   */
  meta?: Record<string, string | number | boolean | null | undefined>;
}

function safeMeta(
  meta: RecordLaneObservabilityInput["meta"],
): RecordLaneObservabilityInput["meta"] {
  if (!meta) return undefined;
  const out: NonNullable<RecordLaneObservabilityInput["meta"]> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof k !== "string" || k.length === 0 || k.length > 60) continue;
    if (
      v === null ||
      v === undefined ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = v ?? undefined;
      continue;
    }
    if (typeof v === "string") {
      out[k] = v.length > 200 ? v.slice(0, 200) : v;
    }
  }
  return out;
}

export function recordLaneObservability(input: RecordLaneObservabilityInput): void {
  if (!env.DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED) return;
  if (!input || typeof input !== "object") return;
  const { event } = input;
  if (typeof event !== "string" || !(event in counters)) return;
  try {
    counters[event] += 1;
    const line = {
      msg: "lane_intelligence",
      event,
      merchantId: input.merchantId ?? undefined,
      courier: input.courier,
      district: input.district,
      thana: input.thana,
      reason: input.reason,
      durationMs:
        typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
          ? Math.round(input.durationMs)
          : undefined,
      error: input.error ? String(input.error).slice(0, 200) : undefined,
      meta: safeMeta(input.meta),
    };
    if (ERROR_EVENTS.has(event)) {
      console.error(JSON.stringify(line));
    } else {
      console.log(JSON.stringify(line));
    }
  } catch (err) {
    try {
      console.error(
        `[lane-observability] emit failed: ${(err as Error)?.message ?? err}`,
      );
    } catch {
      /* nothing */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Counter snapshot for admin observability surface                           */
/* -------------------------------------------------------------------------- */

export interface LaneCountersSnapshot {
  laneUpdated: number;
  areaUpdated: number;
  laneWriteFailed: number;
  areaWriteFailed: number;
  laneHotKey: number;
  laneCanonicalResolved: number;
  laneCanonicalLowConfidence: number;
}

export function snapshotLaneCounters(): LaneCountersSnapshot {
  return {
    laneUpdated: counters.lane_updated,
    areaUpdated: counters.area_updated,
    laneWriteFailed: counters.lane_write_failed,
    areaWriteFailed: counters.area_write_failed,
    laneHotKey: counters.lane_hot_key,
    laneCanonicalResolved: counters.lane_canonical_resolved,
    laneCanonicalLowConfidence: counters.lane_canonical_low_confidence,
  };
}

/* -------------------------------------------------------------------------- */
/* Hot-key tracker — bounded LRU + rolling 1-minute window                    */
/* -------------------------------------------------------------------------- */

const HOT_KEY_CAPACITY = 256;
const HOT_KEY_WINDOW_MS = 60_000;
const HOT_KEY_EMIT_THRESHOLD = 50; // writes inside the window before we emit `lane_hot_key`

interface HotKeyEntry {
  count: number;
  firstAt: number;
  lastAt: number;
  emitted: boolean;
}

const hotKeys = new Map<string, HotKeyEntry>();

function pruneHotKeys(now: number): void {
  if (hotKeys.size === 0) return;
  // Drop entries whose window has elapsed; eviction is ordered by Map
  // insertion (oldest first), so we can stop scanning at the first
  // non-stale one for the common case.
  for (const [key, entry] of hotKeys) {
    if (now - entry.lastAt > HOT_KEY_WINDOW_MS) {
      hotKeys.delete(key);
    }
  }
}

function evictIfFull(): void {
  if (hotKeys.size <= HOT_KEY_CAPACITY) return;
  // Drop oldest by insertion order (Map iteration is insertion-ordered).
  const drop: string[] = [];
  let toRemove = hotKeys.size - HOT_KEY_CAPACITY;
  for (const key of hotKeys.keys()) {
    if (toRemove <= 0) break;
    drop.push(key);
    toRemove -= 1;
  }
  for (const k of drop) hotKeys.delete(k);
}

/**
 * Record one write toward a hot-key bucket. Cheap (Map.get + Map.set);
 * called from every CourierLane / AreaReliability write success.
 *
 * The tracker is intentionally per-process. Across multiple API pods,
 * each pod sees its own slice of the hot-key distribution; the admin
 * snapshot exposes the per-pod view. Aggregating across pods is left
 * to the log aggregator.
 */
export function recordHotKeyHit(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > 200) return;
  const now = Date.now();
  pruneHotKeys(now);
  let entry = hotKeys.get(key);
  if (!entry) {
    entry = { count: 1, firstAt: now, lastAt: now, emitted: false };
    hotKeys.set(key, entry);
    evictIfFull();
    return;
  }
  // If this entry's window has expired, reset.
  if (now - entry.firstAt > HOT_KEY_WINDOW_MS) {
    entry.count = 1;
    entry.firstAt = now;
    entry.lastAt = now;
    entry.emitted = false;
    return;
  }
  entry.count += 1;
  entry.lastAt = now;
  // Emit a single observability event when the threshold is crossed for
  // this window — re-emitting on every subsequent hit would flood logs.
  if (!entry.emitted && entry.count >= HOT_KEY_EMIT_THRESHOLD) {
    entry.emitted = true;
    recordLaneObservability({
      event: "lane_hot_key",
      reason: "threshold_crossed",
      meta: { key, count: entry.count, windowMs: HOT_KEY_WINDOW_MS },
    });
  }
}

export interface HotKeySnapshotEntry {
  key: string;
  count: number;
  ageMs: number;
}

export function snapshotHotKeys(topN = 20): HotKeySnapshotEntry[] {
  const now = Date.now();
  pruneHotKeys(now);
  const entries: HotKeySnapshotEntry[] = [];
  for (const [key, entry] of hotKeys) {
    entries.push({
      key,
      count: entry.count,
      ageMs: now - entry.firstAt,
    });
  }
  entries.sort((a, b) => b.count - a.count);
  return entries.slice(0, Math.max(1, Math.min(100, topN)));
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

/** Test-only — drops counters + hot-key state. */
export function __resetLaneObservability(): void {
  for (const k of COUNTER_KEYS) counters[k] = 0;
  hotKeys.clear();
}

export const __TEST = {
  COUNTER_KEYS,
  HOT_KEY_CAPACITY,
  HOT_KEY_WINDOW_MS,
  HOT_KEY_EMIT_THRESHOLD,
  pruneHotKeys,
};
