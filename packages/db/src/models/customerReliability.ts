import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Per-merchant × buyer-phone delivery-outcome aggregate.
 *
 * Powers Delivery Reliability Intelligence v1 — observation-only signals
 * surfaced on the order detail drawer. The collection is keyed on a
 * SHA-256 hash of the canonical phone (`hashPhoneForNetwork`) so PII never
 * leaves the merchant boundary into a global lookup.
 *
 * Counters tick on every terminal order outcome (delivered / rto /
 * cancelled) via the `applyTrackingEvents` chokepoint fan-out (S4).
 * Reads come from the per-order classifier (`classifyDeliveryReliability`,
 * S6) — eventually consistent; absent rows degrade gracefully to
 * `tier: "no_data"`.
 *
 * Why hashed phone (not raw): mirrors the privacy posture of `FraudSignal`.
 * A row exposed in logs / fixtures cannot be correlated to a buyer.
 *
 * Why per-merchant (not cross-merchant): the cross-merchant network is
 * already covered by `FraudSignal`. This collection is merchant-scoped
 * and answers "how reliably does THIS buyer deliver for THIS merchant".
 */

export const CUSTOMER_RELIABILITY_OUTCOMES = [
  "delivered",
  "rto",
  "cancelled",
] as const;
export type CustomerReliabilityOutcome =
  (typeof CUSTOMER_RELIABILITY_OUTCOMES)[number];

const customerReliabilitySchema = new Schema(
  {
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
    },
    /**
     * SHA-256 of the canonical phone, truncated to 32 chars
     * (`hashPhoneForNetwork` in `apps/api/src/lib/fraud-network.ts`).
     * Schema maxlength=64 leaves headroom matching `FraudSignal.phoneHash`.
     */
    phoneHash: { type: String, required: true, trim: true, maxlength: 64 },

    deliveredCount: { type: Number, default: 0, min: 0 },
    rtoCount: { type: Number, default: 0, min: 0 },
    cancelledCount: { type: Number, default: 0, min: 0 },

    /** Earliest contributing outcome — stamped via $setOnInsert on first write. */
    firstOutcomeAt: { type: Date },
    /** Latest contributing outcome — stamped on every write. Drives staleness. */
    lastOutcomeAt: { type: Date },

    /**
     * Last district seen on a contributing order. Informational only —
     * the classifier does not key on this field. Normalised at write
     * time via `normalizeDistrict` to match the existing district-key
     * convention.
     */
    lastDistrict: { type: String, trim: true, maxlength: 100 },
    /** Latest contributing order id — informational telemetry only. */
    lastOrderId: { type: Schema.Types.ObjectId, ref: "Order" },
  },
  { timestamps: true },
);

/**
 * Primary read + upsert path: every helper call hits this index.
 * Unique guarantees one row per (merchantId, phoneHash); upserts and
 * concurrent writers race-resolve via E11000 + `$inc`-on-existing.
 */
customerReliabilitySchema.index(
  { merchantId: 1, phoneHash: 1 },
  { unique: true },
);

export type CustomerReliability = InferSchemaType<typeof customerReliabilitySchema> & {
  _id: Types.ObjectId;
};

export const CustomerReliability: Model<CustomerReliability> =
  (models.CustomerReliability as Model<CustomerReliability>) ||
  model<CustomerReliability>("CustomerReliability", customerReliabilitySchema);
