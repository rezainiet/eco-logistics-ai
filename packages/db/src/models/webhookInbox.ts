import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Idempotent webhook ledger. Every inbound webhook (Shopify / Woo / custom)
 * stamps a `(merchantId, provider, externalId)` row before processing so a
 * replay (or platform-level retry) never produces a duplicate order.
 *
 * `externalId` is the upstream event id when present (Shopify `X-Shopify-Webhook-Id`),
 * otherwise a hash of the payload + topic. Status flips through processing →
 * succeeded/failed; failed rows are retried by the worker until `attempts >= 5`.
 */
export const WEBHOOK_STATUSES = ["received", "processing", "succeeded", "failed"] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

const webhookInboxSchema = new Schema(
  {
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
      index: true,
    },
    integrationId: { type: Schema.Types.ObjectId, ref: "Integration", index: true },
    provider: { type: String, required: true, trim: true, maxlength: 60 },
    topic: { type: String, required: true, trim: true, maxlength: 120 },
    externalId: { type: String, required: true, trim: true, maxlength: 200 },
    status: {
      type: String,
      enum: WEBHOOK_STATUSES,
      default: "received",
      index: true,
    },
    /** Truncated raw payload — kept for replay/debug. */
    payload: { type: Schema.Types.Mixed },
    payloadBytes: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, trim: true, maxlength: 500 },
    /** Set once an Order has been created/updated as a result. */
    resolvedOrderId: { type: Schema.Types.ObjectId, ref: "Order" },
    receivedAt: { type: Date, default: () => new Date() },
    processedAt: { type: Date },
  },
  { timestamps: true },
);

// Idempotency key — we never duplicate-process the same upstream event.
webhookInboxSchema.index(
  { merchantId: 1, provider: 1, externalId: 1 },
  { unique: true },
);
webhookInboxSchema.index({ status: 1, receivedAt: 1 });

export type WebhookInbox = InferSchemaType<typeof webhookInboxSchema> & {
  _id: Types.ObjectId;
};

export const WebhookInbox: Model<WebhookInbox> =
  (models.WebhookInbox as Model<WebhookInbox>) ||
  model<WebhookInbox>("WebhookInbox", webhookInboxSchema);
