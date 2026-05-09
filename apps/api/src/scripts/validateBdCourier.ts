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
 *   - REFUSES to run in NODE_ENV=production unless --allow-production
 *     is passed. The harness is staging-only by design.
 *
 * Modes:
 *   default        Real run against configured providers (BDCourier).
 *   --preflight    Check env + provider health + cohort, exit before
 *                  any provider call. Catches misconfig early.
 *   --dry-run      Run the full pipeline against injected fake
 *                  providers. NO real HTTP. Proves the harness wiring
 *                  is correct; produces a real-shaped report. NOT
 *                  real validation.
 *
 * Usage:
 *   $ npx tsx src/scripts/validateBdCourier.ts \
 *       --cohort path/to/cohort.json \
 *       --merchantId 507f1f77bcf86cd799439011 \
 *       --output path/to/report.json
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
import {
  DEFAULT_EXTERNAL_PROVIDERS,
  type ExternalProviderAdapter,
} from "../lib/external-delivery/providers/index.js";
import { env } from "../env.js";

interface CohortEntry {
  phone: string;
  label?: string;
}

interface ValidationReport {
  ranAt: string;
  merchantId: string;
  mode: "real" | "dry-run";
  cohortSize: number;
  outcomes: ValidationLookupOutcome[];
  summary: ReturnType<typeof summariseValidationRun>;
  verdict: ReturnType<typeof computeRolloutReadiness>;
  notes?: string;
}

/**
 * The 10 BD operational diversity categories the cohort template
 * documents. Cohort entries are checked against this list so we can
 * warn when the cohort is too narrow.
 */
const TEMPLATE_CATEGORIES = [
  "strong_delivery_known",
  "high_return_known",
  "sparse_history_new_buyer",
  "shared_phone_family_household",
  "reseller_high_volume",
  "rural_cod_agent",
  "marketplace_business_phone",
  "older_dormant_customer",
  "newly_active_customer",
  "merchant_cancellation_inflated",
] as const;

const MIN_COHORT_SIZE = 10;
const MIN_DIVERSITY_CATEGORIES = 5;

/* -------------------------------------------------------------------------- */
/* CLI argument parsing                                                       */
/* -------------------------------------------------------------------------- */

interface Args {
  cohort?: string;
  merchantId: string;
  output?: string;
  notes?: string;
  preflight: boolean;
  dryRun: boolean;
  allowProduction: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { preflight: false, dryRun: false, allowProduction: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cohort") args.cohort = argv[++i];
    else if (arg === "--merchantId") args.merchantId = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--notes") args.notes = argv[++i];
    else if (arg === "--preflight") args.preflight = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--allow-production") args.allowProduction = true;
  }
  if (!args.merchantId) {
    console.error(
      "usage: validateBdCourier --merchantId <hex> [mode flags] [--cohort <path>] [--output <path>]\n" +
        "  modes:\n" +
        "    --preflight              env+provider+cohort check, no provider calls\n" +
        "    --dry-run                inject fake providers, no real HTTP\n" +
        "    --allow-production       opt-in to running in NODE_ENV=production\n" +
        "  required for non-preflight: --cohort, --output",
    );
    process.exit(1);
  }
  if (!Types.ObjectId.isValid(args.merchantId)) {
    console.error(`merchantId is not a valid ObjectId: ${args.merchantId}`);
    process.exit(1);
  }
  if (!args.preflight && (!args.cohort || !args.output)) {
    console.error("non-preflight runs require --cohort AND --output");
    process.exit(1);
  }
  return args as Args;
}

/* -------------------------------------------------------------------------- */
/* Pre-flight check                                                           */
/* -------------------------------------------------------------------------- */

interface PreflightReport {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  passed: string[];
  envSummary: {
    nodeEnv: string;
    externalDeliveryEnabled: boolean;
    bdcourierEnabled: boolean;
    bdcourierApiKeyPresent: boolean;
    bdcourierBaseUrl: string;
    bdcourierTimeoutMs: number;
    networkEvidenceSurfaceEnabled: boolean;
  };
  providers: Array<{
    name: string;
    sourceVersion: string;
    configured: boolean;
  }>;
  cohort?: {
    size: number;
    categoriesCovered: string[];
    missingCategories: string[];
  };
}

