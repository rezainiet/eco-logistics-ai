import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { __TEST as RECONCILE_CLI } from "../src/scripts/reconcileDeliveryReliability.js";
import { __TEST as REPAIR_CLI } from "../src/scripts/repairDeliveryReliability.js";
import { MAX_REPAIR_BATCH } from "../src/lib/delivery-reliability-repair.js";
import { MAX_RECONCILE_SCAN } from "../src/lib/delivery-reliability-reconciliation.js";
import type { RepairKeyResult, RepairSliceResult } from "../src/lib/delivery-reliability-repair.js";

/**
 * S10 finalization — pure-function CLI tests for reconcile + repair scripts.
 *
 * These cover the script-level helpers (`parseArgs`, formatters) without
 * booting the script's `connectDb → run → disconnect` lifecycle. They
 * complement `tests/delivery-reliability-rollout.test.ts` which already
 * covers the verify CLI's helpers.
 */

const NOW = new Date("2026-05-08T12:00:00Z");

/* ========================================================================== */
/* reconcileDeliveryReliability — parseArgs                                   */
/* ========================================================================== */

describe("reconcileDeliveryReliability.parseArgs", () => {
  it("defaults axis to customer when not supplied", () => {
    expect(RECONCILE_CLI.parseArgs(["node", "script"])).toEqual({
      axis: "customer",
    });
  });

  it("extracts --merchant", () => {
    const args = RECONCILE_CLI.parseArgs([
      "node",
      "script",
      "--merchant=507f1f77bcf86cd799439011",
    ]);
    expect(args.merchant).toBe("507f1f77bcf86cd799439011");
    expect(args.axis).toBe("customer");
  });

  it("extracts --axis=address", () => {
    const args = RECONCILE_CLI.parseArgs(["node", "script", "--axis=address"]);
    expect(args.axis).toBe("address");
  });

  it("ignores --axis with an invalid value (defaults to customer)", () => {
    const args = RECONCILE_CLI.parseArgs(["node", "script", "--axis=garbage"]);
    expect(args.axis).toBe("customer");
  });

  it("extracts --limit as an integer", () => {
    const args = RECONCILE_CLI.parseArgs(["node", "script", "--limit=500"]);
    expect(args.limit).toBe(500);
  });

  it("ignores --limit with non-numeric input", () => {
    const args = RECONCILE_CLI.parseArgs(["node", "script", "--limit=abc"]);
    expect(args.limit).toBeUndefined();
  });

  it("extracts --key", () => {
    const args = RECONCILE_CLI.parseArgs([
      "node",
      "script",
      "--key=abcdef0123456789",
    ]);
    expect(args.hashKey).toBe("abcdef0123456789");
  });

  it("extracts --json flag", () => {
    const args = RECONCILE_CLI.parseArgs(["node", "script", "--json"]);
    expect(args.json).toBe(true);
  });

  it("combines all flags", () => {
    const args = RECONCILE_CLI.parseArgs([
      "node",
      "script",
      "--merchant=507f1f77bcf86cd799439011",
      "--axis=address",
      "--limit=200",
      "--key=keyhash",
      "--json",
    ]);
    expect(args).toEqual({
      merchant: "507f1f77bcf86cd799439011",
      axis: "address",
      limit: 200,
      hashKey: "keyhash",
      json: true,
    });
  });
});

/* ========================================================================== */
/* reconcileDeliveryReliability — formatHumanReport                           */
/* ========================================================================== */

