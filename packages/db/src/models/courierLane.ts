import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Phase 3 — thana-level courier performance aggregate.
 *
 * Sibling of `CourierPerformance` (district + _GLOBAL_). Adds thana axis
 * for finer-grained Bangladesh courier intelligence: Pathao / Steadfast /
 * RedX behave very differently across thanas in the same district, so
 * district-level rollups smear good lanes against bad ones.
 *
 * Replay-safety contract:
 *   - ADDITIVE collection. The legacy `CourierPerformance` collection is
 *     UNCHANGED — all existing writes (`recordCourierOutcome`) and reads
 *     (`selectBestCourier`'s district + _GLOBAL_ ladder) continue to
 *     operate on it byte-identically.
 *   - Per-document atomic upsert via $setOnInsert + $inc + $max. Same
 *     replay-storm characteristics as `customer_reliabilities` and
 *     `address_reliabilities`.
 *   - `pipelineVersion` pins each row to its writer's canonicalisation
 *     contract. A future v2 bump never mutates v1 rows in place.
 *
 * Cardinality: bounded by (merchant × courier × district × thana). For
 * 100 merchants × 4 couriers × 30 active thanas → ~12k rows. Storage <
 * 5 MB at this scale.
 */

export const COURIER_LANE_OUTCOMES = ["delivered", "rto", "cancelled"] as const;
export type CourierLaneOutcome = (typeof COURIER_LANE_OUTCOMES)[number];

const courierLaneSchema = new Schema(
  {
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
      index: true,
    },
    courier: { type: String, required: true, trim: true, lowercase: true, maxlength: 60 },
    /** Canonical lowercase district (matches `lib/district.ts:normalizeDistrict`). */
    district: { type: String, required: true, trim: true, lowercase: true, maxlength: 100 },
    /** Canonical lowercase thana (matches `lib/thana-lexicon.ts` canonical
     *  + Phase 2 `canonicalAddress.thana`). REQUIRED — district-only
     *  rollups continue to live in `CourierPerformance`. */
    thana: { type: String, required: true, trim: true, lowercase: true, maxlength: 100 },

    deliveredCount: { type: Number, default: 0, min: 0 },
    rtoCount: { type: Number, default: 0, min: 0 },
    cancelledCount: { type: Number, default: 0, min: 0 },
    /** Sum of (deliveredAt - shippedAt) hours across delivered orders.
     *  Same shape as `CourierPerformance.totalDeliveryHours`. */
    totalDeliveryHours: { type: Number, default: 0, min: 0 },

    /**
     * Per-attempt counters — Phase 3 substrate for retry intelligence
     * (Phase 4 surface). The attempt index is derived at write time from
     * `Order.automation.attemptedCouriers.length` at terminal-flip moment:
     *   attempt 1 = first courier ever booked (length === 1).
     *   attempt 2 = first switch (length === 2).
     *   attempt 3+ = anything beyond, capped at MAX_ATTEMPTED_COURIERS.
     * Counters are atomic $inc — replay-safe through the chokepoint guard.
     */
    attempt1Delivered: { type: Number, default: 0, min: 0 },
    attempt1Rto: { type: Number, default: 0, min: 0 },
    attempt2Delivered: { type: Number, default: 0, min: 0 },
    attempt2Rto: { type: Number, default: 0, min: 0 },
    attempt3PlusDelivered: { type: Number, default: 0, min: 0 },
    attempt3PlusRto: { type: Number, default: 0, min: 0 },

    /** Earliest contributing outcome — written via $setOnInsert. */
    firstOutcomeAt: { type: Date },
    /** Latest contributing outcome — advanced via $max (monotonic). */
    lastOutcomeAt: { type: Date },

    pipelineVersion: { type: String, required: true, trim: true, maxlength: 16 },
  },
  { timestamps: true },
);

// Primary lookup + uniqueness — every read goes through this index.
courierLaneSchema.index(
  { merchantId: 1, courier: 1, district: 1, thana: 1 },
  { unique: true },
);
// Hot-thana lookup for "all couriers in thana X" queries (Phase 4 lane health).
courierLaneSchema.index({ merchantId: 1, district: 1, thana: 1, lastOutcomeAt: -1 });
// Staleness sweeps + admin diagnostics.
courierLaneSchema.index({ merchantId: 1, courier: 1, lastOutcomeAt: -1 });

export type CourierLane = InferSchemaType<typeof courierLaneSchema> & {
  _id: Types.ObjectId;
};

export const CourierLane: Model<CourierLane> =
  (models.CourierLane as Model<CourierLane>) ||
  model<CourierLane>("CourierLane", courierLaneSchema);
