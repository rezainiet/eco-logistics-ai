/**
 * BDCourier staging validation harness.
 *
 * One-shot CLI. Reads a cohort JSON file (list of phones with
 * operator-supplied labels), runs `getOrFetchExternalProfile`
 * against each with `forceFetch: true`, captures every result, and
 * writes a structured JSON report (cohort outcomes + summary +
 * rollout-readiness verdict) to disk.
 *
 * Hard rules (binding):
 *   - NEVER logs the BDCOURIER_API_KEY or any Authorization header.
 *   - NEVER writes raw provider payloads to disk — only the
 *     canonical mapped shape, identical to what's persisted in
 *     ExternalDeliveryProfile.
 *   - Output identifies buyers ONLY by phoneHash + operator-
 *     supplied cohortLabel. The raw phone is read from input but
 *     never written back to disk.
 *   - Best-effort per phone: a single failure does not abort the
 *     run. Failures appear in the report with their causes.
 *
 * Usage:
 *   $ npx tsx src/scripts/validateBdCourier.ts \
 *       --cohort path/to/cohort.json \
 *       --merchantId 507f1f77bcf86cd799439011 \
 *       --output path/to/report.json
 *
 * Cohort file shape:
 *   [
 *     { "phone": "01712345678", "label": "strong_delivery_known" },
 *     { "phone": "01711000000", "label": "reseller_test" },
 *     ...
 *   ]
 *
 * Report shape:
 *   {
 *     ranAt, merchantId, cohortSize,
 *     outcomes: [ ValidationLookupOutcome, ... ],
 *     summary: ValidationSummary,
 *     verdict: RolloutReadinessVerdict
 *   }
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Types } from "mongoose";
import { getOrFetchExternalProfile } from "../lib/external-delivery/fetch-profile.js";
import { normalizeAndHashBdPhone } from "../lib/external-delivery/normalization.js";
import {
  computeRolloutReadiness,
  summariseValidationRun,
  type ValidationLookupOutcome,
} from "../lib/external-delivery/validation-summary.js";

interface CohortEntry {
  phone: string;
  label?: string;
}

interface ValidationReport {
  ranAt: string;
  merchantId: string;
  cohortSize: number;
  outcomes: ValidationLookupOutcome[];
  summary: ReturnType<typeof summariseValidationRun>;
  verdict: ReturnType<typeof computeRolloutReadiness>;
  /** Operator notes / context. Set by the caller via the file. */
  notes?: string;
}

/* -------------------------------------------------------------------------- */
/* CLI argument parsing                                                       */
/* -------------------------------------------------------------------------- */

interface Args {
  cohort: string;
  merchantId: string;
  output: string;
  notes?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cohort") args.cohort = argv[++i];
    else if (arg === "--merchantId") args.merchantId = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--notes") args.notes = argv[++i];
  }
  if (!args.cohort || !args.merchantId || !args.output) {
    console.error(
      "usage: validateBdCourier --cohort <path> --merchantId <hex> --output <path> [--notes <text>]",
    );
    process.exit(1);
  }
  if (!Types.ObjectId.isValid(args.merchantId)) {
    console.error(`merchantId is not a valid ObjectId: ${args.merchantId}`);
    process.exit(1);
  }
  return args as Args;
}

/* -------------------------------------------------------------------------- */
/* Cohort loader                                                              */
/* -------------------------------------------------------------------------- */