describe("reconcileDeliveryReliability.formatHumanReport", () => {
  it("produces a non-empty report for an empty result", () => {
    const out = RECONCILE_CLI.formatHumanReport({
      merchantId: "507f1f77bcf86cd799439011",
      axis: "customer",
      generatedAt: NOW,
      entries: [],
      driftedKeys: [],
      missingKeys: [],
      ordersScanned: 0,
      truncated: false,
      warnings: [],
    });
    expect(out).toContain("Reconciliation Report");
    expect(out).toContain("merchantId:");
    expect(out).toContain("507f1f77bcf86cd799439011");
    expect(out).toContain("axis:");
    expect(out).toContain("customer");
    expect(out).toContain("driftedKeys:      0");
  });

  it("renders drifted keys section with top-magnitude rows", () => {
    const out = RECONCILE_CLI.formatHumanReport({
      merchantId: "507f1f77bcf86cd799439011",
      axis: "customer",
      generatedAt: NOW,
      entries: [
        {
          axis: "customer",
          hashKey: "h".repeat(32),
          exists: true,
          aggregate: { delivered: 1, rto: 0, cancelled: 0 },
          expected: { delivered: 5, rto: 0, cancelled: 0 },
          drift: { delivered: 4, rto: 0, cancelled: 0 },
          driftMagnitude: 4,
          windowStart: new Date(NOW.getTime() - 86400_000),
          sampleSize: 5,
        },
      ],
      driftedKeys: ["h".repeat(32)],
      missingKeys: [],
      ordersScanned: 5,
      truncated: false,
      warnings: [],
    });
    expect(out).toContain("DRIFTED KEYS");
    expect(out).toContain("drift=4");
    expect(out).toContain("agg(D=1");
    expect(out).toContain("expected(D=5");
  });

  it("renders missing aggregates section", () => {
    const out = RECONCILE_CLI.formatHumanReport({
      merchantId: "507f1f77bcf86cd799439011",
      axis: "address",
      generatedAt: NOW,
      entries: [],
      driftedKeys: [],
      missingKeys: ["m".repeat(32)],
      ordersScanned: 2,
      truncated: false,
      warnings: [],
    });
    expect(out).toContain("MISSING AGGREGATES");
    expect(out.includes("m".repeat(16))).toBe(true);
  });

  it("renders truncated + warnings", () => {
    const out = RECONCILE_CLI.formatHumanReport({
      merchantId: "507f1f77bcf86cd799439011",
      axis: "customer",
      generatedAt: NOW,
      entries: [],
      driftedKeys: [],
      missingKeys: [],
      ordersScanned: 9999,
      truncated: true,
      warnings: ["order scan capped at 9999"],
    });
    expect(out).toContain("truncated:        true");
    expect(out).toContain("warnings:");
    expect(out).toContain("order scan capped");
  });
});

/* ========================================================================== */
/* repairDeliveryReliability — parseArgs                                      */
/* ========================================================================== */

describe("repairDeliveryReliability.parseArgs", () => {
  it("defaults axis=customer, limit=MAX_REPAIR_BATCH, apply=false", () => {
    expect(REPAIR_CLI.parseArgs(["node", "script"])).toEqual({
      axis: "customer",
      limit: MAX_REPAIR_BATCH,
      apply: false,
    });
  });

  it("extracts --apply flag", () => {
    const args = REPAIR_CLI.parseArgs(["node", "script", "--apply"]);
    expect(args.apply).toBe(true);
  });

  it("clamps --limit to [1, MAX_REPAIR_BATCH]", () => {
    expect(
      REPAIR_CLI.parseArgs(["node", "script", "--limit=0"]).limit,
    ).toBe(1);
    expect(
      REPAIR_CLI.parseArgs(["node", "script", `--limit=${MAX_REPAIR_BATCH + 50}`]).limit,
    ).toBe(MAX_REPAIR_BATCH);
    expect(
      REPAIR_CLI.parseArgs(["node", "script", "--limit=42"]).limit,
    ).toBe(42);
  });

  it("ignores non-numeric --limit (default preserved)", () => {
    const args = REPAIR_CLI.parseArgs(["node", "script", "--limit=abc"]);
    expect(args.limit).toBe(MAX_REPAIR_BATCH);
  });

  it("extracts --merchant + --axis + --key + --apply + --json combined", () => {
    const args = REPAIR_CLI.parseArgs([
      "node",
      "script",
      "--merchant=507f1f77bcf86cd799439011",
      "--axis=address",
      "--key=somehash",
      "--apply",
      "--json",
    ]);
    expect(args).toEqual({
      merchant: "507f1f77bcf86cd799439011",
      axis: "address",
      hashKey: "somehash",
      limit: MAX_REPAIR_BATCH,
      apply: true,
      json: true,
    });
  });

  it("--axis with unknown value defaults to customer", () => {
    const args = REPAIR_CLI.parseArgs(["node", "script", "--axis=garbage"]);
    expect(args.axis).toBe("customer");
  });
});

/* ========================================================================== */
/* repairDeliveryReliability — formatKeyResult                                */
/* ========================================================================== */

