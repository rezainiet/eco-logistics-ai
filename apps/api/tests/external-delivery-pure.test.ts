import { describe, expect, it } from "vitest";
import {
  hashNormalizedPhone,
  normalizeAndHashBdPhone,
  normalizeBdPhone,
} from "../src/lib/external-delivery/normalization.js";
import {
  aggregateProviders,
  providerSuccessRateVariance,
  type ProviderResultLike,
} from "../src/lib/external-delivery/aggregation.js";
import {
  __TEST,
  classifyExternalDeliverySignals,
} from "../src/lib/external-delivery/signals.js";
import { hashPhoneForNetwork } from "../src/lib/fraud-network.js";

/* -------------------------------------------------------------------------- */

describe("external-delivery / normalization", () => {
  it("normalises canonical 13-digit form unchanged", () => {
    expect(normalizeBdPhone("8801712345678")).toBe("8801712345678");
  });

  it("normalises 11-digit local form to 13-digit canonical", () => {
    expect(normalizeBdPhone("01712345678")).toBe("8801712345678");
  });

  it("strips non-digits before normalising", () => {
    expect(normalizeBdPhone("+880 17-12345678")).toBe("8801712345678");
    expect(normalizeBdPhone("(0171) 234-5678")).toBe("8801712345678");
  });

  it("rejects all-same-digit placeholders", () => {
    expect(normalizeBdPhone("00000000000")).toBeNull();
    expect(normalizeBdPhone("99999999999")).toBeNull();
  });

  it("rejects too-short / too-long / non-BD shapes", () => {
    expect(normalizeBdPhone("1234567")).toBeNull();
    expect(normalizeBdPhone("12345678901234567")).toBeNull();
    expect(normalizeBdPhone("01112345678")).toBeNull(); // 011 is not a valid BD operator
  });

  it("rejects degenerate input types", () => {
    expect(normalizeBdPhone(null)).toBeNull();
    expect(normalizeBdPhone(undefined)).toBeNull();
    expect(normalizeBdPhone(12345)).toBeNull();
    expect(normalizeBdPhone("")).toBeNull();
  });

  it("hash matches hashPhoneForNetwork output (cross-reference with FraudSignal)", () => {
    const phone = "8801712345678";
    expect(hashNormalizedPhone(phone)).toBe(hashPhoneForNetwork(phone));
  });

  it("normalizeAndHashBdPhone returns null on unusable input", () => {
    expect(normalizeAndHashBdPhone("00000")).toBeNull();
    expect(normalizeAndHashBdPhone(null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

const provider = (
  name: string,
  partial: Partial<ProviderResultLike> = {},
): ProviderResultLike => ({
  name,
  configured: true,
  ok: true,
  total: 0,
  delivered: 0,
  rto: 0,
  cancelled: 0,
  successRate: null,
  ...partial,
});

describe("external-delivery / aggregation", () => {
  it("returns zeros + null successRate when no providers", () => {
    const r = aggregateProviders([]);
    expect(r.total).toBe(0);
    expect(r.successRate).toBeNull();
    expect(r.contributingProviders).toEqual([]);
  });

  it("excludes unconfigured providers from aggregate", () => {
    const r = aggregateProviders([
      provider("pathao", { configured: false, total: 999 }),
      provider("redx", { total: 10, delivered: 9, rto: 1 }),
    ]);
    expect(r.total).toBe(10);
    expect(r.contributingProviders).toEqual(["redx"]);
  });

  it("excludes failed providers (ok=false) from aggregate", () => {
    const r = aggregateProviders([
      provider("pathao", { ok: false, total: 999 }),
      provider("redx", { total: 10, delivered: 9, rto: 1 }),
    ]);
    expect(r.total).toBe(10);
    expect(r.contributingProviders).toEqual(["redx"]);
  });

  it("computes successRate as delivered / (delivered + rto), excluding cancelled", () => {
    const r = aggregateProviders([
      provider("pathao", { total: 20, delivered: 15, rto: 3, cancelled: 2 }),
    ]);
    expect(r.successRate).toBeCloseTo(15 / 18, 3);
  });

  it("merges multiple providers into a single contributing list (preserving input order)", () => {
    const r = aggregateProviders([
      provider("pathao", { total: 5, delivered: 5 }),
      provider("steadfast", { total: 10, delivered: 8, rto: 2 }),
      provider("redx", { total: 3, delivered: 1, rto: 2 }),
    ]);
    expect(r.contributingProviders).toEqual(["pathao", "steadfast", "redx"]);
    expect(r.total).toBe(18);
    expect(r.delivered).toBe(14);
    expect(r.rto).toBe(4);
  });

  it("safeCount clamps NaN / negative / non-finite to 0", () => {
    const r = aggregateProviders([
      provider("pathao", {
        // @ts-expect-error — exercising defensive runtime
        total: Number.NaN,
        delivered: -5,
        rto: Infinity,
      }),
    ]);
    expect(r.total).toBe(0);
    expect(r.delivered).toBe(0);
    expect(r.rto).toBe(0);
  });
});

describe("external-delivery / providerSuccessRateVariance", () => {
  it("returns 0 when fewer than 2 providers contribute", () => {
    expect(
      providerSuccessRateVariance([provider("pathao", { total: 10, delivered: 9, rto: 1 })]),
    ).toBe(0);
  });

  it("returns 0 across uniform success rates", () => {
    const v = providerSuccessRateVariance([
      provider("pathao", { total: 10, delivered: 9, rto: 1 }),
      provider("redx", { total: 20, delivered: 18, rto: 2 }),
    ]);
    expect(v).toBeCloseTo(0, 5);
  });

  it("surfaces meaningful variance across divergent providers", () => {
    const v = providerSuccessRateVariance([
      provider("pathao", { total: 10, delivered: 9, rto: 1 }),  // 0.9
      provider("redx", { total: 10, delivered: 4, rto: 6 }),     // 0.4
    ]);
    expect(v).toBeGreaterThan(0.2);
  });
});

/* -------------------------------------------------------------------------- */

describe("external-delivery / classifyExternalDeliverySignals", () => {
  it("zero data → sparse_history=true, others=false", () => {
    const r = classifyExternalDeliverySignals(
      { total: 0, delivered: 0, rto: 0, cancelled: 0, successRate: null, contributingProviders: [] },
      [],
    );
    expect(r).toEqual({
      strong_delivery_history: false,
      elevated_return_pattern: false,
      sparse_history: true,
      mixed_delivery_history: false,
    });
  });

  it("sparse_history=true short-circuits both positive AND negative verdicts", () => {
    // Below SPARSE_HISTORY_THRESHOLD (5) — even with 100% returns we won't
    // call the buyer elevated-return.
    const r = classifyExternalDeliverySignals(
      { total: 4, delivered: 0, rto: 4, cancelled: 0, successRate: 0, contributingProviders: ["pathao"] },
      [provider("pathao", { total: 4, delivered: 0, rto: 4 })],
    );
    expect(r.sparse_history).toBe(true);
    expect(r.elevated_return_pattern).toBe(false);
  });

  it("elevated_return_pattern fires at (rto+cancelled)/total >= 0.25 with >= 10 obs", () => {
    const r = classifyExternalDeliverySignals(
      { total: 20, delivered: 14, rto: 6, cancelled: 0, successRate: 14 / 20, contributingProviders: ["pathao"] },
      [provider("pathao", { total: 20, delivered: 14, rto: 6, successRate: 14 / 20 })],
    );
    // 6/20 = 30% returnish → elevated fires
    expect(r.elevated_return_pattern).toBe(true);
    expect(r.sparse_history).toBe(false);
  });

  it("elevated_return_pattern uses (rto + cancelled) — covers providers that conflate the two", () => {
    // BDCourier-style: the upstream lumps RTOs into cancelled, so we
    // see rto=0 cancelled=5 on 15 total. The signal must still fire.
    const r = classifyExternalDeliverySignals(
      { total: 15, delivered: 10, rto: 0, cancelled: 5, successRate: 1, contributingProviders: ["bdcourier"] },
      [provider("bdcourier", { total: 15, delivered: 10, rto: 0, cancelled: 5, successRate: 1 })],
    );
    // 5/15 = 33% returnish via cancelled → elevated still fires
    expect(r.elevated_return_pattern).toBe(true);
  });

  it("strong_delivery_history fires at successRate >= 0.9 with >= 15 observations", () => {
    const r = classifyExternalDeliverySignals(
      { total: 20, delivered: 19, rto: 1, cancelled: 0, successRate: 19 / 20, contributingProviders: ["pathao"] },
      [provider("pathao", { total: 20, delivered: 19, rto: 1, successRate: 19 / 20 })],
    );
    expect(r.strong_delivery_history).toBe(true);
  });

  it("strong_delivery_history does NOT fire below MIN_OBSERVATIONS even at 100% success", () => {
    const r = classifyExternalDeliverySignals(
      { total: 10, delivered: 10, rto: 0, cancelled: 0, successRate: 1, contributingProviders: ["pathao"] },
      [provider("pathao", { total: 10, delivered: 10, successRate: 1 })],
    );
    expect(r.strong_delivery_history).toBe(false);
  });

  it("mixed_delivery_history fires when per-provider variance > threshold", () => {
    const r = classifyExternalDeliverySignals(
      { total: 30, delivered: 20, rto: 10, cancelled: 0, successRate: 20 / 30, contributingProviders: ["pathao", "redx"] },
      [
        provider("pathao", { total: 15, delivered: 14, rto: 1 }),  // 93%
        provider("redx", { total: 15, delivered: 6, rto: 9 }),     // 40%
      ],
    );
    expect(r.mixed_delivery_history).toBe(true);
  });

  it("__TEST tunables are exported for downstream test calibration", () => {
    expect(__TEST.SPARSE_HISTORY_THRESHOLD).toBe(5);
    expect(__TEST.ELEVATED_RETURN_MIN_OBSERVATIONS).toBe(10);
    expect(__TEST.STRONG_MIN_OBSERVATIONS).toBe(15);
  });
});
