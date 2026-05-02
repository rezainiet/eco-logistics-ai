import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Cross-merchant fraud signal — anonymised, aggregate.
 *
 * One document per (phoneHash, addressHash) pair, where either side may be
 * a literal "_none_" sentinel when only one identifier is known. We track:
 *
 *  - `deliveredCount`      — orders with this fingerprint that succeeded
 *  - `rtoCount`            — orders that returned to origin
 *  - `cancelledCount`      — orders cancelled / rejected before shipping
 *  - `merchantIds`         — the distinct merchants that have observed this
 *                            fingerprint (capped at MAX_MERCHANTS_TRACKED).
 *  - `firstSeenAt`         — earliest contribution timestamp
 *  - `lastSeenAt`          — most recent contribution timestamp
 *
 * Privacy posture: raw phone numbers and addresses are NEVER persisted in
 * this collection. The two hash columns are the only identifiers, and the
 * `merchantIds` array is capped so a merchant can't probe the network for
 * which other merchants have served a particular fingerprint.
 *
 * Tenant isolation: this collection is global by design — that's the
 * point. The privacy boundary is enforced at write time (only hashes
 * persist) and at read time (the `lookupNetworkRisk` helper exposes only
 * aggregate counts, never the merchant id list).
 */

export const FRAUD_SIGNAL_OUTCOMES = ["delivered", "rto", "cancelled"] as const;
export type FraudSignalOutcome = (typeof FRAUD_SIGNAL_OUTCOMES)[number];

/** Cap on stored merchantIds per signal — enforced at the writer */
/** AND validated at the schema level so a write that bypasses the helper */
/** still fails loudly instead of letting the array balloon. */
export const FRAUD_SIGNAL_MAX_MERCHANTS = 64;

const fraudSignalSchema = new Schema(
  {
    /** SHA-256 of the normalized phone (`88017XXXXXXXX`). `_none_` if absent. */
    phoneHash: { type: String, required: true, trim: true, maxlength: 64 },
    /** Output of crypto.hashAddress(...). `_none_` if address+district missing. */
    addressHash: { type: String, required: true, trim: true, maxlength: 64 },
    deliveredCount: { type: Number, default: 0, min: 0 },
    rtoCount: { type: Number, default: 0, min: 0 },
    cancelledCount: { type: Number, default: 0, min: 0 },
    /**
     * Distinct merchant ids that have contributed. Capped at 64 entries to
     * bound write growth — once we hit the cap, future contributors update
     * counts without re-adding their id. Length is the network-confidence
     * proxy used by the lookup.
     */
    merchantIds: {
      type: [Schema.Types.ObjectId],
      default: [],
      validate: {
        validator: (arr: unknown) => Array.isArray(arr) && arr.length <= FRAUD_SIGNAL_MAX_MERCHANTS,
        message: `merchantIds cannot exceed ${FRAUD_SIGNAL_MAX_MERCHANTS} entries`,
      },
    },
    firstSeenAt: { type: Date, default: () => new Date() },
    lastSeenAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

// Idempotency / lookup index — every read goes through this.
fraudSignalSchema.index(
  { phoneHash: 1, addressHash: 1 },
  { unique: true },
);
// Independent lookups (when only the phone OR only the address is known).
fraudSignalSchema.index({ phoneHash: 1 });
fraudSignalSchema.index({ addressHash: 1 });

export type FraudSignal = InferSchemaType<typeof fraudSignalSchema> & {
  _id: Types.ObjectId;
};

export const FraudSignal: Model<FraudSignal> =
  (models.FraudSignal as Model<FraudSignal>) ||
  model<FraudSignal>("FraudSignal", fraudSignalSchema);

/**
 * Sentinel used when only one of the two hashes is present. Keeping it as
 * a literal string (not undefined) makes the unique compound index work
 * across "phone-only" rows without lots of null-handling noise.
 */
export const FRAUD_SIGNAL_NONE = "_none_" as const;
