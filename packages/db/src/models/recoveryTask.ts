import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Abandoned-cart recovery task. Created by the recovery worker for each
 * stitched session that hit `abandonedCart=true` with a reachable identity
 * (phone/email) and no resulting order. Becomes the merchant's actionable
 * outreach queue — call, SMS, email — and tracks state so the same buyer
 * isn't pestered twice.
 *
 * One row per (merchantId, sessionId) — re-runs of the worker are idempotent.
 */
export const RECOVERY_STATUSES = [
  "pending",
  "contacted",
  "recovered",
  "dismissed",
  "expired",
] as const;
export type RecoveryStatus = (typeof RECOVERY_STATUSES)[number];

export const RECOVERY_CHANNELS = ["call", "sms", "email"] as const;

const recoveryTaskSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    sessionId: { type: String, required: true, trim: true, maxlength: 64 },
    /** Tracking-session document this row was derived from. */
    trackingSessionId: { type: Schema.Types.ObjectId, ref: "TrackingSession" },
    phone: { type: String, trim: true, maxlength: 32, index: true },
    email: { type: String, trim: true, lowercase: true, maxlength: 200, index: true },
    /** Estimated cart value, summed from product_view + add_to_cart prices. */
    cartValue: { type: Number, default: 0 },
    /** Top product names captured during the session — power the reach-out script. */
    topProducts: { type: [String], default: [] },
    /** When we believe the session abandoned (last_seen of the session). */
    abandonedAt: { type: Date, required: true },
    status: {
      type: String,
      enum: RECOVERY_STATUSES,
      default: "pending",
      index: true,
    },
    /** Last channel the agent used to reach out, when status==contacted. */
    lastChannel: { type: String, enum: RECOVERY_CHANNELS },
    contactedAt: { type: Date },
    contactedBy: { type: Schema.Types.ObjectId },
    /** If the buyer eventually placed an order, link it here. */
    recoveredOrderId: { type: Schema.Types.ObjectId, ref: "Order" },
    recoveredAt: { type: Date },
    /** Free-form note set by the agent. */
    note: { type: String, trim: true, maxlength: 500 },
    /** Auto-expiry sweep marks rows older than the recovery window expired. */
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

// Idempotency: one task per session.
recoveryTaskSchema.index({ merchantId: 1, sessionId: 1 }, { unique: true });
// Hot lookup for the dashboard queue: pending first, freshest first.
recoveryTaskSchema.index({ merchantId: 1, status: 1, abandonedAt: -1 });
// Worker pickup for expiry sweep.
recoveryTaskSchema.index(
  { status: 1, expiresAt: 1 },
  { partialFilterExpression: { status: "pending" } },
);

export type RecoveryTask = InferSchemaType<typeof recoveryTaskSchema> & {
  _id: Types.ObjectId;
};

export const RecoveryTask: Model<RecoveryTask> =
  (models.RecoveryTask as Model<RecoveryTask>) ||
  model<RecoveryTask>("RecoveryTask", recoveryTaskSchema);