async function loadCohort(path: string): Promise<CohortEntry[]> {
  const raw = await readFile(resolve(path), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`cohort file is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("cohort file must be a JSON array");
  }
  const out: CohortEntry[] = [];
  for (const e of parsed) {
    if (!e || typeof e !== "object") continue;
    const obj = e as Record<string, unknown>;
    const phone = typeof obj.phone === "string" ? obj.phone : null;
    if (!phone) continue;
    out.push({
      phone,
      label: typeof obj.label === "string" ? obj.label : undefined,
    });
  }
  if (out.length === 0) {
    throw new Error("cohort file produced 0 valid entries");
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Per-entry runner                                                           */
/* -------------------------------------------------------------------------- */

async function runOne(
  merchantId: string,
  entry: CohortEntry,
): Promise<ValidationLookupOutcome> {
  const startedAt = Date.now();
  const normalized = normalizeAndHashBdPhone(entry.phone);
  if (!normalized) {
    return {
      cohortLabel: entry.label,
      phoneHash: null,
      resolved: false,
      totalDurationMs: 0,
      failureReason: "unusable_phone",
    };
  }
  try {
    const profile = await getOrFetchExternalProfile({
      merchantId,
      phone: entry.phone,
      forceFetch: true,
    });
    const totalDurationMs = Date.now() - startedAt;
    if (!profile) {
      return {
        cohortLabel: entry.label,
        phoneHash: normalized.phoneHash,
        resolved: false,
        totalDurationMs,
        // The orchestrator returns null in three cases the harness
        // can detect from outside: master_flag_off, invalid_merchant_id,
        // unusable_phone. We've already excluded the latter two; the
        // remaining case is the most likely.
        failureReason: "master_flag_off",
      };
    }
    return {
      cohortLabel: entry.label,
      phoneHash: normalized.phoneHash,
      resolved: true,
      totalDurationMs,
      source: profile.source,
      profile,
    };
  } catch (err) {
    return {
      cohortLabel: entry.label,
      phoneHash: normalized.phoneHash,
      resolved: false,
      totalDurationMs: Date.now() - startedAt,
      failureReason: "unknown",
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cohort = await loadCohort(args.cohort);
  console.log(
    `[validate] cohort loaded: ${cohort.length} entries from ${args.cohort}`,
  );

  // Run sequentially. Concurrent runs would defeat the in-flight
  // dedupe instrumentation we want to see, and BDCourier rate-limit
  // posture is unknown — sequential is the conservative choice.
  const outcomes: ValidationLookupOutcome[] = [];
  for (let i = 0; i < cohort.length; i++) {
    const entry = cohort[i]!;
    const result = await runOne(args.merchantId, entry);
    outcomes.push(result);
    const label = entry.label ?? "(unlabelled)";
    const status = result.resolved ? result.source ?? "providers" : "FAILED";
    console.log(
      `[validate] ${i + 1}/${cohort.length} ${label} → ${status} (${result.totalDurationMs}ms)`,
    );
  }

  const summary = summariseValidationRun(outcomes);
  const verdict = computeRolloutReadiness(summary);
  const report: ValidationReport = {
    ranAt: new Date().toISOString(),
    merchantId: args.merchantId,
    cohortSize: cohort.length,
    outcomes,
    summary,
    verdict,
    ...(args.notes ? { notes: args.notes } : {}),
  };

  await writeFile(resolve(args.output), JSON.stringify(report, null, 2), "utf8");
  console.log(`[validate] report written to ${args.output}`);
  console.log(
    `[validate] verdict: ready=${verdict.ready} blockers=${verdict.blockers.length} warnings=${verdict.warnings.length}`,
  );
  for (const b of verdict.blockers) console.log(`[validate] BLOCKER: ${b}`);
  for (const w of verdict.warnings) console.log(`[validate] WARN: ${w}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { connectDb, disconnectDb } = await import("../lib/db.js");
  await connectDb();
  // Prime the gazetteer if the system relies on it for canonicalisation —
  // BDCourier itself doesn't, but loading is cheap and matches boot.
  try {
    const { awaitLoad } = await import("../lib/gazetteer.js");
    await awaitLoad();
  } catch {
    /* non-fatal */
  }
  try {
    await main();
  } catch (err) {
    console.error("[validate] failed:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await disconnectDb();
  }
} else {
  // module-imported (e.g. by a test) — export internal helpers here later if needed
  void fileURLToPath;
}
