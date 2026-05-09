import { describe, expect, it } from "vitest";
import {
  classifyNetworkEvidence,
  __TEST,
  type NetworkEvidenceResult,
  type NetworkEvidenceSignalKey,
} from "../src/lib/network-evidence.js";
import type { NetworkRiskAggregate } from "../src/lib/fraud-network.js";

const NOW = new Date("2026-05-09T12:00:00Z");

const aggregate = (
  partial: Partial<NetworkRiskAggregate> = {},
): NetworkRiskAggregate => ({
  merchantCount: 0,
  deliveredCount: 0,
  rtoCount: 0,
  cancelledCount: 0,
  rtoRate: null,
  firstSeenAt: null,
  lastSeenAt: null,
  bonus: 0,
  matchedOn: "phone",
  ...partial,
});

function findSignal(
  r: NetworkEvidenceResult,
  key: NetworkEvidenceSignalKey,
) {
  return r.signals.find((s) => s.key === key);
}

/* -------------------------------------------------------------------------- */

describe("network-evidence — empty / no-match", () => {
  it("returns EMPTY for null aggregate", () => {
    const r = classifyNetworkEvidence(null);
    expect(r.label).toBe("no_data");
    expect(r.matched).toBe(false);
    expect(r.matchedOn).toBe("none");
    expect(findSignal(r, "network_disabled_or_missing")).toBeDefined();
  });

  it("returns EMPTY for matchedOn=none", () => {
    const r = classifyNetworkEvidence(aggregate({ matchedOn: "none" }));
    expect(r.label).toBe("no_data");
    expect(r.matched).toBe(false);
  });

  it("never throws on undefined aggregate", () => {
    expect(() => classifyNetworkEvidence(undefined)).not.toThrow();
  });
});

describe("network-evidence — strong delivery", () => {
  it("fires network_strong_delivery at >=85% success across >=2 merchants and >=5 obs", () => {
    const r = classifyNetworkEvidence(
      aggregate({
        merchantCount: 3,
        deliveredCount: 9,
        rtoCount: 1,
        cancelledCount: 0,
        rtoRate: 0.1,
        matchedOn: "phone+address",
        lastSeenAt: NOW,
      }),
      { now: NOW },
    );
    expect(r.label).toBe("strong");
    expect(findSignal(r, "network_strong_delivery")).toBeDefined();
    expect(r.successRate).toBeCloseTo(0.9, 2);
    expect(r.merchantCount).toBe(3);
  });

  it("does NOT fire when merchantCount is too low (single-merchant signal stays invisible)", () => {
    const r = classifyNetworkEvidence(
      aggregate({
        merchantCount: 1,
        deliveredCount: 9,
        rtoCount: 1,
        rtoRate: 0.1,
        matchedOn: "phone",
      }),
      { now: NOW },
    );
    expect(r.label).not.toBe("strong");
    expect(findSignal(r, "network_strong_delivery")).toBeUndefined();
  });

  it("does NOT fire when observation count is too low", () => {
    const r = classifyNetworkEvidence(
      aggregate({
        merchantCount: 3,
        deliveredCount: 3,
        rtoCount: 0,
        rtoRate: 0,
        matchedOn: "phone",
      }),
      { now: NOW },
    );
    expect(r.label).not.toBe("strong");
    expect(findSignal(r, "network_sparse")).toBeDefined();
  });
});

describe("network-evidence — high return rate", () => {
  it("fires network_high_return_rate at >=50% RTO across >=2 merchants and >=4 obs", () => {
    const r = classifyNetworkEvidence(
      aggregate({
        merchantCount: 4,
        deliveredCount: 4,
        rtoCount: 6,
        cancelledCount: 0,
        rtoRate: 0.6,
        matchedOn: "phone",
        lastSeenAt: NOW,
      }),
      { now: NOW },
    );
    expect(r.label).toBe("caution");
    expect(findSignal(r, "network_high_return_rate")).toBeDefined();
    expect(r.rtoRate).toBeCloseTo(0.6, 2);
  });

  it("does NOT fire when single merchant has observed (k-anonymity)", () => {
    const r = classifyNetworkEvidence(
      aggregate({
        merchantCount: 1,
        deliveredCount: 1,
        rtoCount: 9,
        rtoRate: 0.9,
        matchedOn: "phone",
      }),
      { now: NOW },
    );
    expect(r.label).not.toBe("caution");
    expect(findSignal(r, "network_high_return_rate")).toBeUndefined();
  });
});

