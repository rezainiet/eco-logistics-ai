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

/** Where the abandoned cart lived. Absent on rows created before this field (storefront SDK). */
export const RECOVERY_SOURCES = ["storefront", "landing_page"] as const;

/**
 * Automatic recovery email lifecycle (Growth+, landing-page carts only — the
 * only carts ConfirmX can restore):
 *   queued    → waiting for the send delay
 *   sending   → claimed by one sweep (lockedUntil guards a crashed worker)
 *   sent      → delivered to the provider (task moves pending → contacted)
 *   failed    → gave up (permanent error or retries exhausted)
 *   suppressed→ recipient on the bounce/complaint suppression list
 *   cancelled → not sent: the buyer ordered, the page went offline, the
 *               merchant acted first, or the task expired
 */
export const RECOVERY_EMAIL_STATES = ["queued", "sending", "sent", "failed", "suppressed", "cancelled"] as const;
export type RecoveryEmailState = (typeof RECOVERY_EMAIL_STATES)[number];

const recoveryEmailSchema = new Schema(
  {
    state: { type: String, enum: RECOVERY_EMAIL_STATES, required: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date },
    lockedUntil: { type: Date },
    sentAt: { type: Date },
    providerMessageId: { type: String, trim: true, maxlength: 120 },
    lastError: { type: String, trim: true, maxlength: 300 },
    cancelReason: { type: String, trim: true, maxlength: 60 },
    /** Random per-task nonce the link token is derived from (never the token itself). */
    tokenNonce: { type: String, trim: true, maxlength: 64 },
    /** sha256 of the recovery link token — the link is matched by this hash. */
    tokenHash: { type: String, trim: true, maxlength: 64 },
    clickedAt: { type: Date },
    clicks: { type: Number, default: 0 },
    checkoutStartedAt: { type: Date },
  },
  { _id: false },
);

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
    source: { type: String, enum: RECOVERY_SOURCES },
    /** Landing-page carts: the page and the host the buyer used (the link goes back there). */
    landingPageId: { type: Schema.Types.ObjectId, ref: "LandingPage" },
    landingHost: { type: String, trim: true, lowercase: true, maxlength: 253 },
    landingLocale: { type: String, trim: true, maxlength: 8 },
    /** Automatic recovery email (absent = merchant-assisted only). */
    emailRecovery: { type: recoveryEmailSchema, default: undefined },
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
