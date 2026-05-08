/**
 * intelligenceSchemas — zod input shapes for every RTO Intelligence tRPC
 * procedure.
 *
 * Lives in its own module so the analytics router stays declarative — a
 * dashboard reader can scan `analytics.ts` once and see "this procedure
 * takes intelligenceDaysInput, runs intentDistributionHandler" without
 * any zod boilerplate inline.
 *
 * Window safety: `days` is clamped to `[1, 90]` everywhere. A misconfigured
 * caller cannot collection-scan beyond the 90-day ceiling. If a longer
 * window is ever genuinely needed, the right move is a new schema/handler
 * pair (e.g. `intelligenceLongHorizonInput`), not relaxing the cap here.
 */

import { z } from "zod";

/** Single-axis days window. Used by intent / address / campaign /
 *  repeat-visitor procedures. */
export const intelligenceDaysInput = z
  .object({
    days: z.number().int().min(1).max(90).default(30),
  })
  .default({ days: 30 });

/** Top-thanas — same window, plus a result-set cap of 50. The cap exists
 *  so a misuse-by-a-test or a UI bug cannot ask for thousands of thana
 *  rows. */
export const intelligenceTopThanasInput = z
  .object({
    days: z.number().int().min(1).max(90).default(30),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .default({ days: 30, limit: 10 });

/** Inferred input types — useful for handler signatures. */
export type IntelligenceDaysInput = z.infer<typeof intelligenceDaysInput>;
export type IntelligenceTopThanasInput = z.infer<
  typeof intelligenceTopThanasInput
>;
