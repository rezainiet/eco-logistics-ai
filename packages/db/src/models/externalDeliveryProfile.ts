import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Phase 4A — external delivery history intelligence.
 *
 * Per-(buyer phone) snapshot of delivery outcomes aggregated from
 * third-party courier APIs (Pathao / Steadfast / RedX / future
 * couriers). ENRICHMENT data — eventually consistent, cache-oriented,
 * advisory-only.
 *
 * Architectural rules (binding):
 *
 *   - This collection is COMPLETELY SEPARATE from the operational
 *     aggregates (CourierPerformance / CourierLane / AreaReliability /
 *     CustomerReliability / AddressReliability). NEVER written from
 *     `applyTrackingEvents`'s chokepoint.
 *   - GLOBAL scope (no merchantId). Identity-level — same buyer phone
 *     produces the same profile across all merchants. Privacy posture
 *     mirrors `FraudSignal`: only hash, only outcome counters, no
 *     order ids, no addresses, no merchant linkage.
 *   - REPLAY-INSENSITIVE. Atomic findOneAndUpdate upserts with $set;
 *     re-running the orchestrator for the same phoneHash overwrites
 *     fields with byte-identical values modulo the freshness
 *     timestamps. No $inc; no replay-storm class.
 *   - VERSIONED. `pipelineVersion` pins each row to its writer's shape.
 *     Future schema bumps will not retroactively rewrite v1 rows.
 *
 * Read pattern: orchestrator (`lib/external-delivery/fetch-profile.ts`)
 * checks Redis → falls through to Mongo → falls through to provider
 * fan-out → upserts here. See that module for the full flow.
 */

export const EXTERNAL_DELIVERY_PIPELINE_VERSION = "v1" as const;
export type ExternalDeliveryPipelineVersion =
  typeof EXTERNAL_DELIVERY_PIPELINE_VERSION;

/** Provider-name catalogue. New providers (e.g. "ecourier", "sundarban")
 *  drop in by extending this list and shipping a matching adapter. */
export const EXTERNAL_DELIVERY_PROVIDERS = ["pathao", "steadfast", "redx"] as const;
export type ExternalDeliveryProvider = (typeof EXTERNAL_DELIVERY_PROVIDERS)[number];

/* -------------------------------------------------------------------------- */
/* Per-provider snapshot subdoc                                               */
/* -------------------------------------------------------------------------- */

const providerSnapshotSchema = new Schema(
  {
    /** False when the provider is not enabled or has no API access for
     *  this merchant cohort. Aggregator skips unconfigured providers. */
    configured: { type: Boolean, default: false },
    /** Last-fetch outcome. False when the provider call failed or
     *  timed out — counters in this case are zeros and `error` carries
     *  the truncated reason. */
    ok: { type: Boolean, default: false },
    total: { type: Number, default: 0, min: 0 },
    delivered: { type: Number, default: 0, min: 0 },
    rto: { type: Number, default: 0, min: 0 },
    cancelled: { type: Number, default: 0, min: 0 },
    /** delivered / total when total > 0; null otherwise. */
    successRate: { type: Number, default: null, min: 0, max: 1 },
    lastFetchedAt: { type: Date, default: null },
    /** Adapter-version label (e.g. "pathao-v1"). Lets us re-fetch on
     *  adapter bumps without reading the writer source. */
    sourceVersion: { type: String, trim: true, maxlength: 32 },
    /** Truncated error message when ok=false; never raw stack traces. */
    error: { type: String, trim: true, maxlength: 200 },
  },
  { _id: false },
);

/* -------------------------------------------------------------------------- */
/* Aggregate subdoc                                                           */
/* -------------------------------------------------------------------------- */

const aggregateSchema = new Schema(
  {
    total: { type: Number, default: 0, min: 0 },
    delivered: { type: Number, default: 0, min: 0 },
    rto: { type: Number, default: 0, min: 0 },
    cancelled: { type: Number, default: 0, min: 0 },
    /** Aggregate delivered / aggregate (delivered + rto). Null when no
     *  configured-and-ok provider returned data. */
    successRate: { type: Number, default: null, min: 0, max: 1 },
    /** Provider names that contributed to this aggregate (configured AND
     *  ok). Bounded by `EXTERNAL_DELIVERY_PROVIDERS.length`. */
    contributingProviders: { type: [String], default: [] },
  },
  { _id: false },
);

