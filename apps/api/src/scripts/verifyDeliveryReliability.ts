import mongoose, { Types } from "mongoose";
import {
  AddressReliability,
  CourierPerformance,
  CustomerReliability,
} from "@ecom/db";
import { connectDb } from "../lib/db.js";
import { snapshotReliabilityCounters } from "../lib/observability/delivery-reliability.js";
import {
  getRolloutState,
  __resetRolloutAllowlistCache,
} from "../lib/delivery-reliability-rollout.js";
import {
  checkAddressReliabilityIntegrity,
  checkCustomerReliabilityIntegrity,
} from "../lib/delivery-reliability-integrity.js";

/**
 * verifyDeliveryReliability — read-only operational health check for the
 * Delivery Reliability layer.
 *
 * Designed to be safe to run during business hours: every Mongo
 * operation is `find` / `count` only, capped by `LIMIT_PER_AXIS`.
 * No mutations. No replay triggers. No backfill behaviour. No queue
 * dispatches. The script never touches `Order`, `applyTrackingEvents`,
 * any worker, or any chokepoint side-effect.
 *
 * Usage:
 *   npm --workspace apps/api run verify:delivery-reliability
 *   MONGODB_URI=<staging> npx tsx src/scripts/verifyDeliveryReliability.ts
 *   npx tsx src/scripts/verifyDeliveryReliability.ts --merchant=<hex>
 *
 * Exit code:
 *   0 — completed (does NOT mean "no problems"; check the output for
 *       any non-zero `violations` lines).
 *   1 — fatal (DB unreachable, etc.).
 *
 * The script ONLY prints. It does not alert, page, or modify anything.
 */

const LIMIT_PER_AXIS = 200; // cap per integrity sample
const STALE_DAYS = 180;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

interface CliArgs {
  merchant?: string;
  json?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--merchant=")) {
      out.merchant = a.slice("--merchant=".length).trim();
    } else if (a === "--json") {
      out.json = true;
    }
  }
  return out;
}

interface PerMerchantHealth {
  merchantId: string;
  customerRows: number;
  addressRows: number;
  courierRows: number;
  customerStaleRows: number;
  addressStaleRows: number;
  courierStaleRows: number;
  customerStalePct: number;
  addressStalePct: number;
  courierStalePct: number;
  integrityViolations: number;
  integritySampled: number;
}

interface VerificationReport {
  generatedAt: string;
  rollout: ReturnType<typeof getRolloutState>;
  observabilityCounters: ReturnType<typeof snapshotReliabilityCounters>;
  scope: "single_merchant" | "global";
  merchants: PerMerchantHealth[];
  warnings: string[];
}

async function safeCount(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch {
    return -1;
  }
}

async function inspectMerchant(
  merchantId: Types.ObjectId,
  now: Date,
): Promise<PerMerchantHealth> {
  const cutoff = new Date(now.getTime() - STALE_MS);

  const [
    customerRows,
    addressRows,
    courierRows,
    customerStaleRows,
    addressStaleRows,
    courierStaleRows,
  ] = await Promise.all([
    safeCount(() => CustomerReliability.countDocuments({ merchantId })),
    safeCount(() => AddressReliability.countDocuments({ merchantId })),
    safeCount(() => CourierPerformance.countDocuments({ merchantId })),
    safeCount(() =>
      CustomerReliability.countDocuments({
        merchantId,
        lastOutcomeAt: { $lte: cutoff },
      }),
    ),
    safeCount(() =>
      AddressReliability.countDocuments({
        merchantId,
        lastOutcomeAt: { $lte: cutoff },
      }),
    ),
    safeCount(() =>
      CourierPerformance.countDocuments({
        merchantId,
        lastOutcomeAt: { $lte: cutoff },
      }),
    ),
  ]);

  // Sample integrity check — bounded scan of recent rows on each axis.
  let integrityViolations = 0;
  let integritySampled = 0;
  try {
    const customerSample = await CustomerReliability.find({ merchantId })
      .select(
        "deliveredCount rtoCount cancelledCount firstOutcomeAt lastOutcomeAt",
      )
      .sort({ updatedAt: -1 })
      .limit(LIMIT_PER_AXIS)
      .lean()
      .exec();
    for (const row of customerSample) {
      integritySampled += 1;
      const report = checkCustomerReliabilityIntegrity(row, { now });
      if (!report.ok) integrityViolations += report.violations.length;
    }
  } catch {
    /* leave integrity counts unchanged */
  }

  try {
    const addressSample = await AddressReliability.find({ merchantId })
      .select(
        "deliveredCount rtoCount cancelledCount distinctPhoneHashes firstOutcomeAt lastOutcomeAt",
      )
      .sort({ updatedAt: -1 })
      .limit(LIMIT_PER_AXIS)
      .lean()
      .exec();
    for (const row of addressSample) {
      integritySampled += 1;
      const report = checkAddressReliabilityIntegrity(row, { now });
      if (!report.ok) integrityViolations += report.violations.length;
    }
  } catch {
    /* leave integrity counts unchanged */
  }

  return {
    merchantId: merchantId.toHexString(),
    customerRows,
    addressRows,
    courierRows,
    customerStaleRows,
    addressStaleRows,
    courierStaleRows,
    customerStalePct: customerRows > 0 ? customerStaleRows / customerRows : 0,
    addressStalePct: addressRows > 0 ? addressStaleRows / addressRows : 0,
    courierStalePct: courierRows > 0 ? courierStaleRows / courierRows : 0,
    integrityViolations,
    integritySampled,
  };
}