function preflight(args: Args, cohort?: CohortEntry[]): PreflightReport {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const passed: string[] = [];

  // 1. Env-shape check.
  const envSummary = {
    nodeEnv: env.NODE_ENV,
    externalDeliveryEnabled: env.EXTERNAL_DELIVERY_ENABLED,
    bdcourierEnabled: env.BDCOURIER_ENABLED,
    bdcourierApiKeyPresent:
      typeof env.BDCOURIER_API_KEY === "string" &&
      env.BDCOURIER_API_KEY.trim().length > 0,
    bdcourierBaseUrl: env.BDCOURIER_BASE_URL,
    bdcourierTimeoutMs: env.BDCOURIER_TIMEOUT_MS,
    networkEvidenceSurfaceEnabled: env.NETWORK_EVIDENCE_SURFACE_ENABLED,
  };

  if (envSummary.nodeEnv === "production" && !args.allowProduction) {
    blockers.push(
      "Refusing to run in NODE_ENV=production. The harness is staging-only by design. Pass --allow-production to override.",
    );
  } else if (envSummary.nodeEnv === "production") {
    warnings.push("Running in NODE_ENV=production with --allow-production override.");
  } else {
    passed.push(`NODE_ENV=${envSummary.nodeEnv}`);
  }

  if (envSummary.networkEvidenceSurfaceEnabled) {
    warnings.push(
      "NETWORK_EVIDENCE_SURFACE_ENABLED=1 — merchant-facing surface is ON during validation. Consider turning it off until calibration is complete.",
    );
  }

  if (!args.dryRun) {
    if (!envSummary.externalDeliveryEnabled) {
      blockers.push(
        "EXTERNAL_DELIVERY_ENABLED=0 — orchestrator returns null immediately. Set this to 1 in staging before running.",
      );
    } else {
      passed.push("EXTERNAL_DELIVERY_ENABLED=1");
    }
    if (!envSummary.bdcourierEnabled) {
      warnings.push(
        "BDCOURIER_ENABLED=0 — bdcourier adapter will report stub_unconfigured. Real validation requires this flag on.",
      );
    } else if (!envSummary.bdcourierApiKeyPresent) {
      blockers.push(
        "BDCOURIER_ENABLED=1 but BDCOURIER_API_KEY is unset. Adapter will fail closed; real validation cannot proceed.",
      );
    } else {
      passed.push("BDCourier flag + API key present");
    }
  }

  // 2. Provider configured-state.
  const providers = DEFAULT_EXTERNAL_PROVIDERS.map((p) => ({
    name: p.name,
    sourceVersion: p.sourceVersion,
    configured: args.dryRun ? true : p.isConfigured(),
  }));
  if (!args.dryRun) {
    const configuredCount = providers.filter((p) => p.configured).length;
    if (configuredCount === 0) {
      blockers.push("No provider reports configured=true. The orchestrator will produce only sparse_history results.");
    } else {
      passed.push(`${configuredCount}/${providers.length} provider(s) configured`);
    }
  }

  // 3. Cohort diversity (only when a cohort was loaded).
  if (cohort) {
    const categoriesCovered = new Set<string>();
    for (const c of cohort) {
      if (c.label && (TEMPLATE_CATEGORIES as readonly string[]).includes(c.label)) {
        categoriesCovered.add(c.label);
      }
    }
    const missingCategories = TEMPLATE_CATEGORIES.filter(
      (c) => !categoriesCovered.has(c),
    );
    const cohortInfo = {
      size: cohort.length,
      categoriesCovered: [...categoriesCovered],
      missingCategories,
    };

    if (cohort.length < MIN_COHORT_SIZE) {
      blockers.push(
        `Cohort size ${cohort.length} below minimum ${MIN_COHORT_SIZE}. BD operational diversity requires more entries.`,
      );
    } else {
      passed.push(`Cohort size ${cohort.length}`);
    }
    if (categoriesCovered.size < MIN_DIVERSITY_CATEGORIES) {
      warnings.push(
        `Cohort covers only ${categoriesCovered.size}/${TEMPLATE_CATEGORIES.length} BD operational categories. Consider extending to cover at least ${MIN_DIVERSITY_CATEGORIES}.`,
      );
    }

    return {
      ok: blockers.length === 0,
      blockers,
      warnings,
      passed,
      envSummary,
      providers,
      cohort: cohortInfo,
    };
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    passed,
    envSummary,
    providers,
  };
}

