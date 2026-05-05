import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Idempotent webhook ledger. Every inbound webhook (Shopify / Woo / custom)
 * stamps a `(merchantId, provider, externalId)` row before processing so a
 * replay (or platform-level retry) never produces a duplicate order.
 *
 * `externalId` is the upstream event id when present (Shopify `X-Shopify-Webhook-Id`),
 * otherwise a hash of the payload + topic. Status flips through received →
 * processing → succeeded/failed; failed rows are retried by the worker until
 * `attempts >= 5`.
 *
 * **Idempotency durability — INFINITE.** The dedup keys
 * `(merchantId, provider, externalId)` live FOREVER. Earlier versions reaped
 * whole rows after 30 days via a TTL index, which silently re-opened the
 * dedup window for any platform that retries indefinitely (Shopify will
 * happily redeliver an event a year later if the receiver was unreachable
 * the first time). The audit caught a concrete failure scenario where a
 * 32-day-old replay produced a duplicate order; this design closes it.
 *
 * Storage is bounded by reaping the *payload* — not the row. The
 * `webhookRetry` sweeper NULLs `payload` and `payloadBytes` on succeeded
 * rows whose `payloadReapAt` has passed (default: receivedAt + 90 days).
 * The remaining slim row (~200 bytes) is enough to dedupe a future
 * delivery and to surface the resolved order id back to the caller. If a
 * replayed event arrives after payload reap, the inbox lookup short-
 * circuits with `duplicate: true` and the caller never re-processes.
 *
 * Defense-in-depth: even if a row IS deleted (manual cleanup, partition
 * loss), the second-line guard is the unique sparse index on Order
 * `(merchantId, source.externalId)` — `ingestNormalizedOrder` checks
 * Order.findOne before insert, so a duplicate cannot create a second order
 * as long as the original order document still exists.
 */
export const WEBHOOK_PAYLOAD_REAP_DAYS = 90;
/**
 * Backward-compatible alias — old code referenced `WEBHOOK_INBOX_TTL_DAYS`
 * back when whole rows were reaped. The constant is kept so external
 * consumers don't break, but it now means "payload reap deadline", not
 * "row deletion deadline".
 *
 * @deprecated Use `WEBHOOK_PAYLOAD_REAP_DAYS` for clarity.
 */
export const WEBHOOK_INBOX_TTL_DAYS = WEBHOOK_PAYLOAD_REAP_DAYS;
/**
 * Webhook inbox lifecycle states.
 *
 *   received        — row stamped, awaiting processing
 *   processing      — worker has it in flight
 *   succeeded       — order created OR topic ignored (non-order event)
 *   failed          — transient failure; worker will retry per nextRetryAt
 *   needs_attention — order-shaped event we CANNOT process and will not
 *                     retry (e.g. customer phone missing). Surfaces in
 *                     the dashboard so the merchant can fix the
 *                     storefront and trigger a manual replay.
 *                     **Not retried automatically** — that's the whole
 *                     point of carving it out from "failed".
 */
export const WEBHOOK_STATUSES = [
  "received",
  "processing",
  "succeeded",
  "failed",
  "needs_attention",
] as const;
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
    /** Earliest moment the retry worker is allowed to re-process a failed row. */
    nextRetryAt: { type: Date },
    /** Set once `attempts` hits the cap and we give up + alert the merchant. */
    deadLetteredAt: { type: Date },
    /**
     * Why the row was routed to `needs_attention` rather than retried.
     * Set by the adapter normalizer (e.g. `missing_phone`,
     * `missing_external_id`). Surfaces in the merchant-facing inbox so
     * they can correlate the exact reason with their storefront config.
     */
    skipReason: { type: String, trim: true, maxlength: 60 },
    /** Set once an Order has been created/updated as a result. */
    resolvedOrderId: { type: Schema.Types.ObjectId, ref: "Order" },
    receivedAt: { type: Date, default: () => new Date() },
    processedAt: { type: Date },
    /**
     * Payload-reap deadline. Once `now > payloadReapAt` AND the row is
     * `succeeded`, the `webhookRetry` sweeper NULLs the `payload` and
     * `payloadBytes` fields. The row itself stays — its dedup keys are
     * what makes the idempotency window infinite. Defaults to
     * `receivedAt + WEBHOOK_PAYLOAD_REAP_DAYS`.
     *
     * Historical name: `expiresAt`. Renamed for semantic clarity — old
     * versions used this as a Mongo TTL anchor that deleted whole rows.
     */
    payloadReapAt: {
      type: Date,
      default: () =>
        new Date(Date.now() + WEBHOOK_PAYLOAD_REAP_DAYS * 24 * 60 * 60 * 1000),
    },
    /** True once the sweeper has cleared `payload`. Stable signal for ops. */
    payloadReaped: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Idempotency key — we never duplicate-process the same upstream event.
// PERMANENT: there is intentionally NO TTL on this collection. Reaping rows
// re-opens the dedup window — see the schema doc-comment above.
webhookInboxSchema.index(
  { merchantId: 1, provider: 1, externalId: 1 },
  { unique: true },
);
webhookInboxSchema.index({ status: 1, receivedAt: 1 });
// Retry worker pickup — failed rows ready for re-attempt, oldest first.
webhookInboxSchema.index(
  { status: 1, nextRetryAt: 1 },
  { partialFilterExpression: { status: "failed" } },
);
// Merchant inbox view of unresolved-but-not-retryable rows. Partial filter
// keeps the index tiny — most rows succeed cleanly and never enter this set.
webhookInboxSchema.index(
  { merchantId: 1, receivedAt: -1 },
  { partialFilterExpression: { status: "needs_attention" } },
);
// Payload-reap sweeper pickup — succeeded rows whose payload deadline has
// passed, oldest first. Partial filter keeps the index tiny.
webhookInboxSchema.index(
  { payloadReapAt: 1 },
  {
    partialFilterExpression: {
      status: "succeeded",
      payloadReaped: false,
    },
  },
);

export type WebhookInbox = InferSchemaType<typeof webhookInboxSchema> & {
  _id: Types.ObjectId;
};

export const WebhookInbox: Model<WebhookInbox> =
  (models.WebhookInbox as Model<WebhookInbox>) ||
  model<WebhookInbox>("WebhookInbox", webhookInboxSchema);
