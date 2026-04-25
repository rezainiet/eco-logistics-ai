import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Raw behavioral events emitted by the merchant's storefront via the JS SDK.
 *
 * Tenant-isolated by `merchantId` (resolved server-side from the public
 * tracking key). PII is bounded — we capture phone/email *only* on
 * checkout_submit (so identity-resolution can stitch the prior anonymous
 * session to a created order). The collector is the trust boundary; the SDK
 * never sends raw cookies or IPs from the client.
 *
 * Events are append-only. The dedupeKey (merchantId + sessionId + clientEventId)
 * lets retries land idempotently. Hot indexes are kept narrow — analytics
 * queries hit `(merchantId, type, occurredAt)` and `(merchantId, sessionId,
 * occurredAt)` exclusively.
 */
export const TRACKING_EVENT_TYPES = [
  "page_view",
  "product_view",
  "add_to_cart",
  "remove_from_cart",
  "checkout_start",
  "checkout_submit",
  "click",
  "scroll",
  "session_start",
  "session_end",
  "identify",
  "custom",
] as const;
export type TrackingEventType = (typeof TRACKING_EVENT_TYPES)[number];

const trackingEventSchema = new Schema(
  {
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
      index: true,
    },
    sessionId: { type: String, required: true, trim: true, maxlength: 64, index: true },
    anonId: { type: String, trim: true, maxlength: 64, index: true },
    type: { type: String, enum: TRACKING_EVENT_TYPES, required: true },
    /** Per-event client id used for batched-retry idempotency. */
    clientEventId: { type: String, trim: true, maxlength: 64 },
    /** Page url + referrer (host-level, full path captured separately). */
    url: { type: String, trim: true, maxlength: 1000 },
    path: { type: String, trim: true, maxlength: 500 },
    referrer: { type: String, trim: true, maxlength: 1000 },
    /** UTM / campaign params lifted from the URL by the SDK. */
    campaign: {
      source: { type: String, trim: true, maxlength: 80 },
      medium: { type: String, trim: true, maxlength: 80 },
      name: { type: String, trim: true, maxlength: 200 },
      term: { type: String, trim: true, maxlength: 120 },
      content: { type: String, trim: true, maxlength: 200 },
    },
    device: {
      type: { type: String, trim: true, maxlength: 30 }, // "mobile" | "tablet" | "desktop"
      os: { type: String, trim: true, maxlength: 60 },
      browser: { type: String, trim: true, maxlength: 60 },
      viewport: { type: String, trim: true, maxlength: 40 },
      language: { type: String, trim: true, maxlength: 20 },
    },
    /**
     * Free-form event-specific properties. For `product_view` we expect
     * { productId, name, price, sku }; for `scroll` we expect { depth };
     * for `checkout_submit` we expect { phone, email, orderTotal }.
     */
    properties: { type: Schema.Types.Mixed },
    /** Identity hooks — set when the SDK calls `track.identify(...)` or on checkout_submit. */
    phone: { type: String, trim: true, maxlength: 32, index: true },
    email: { type: String, trim: true, lowercase: true, maxlength: 200, index: true },
    /** Captured server-side from the request (IP + UA fingerprint). Never trusted from the SDK. */
    ip: { type: String, trim: true, maxlength: 64 },
    userAgent: { type: String, trim: true, maxlength: 500 },
    occurredAt: { type: Date, required: true, index: true },
    receivedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);

trackingEventSchema.index({ merchantId: 1, occurredAt: -1 });
trackingEventSchema.index({ merchantId: 1, type: 1, occurredAt: -1 });
trackingEventSchema.index({ merchantId: 1, sessionId: 1, occurredAt: 1 });
trackingEventSchema.index({ merchantId: 1, phone: 1 }, { sparse: true });
trackingEventSchema.index({ merchantId: 1, email: 1 }, { sparse: true });
// Idempotent retry guard — SDK assigns a uuid per event in the batch.
trackingEventSchema.index(
  { merchantId: 1, sessionId: 1, clientEventId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientEventId: { $exists: true, $type: "string" } },
  },
);

export type TrackingEvent = InferSchemaType<typeof trackingEventSchema> & {
  _id: Types.ObjectId;
};

export const TrackingEvent: Model<TrackingEvent> =
  (models.TrackingEvent as Model<TrackingEvent>) ||
  model<TrackingEvent>("TrackingEvent", trackingEventSchema);