function printPreflight(report: PreflightReport): void {
  console.log("[validate] === preflight ===");
  console.log(`  NODE_ENV=${report.envSummary.nodeEnv}`);
  console.log(
    `  EXTERNAL_DELIVERY_ENABLED=${report.envSummary.externalDeliveryEnabled} BDCOURIER_ENABLED=${report.envSummary.bdcourierEnabled} BDCOURIER_API_KEY=${report.envSummary.bdcourierApiKeyPresent ? "<present>" : "<UNSET>"} NETWORK_EVIDENCE_SURFACE_ENABLED=${report.envSummary.networkEvidenceSurfaceEnabled}`,
  );
  console.log(
    `  BDCOURIER_BASE_URL=${report.envSummary.bdcourierBaseUrl} BDCOURIER_TIMEOUT_MS=${report.envSummary.bdcourierTimeoutMs}`,
  );
  for (const p of report.providers) {
    console.log(`  provider ${p.name}@${p.sourceVersion} configured=${p.configured}`);
  }
  if (report.cohort) {
    console.log(
      `  cohort size=${report.cohort.size} covers=${report.cohort.categoriesCovered.length} missing=[${report.cohort.missingCategories.join(",")}]`,
    );
  }
  for (const p of report.passed) console.log(`  PASS  ${p}`);
  for (const w of report.warnings) console.log(`  WARN  ${w}`);
  for (const b of report.blockers) console.log(`  BLOCK ${b}`);
  console.log(`[validate] preflight verdict: ${report.ok ? "ok" : "BLOCKED"}`);
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
/* Fake provider set for --dry-run                                            */
/* -------------------------------------------------------------------------- */

function buildDryRunProviders(): ExternalProviderAdapter[] {
  // Deterministic synthetic results so the dry-run report is
  // reproducible. NOT real validation.
  return [
    {
      name: "bdcourier",
      sourceVersion: "bdcourier-dryrun-v1",
      isConfigured: () => true,
      fetchHistory: async (input) => {
        // Pseudo-vary based on the last digit of the normalized phone.
        const digit = Number(input.normalizedPhone.slice(-1));
        const total = 5 + digit * 3;
        const cancelled = Math.min(total, Math.floor(digit / 2));
        const delivered = total - cancelled;
        return {
          ok: true,
          total,
          delivered,
          rto: 0,
          cancelled,
          successRate: total > 0 ? delivered / total : null,
          durationMs: 30,
        };
      },
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Per-entry runner                                                           */
/* -------------------------------------------------------------------------- */

async function runOne(
  merchantId: string,
  entry: CohortEntry,
  providers: ReadonlyArray<ExternalProviderAdapter> | undefined,
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
      ...(providers ? { providers } : {}),
    });
    const totalDurationMs = Date.now() - startedAt;
    if (!profile) {
      return {
        cohortLabel: entry.label,
        phoneHash: normalized.phoneHash,
        resolved: false,
        totalDurationMs,
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
  } catch {
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
  const cohort = args.cohort ? await loadCohort(args.cohort) : undefined;

  // Pre-flight first — every mode runs this. Pre-flight blockers
  // abort before any provider call.
  const pf = preflight(args, cohort);
  printPreflight(pf);
  if (!pf.ok) {
    console.error("[validate] preflight blocked. Fix the BLOCK lines above and re-run.");
    process.exit(2);
  }

  if (args.preflight) {
    console.log("[validate] preflight-only mode — exiting without provider calls.");
    return;
  }

  if (!cohort || !args.output) {
    // Defensive: parseArgs already enforces this, but double-check.
    console.error("[validate] non-preflight runs require --cohort + --output");
    process.exit(1);
  }
  console.log(`[validate] cohort loaded: ${cohort.length} entries from ${args.cohort}`);

  const dryRunProviders = args.dryRun ? buildDryRunProviders() : undefined;
  if (args.dryRun) {
    console.log(
      "[validate] *** DRY-RUN MODE *** using injected fake providers. NOT real validation.",
    );
  }

  // Sequential. Concurrency would defeat the in-flight dedupe
  // instrumentation and BDCourier rate-limit posture is unverified.
  const outcomes: ValidationLookupOutcome[] = [];
  for (let i = 0; i < cohort.length; i++) {
    const entry = cohort[i]!;
    const result = await runOne(args.merchantId, entry, dryRunProviders);
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
    mode: args.dryRun ? "dry-run" : "real",
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
  if (args.dryRun) {
    console.log(
      "[validate] *** dry-run report — verdict has no operational meaning. Re-run without --dry-run for real validation. ***",
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { connectDb, disconnectDb } = await import("../lib/db.js");
  await connectDb();
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
  void fileURLToPath;
}