export async function buildVerificationReport(args: CliArgs = {}): Promise<VerificationReport> {
  __resetRolloutAllowlistCache();
  const now = new Date();
  const rollout = getRolloutState();
  const observabilityCounters = snapshotReliabilityCounters();
  const warnings: string[] = [];

  let scope: VerificationReport["scope"] = "global";
  const merchants: PerMerchantHealth[] = [];

  if (args.merchant) {
    if (!Types.ObjectId.isValid(args.merchant)) {
      warnings.push(`Invalid --merchant value: ${args.merchant}`);
    } else {
      scope = "single_merchant";
      merchants.push(
        await inspectMerchant(new Types.ObjectId(args.merchant), now),
      );
    }
  } else {
    // Global scope — distinct merchantIds with at least one CustomerReliability
    // row. Bounded by Mongo's distinct cap (16MB BSON); for v1's expected
    // merchant count this is plenty. Caller can scope to one merchant via
    // --merchant=<hex> if the merchant cohort grows beyond that.
    let merchantIds: Types.ObjectId[] = [];
    try {
      merchantIds = (await CustomerReliability.distinct("merchantId")) as Types.ObjectId[];
    } catch (err) {
      warnings.push(`Failed to enumerate merchants: ${(err as Error).message}`);
    }
    for (const id of merchantIds) {
      merchants.push(await inspectMerchant(id, now));
    }
  }

  return {
    generatedAt: now.toISOString(),
    rollout,
    observabilityCounters,
    scope,
    merchants,
    warnings,
  };
}

function formatHumanReport(report: VerificationReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=== Delivery Reliability — Verification Report ===");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("Rollout state:");
  lines.push(`  phase:           ${report.rollout.phase}`);
  lines.push(`  flags.write:     ${report.rollout.flags.write}`);
  lines.push(`  flags.read:      ${report.rollout.flags.read}`);
  lines.push(`  flags.analytics: ${report.rollout.flags.analytics}`);
  lines.push(`  flags.observability: ${report.rollout.flags.observability}`);
  lines.push(`  staged:          ${report.rollout.staged}`);
  lines.push(`  allowlistSize:   ${report.rollout.allowlistSize}`);
  lines.push("");
  lines.push("Observability counters:");
  for (const [k, v] of Object.entries(report.observabilityCounters)) {
    lines.push(`  ${k.padEnd(22)} ${v}`);
  }
  lines.push("");
  lines.push(`Scope: ${report.scope}  (merchants: ${report.merchants.length})`);
  for (const m of report.merchants) {
    lines.push("");
    lines.push(`  merchantId ${m.merchantId}`);
    lines.push(
      `    rows:     customer=${m.customerRows}  address=${m.addressRows}  courier=${m.courierRows}`,
    );
    lines.push(
      `    stale:    customer=${(m.customerStalePct * 100).toFixed(1)}%  address=${(m.addressStalePct * 100).toFixed(1)}%  courier=${(m.courierStalePct * 100).toFixed(1)}%`,
    );
    lines.push(
      `    integrity: ${m.integrityViolations} violation(s) across ${m.integritySampled} sampled row(s)`,
    );
  }
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of report.warnings) lines.push(`  - ${w}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  await connectDb();
  let report: VerificationReport;
  try {
    report = await buildVerificationReport(args);
  } finally {
    await mongoose.disconnect();
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHumanReport(report));
  }
}

// Only run main when invoked directly (allows tests to import the helpers
// without booting the script's connect → run → disconnect lifecycle).
const isDirectRun =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /verifyDeliveryReliability\.(ts|js)$/.test(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    console.error("[verify-delivery-reliability] fatal:", err);
    process.exit(1);
  });
}

export const __TEST = {
  parseArgs,
  inspectMerchant,
  formatHumanReport,
  LIMIT_PER_AXIS,
  STALE_DAYS,
};
