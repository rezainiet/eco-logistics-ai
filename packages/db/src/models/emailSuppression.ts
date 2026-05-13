import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Persistent suppression list — addresses we will never send to again.
 *
 * Populated by the Resend webhook handler on:
 *   - `email.bounced` with `bounce.type === "hard"` — mailbox does not
 *     exist or the domain has rejected us permanently. Re-sending damages
 *     the sender's reputation.
 *   - `email.complained` — recipient marked our mail as spam at the
 *     mailbox-provider level. Continued sends accelerate reputation
 *     decay and can trigger account-level enforcement at Gmail/Yahoo.
 *
 * Explicitly NOT suppressed:
 *   - Soft bounces — transient (mailbox full, greylist, temp DNS).
 *     Resend's own retry logic handles these; we log the event but
 *     keep the address active.
 *   - Delays (`email.delivery_delayed`) — informational.
 *
 * Storage lifecycle: NO TTL. A suppression is a durable fact about
 * the recipient, not a snapshot. Removal is an explicit admin action
 * (e.g. user confirms they fixed their inbox + asks to re-enroll). The
 * companion `EmailEvent` collection has a 90-day TTL so the raw
 * forensic record decays even while the suppression survives.
 *
 * Lookup: every `sendEmail()` call does a single indexed lookup by
 * `address`. Volume is far below the threshold where a Redis cache
 * would matter — postponed until traffic warrants it.
 */

export const EMAIL_SUPPRESSION_REASONS = ["bounce_hard", "complaint"] as const;
export type EmailSuppressionReason = (typeof EMAIL_SUPPRESSION_REASONS)[number];

const emailSuppressionSchema = new Schema(
  {
    /**
     * Lowercased + trimmed recipient address. Unique — a single row
     * per suppressed address regardless of which flow or how many
     * times we've seen the signal.
     */
    address: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 200,
    },
    reason: {
      type: String,
      enum: EMAIL_SUPPRESSION_REASONS,
      required: true,
    },
    /** First Svix event id that caused this suppression. */
    eventId: { type: String, required: true, trim: true, maxlength: 120 },
    /** "hard" / "soft" — copy of `EmailEvent.bounceType` for the triggering event. */
    bounceType: { type: String, trim: true, maxlength: 20 },
    /** Truncated diagnostic text — useful for "why am I suppressed" UI. */
    diagnostic: { type: String, trim: true, maxlength: 500 },
    /**
     * Snapshot of the payload that triggered the FIRST suppression.
     * Later upserts only bump `count` + `lastSeenAt`; the original
     * forensic snapshot is preserved.
     */
    payload: { type: Schema.Types.Mixed },
    firstSeenAt: { type: Date, default: () => new Date() },
    lastSeenAt: { type: Date, default: () => new Date() },
    /** Number of times we've seen a suppression-worthy event for this address. */
    count: { type: Number, default: 1, min: 1 },
  },
  { timestamps: true },
);

emailSuppressionSchema.index({ address: 1 }, { unique: true });
// Ops query: "show me the latest 100 complaints".
emailSuppressionSchema.index({ reason: 1, lastSeenAt: -1 });

export type EmailSuppression = InferSchemaType<typeof emailSuppressionSchema> & {
  _id: Types.ObjectId;
};

export const EmailSuppression: Model<EmailSuppression> =
  (models.EmailSuppression as Model<EmailSuppression>) ||
  model<EmailSuppression>("EmailSuppression", emailSuppressionSchema);
