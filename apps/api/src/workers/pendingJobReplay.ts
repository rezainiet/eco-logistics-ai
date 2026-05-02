import type { Job } from "bullmq";
import { Types } from "mongoose";
import {
  MAX_REPLAY_ATTEMPTS,
  PendingJob,
  type PendingJob as PendingJobDoc,
} from "@ecom/db";
import { getQueue, QUEUE_NAMES, registerWorker, type QueueName } from "../lib/queue.js";

/**
 * Dead-letter replay sweeper.
 *
 * Runs as a BullMQ repeatable job. Each tick claims a small batch of
 * `pending` PendingJob rows whose `nextAttemptAt` has passed, tries to
 * push them onto their original BullMQ queue, and either deletes the row
 * on success or applies exponential backoff on failure.
 *
 * Multi-instance safety: each row is claimed via `findOneAndUpdate` with
 * a `nextAttemptAt < now` filter and a forward-bumped `nextAttemptAt` so
 * a sibling sweeper sees a future deadline and skips. The increment of
 * `attempts` IS the claim; even if the subsequent enqueue / replay
 * crashes, the row has been pushed forward and won't loop in the same
 * tick.
 *
 * Failure modes:
 *   - queue.add throws AGAIN → bump attempts, schedule next attempt with
 *     exponential backoff (1m, 5m, 15m, 60m, 4h).
 *   - attempts hit MAX_REPLAY_ATTEMPTS → status flips to "exhausted",
 *     critical merchant alert fires (best effort).
 */

const REPEAT_JOB_NAME = "pending-job-replay:sweep";
const SWEEP_BATCH = 50;
const DEFAULT_INTERVAL_MS = 30_000; // 30 seconds

const BACKOFF_BY_ATTEMPT_MS: ReadonlyArray<number> = [
  60_000,        // attempt 1 → 1 min
  5 * 60_000,    // attempt 2 → 5 min
  15 * 60_000,   // attempt 3 → 15 min
  60 * 60_000,   // attempt 4 → 1 h
  4 * 60 * 60_000, // attempt 5 → 4 h
];

function nextDeadline(attemptsAfterIncrement: number): Date {
  const idx = Math.min(attemptsAfterIncrement - 1, BACKOFF_BY_ATTEMPT_MS.length - 1);
  return new Date(Date.now() + BACKOFF_BY_ATTEMPT_MS[idx]!);
}

export interface PendingJobReplayResult {
  picked: number;
  replayed: number;
  reFailed: number;
  exhausted: number;
}

/**
 * Single sweep — exported for ad-hoc invocation (admin replay button,
 * tests).
 */
