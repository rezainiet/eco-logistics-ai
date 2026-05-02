import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetCourierWebhookCounters,
  recordWebhookOutcome,
  snapshotCounters,
} from "../src/lib/observability/courier-webhook.js";

describe("courier webhook observability", () => {
  afterEach(() => {
    __resetCourierWebhookCounters();
    vi.restoreAllMocks();
  });

  it("counts applied + duplicate + ignored as success", () => {
    recordWebhookOutcome({ provider: "steadfast", outcome: "applied" });
    recordWebhookOutcome({ provider: "steadfast", outcome: "applied" });
    recordWebhookOutcome({ provider: "steadfast", outcome: "duplicate" });
    recordWebhookOutcome({ provider: "steadfast", outcome: "ignored" });
    recordWebhookOutcome({ provider: "steadfast", outcome: "invalid_signature" });

    const snap = snapshotCounters().find((s) => s.provider === "steadfast")!;
    expect(snap.total).toBe(5);
    expect(snap.applied).toBe(2);
    expect(snap.duplicate).toBe(1);
    expect(snap.invalidSignature).toBe(1);
    expect(snap.successRate).toBeCloseTo(4 / 5, 5);
  });

  it("tracks counters per provider independently", () => {
    recordWebhookOutcome({ provider: "pathao", outcome: "applied" });
    recordWebhookOutcome({ provider: "redx", outcome: "applied" });
    recordWebhookOutcome({ provider: "redx", outcome: "applied" });
    const snaps = snapshotCounters();
    expect(snaps.find((s) => s.provider === "pathao")!.total).toBe(1);
    expect(snaps.find((s) => s.provider === "redx")!.total).toBe(2);
    expect(snaps.find((s) => s.provider === "steadfast")!.total).toBe(0);
  });

  it("logs to stderr (not stdout) for warn-tier outcomes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    recordWebhookOutcome({ provider: "steadfast", outcome: "invalid_signature", merchantId: "m1" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(err).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("logs to stderr AND captures Sentry for apply_failed", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    recordWebhookOutcome({
      provider: "steadfast",
      outcome: "apply_failed",
      merchantId: "m1",
      error: "boom",
    });
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("emits a JSON-only log line containing trackingCode but not PII fields", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    recordWebhookOutcome({
      provider: "pathao",
      outcome: "applied",
      merchantId: "m1",
      trackingCode: "P-42",
      newEvents: 1,
    });
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.provider).toBe("pathao");
    expect(parsed.outcome).toBe("applied");
    expect(parsed.trackingCode).toBe("P-42");
    expect(parsed.merchantId).toBe("m1");
    // No PII fields surface in the log line.
    expect(parsed.phone).toBeUndefined();
    expect(parsed.address).toBeUndefined();
    expect(parsed.cod).toBeUndefined();
  });
});