describe("network-evidence — recent activity", () => {
  it("fires network_recent_activity when lastSeenAt within 30d", () => {
    const r = classifyNetworkEvidence(
      aggregate({
        merchantCount: 3,
        deliveredCount: 5,
        rtoCount: 5,
        rtoRate: 0.5,
        matchedOn: "phone",
        lastSeenAt: new Date(NOW.getTime() - 5 * 86400_000),
      }),
      { now: NOW },
    );
    expect(findSignal(r, "network_recent_activity")).toBeDefined();
  });

  it("does NOT fire when lastSeenAt > 30d ago", () => {
    const r = classifyNetworkEvidence(
      aggregate({
        merchantCount: 3,
        deliveredCount: 5,
        rtoCount: 5,
        rtoRate: 0.5,
        matchedOn: "phone",
        lastSeenAt: new Date(NOW.getTime() - 90 * 86400_000),
      }),
      { now: NOW },
    );
    expect(findSignal(r, "network_recent_activity")).toBeUndefined();
  });
});

describe("network-evidence — mixed signals", () => {
  it("strong + caution → label resolves to neutral (mixed evidence)", () => {
    // Contrived but mathematically possible: high RTO rate AND high
    // delivered count across many merchants. The classifier should
    // surface both signals but not pick a side.
    const r = classifyNetworkEvidence(
      aggregate({
        merchantCount: 5,
        deliveredCount: 20,
        rtoCount: 25,
        rtoRate: 25 / 45,
        matchedOn: "phone",
        lastSeenAt: NOW,
      }),
      { now: NOW },
    );
    // 20/45 = 44% success → strong NOT fire (below 85%)
    // 25/45 = 55% RTO → caution fires
    expect(r.label).toBe("caution");
    expect(findSignal(r, "network_high_return_rate")).toBeDefined();
    expect(findSignal(r, "network_strong_delivery")).toBeUndefined();
  });
});

describe("network-evidence — sparse-but-matched", () => {
  it("matched but below actionable floors → label=no_data, signal=network_sparse", () => {
    const r = classifyNetworkEvidence(
      aggregate({
        merchantCount: 2,
        deliveredCount: 1,
        rtoCount: 1,
        rtoRate: 0.5,
        matchedOn: "phone",
      }),
      { now: NOW },
    );
    expect(r.matched).toBe(true);
    expect(r.label).toBe("no_data"); // sparse → no actionable label
    expect(findSignal(r, "network_sparse")).toBeDefined();
  });
});

describe("network-evidence — surface invariants", () => {
  it("source is locked to 'fraud_signal_v1'", () => {
    const r = classifyNetworkEvidence(
      aggregate({ merchantCount: 0, matchedOn: "phone" }),
      { now: NOW },
    );
    expect(r.source).toBe("fraud_signal_v1");
  });

  it("never returns a signal key outside the closed set", () => {
    const r = classifyNetworkEvidence(
      aggregate({
        merchantCount: 3,
        deliveredCount: 9,
        rtoCount: 1,
        rtoRate: 0.1,
        matchedOn: "phone",
        lastSeenAt: NOW,
      }),
      { now: NOW },
    );
    const allowed = new Set(__TEST.EMPTY.signals.map((s) => s.key));
    allowed.add("network_strong_delivery");
    allowed.add("network_high_return_rate");
    allowed.add("network_recent_activity");
    allowed.add("network_sparse");
    for (const s of r.signals) expect(allowed.has(s.key)).toBe(true);
  });

  it("__TEST tunables are exported for downstream calibration", () => {
    expect(__TEST.STRONG_MIN_MERCHANTS).toBe(2);
    expect(__TEST.CAUTION_MIN_MERCHANTS).toBe(2);
    expect(__TEST.RECENT_ACTIVITY_DAYS).toBe(30);
  });
});
