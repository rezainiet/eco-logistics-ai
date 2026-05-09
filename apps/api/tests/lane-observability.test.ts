import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __TEST,
  __resetLaneObservability,
  recordHotKeyHit,
  recordLaneObservability,
  snapshotHotKeys,
  snapshotLaneCounters,
} from "../src/lib/observability/lane-intelligence.js";
import { env } from "../src/env.js";

type MutableEnv = { DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED: boolean };
let originalObservability: boolean;

beforeEach(() => {
  originalObservability = env.DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED;
  (env as unknown as MutableEnv).DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED = true;
  __resetLaneObservability();
});

afterEach(() => {
  (env as unknown as MutableEnv).DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED =
    originalObservability;
  __resetLaneObservability();
});

describe("lane-observability — counters", () => {
  it("snapshot returns zeroed counters before any emit", () => {
    const s = snapshotLaneCounters();
    expect(s.laneUpdated).toBe(0);
    expect(s.areaUpdated).toBe(0);
    expect(s.laneWriteFailed).toBe(0);
    expect(s.areaWriteFailed).toBe(0);
  });

  it("recordLaneObservability bumps the matching counter", () => {
    recordLaneObservability({ event: "lane_updated", reason: "delivered" });
    recordLaneObservability({ event: "lane_updated", reason: "rto" });
    recordLaneObservability({ event: "area_updated", reason: "delivered" });
    const s = snapshotLaneCounters();
    expect(s.laneUpdated).toBe(2);
    expect(s.areaUpdated).toBe(1);
  });

  it("unknown events are silently dropped (closed enum)", () => {
    recordLaneObservability({
      // @ts-expect-error — exercising defensive runtime
      event: "not_a_real_event",
    });
    const s = snapshotLaneCounters();
    expect(s.laneUpdated).toBe(0);
    expect(s.areaUpdated).toBe(0);
  });

  it("flag-off is a no-op (no counter bump)", () => {
    (env as unknown as MutableEnv).DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED =
      false;
    recordLaneObservability({ event: "lane_updated", reason: "delivered" });
    expect(snapshotLaneCounters().laneUpdated).toBe(0);
  });

  it("never throws on degenerate input", () => {
    expect(() =>
      recordLaneObservability(null as unknown as Parameters<typeof recordLaneObservability>[0]),
    ).not.toThrow();
    expect(() =>
      recordLaneObservability(undefined as unknown as Parameters<typeof recordLaneObservability>[0]),
    ).not.toThrow();
    expect(() =>
      recordLaneObservability({
        event: "lane_updated",
        meta: {
          // bounded scalar enforcement — long string is truncated, not rejected.
          tooLong: "x".repeat(500),
        },
      }),
    ).not.toThrow();
  });
});

describe("lane-observability — hot-key tracker", () => {
  it("records hits and surfaces top-N in snapshot", () => {
    for (let i = 0; i < 5; i++) recordHotKeyHit("merchA|lane|pathao|dhaka|dhanmondi");
    for (let i = 0; i < 3; i++) recordHotKeyHit("merchA|lane|redx|dhaka|mirpur");
    recordHotKeyHit("merchA|area|dhaka|dhaka|banani");

    const top = snapshotHotKeys(10);
    expect(top.length).toBe(3);
    expect(top[0]!.key).toBe("merchA|lane|pathao|dhaka|dhanmondi");
    expect(top[0]!.count).toBe(5);
    expect(top[1]!.count).toBe(3);
    expect(top[2]!.count).toBe(1);
  });

  it("emits lane_hot_key event when threshold crossed; only once per window", () => {
    const threshold = __TEST.HOT_KEY_EMIT_THRESHOLD;
    for (let i = 0; i < threshold + 5; i++) {
      recordHotKeyHit("merchB|lane|pathao|dhaka|dhanmondi");
    }
    expect(snapshotLaneCounters().laneHotKey).toBe(1);
  });

  it("evicts oldest entries when capacity is exceeded", () => {
    const cap = __TEST.HOT_KEY_CAPACITY;
    for (let i = 0; i < cap + 50; i++) {
      recordHotKeyHit(`merchC|lane|pathao|dhaka|thana${i}`);
    }
    const top = snapshotHotKeys(500);
    expect(top.length).toBeLessThanOrEqual(cap);
  });

  it("ignores degenerate keys (empty / oversized)", () => {
    recordHotKeyHit("");
    recordHotKeyHit("x".repeat(1000));
    expect(snapshotHotKeys().length).toBe(0);
  });

  it("snapshot honours topN clamp [1, 100]", () => {
    for (let i = 0; i < 5; i++) recordHotKeyHit(`k${i}`);
    expect(snapshotHotKeys(0).length).toBe(1); // clamp lower
    expect(snapshotHotKeys(1000).length).toBe(5); // clamp upper but only 5 entries
  });
});
