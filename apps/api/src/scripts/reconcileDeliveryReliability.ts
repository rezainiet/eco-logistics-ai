import mongoose, { Types } from "mongoose";
import { connectDb } from "../lib/db.js";
import {
  reconcileSlice,
  type ReliabilityAxis,
} from "../lib/delivery-reliability-reconciliation.js";

/**
 * reconcileDeliveryReliability — read-only reconciliation CLI.
 *
 * Compares aggregate counters against terminal Order observations within
 * each aggregate's `firstOutcomeAt` window. Reports drift; never repairs.
 * For repair, see `repairDeliveryReliability.ts` (explicit invocation).
 *
 * Usage:
 *   npm --workspace apps/api run reconcile:delivery-reliability -- --merchant=<hex> [--axis=customer|address] [--limit=10000]
 *   npx tsx src/scripts/reconcileDeliveryReliability.ts --merchant=<hex> --json
 *
 * Exit code: 0 on completion (does NOT mean "no drift" — read the output).
 *            1 on fatal error (DB unreachable, etc.).
 */

interface CliArgs {
  merchant?: string;
  axis: ReliabilityAxis;
  limit?: number;
  json?: boolean;
  hashKey?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { axis: "customer" };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--merchant=")) out.merchant = a.slice("--merchant=".length).trim();
    else if (a.startsWith("--axis=")) {
      const v = a.slice("--axis=".length).trim();
      if (v === "customer" || v === "address") out.axis = v;
    } else if (a.startsWith("--limit=")) {
      const n = Number.parseInt(a.slice("--limit=".length), 10);
      if (Number.isFinite(n)) out.limit = n;
    } else if (a.startsWith("--key=")) {
      out.hashKey = a.slice("--key=".length).trim();
    } else if (a === "--json") {
      out.json = true;
    }
  }
  return out;
}

function formatHumanReport(
  result: Awaited<ReturnType<typeof reconcileSlice>>,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=== Delivery Reliability — Reconciliation Report ===");
  lines.push(`merchantId:       ${result.merchantId}`);
  lines.push(`axis:             ${result.axis}`);
  lines.push(`generatedAt:      ${result.generatedAt.toISOString()}`);
  lines.push(`ordersScanned:    ${result.ordersScanned}`);
  lines.push(`truncated:        ${result.truncated}`);
  lines.push(`entries:          ${result.entries.length}`);
  lines.push(`driftedKeys:      ${result.driftedKeys.length}`);
  lines.push(`missingKeys:      ${result.missingKeys.length}`);
  if (result.warnings.length > 0) {
    lines.push(`warnings:`);
    for (const w of result.warnings) lines.push(`  - ${w}`);
  }
  if (result.driftedKeys.length > 0) {
    lines.push("");
    lines.push("DRIFTED KEYS (top 20 by magnitude):");
    const top = [...result.entries]
      .filter((e) => e.exists && e.driftMagnitude > 0)
      .sort((a, b) => b.driftMagnitude - a.driftMagnitude)
      .slice(0, 20);
    for (const e of top) {
      lines.push(
        `  ${e.hashKey.slice(0, 16)}…  drift=${e.driftMagnitude}  ` +
          `agg(D=${e.aggregate.delivered},R=${e.aggregate.rto},C=${e.aggregate.cancelled}) ` +
          `expected(D=${e.expected.delivered},R=${e.expected.rto},C=${e.expected.cancelled})`,
      );
    }
  }
  if (result.missingKeys.length > 0) {
    lines.push("");
    lines.push("MISSING AGGREGATES (chokepoint never recorded):");
    for (const k of result.missingKeys) lines.push(`  ${k.slice(0, 16)}…`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.merchant) {
    console.error(
      "Usage: reconcile:delivery-reliability -- --merchant=<hex> [--axis=customer|address] [--limit=N] [--key=<hash>] [--json]",
    );
    process.exit(2);
  }
  if (!Types.ObjectId.isValid(args.merchant)) {
    console.error(`Invalid merchant id: ${args.merchant}`);
    process.exit(2);
  }
  await connectDb();
  let result;
  try {
    result = await reconcileSlice({
      merchantId: new Types.ObjectId(args.merchant),
      axis: args.axis,
      scanLimit: args.limit,
      hashKey: args.hashKey,
    });
  } finally {
    await mongoose.disconnect();
  }
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatHumanReport(result));
  }
}

const isDirectRun =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /reconcileDeliveryReliability\.(ts|js)$/.test(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    console.error("[reconcile-delivery-reliability] fatal:", err);
    process.exit(1);
  });
}

export const __TEST = { parseArgs, formatHumanReport };