export async function sweepPendingJobs(
  batchSize: number = SWEEP_BATCH,
): Promise<PendingJobReplayResult> {
  const result: PendingJobReplayResult = {
    picked: 0,
    replayed: 0,
    reFailed: 0,
    exhausted: 0,
  };

  // Claim batch atomically — each `findOneAndUpdate` advances nextAttemptAt
  // past the moment we care about so concurrent sweepers don't re-pick the
  // same row inside this tick. The row stays "pending" so the next tick
  // (after the real backoff) can still see it if we fail.
  const claimed: PendingJobDoc[] = [];
  for (let i = 0; i < batchSize; i++) {
    const claim = (await PendingJob.findOneAndUpdate(
      {
        status: "pending",
        nextAttemptAt: { $lte: new Date() },
      },
      // Push the row into the future briefly so the next pass during
      // this tick won't re-pick it. The actual backoff is applied below
      // once we know the outcome.
      { $set: { nextAttemptAt: new Date(Date.now() + 60_000) } },
      { new: true, sort: { nextAttemptAt: 1 } },
    ).lean()) as PendingJobDoc | null;
    if (!claim) break;
    claimed.push(claim);
  }
  result.picked = claimed.length;

  for (const row of claimed) {
    const attemptN = (row.attempts ?? 0) + 1;
    try {
      const queue = getQueue(row.queueName as QueueName);
      const job = await queue.add(
        row.jobName,
        row.data,
        (row.jobOpts as Record<string, unknown>) ?? {},
      );
      await PendingJob.deleteOne({ _id: row._id });
      console.log(
        JSON.stringify({
          evt: "queue.dead_letter_replayed",
          queue: row.queueName,
          job: row.jobName,
          pendingJobId: String(row._id),
          jobId: job?.id,
          attempt: attemptN,
        }),
      );
      bumpReplayedCounter(row.queueName as QueueName);
      result.replayed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isExhausted = attemptN >= MAX_REPLAY_ATTEMPTS;
      const update: Record<string, unknown> = {
        $set: {
          attempts: attemptN,
          lastError: message.slice(0, 1000),
          status: isExhausted ? "exhausted" : "pending",
          nextAttemptAt: isExhausted
            ? new Date(Date.now() + 365 * 24 * 60 * 60_000)
            : nextDeadline(attemptN),
        },
      };
      await PendingJob.updateOne({ _id: row._id }, update);
      if (isExhausted) {
        result.exhausted++;
        bumpExhaustedCounter(row.queueName as QueueName);
        await emitExhaustedAlert(row).catch((nErr) =>
          console.error(
            "[pending-job-replay] exhaust alert failed:",
            (nErr as Error).message,
          ),
        );
        console.error(
          JSON.stringify({
            evt: "queue.dead_letter_exhausted",
            queue: row.queueName,
            job: row.jobName,
            pendingJobId: String(row._id),
            attempts: attemptN,
            error: message,
          }),
        );
      } else {
        result.reFailed++;
        console.warn(
          JSON.stringify({
            evt: "queue.dead_letter_replay_failed",
            queue: row.queueName,
            job: row.jobName,
            pendingJobId: String(row._id),
            attempt: attemptN,
            error: message,
          }),
        );
      }
    }
  }

  return result;
}

async function emitExhaustedAlert(row: PendingJobDoc): Promise<void> {
  const ctx = (row.ctx as { merchantId?: string; description?: string } | null) ?? null;
  if (!ctx?.merchantId) return;
  const { dispatchNotification } = await import("../lib/notifications.js");
  await dispatchNotification({
    merchantId: new Types.ObjectId(ctx.merchantId),
    kind: "queue.enqueue_failed",
    severity: "critical",
    title: "Background job permanently failed",
    body: `${
      ctx.description ?? row.jobName
    } could not be queued after ${MAX_REPLAY_ATTEMPTS} attempts. Operations has been notified — please retry the action manually.`,
    dedupeKey: `pending_job_exhausted:${row.queueName}:${ctx.merchantId}:${String(row._id)}`,
  });
}

/* ------------------------------------------------------------------------ */
/* Counter integration — pulls the same _counters table queue.ts maintains. */
/* We import lazily (with a runtime no-op fallback) so this worker module    */
/* doesn't pull queue.ts into a circular import on first load.               */
/* ------------------------------------------------------------------------ */

function bumpReplayedCounter(queueName: QueueName): void {
  void import("../lib/queue.js").then((mod) => {
    // Only present in the hardened build; older callers see a missing fn.
    (mod as unknown as { __bumpReplayed?: (q: QueueName) => void }).__bumpReplayed?.(
      queueName,
    );
  });
}
function bumpExhaustedCounter(queueName: QueueName): void {
  void import("../lib/queue.js").then((mod) => {
    (mod as unknown as { __bumpExhausted?: (q: QueueName) => void }).__bumpExhausted?.(
      queueName,
    );
  });
}

/* ------------------------------------------------------------------------ */
/* Worker registration                                                       */
/* ------------------------------------------------------------------------ */

export function startPendingJobReplayWorker() {
  const worker = registerWorker<unknown, PendingJobReplayResult>(
    QUEUE_NAMES.pendingJobReplay,
    async (_job: Job) => sweepPendingJobs(),
    { concurrency: 1 },
  );
  return worker;
}

export async function ensureRepeatableSweep(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.pendingJobReplay);
  await queue.add(
    REPEAT_JOB_NAME,
    {},
    {
      repeat: { every: intervalMs },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    },
  );
}

export const __TEST = {
  REPEAT_JOB_NAME,
  DEFAULT_INTERVAL_MS,
  SWEEP_BATCH,
  BACKOFF_BY_ATTEMPT_MS,
  nextDeadline,
};
