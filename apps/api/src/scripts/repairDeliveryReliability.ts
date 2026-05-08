import mongoose, { Types } from "mongoose";
import { connectDb } from "../lib/db.js";
import {
  rebuildAggregateForKey,
  rebuildSliceForMerchant,
  MAX_REPAIR_BATCH,
  type RepairKeyResult,
  type RepairSliceResult,
} from "../lib/delivery-reliability-repair.js";
import type { ReliabilityAxis } from "../lib/delivery-reliability-reconciliation.js";

/**
 * repairDeliveryReliability — bounded, explicit-invocation repair CLI.
 *
 * Hard rules (binding):
 *   - **Dry-run by default.** The CLI defaults to dry-run; pass `--apply`
 *     to write. Even with `--apply`, the underlying helper enforces a
 *     drift-tolerance gate so trivial 1-count discrepancies don't
 *     mutate.
 *   - **Bounded scope.** Either single-key (`--key=<hash>`) or merchant-
 *     scoped slice (capped at MAX_REPAIR_BATCH=100). No global rebuild.
 *   - **Idempotent writes.** Repair uses `$set` of absolute counter
 *     values from the reconciler's expected output.
 *   - **Audit trail.** Every applied repair emits an
 *     `integrity_warning` observability event so the structured-log
 *     stream records the change.
 *
 * Usage:
 *   # Single-key repair (dry-run):
 *   npx tsx src/scripts/repairDeliveryReliability.ts --merchant=<hex> --axis=customer --key=<phoneHash>
 *
 *   # Single-key repair (apply):
 *   npx tsx src/scripts/repairDeliveryReliability.ts --merchant=<hex> --axis=customer --key=<phoneHash> --apply
 *
 *   # Merchant-scoped slice repair (dry-run):
 *   npx tsx src/scripts/repairDeliveryReliability.ts --merchant=<hex> --axis=address --limit=20
 *
 *   # Merchant-scoped slice repair (apply):
 *   npx tsx src/scripts/repairDeliveryReliability.ts --merchant=<hex> --axis=address --limit=20 --apply
 *
 * Exit code: 0 on completion (does NOT mean "no drift" — read the output).
 *            1 on fatal error (DB unreachable, etc.).
 *            2 on bad input.
 */

interface CliArgs {
  merchant?: string;
  axis: ReliabilityAxis;
  hashKey?: string;
  limit: number;
  apply: boolean;
  json?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { axis: "customer", limit: MAX_REPAIR_BATCH, apply: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--merchant=")) out.merchant = a.slice("--merchant=".length).trim();
    else if (a.startsWith("--axis=")) {
      const v = a.slice("--axis=".length).trim();
      if (v === "customer" || v === "address") out.axis = v;
    } else if (a.startsWith("--key=")) out.hashKey = a.slice("--key=".length).trim();
    else if (a.startsWith("--limit=")) {
      const n = Number.parseInt(a.slice("--limit=".length), 10);
      if (Number.isFinite(n)) out.limit = Math.min(MAX_REPAIR_BATCH, Math.max(1, n));
    } else if (a === "--apply") out.apply = true;
    else if (a === "--json") out.json = true;
  }
  return out;
}

function formatKeyResult(r: RepairKeyResult): string {
  const drift = r.driftBefore;
  const summary = drift && drift.exists
    ? `agg(D=${drift.aggregate.delivered},R=${drift.aggregate.rto},C=${drift.aggregate.cancelled}) ` +
      `expected(D=${drift.expected.delivered},R=${drift.expected.rto},C=${drift.expected.cancelled}) ` +
      `magnitude=${drift.driftMagnitude}`
    : "no drift report";
  let actionStr: string;
  switch (r.action.kind) {
    case "noop":
      actionStr = `NOOP (${r.action.reason})`;
      break;
    case "applied":
      actionStr = `APPLIED [${r.action.mutatedFields.join(", ")}]`;
      break;
    case "failed":
      actionStr = `FAILED: ${r.action.error}`;
      break;
  }
  return `  ${r.hashKey.slice(0, 16)}…  ${actionStr}  ${summary}`;
}

function formatSliceResult(slice: RepairSliceResult, applyMode: boolean): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=== Delivery Reliability — Repair Report ===");
  lines.push(`merchantId:       ${slice.merchantId}`);
  lines.push(`axis:             ${slice.axis}`);
  lines.push(`mode:             ${applyMode ? "APPLY" : "DRY-RUN"}`);
  lines.push(`generatedAt:      ${slice.generatedAt.toISOString()}`);
  lines.push(`keys inspected:   ${slice.perKey.length}`);
  lines.push(`keys capped:      ${slice.capped}`);
  if (slice.warnings.length > 0) {
    lines.push("warnings:");
    for (const w of slice.warnings) lines.push(`  - ${w}`);
  }
  if (slice.perKey.length > 0) {
    lines.push("");
    lines.push("Per-key outcomes:");
    for (const r of slice.perKey) lines.push(formatKeyResult(r));
  }
  if (!applyMode) {
    lines.push("");
    lines.push(
      "Re-run with --apply to mutate the rows. Repair uses $set of absolute counter values from the reconciler's expected output (idempotent).",
    );
  }
  lines.push("");
  return lines.join("\n");
}

function formatSingleKeyResult(r: RepairKeyResult, applyMode: boolean): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=== Delivery Reliability — Single-Key Repair ===");
  lines.push(`merchantId:       ${r.merchantId}`);
  lines.push(`axis:             ${r.axis}`);
  lines.push(`hashKey:          ${r.hashKey.slice(0, 16)}…`);
  lines.push(`mode:             ${applyMode ? "APPLY" : "DRY-RUN"}`);
  lines.push(formatKeyResult(r));
  if (!applyMode) {
    lines.push("");
    lines.push("Re-run with --apply to mutate the row.");
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.merchant) {
    console.error(
      "Usage: repair:delivery-reliability -- --merchant=<hex> --axis=customer|address [--key=<hash>] [--limit=N] [--apply] [--json]",
    );
    process.exit(2);
  }
  if (!Types.ObjectId.isValid(args.merchant)) {
    console.error(`Invalid merchant id: ${args.merchant}`);
    process.exit(2);
  }
  await connectDb();
  try {
    if (args.hashKey) {
      const result = await rebuildAggregateForKey({
        merchantId: new Types.ObjectId(args.merchant),
        axis: args.axis,
        hashKey: args.hashKey,
        dryRun: !args.apply,
      });
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatSingleKeyResult(result, args.apply));
      }
    } else {
      const slice = await rebuildSliceForMerchant({
        merchantId: new Types.ObjectId(args.merchant),
        axis: args.axis,
        dryRun: !args.apply,
        limit: args.limit,
      });
      if (args.json) {
        console.log(JSON.stringify(slice, null, 2));
      } else {
        console.log(formatSliceResult(slice, args.apply));
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

const isDirectRun =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /repairDeliveryReliability\.(ts|js)$/.test(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    console.error("[repair-delivery-reliability] fatal:", err);
    process.exit(1);
  });
}

export const __TEST = {
  parseArgs,
  formatKeyResult,
  formatSliceResult,
  formatSingleKeyResult,
};