/* -------------------------------------------------------------------------- */
/* Signals subdoc — boolean flags computed at write time                      */
/* -------------------------------------------------------------------------- */

const signalsSchema = new Schema(
  {
    high_rto_customer: { type: Boolean, default: false },
    strong_delivery_history: { type: Boolean, default: false },
    sparse_history: { type: Boolean, default: true },
    mixed_provider_reputation: { type: Boolean, default: false },
  },
  { _id: false },
);

/* -------------------------------------------------------------------------- */
/* Freshness subdoc                                                           */
/* -------------------------------------------------------------------------- */

const freshnessSchema = new Schema(
  {
    fetchedAt: { type: Date, default: () => new Date() },
    /** fetchedAt + TTL_HOURS — the cutoff at which this snapshot is
     *  considered stale and a fresh fetch should be triggered. */
    expiresAt: { type: Date },
    /** Convenience flag (now > expiresAt at last write). The
     *  orchestrator re-checks at read time; this field exists so cheap
     *  cohort queries can `find({ "freshness.stale": true })` without
     *  computing `now > expiresAt` in JS. */
    stale: { type: Boolean, default: false },
  },
  { _id: false },
);

/* -------------------------------------------------------------------------- */
/* Top-level                                                                  */
/* -------------------------------------------------------------------------- */

const externalDeliveryProfileSchema = new Schema(
  {
    /**
     * SHA-256[:32] of the canonical normalised phone, matching the
     * Phase 1 `hashPhoneForNetwork` shape. The collection is keyed
     * SOLELY on this field — global scope, no merchantId.
     */
    phoneHash: { type: String, required: true, trim: true, maxlength: 64 },
    /**
     * Canonical normalised phone (e.g. "8801712345678"). Stored for
     * admin-tooling readability; never used as the lookup key. The
     * hash is the privacy boundary.
     */
    normalizedPhone: { type: String, required: true, trim: true, maxlength: 32 },

    /**
     * Per-provider snapshots. Map<providerName, ProviderSnapshot> so
     * adding a 4th courier in Phase 4B is a code-only change (no
     * schema migration). Keys are constrained to
     * EXTERNAL_DELIVERY_PROVIDERS at write time by the writer.
     */
    providers: {
      type: Map,
      of: providerSnapshotSchema,
      default: () => new Map(),
    },

    aggregate: { type: aggregateSchema, default: () => ({}) },
    signals: { type: signalsSchema, default: () => ({}) },
    freshness: { type: freshnessSchema, default: () => ({}) },

    pipelineVersion: { type: String, required: true, trim: true, maxlength: 16 },
  },
  { timestamps: true },
);

// Hot read path: phoneHash is the only lookup key. Unique index above
// enforces the (merchantless) global scope.
externalDeliveryProfileSchema.index({ phoneHash: 1 }, { unique: true });
// Staleness sweep — a future reaper / re-fetch worker queries by
// `expiresAt: { $lt: now }` to find profiles ready for refresh.
externalDeliveryProfileSchema.index({ "freshness.expiresAt": 1 });
// Cohort queries (admin only — never on the hot path):
//   "buyers with strongest delivery history platform-wide"
externalDeliveryProfileSchema.index({ "aggregate.successRate": -1 });
externalDeliveryProfileSchema.index({ "aggregate.total": -1 });

export type ExternalDeliveryProfile = InferSchemaType<typeof externalDeliveryProfileSchema> & {
  _id: Types.ObjectId;
};

export const ExternalDeliveryProfile: Model<ExternalDeliveryProfile> =
  (models.ExternalDeliveryProfile as Model<ExternalDeliveryProfile>) ||
  model<ExternalDeliveryProfile>(
    "ExternalDeliveryProfile",
    externalDeliveryProfileSchema,
  );
