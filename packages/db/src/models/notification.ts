import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * In-app notifications for merchant/agent actions that aren't tied to a
 * live UI event — today only fraud alerts write here, but the shape is
 * generic so follow-up features (tracking delays, trial expiry, etc.) can
 * reuse the same inbox.
 */
export const NOTIFICATION_KINDS = [
  "fraud.pending_review",
  "fraud.rescored_high",
  "fraud.velocity_breach",
  "fraud.blocked_match",
  "integration.webhook_failed",
  "recovery.cart_pending",
  "automation.stale_pending",
  "automation.watchdog_exhausted",
  "queue.enqueue_failed",
  "queue.stalled",
  /**
   * Platform-level anomaly alert (payment_spike, webhook_failure_spike,
   * automation_failure_spike, fraud_spike). Fanned out to every role=admin
   * merchant by lib/admin-alerts.ts whenever the anomaly worker emits an
   * `alert.fired` audit row.
   */
  "admin.alert",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_SEVERITIES = ["info", "warning", "critical"] as const;

const notificationSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true, index: true },
    kind: { type: String, enum: NOTIFICATION_KINDS, required: true },
    severity: { type: String, enum: NOTIFICATION_SEVERITIES, default: "warning" },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, trim: true, maxlength: 1000 },
    /** Optional deep-link target (e.g. `/dashboard/fraud-review?id=…`). */
    link: { type: String, trim: true, maxlength: 500 },
    /** Subject reference — used for de-dup and UI badges. */
    subjectType: {
      type: String,
      enum: ["order", "merchant", "integration", "system"],
      default: "order",
    },
    subjectId: { type: Schema.Types.ObjectId },
    /** Arbitrary payload (risk score, COD value, matched signals, …). */
    meta: { type: Schema.Types.Mixed },
    readAt: { type: Date, default: null, index: true },
    /** Used to collapse rapid-fire alerts on the same subject. */
    dedupeKey: { type: String, trim: true, maxlength: 128 },
  },
  { timestamps: true },
);

notificationSchema.index({ merchantId: 1, createdAt: -1 });
notificationSchema.index({ merchantId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index(
  { merchantId: 1, dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { dedupeKey: { $exists: true, $type: "string" } },
  },
);

export type Notification = InferSchemaType<typeof notificationSchema> & {
  _id: Types.ObjectId;
};

export const Notification: Model<Notification> =
  (models.Notification as Model<Notification>) ||
  model<Notification>("Notification", notificationSchema);
