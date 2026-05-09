import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Phase 3 — area-level delivery reliability aggregate.
 *
 * Per-merchant × geographic-area aggregate, NOT keyed on courier. Powers
 * "is delivery to Mirpur healthy?" / "is this lane degrading?" cohort
 * questions without needing a courier filter. Sibling of `CustomerReliability`
 * and `AddressReliability` — same writer pattern, same replay-safety
 * characteristics.
 *
 * Privacy:
 *   - NO phoneHash. NO addressHash. Strictly geographic + outcome counters.
 *     A row exposed in logs / fixtures cannot identify a buyer.
 *   - The unreachable counter is a CallLog-derived statistic at chokepoint
 *     time; the row never carries the call-log row id back-reference.
 *
 * Replay-safety:
 *   - ADDITIVE collection.
 *   - Per-document atomic upsert via $setOnInsert + $inc + $max. Same
 *     replay-storm characteristics as the existing reliability writers.
 *   - The 7-day rolling counters use a CAS-style two-step write at the
 *     writer level (analogous to `recordCourierBookFailure`'s window
 *     reset). Replay-suppressed at the chokepoint, so out-of-order races
 *     at worst over-count by one — same loss tolerance as the cumulative
 *     counters.
 *   - `pipelineVersion` pins each row to its writer's canonicalisation
 *     contract.
 *
 * Cardinality: bounded by (merchant × thana). For 100 merchants × 30
 * active thanas → ~3k rows. Storage < 1 MB at this scale.
 */

export const AREA_RELIABILITY_OUTCOMES = ["delivered", "rto", "cancelled"] as const;
export type AreaReliabilityOutcome = (typeof AREA_RELIABILITY_OUTCOMES)[number];

const areaReliabilitySchema = new Schema(
  {
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
      index: true,
    },
    division: { type: String, required: true, trim: true, lowercase: true, maxlength: 100 },
    district: { type: String, required: true, trim: true, lowercase: true, maxlength: 100 },
    thana: { type: String, required: true, trim: true, lowercase: true, maxlength: 100 },

    deliveredCount: { type: Number, default: 0, min: 0 },
    rtoCount: { type: Number, default: 0, min: 0 },
    cancelledCount: { type: Number, default: 0, min: 0 },
    /**
     * Unreachable-on-first-contact count. Stamped at chokepoint when the
     * call-center recorded an `answered: false` outcome PRIOR to the
     * terminal status flip. Best-effort; absent on legacy orders.
     */
    unreachableCount: { type: Number, default: 0, min: 0 },

    /**
     * Rolling-7-day window counters for degradation detection. Reset at
     * the writer when `(now - recent7dWindowStartedAt) > 7d`. Lock-free
     * via a CAS-style two-step pattern at the writer.
     */
    recent7dDelivered: { type: Number, default: 0, min: 0 },
    recent7dRto: { type: Number, default: 0, min: 0 },
    recent7dCancelled: { type: Number, default: 0, min: 0 },
    recent7dWindowStartedAt: { type: Date },

    firstOutcomeAt: { type: Date },
    lastOutcomeAt: { type: Date },

    pipelineVersion: { type: String, required: true, trim: true, maxlength: 16 },
  },
  { timestamps: true },
);

// Primary lookup + uniqueness — every read goes through this index.
areaReliabilitySchema.index(
  { merchantId: 1, division: 1, district: 1, thana: 1 },
  { unique: true },
);
// Hot-area listing ("all areas for this merchant, freshest first").
areaReliabilitySchema.index({ merchantId: 1, lastOutcomeAt: -1 });

export type AreaReliability = InferSchemaType<typeof areaReliabilitySchema> & {
  _id: Types.ObjectId;
};

export const AreaReliability: Model<AreaReliability> =
  (models.AreaReliability as Model<AreaReliability>) ||
  model<AreaReliability>("AreaReliability", areaReliabilitySchema);
