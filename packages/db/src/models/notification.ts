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
  /**
   * Adapter classified an inbound order-shaped webhook as unprocessable
   * (missing customer phone, malformed payload). The order is parked in
   * the `needs_attention` inbox bucket — not retried automatically — and
   * the merchant must fix the storefront and click Replay. Distinct from
   * `integration.webhook_failed` (which is dead-lettered after exhausted
   * retries on a transient error) because there's a clear, merchant-side
   * remediation path.
   */
  "integration.webhook_needs_attention",
  /**
   * The merchant's plan was changed to a tier whose caps don't fit their
   * current footprint, so `enforceIntegrationCapacity` disabled the
   * excess connectors. Fired with severity=warning and includes the list
   * of disabled rows in `meta` so the dashboard can surface a "click to
   * upgrade and reconnect" CTA.
   */
  "subscription.plan_downgrade_enforced",
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
  /**
   * Shopify forwarded a `customers/data_request` for one of the
   * merchant's customers. Per the processor / controller relationship,
   * the merchant is responsible for replying to the customer within 30
   * days; we surface the request so they know to act. Fired from
   * server/webhooks/shopify-gdpr.ts.
   */
  "gdpr.data_request_received",
  /**
   * The merchant trashed an order in the upstream platform (Woo
   * `order.deleted`, Shopify `orders/cancelled`) AFTER a courier AWB
   * was already issued. We flip the local Order to `cancelled` but
   * the courier still has the parcel out for delivery; the merchant
   * must call the courier directly to cancel pickup or accept the
   * RTO. BD courier adapters (Pathao/RedX/Steadfast) don't expose a
   * REST cancel endpoint, so manual intervention is the only path.
   * Severity=critical because letting this slip risks a real-money
   * RTO + a wasted courier slot.
   */
  "order.courier_cancel_required",
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
