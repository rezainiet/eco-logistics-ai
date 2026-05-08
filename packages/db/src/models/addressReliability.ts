import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Per-merchant × delivery-address aggregate.
 *
 * Sibling of `CustomerReliability`. Keyed on the existing token-sorted
 * `addressHash` produced by `apps/api/src/server/risk.ts:hashAddress`,
 * which is already stamped on every fresh order at `Order.source.addressHash`
 * — so the chokepoint already has the key in hand at terminal-flip time.
 *
 * Counters tick on every terminal order outcome via the
 * `applyTrackingEvents` fan-out (S4). The bounded `distinctPhoneHashes`
 * array surfaces "this address has been used by N distinct buyers"
 * without re-scanning Order at read time. The cap mirrors the
 * `FraudSignal.merchantIds` pattern: validate at the schema and slice
 * at the writer.
 *
 * Privacy: only hashes are persisted. Raw addresses live on `Order` and
 * never enter this collection.
 */

export const ADDRESS_RELIABILITY_OUTCOMES = [
  "delivered",
  "rto",
  "cancelled",
] as const;
export type AddressReliabilityOutcome =
  (typeof ADDRESS_RELIABILITY_OUTCOMES)[number];

/** Cap on stored distinct phone hashes — bounds write growth + protects
 *  the document from unbounded array drift. Mirrors the
 *  `FRAUD_SIGNAL_MAX_MERCHANTS=64` pattern in shape; smaller cap because
 *  the address-axis surfaces a "multi-buyer" signal at distinctPhones≥3
 *  and storing more than ~32 distinct hashes would be informational
 *  overflow. */
export const ADDRESS_RELIABILITY_DISTINCT_PHONES_CAP = 32;

const addressReliabilitySchema = new Schema(
  {
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
    },
    /**
     * Output of `hashAddress(address, district)` — token-sorted SHA-256
     * truncated to 32 chars (matches `Order.source.addressHash` shape).
     * Schema maxlength=64 leaves headroom.
     */
    addressHash: { type: String, required: true, trim: true, maxlength: 64 },

    deliveredCount: { type: Number, default: 0, min: 0 },
    rtoCount: { type: Number, default: 0, min: 0 },
    cancelledCount: { type: Number, default: 0, min: 0 },

    /**
     * Bounded set of contributing phone hashes (per blueprint §1.3).
     * Cap is enforced at the schema level so a writer that bypasses the
     * `$slice` pipeline still fails loudly instead of growing the array.
     */
    distinctPhoneHashes: {
      type: [String],
      default: [],
      validate: {
        validator: (arr: unknown) =>
          Array.isArray(arr) && arr.length <= ADDRESS_RELIABILITY_DISTINCT_PHONES_CAP,
        message: `distinctPhoneHashes cannot exceed ${ADDRESS_RELIABILITY_DISTINCT_PHONES_CAP} entries`,
      },
    },

    firstOutcomeAt: { type: Date },
    lastOutcomeAt: { type: Date },

    /** Last district seen — informational only. */
    lastDistrict: { type: String, trim: true, maxlength: 100 },
    /** Latest contributing order id — informational telemetry only. */
    lastOrderId: { type: Schema.Types.ObjectId, ref: "Order" },
  },
  { timestamps: true },
);

addressReliabilitySchema.index(
  { merchantId: 1, addressHash: 1 },
  { unique: true },
);

export type AddressReliability = InferSchemaType<typeof addressReliabilitySchema> & {
  _id: Types.ObjectId;
};

export const AddressReliability: Model<AddressReliability> =
  (models.AddressReliability as Model<AddressReliability>) ||
  model<AddressReliability>("AddressReliability", addressReliabilitySchema);
