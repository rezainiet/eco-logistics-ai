import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Monthly usage counters per merchant. One row per (merchantId, period) where
 * `period` is "YYYY-MM" — small enough to fit a compound unique index and
 * cheap to query from the billing page.
 *
 * We increment atomically via `$inc` so there's no read-modify-write race.
 */

const usageSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    /** "YYYY-MM" in UTC. */
    period: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    ordersCreated: { type: Number, default: 0, min: 0 },
    shipmentsBooked: { type: Number, default: 0, min: 0 },
    fraudReviewsUsed: { type: Number, default: 0, min: 0 },
    callsInitiated: { type: Number, default: 0, min: 0 },
    callMinutesUsed: { type: Number, default: 0, min: 0 },
    /** Free-form last-touch timestamp for UI "last activity" hints. */
    lastActivityAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

usageSchema.index({ merchantId: 1, period: 1 }, { unique: true });

export type Usage = InferSchemaType<typeof usageSchema> & { _id: Types.ObjectId };

export const Usage: Model<Usage> =
  (models.Usage as Model<Usage>) || model<Usage>("Usage", usageSchema);

/** Current UTC period in "YYYY-MM" form. */
export function currentUsagePeriod(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
