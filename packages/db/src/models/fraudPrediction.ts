import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Per-order fraud prediction → outcome ledger. Captured at scoring time and
 * stamped with the resolved outcome (delivered / rto / cancelled) when the
 * tracking pipeline lands a terminal status. Feeds the monthly weight-tuning
 * worker — without this row we cannot tell which signals correlated with
 * actual RTO and which were noise.
 *
 * We deliberately keep this in a separate collection from `Order` so:
 *   - Order writes stay narrow (hot path).
 *   - The history is append-only / immutable (we want frozen snapshots of
 *     what we predicted, not whatever the live order doc says today).
 *   - The TTL can lapse independently — we keep 13 months so the tuning
 *     worker always has a 12-month window plus a month of grace.
 */
export const FRAUD_PREDICTION_TTL_DAYS = 400;

const fraudSignalSnapshotSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 80 },
    weight: { type: Number, required: true },
  },
  { _id: false },
);

const fraudPredictionSchema = new Schema(
  {
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
      index: true,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      unique: true,
    },
    /** What we predicted at scoring time. */
    riskScore: { type: Number, required: true, min: 0, max: 100 },
    pRto: { type: Number, required: true, min: 0, max: 1 },
    levelPredicted: {
      type: String,
      enum: ["low", "medium", "high"],
      required: true,
    },
    customerTier: {
      type: String,
      enum: ["new", "standard", "silver", "gold"],
      default: "new",
    },
    signals: { type: [fraudSignalSnapshotSchema], default: [] },
    /**
     * Frozen copy of the weight set used at scoring time. Lets the tuning
     * worker compute precision/recall against the snapshot rather than the
     * live (possibly newer) weights.
     */
    weightsVersion: { type: String, required: true, trim: true, maxlength: 60 },
    /** Set by the tracking pipeline once the order resolves. */
    outcome: {
      type: String,
      enum: ["delivered", "rto", "cancelled"],
    },
    outcomeAt: { type: Date },
    scoredAt: { type: Date, default: () => new Date() },
    expiresAt: {
      type: Date,
      default: () =>
        new Date(Date.now() + FRAUD_PREDICTION_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true },
);

// Tuning-worker primary scan: pull resolved predictions for a merchant in a
// time window, oldest first.
fraudPredictionSchema.index(
  { merchantId: 1, outcomeAt: 1 },
  { partialFilterExpression: { outcomeAt: { $type: "date" } } },
);
// Cross-merchant sweep — `distinct("merchantId", { outcomeAt: { $gte } })`
// run by the monthly tuner. Without this it would IXSCAN per-merchant or
// fall back to a full collscan as the table grows.
fraudPredictionSchema.index(
  { outcomeAt: 1 },
  { partialFilterExpression: { outcomeAt: { $type: "date" } } },
);
// Sweep for orders that need outcome attached.
fraudPredictionSchema.index({ merchantId: 1, scoredAt: 1 });
// TTL — keep 13 months of feedback then reap.
fraudPredictionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type FraudPrediction = InferSchemaType<typeof fraudPredictionSchema> & {
  _id: Types.ObjectId;
};

export const FraudPrediction: Model<FraudPrediction> =
  (models.FraudPrediction as Model<FraudPrediction>) ||
  model<FraudPrediction>("FraudPrediction", fraudPredictionSchema);
