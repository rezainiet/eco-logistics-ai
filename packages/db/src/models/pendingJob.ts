import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Dead-letter persistence for `safeEnqueue`.
 *
 * When Redis is unreachable (or BullMQ throws for any other reason), we
 * cannot afford to lose the work — the auto-book / SMS / webhook-process
 * pipelines depend on every accepted job eventually running. Rather than
 * relying on the caller to react to an `ok: false` return (the audit
 * showed `void safeEnqueue(...)` in production code), we persist the job
 * description here and let a sweeper replay it once Redis recovers.
 *
 * The sweeper (`workers/pendingJobReplay.ts`) wakes every 30s, claims
 * `pending` rows whose `nextAttemptAt` has passed, and tries `queue.add`
 * again. Successes delete the row; failures bump `attempts` and back off
 * exponentially. After `MAX_REPLAY_ATTEMPTS` attempts the row flips to
 * `exhausted` and an admin alert fires.
 */

export const PENDING_JOB_STATUSES = ["pending", "exhausted"] as const;
export type PendingJobStatus = (typeof PENDING_JOB_STATUSES)[number];

export const MAX_REPLAY_ATTEMPTS = 5;

const pendingJobSchema = new Schema(
  {
    /** Logical BullMQ queue name (e.g. "automation-book"). */
    queueName: { type: String, required: true, trim: true, maxlength: 60, index: true },
    /** BullMQ job name (the "step" inside the queue). */
    jobName: { type: String, required: true, trim: true, maxlength: 80 },
    /** Raw job payload — must already be JSON-serializable; BullMQ requires that anyway. */
    data: { type: Schema.Types.Mixed, required: true },
    /** BullMQ JobsOptions — backoff, attempts, jobId, delay, etc. */
    jobOpts: { type: Schema.Types.Mixed },
    /** SafeEnqueueContext snapshot (merchantId, orderId, description) so the sweeper can re-emit alerts on exhaustion. */
    ctx: { type: Schema.Types.Mixed },
    /**
     * Sweeper state machine:
     *   pending    — eligible for replay once nextAttemptAt passes.
     *   exhausted  — attempted MAX_REPLAY_ATTEMPTS times with no success;
     *                kept for forensics + manual replay. Admin alert fired
     *                on the transition.
     */
    status: {
      type: String,
      enum: PENDING_JOB_STATUSES,
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String, trim: true, maxlength: 1000 },
    /**
     * Earliest moment the sweeper will retry. Initial value is shortly
     * after the failed enqueue (30s) so a flapping Redis recovery picks
     * the job up quickly. Later attempts back off exponentially.
     */
    nextAttemptAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 30_000),
    },
    /**
     * Stamp set when the row finally lands on the queue (on a successful
     * replay). We delete the row right after on success — the field exists
     * for the brief window between mark + delete so a crashed sweeper
     * doesn't double-replay.
     */
    replayedAt: { type: Date },
  },
  { timestamps: true },
);

/**
 * Sweeper pickup: oldest-first scan of `pending` rows due for retry. The
 * partial filter keeps the index scoped — exhausted rows never appear in
 * the picker's working set.
 */
pendingJobSchema.index(
  { nextAttemptAt: 1 },
  { partialFilterExpression: { status: "pending" } },
);
pendingJobSchema.index({ queueName: 1, status: 1, createdAt: -1 });

export type PendingJob = InferSchemaType<typeof pendingJobSchema> & {
  _id: Types.ObjectId;
};

export const PendingJob: Model<PendingJob> =
  (models.PendingJob as Model<PendingJob>) ||
  model<PendingJob>("PendingJob", pendingJobSchema);