describe("repairDeliveryReliability.formatKeyResult", () => {
  const merchantId = new Types.ObjectId().toHexString();

  function baseResult(action: RepairKeyResult["action"]): RepairKeyResult {
    return {
      axis: "customer",
      merchantId,
      hashKey: "k".repeat(32),
      driftBefore: {
        axis: "customer",
        hashKey: "k".repeat(32),
        exists: true,
        aggregate: { delivered: 1, rto: 0, cancelled: 0 },
        expected: { delivered: 5, rto: 0, cancelled: 0 },
        drift: { delivered: 4, rto: 0, cancelled: 0 },
        driftMagnitude: 4,
        windowStart: NOW,
        sampleSize: 5,
      },
      action,
      proposed: { deliveredCount: 5, rtoCount: 0, cancelledCount: 0 },
    };
  }

  it("renders the NOOP discriminant with reason", () => {
    const out = REPAIR_CLI.formatKeyResult(
      baseResult({ kind: "noop", reason: "drift_within_tolerance" }),
    );
    expect(out).toContain("NOOP (drift_within_tolerance)");
    expect(out).toContain("magnitude=4");
  });

  it("renders the APPLIED discriminant with mutated fields", () => {
    const out = REPAIR_CLI.formatKeyResult(
      baseResult({
        kind: "applied",
        mutatedFields: ["deliveredCount", "rtoCount", "cancelledCount"],
      }),
    );
    expect(out).toContain("APPLIED [deliveredCount, rtoCount, cancelledCount]");
  });

  it("renders the FAILED discriminant with the error message", () => {
    const out = REPAIR_CLI.formatKeyResult(
      baseResult({ kind: "failed", error: "row not found at write time" }),
    );
    expect(out).toContain("FAILED: row not found at write time");
  });

  it("renders missing-aggregate without driftBefore as 'no drift report'", () => {
    const out = REPAIR_CLI.formatKeyResult({
      axis: "customer",
      merchantId,
      hashKey: "k".repeat(32),
      driftBefore: null,
      action: { kind: "noop", reason: "missing_aggregate_skipped" },
      proposed: null,
    });
    expect(out).toContain("no drift report");
  });
});

/* ========================================================================== */
/* repairDeliveryReliability — formatSliceResult / formatSingleKeyResult      */
/* ========================================================================== */

describe("repairDeliveryReliability.formatSliceResult", () => {
  const merchantId = new Types.ObjectId().toHexString();

  function emptySlice(): RepairSliceResult {
    return {
      axis: "customer",
      merchantId,
      generatedAt: NOW,
      perKey: [],
      capped: 0,
      warnings: [],
    };
  }

  it("renders a header with mode=DRY-RUN when applyMode=false", () => {
    const out = REPAIR_CLI.formatSliceResult(emptySlice(), false);
    expect(out).toContain("=== Delivery Reliability — Repair Report ===");
    expect(out).toContain("mode:             DRY-RUN");
    expect(out).toContain("Re-run with --apply to mutate");
  });

  it("renders mode=APPLY when applyMode=true", () => {
    const out = REPAIR_CLI.formatSliceResult(emptySlice(), true);
    expect(out).toContain("mode:             APPLY");
    expect(out).not.toContain("Re-run with --apply");
  });

  it("includes capped + warnings", () => {
    const out = REPAIR_CLI.formatSliceResult(
      {
        ...emptySlice(),
        capped: 7,
        warnings: ["order scan capped"],
      },
      false,
    );
    expect(out).toContain("keys capped:      7");
    expect(out).toContain("order scan capped");
  });

  it("formatSingleKeyResult renders DRY-RUN footer note", () => {
    const out = REPAIR_CLI.formatSingleKeyResult(
      {
        axis: "customer",
        merchantId,
        hashKey: "k".repeat(32),
        driftBefore: null,
        action: { kind: "noop", reason: "missing_aggregate_skipped" },
        proposed: null,
      },
      false,
    );
    expect(out).toContain("=== Delivery Reliability — Single-Key Repair ===");
    expect(out).toContain("Re-run with --apply");
  });

  it("formatSingleKeyResult omits the footer in apply mode", () => {
    const out = REPAIR_CLI.formatSingleKeyResult(
      {
        axis: "customer",
        merchantId,
        hashKey: "k".repeat(32),
        driftBefore: null,
        action: { kind: "noop", reason: "dry_run" },
        proposed: null,
      },
      true,
    );
    expect(out).not.toContain("Re-run with --apply");
  });
});

/* ========================================================================== */
/* Sanity: caps used by the CLIs are exposed                                  */
/* ========================================================================== */

describe("CLI cap constants", () => {
  it("MAX_RECONCILE_SCAN exposed for the reconcile CLI", () => {
    expect(MAX_RECONCILE_SCAN).toBe(10_000);
  });

  it("MAX_REPAIR_BATCH exposed for the repair CLI", () => {
    expect(MAX_REPAIR_BATCH).toBe(100);
  });
});
