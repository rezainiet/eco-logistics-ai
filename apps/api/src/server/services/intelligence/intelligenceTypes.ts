/**
 * intelligenceTypes — shared analytics DTOs and the protected-handler
 * context type.
 *
 * Result shapes (`IntentDistributionResult`, etc.) are the public contract
 * each tRPC procedure returns. Keeping them centralised means:
 *   - the dashboard UI imports a single named type per card.
 *   - future split-procedure refactors don't break consumers because the
 *     wire shape is anchored to a typed surface, not inferred from a
 *     handler body.
 *
 * `ProtectedHandlerCtx` is the context shape every intelligence handler
 * receives. It is INFERRED from `Context` (the createContext return) by
 * narrowing `user` to non-null — no field is duplicated. When `Context`
 * gains a field (or `user` gains a property), every handler picks it up
 * automatically.
 */

import type { Context } from "../../trpc.js";
import type { OutcomeBucket } from "./intelligenceBuckets.js";
import type { CampaignCategory } from "./campaignClassification.js";

/* -------------------------------------------------------------------------- */
/* Handler context                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Context shape after `protectedProcedure` runs — `user` is guaranteed
 * non-null. Every other field flows through unchanged from `Context`.
 *
 * Inferred via NonNullable so:
 *   - any field added to `createContext` is automatically visible here
 *   - no duplication of `user` shape (`AuthUser` is the source of truth)
 *   - changing `AuthUser` somewhere else doesn't drift the handler
 *     signatures here.
 */
export type ProtectedHandlerCtx = Context & {
  user: NonNullable<Context["user"]>;
};

/* -------------------------------------------------------------------------- */
/* Intent distribution                                                        */
/* -------------------------------------------------------------------------- */

export type IntentTier = "verified" | "implicit" | "unverified" | "no_data";

export interface IntentDistributionBucket extends OutcomeBucket {
  tier: IntentTier;
}

export interface IntentDistributionResult {
  windowDays: number;
  totalOrders: number;
  buckets: IntentDistributionBucket[];
}

/* -------------------------------------------------------------------------- */
/* Address-quality distribution                                               */
/* -------------------------------------------------------------------------- */

export type AddressCompleteness = "complete" | "partial" | "incomplete";

export interface AddressQualityBucket extends OutcomeBucket {
  completeness: AddressCompleteness;
}

export interface AddressQualityResult {
  windowDays: number;
  totalOrders: number;
  buckets: AddressQualityBucket[];
}

/* -------------------------------------------------------------------------- */
/* Top thanas                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Top-thanas result rows expose the full count breakdown per thana so the
 * dashboard can sort by delivered % / RTO % / pending % client-side
 * without a second roundtrip. Schema mirrors `OutcomeBucket` plus the
 * `pendingRate` derived field (in-flight share of total).
 */
export interface TopThanasRow {
  thana: string;
  total: number;
  delivered: number;
  rto: number;
  cancelled: number;
  inFlight: number;
  resolved: number;
  deliveredRate: number | null;
  rtoRate: number | null;
  /** in-flight / total (NOT in-flight / resolved). Used for "% pending"
   *  badges. */
  pendingRate: number;
}

export interface TopThanasResult {
  windowDays: number;
  thanas: TopThanasRow[];
}

/* -------------------------------------------------------------------------- */
/* Campaign source outcomes                                                   */
/* -------------------------------------------------------------------------- */

/** Buckets returned by the campaign-source procedure. `no_session` is the
 *  catch-all for orders that never matched a TrackingSession. */
export type CampaignBucketKey = CampaignCategory | "no_session";

export interface CampaignSourceBucket extends OutcomeBucket {
  source: CampaignBucketKey;
}

export interface CampaignSourceResult {
  windowDays: number;
  totalOrders: number;
  buckets: CampaignSourceBucket[];
}

/* -------------------------------------------------------------------------- */
/* Repeat-visitor outcomes                                                    */
/* -------------------------------------------------------------------------- */

export type RepeatVisitorKind = "repeat" | "first_time" | "no_session";

export interface RepeatVisitorBucket extends OutcomeBucket {
  kind: RepeatVisitorKind;
}

export interface RepeatVisitorResult {
  windowDays: number;
  totalOrders: number;
  buckets: RepeatVisitorBucket[];
}
