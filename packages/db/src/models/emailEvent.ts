import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Resend webhook ingestion ledger.
 *
 * Every event Resend POSTs (delivered / bounced / complained / delayed /
 * sent / opened / clicked) lands here verbatim. The collection is the
 * forensic record behind every suppression and the operational dataset
 * for "where did this email actually end up" diagnostics.
 *
 * Idempotency: `eventId` is the Svix `svix-id` header value. Unique
 * index — a webhook retry collapses to a duplicate-key error and the
 * handler returns 200 immediately without re-processing.
 *
 * Storage bound: TTL on `createdAt` (90 days). Long enough to cover
 * Gmail's 30-day complaint feedback window plus an investigation
 * buffer; short enough to keep the collection bounded without
 * archive tooling. The companion `EmailSuppression` collection is
 * TTL-free — derived state from events SHOULD outlive the raw events.
 *
 * Cross-reference: the `tag` field is the same tag the sender passes
 * via `EmailMessage.tag` (e.g. "verify_email", "password_reset"). Lets
 * us join "Stripe webhook fired payment_approved at T" with
 * "Resend bounced at T+30s" without an external correlation system.
 */

/**
 * Resend event types we model explicitly. The catch-all "other" leaf
 * exists so a new Resend event type (e.g. opened-with-bot-filter) is
 * ingested cleanly instead of crashing the handler — we'd rather
 * silently capture and revisit than refuse the webhook.
 */
export const EMAIL_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
  "email.failed",
  "other",
] as const;
export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number];

const emailEventSchema = new Schema(
  {
    /** Svix `svix-id` header — globally unique per delivery. */
    eventId: { type: String, required: true, trim: true, maxlength: 120 },
    /** Resend event `type` field (e.g. "email.bounced"). */
    type: { type: String, required: true, trim: true, maxlength: 60 },
    /**
     * Recipient address, lowercased + trimmed for join with
     * `EmailSuppression.address`. Resend can deliver to multiple
     * recipients but we only ever post to one in `sendEmail()`, so
     * `to` is always the single string here.
     */
    to: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    /** Pre-render subject line (truncated). Forensic-only. */
    subject: { type: String, trim: true, maxlength: 200 },
    /**
     * Our `EmailMessage.tag` round-tripped through Resend's `tags`
     * array. Identifies the flow (verify_email, password_reset,
     * admin_alert_<kind>, …).
     */
    tag: { type: String, trim: true, maxlength: 80 },
    /**
     * Our `enqueueEmail` correlationId, when carried through Resend
     * tags. Best-effort: present for flows where the worker passes
     * the cid as a tag, absent otherwise.
     */
    correlationId: { type: String, trim: true, maxlength: 200 },
    /** Resend's own message id (`email_id` in their payload). */
    providerId: { type: String, trim: true, maxlength: 120 },
    /** "hard" or "soft" — only set on `email.bounced`. */
    bounceType: { type: String, trim: true, maxlength: 20 },
    /** Bounce diagnostic text from Resend / upstream SMTP, truncated. */
    bounceMessage: { type: String, trim: true, maxlength: 500 },
    /** Full Resend payload (already JSON-parsed). Kept for forensics. */
    payload: { type: Schema.Types.Mixed },
    receivedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

// Idempotency boundary — duplicate-key error on retry, handler returns 200.
emailEventSchema.index({ eventId: 1 }, { unique: true });
// Per-recipient history — "show me every event for ma***@gmail.com last 30d".
emailEventSchema.index({ to: 1, receivedAt: -1 });
// Ops dashboard — "show every bounce in last 24h".
emailEventSchema.index({ type: 1, receivedAt: -1 });
// Cross-system trace — link an event back to the enqueueEmail call.
emailEventSchema.index({ correlationId: 1 }, { sparse: true });
// TTL: 90 days. `createdAt` is auto-stamped by timestamps:true.
emailEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export type EmailEvent = InferSchemaType<typeof emailEventSchema> & {
  _id: Types.ObjectId;
};

export const EmailEvent: Model<EmailEvent> =
  (models.EmailEvent as Model<EmailEvent>) ||
  model<EmailEvent>("EmailEvent", emailEventSchema);
