import { describe, it, expect } from "vitest";
import {
  computeIntentScore,
  INTENT_SIGNAL_KEYS,
  type SessionInput,
  type IntentSignalKey,
} from "../src/lib/intent.js";

/**
 * Intent Intelligence v1 unit tests.
 *
 * No DB. Pure-function coverage for `computeIntentScore`. The async
 * `scoreIntentForOrder` helper is exercised separately in
 * `tests/intent.ingestion.test.ts` (this file only validates the math).
 *
 *  - no-data fallback
 *  - tier classification (verified / implicit / unverified)
 *  - signal contributions (each key fires when expected)
 *  - paid-social vs organic vs direct attribution
 *  - multi-session converter (span-day calculation)
 *  - confirmation-input layer (delivered + replied + fast)
 *  - score clamping
 *  - determinism
 */

const baseSession: SessionInput = {
  pageViews: 1,
  productViews: 0,
  addToCartCount: 0,
  checkoutStartCount: 1,
  checkoutSubmitCount: 1,
  maxScrollDepth: 0,
  durationMs: 0,
  repeatVisitor: false,
  landingPath: "/",
  campaign: null,
  firstSeenAt: new Date("2026-05-01T10:00:00Z"),
  lastSeenAt: new Date("2026-05-01T10:00:30Z"),
};

describe("computeIntentScore — no_data fallback", () => {
  it("returns no_data tier and a single explanatory signal when sessions is empty", () => {
    const r = computeIntentScore([]);
    expect(r.tier).toBe("no_data");
    expect(r.score).toBe(0);
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]!.key).toBe("no_session_data");
    expect(r.sessionsConsidered).toBe(0);
  });

  it("treats null / undefined input the same as empty array", () => {
    expect(computeIntentScore(null).tier).toBe("no_data");
    expect(computeIntentScore(undefined).tier).toBe("no_data");
  });
});

describe("computeIntentScore — commitment subscore", () => {
  it("fires repeat_visitor signal when session.repeatVisitor is true", () => {
    const r = computeIntentScore([{ ...baseSession, repeatVisitor: true }]);
    expect(r.signals.map((s) => s.key)).toContain("repeat_visitor");
  });

  it("fires repeat_visitor signal when 2+ sessions stitch to the order", () => {
    const r = computeIntentScore([baseSession, baseSession]);
    expect(r.signals.map((s) => s.key)).toContain("repeat_visitor");
  });

  it("fires deep_engagement when productViews >= 3", () => {
    const r = computeIntentScore([{ ...baseSession, productViews: 4 }]);
    expect(r.signals.map((s) => s.key)).toContain("deep_engagement");
  });

  it("fires deep_engagement (alt path) when scrollDepth >= 50", () => {
    const r = computeIntentScore([{ ...baseSession, maxScrollDepth: 75 }]);
    expect(r.signals.map((s) => s.key)).toContain("deep_engagement");
  });

  it("fires long_dwell when total durationMs >= 60s", () => {
    const r = computeIntentScore([{ ...baseSession, durationMs: 90_000 }]);
    expect(r.signals.map((s) => s.key)).toContain("long_dwell");
  });

  it("fires funnel_completion when submit/start ratio >= 0.5", () => {
    const r = computeIntentScore([
      { ...baseSession, checkoutStartCount: 2, checkoutSubmitCount: 1 },
    ]);
    expect(r.signals.map((s) => s.key)).toContain("funnel_completion");
  });

  it("does NOT fire funnel_completion when submit < half of starts", () => {
    const r = computeIntentScore([
      { ...baseSession, checkoutStartCount: 5, checkoutSubmitCount: 1 },
    ]);
    expect(r.signals.map((s) => s.key)).not.toContain("funnel_completion");
  });
});

describe("computeIntentScore — engagement quality", () => {
  it("rewards organic search (medium=organic) with the high bonus", () => {
    const r = computeIntentScore([
      {
        ...baseSession,
        campaign: { source: "google", medium: "organic" },
      },
    ]);
    const sig = r.signals.find((s) => s.key === "organic_landing");
    expect(sig).toBeDefined();
    expect(sig!.weight).toBe(15);
  });

  it("rewards direct/no-attribution with the lower organic bonus", () => {
    const r = computeIntentScore([{ ...baseSession, campaign: null }]);
    const sig = r.signals.find((s) => s.key === "organic_landing");
    expect(sig).toBeDefined();
    expect(sig!.weight).toBe(10);
  });

  it("does NOT reward paid social (medium=cpc on facebook source)", () => {
    const r = computeIntentScore([
      {
        ...baseSession,
        campaign: { source: "facebook", medium: "cpc" },
      },
    ]);
    expect(r.signals.map((s) => s.key)).not.toContain("organic_landing");
  });

  it("fires multi_session_converter when sessions span >= 1 day", () => {
    const earlier: SessionInput = {
      ...baseSession,
      firstSeenAt: new Date("2026-05-01T10:00:00Z"),
      lastSeenAt: new Date("2026-05-01T10:30:00Z"),
    };
    const later: SessionInput = {
      ...baseSession,
      firstSeenAt: new Date("2026-05-03T10:00:00Z"),
      lastSeenAt: new Date("2026-05-03T10:30:00Z"),
    };
    const r = computeIntentScore([earlier, later]);
    expect(r.signals.map((s) => s.key)).toContain("multi_session_converter");
  });

  it("does NOT fire multi_session_converter when sessions are within the same day", () => {
    const r = computeIntentScore([baseSession, baseSession]);
    expect(r.signals.map((s) => s.key)).not.toContain("multi_session_converter");
  });
});

