import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Aggregated rollup of a behavioral session — much cheaper to query than
 * scanning raw events for funnel + intent analytics. Rebuilt incrementally
 * on every collector batch via `upsertSessionAggregates`.
 *
 * Identity columns (phone / email / customerHash) are populated when the
 * checkout_submit event lands or when `identify()` is called. We keep the
 * latest value seen rather than maintaining a history — the previous-value
 * audit trail lives in `TrackingEvent`.
 */
const trackingSessionSchema = new Schema(
  {
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
      index: true,
    },
    sessionId: { type: String, required: true, trim: true, maxlength: 64 },
    anonId: { type: String, trim: true, maxlength: 64, index: true },
    /** Most recent identity. Populated on checkout_submit or identify. */
    phone: { type: String, trim: true, maxlength: 32, index: true },
    email: { type: String, trim: true, lowercase: true, maxlength: 200, index: true },
    customerHash: { type: String, trim: true, maxlength: 64, index: true },
    /** Counts — incremented on the collector path. */
    pageViews: { type: Number, default: 0 },
    productViews: { type: Number, default: 0 },
    addToCartCount: { type: Number, default: 0 },
    checkoutStartCount: { type: Number, default: 0 },
    checkoutSubmitCount: { type: Number, default: 0 },
    clickCount: { type: Number, default: 0 },
    /** Highest scroll depth (0-100) seen in this session. */
    maxScrollDepth: { type: Number, default: 0 },
    /** First / last event timestamps; used for session_duration + bounce detection. */
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    durationMs: { type: Number, default: 0 },
    /** First-page channel attribution snapshot. */
    landingPath: { type: String, trim: true, maxlength: 500 },
    referrer: { type: String, trim: true, maxlength: 1000 },
    campaign: {
      source: { type: String, trim: true, maxlength: 80 },
      medium: { type: String, trim: true, maxlength: 80 },
      name: { type: String, trim: true, maxlength: 200 },
    },
    device: {
      type: { type: String, trim: true, maxlength: 30 },
      os: { type: String, trim: true, maxlength: 60 },
      browser: { type: String, trim: true, maxlength: 60 },
    },
    /** True when this is the n>=2nd session for the same anonId/email/phone. */
    repeatVisitor: { type: Boolean, default: false },
    /** True if the session contained ≥2 add_to_cart events without a checkout. */
    abandonedCart: { type: Boolean, default: false },
    /** True if the session triggered checkout_submit. */
    converted: { type: Boolean, default: false },
    /** Linked order once identity-resolution fires. */
    resolvedOrderId: { type: Schema.Types.ObjectId, ref: "Order" },
    resolvedAt: { type: Date },
    /**
     * Risk hint: 0-100 derived from signals like `multiple_carts_no_checkout`,
     * `bot_user_agent`, `extreme_velocity`. Cheaper than re-running the full
     * fraud engine — populated by behavior-analytics queries.
     */
    riskHint: { type: Number, min: 0, max: 100, default: 0 },
    riskFlags: { type: [String], default: [] },
  },
  { timestamps: true },
);

trackingSessionSchema.index({ merchantId: 1, sessionId: 1 }, { unique: true });
trackingSessionSchema.index({ merchantId: 1, lastSeenAt: -1 });
trackingSessionSchema.index({ merchantId: 1, converted: 1, lastSeenAt: -1 });
trackingSessionSchema.index({ merchantId: 1, abandonedCart: 1, lastSeenAt: -1 });
trackingSessionSchema.index({ merchantId: 1, riskHint: -1 });
trackingSessionSchema.index({ merchantId: 1, anonId: 1, firstSeenAt: -1 });
// Intent Intelligence — fast lookup of every session resolved to a given
// order. Partial filter keeps the index narrow (only sessions that actually
// stitched). Read by `lib/intent.ts` `scoreIntentForOrder` post-ingest.
trackingSessionSchema.index(
  { merchantId: 1, resolvedOrderId: 1 },
  {
    partialFilterExpression: { resolvedOrderId: { $exists: true } },
  },
);

export type TrackingSession = InferSchemaType<typeof trackingSessionSchema> & {
  _id: Types.ObjectId;
};

export const TrackingSession: Model<TrackingSession> =
  (models.TrackingSession as Model<TrackingSession>) ||
  model<TrackingSession>("TrackingSession", trackingSessionSchema);
