import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Per-merchant × courier × district performance bucket.
 *
 * Powers the courier-intelligence engine. Counters tick on every order
 * outcome (delivered / rto / cancelled). The selection layer reads a
 * single document per (merchantId, courier, district) candidate, plus a
 * `_GLOBAL_` district fallback when the order's specific district has
 * insufficient evidence.
 *
 * Why per-merchant: courier behaviour varies wildly by merchant —
 * Steadfast might deliver 95% for one merchant and 70% for another in the
 * same district, depending on the merchant's order volume / packaging /
 * customer base. We score each merchant on their OWN history.
 *
 * Why district + global: at low data volume the per-district stats are
 * noisy. The selection engine prefers district-level evidence when a
 * threshold of observations exists; otherwise it falls back to the
 * merchant's global average for that courier.
 */

export const COURIER_PERF_OUTCOMES = ["delivered", "rto", "cancelled"] as const;
export type CourierPerfOutcome = (typeof COURIER_PERF_OUTCOMES)[number];

/** Sentinel used for the merchant-wide aggregate row. */
export const COURIER_PERF_GLOBAL_DISTRICT = "_GLOBAL_" as const;

const courierPerformanceSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    /** Courier provider name (matches Merchant.couriers[].name). */
    courier: { type: String, required: true, trim: true, lowercase: true, maxlength: 60 },
    /** Order destination district, or `_GLOBAL_` for the merchant-wide row. */
    district: { type: String, required: true, trim: true, maxlength: 100 },
    deliveredCount: { type: Number, default: 0, min: 0 },
    rtoCount: { type: Number, default: 0, min: 0 },
    cancelledCount: { type: Number, default: 0, min: 0 },
    /**
     * Sum of (deliveredAt - shippedAt) hours across delivered orders. Used
     * with `deliveredCount` to compute the rolling avgDeliveryHours.
     * Stored as a sum so $inc updates stay lock-free.
     */
    totalDeliveryHours: { type: Number, default: 0, min: 0 },
    lastOutcomeAt: { type: Date },
    /** Circuit-breaker — booking failures inside the rolling window below. */
    recentFailureCount: { type: Number, default: 0, min: 0 },
    /** Window start. Reset whenever (now - windowStart) exceeds the configured TTL. */
    recentFailureWindowAt: { type: Date },
  },
  { timestamps: true },
);

courierPerformanceSchema.index(
  { merchantId: 1, courier: 1, district: 1 },
  { unique: true },
);
courierPerformanceSchema.index({ merchantId: 1, courier: 1, lastOutcomeAt: -1 });

export type CourierPerformance = InferSchemaType<typeof courierPerformanceSchema> & {
  _id: Types.ObjectId;
};

export const CourierPerformance: Model<CourierPerformance> =
  (models.CourierPerformance as Model<CourierPerformance>) ||
  model<CourierPerformance>("CourierPerformance", courierPerformanceSchema);