describe("computeIntentScore — confirmation quality", () => {
  it("fires confirmation_delivered when DLR=delivered", () => {
    const r = computeIntentScore([baseSession], { deliveryStatus: "delivered" });
    expect(r.signals.map((s) => s.key)).toContain("confirmation_delivered");
  });

  it("fires confirmation_replied when buyer replied", () => {
    const r = computeIntentScore([baseSession], { replied: true });
    expect(r.signals.map((s) => s.key)).toContain("confirmation_replied");
  });

  it("fires fast_confirmation when reply lands within 1h of send", () => {
    const sent = new Date("2026-05-01T10:00:00Z");
    const replied = new Date("2026-05-01T10:30:00Z");
    const r = computeIntentScore([baseSession], {
      replied: true,
      sentAt: sent,
      repliedAt: replied,
    });
    expect(r.signals.map((s) => s.key)).toContain("fast_confirmation");
  });

  it("does NOT fire fast_confirmation when reply is > 1h after send", () => {
    const sent = new Date("2026-05-01T10:00:00Z");
    const replied = new Date("2026-05-01T12:00:00Z");
    const r = computeIntentScore([baseSession], {
      replied: true,
      sentAt: sent,
      repliedAt: replied,
    });
    expect(r.signals.map((s) => s.key)).not.toContain("fast_confirmation");
  });
});

describe("computeIntentScore — tier classification", () => {
  it("scores a high-engagement multi-day organic-search visitor as verified", () => {
    // Verified requires either (multi-day return + organic) OR (organic +
    // confirmation reply). Single-session buyers cap at implicit by design
    // — confirmation reply / multi-day return is the strongest commitment
    // signal we can observe pre-dispatch.
    const earlier = new Date("2026-04-29T10:00:00Z");
    const later = new Date("2026-05-01T11:00:00Z");
    const r = computeIntentScore([
      {
        ...baseSession,
        repeatVisitor: true,
        productViews: 5,
        durationMs: 120_000,
        campaign: { source: "google", medium: "organic" },
        firstSeenAt: earlier,
        lastSeenAt: earlier,
      },
      {
        ...baseSession,
        firstSeenAt: later,
        lastSeenAt: later,
      },
    ]);
    expect(r.tier).toBe("verified");
    expect(r.score).toBeGreaterThanOrEqual(70);
  });

  it("scores a single-session organic-search visitor as implicit (verified needs more)", () => {
    const r = computeIntentScore([
      {
        ...baseSession,
        repeatVisitor: true,
        productViews: 3,
        durationMs: 90_000,
        campaign: { source: "google", medium: "organic" },
      },
    ]);
    expect(r.tier).toBe("implicit");
    expect(r.score).toBeGreaterThanOrEqual(40);
    expect(r.score).toBeLessThan(70);
  });

  it("scores a moderate paid-social repeat visitor as implicit", () => {
    const r = computeIntentScore([
      {
        ...baseSession,
        repeatVisitor: true,
        productViews: 3,
        durationMs: 90_000,
        campaign: { source: "facebook", medium: "cpc" },
      },
    ]);
    expect(r.tier).toBe("implicit");
  });

  it("scores a thin paid-social session as unverified", () => {
    const r = computeIntentScore([
      {
        ...baseSession,
        campaign: { source: "tiktok", medium: "paid_social" },
      },
    ]);
    expect(r.tier).toBe("unverified");
    expect(r.score).toBeLessThan(40);
  });
});

describe("computeIntentScore — score clamping + determinism", () => {
  it("never returns score > 100", () => {
    const r = computeIntentScore(
      [
        {
          ...baseSession,
          repeatVisitor: true,
          productViews: 99,
          maxScrollDepth: 100,
          durationMs: 1_000_000,
          checkoutStartCount: 1,
          checkoutSubmitCount: 1,
          campaign: { source: "google", medium: "organic" },
          firstSeenAt: new Date("2026-04-01T00:00:00Z"),
          lastSeenAt: new Date("2026-05-01T00:00:00Z"),
        },
        {
          ...baseSession,
          firstSeenAt: new Date("2026-04-01T00:00:00Z"),
        },
      ],
      { deliveryStatus: "delivered", replied: true,
        sentAt: new Date(), repliedAt: new Date() },
    );
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("never returns score < 0", () => {
    const r = computeIntentScore([baseSession]);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it("emits only known signal keys", () => {
    const r = computeIntentScore([
      {
        ...baseSession,
        repeatVisitor: true,
        productViews: 4,
        durationMs: 90_000,
      },
    ]);
    for (const s of r.signals) {
      expect(INTENT_SIGNAL_KEYS).toContain(s.key as IntentSignalKey);
    }
  });

  it("same input → same score", () => {
    const inp: SessionInput[] = [
      {
        ...baseSession,
        productViews: 3,
        durationMs: 90_000,
      },
    ];
    const a = computeIntentScore(inp);
    const b = computeIntentScore(inp);
    expect(a.score).toBe(b.score);
    expect(a.tier).toBe(b.tier);
    expect(a.signals.map((s) => s.key)).toEqual(b.signals.map((s) => s.key));
  });
});
