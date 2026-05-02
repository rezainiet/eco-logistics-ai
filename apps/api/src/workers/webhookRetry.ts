import type { Job } from "bullmq";
import { WebhookInbox } from "@ecom/db";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import { replayWebhookInbox, WEBHOOK_RETRY_MAX_ATTEMPTS } from "../server/ingest.js";
import { replayCourierInbox, isCourierInboxProvider } from "../server/courier-replay.js";

/** Payload-reap batch — capped per tick so a backlog can't monopolise the worker. */
const PAYLOAD_REAP_BATCH = 500;

/**
 * Webhook retry worker.
 *
 * Runs as a BullMQ repeatable job. Each tick scans `WebhookInbox` for failed
 * rows that are due for a retry (`status: "failed"`, `nextRetryAt <= now`,
 * `attempts < MAX`) and pumps them back through `replayWebhookInbox` —
 * which handles the backoff bookkeeping and dead-letter alert when the cap
 * is hit.
 *
 * Designed to be safe on multi-instance deploys: the row's
 * `(merchantId, provider, externalId)` unique index plus the inbox state
 * machine prevent double-processing if two workers grab the same row in the
 * same tick.
 */

const REPEAT_JOB_NAME = "webhook-retry:sweep";
const SWEEP_BATCH = 50;
const DEFAULT_INTERVAL_MS = 60_000; // 1 minute
/**
 * Rows stamped `received` by the route but not picked up by the
 * `webhook-process` worker within this window are assumed orphaned (worker
 * crash, Redis blip during enqueue) and re-driven by the sweep. Generous
 * enough that a healthy worker drains the queue first.
 */
const ORPHAN_RECEIVED_AGE_MS = 5 * 60_000; // 5 minutes

export interface WebhookRetryJobResult {
  picked: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
  skipped: number;
  /** Number of inbox rows whose `payload` was NULLed this tick. */
  payloadsReaped: number;
}

/**
 * Reap payload bytes on succeeded inbox rows whose `payloadReapAt` has
 * passed. The row itself stays — its dedup keys are what makes the
 * idempotency window infinite. Without this, the collection would grow
 * unbounded with full webhook payloads (Shopify order bodies are 5–50 KB).
 *
 * Idempotent: the partial index restricts pickup to non-reaped rows, and
 * the `$set: { payloadReaped: true }` flag ensures a row is only paid for
 * once even if two workers race the same tick.
 */
export async function reapWebhookPayloads(
  batchSize: number = PAYLOAD_REAP_BATCH,
): Promise<number> {
  const now = new Date();
  const due = await WebhookInbox.find({
    status: "succeeded",
    payloadReaped: false,
    payloadReapAt: { $lte: now },
  })
    .sort({ payloadReapAt: 1 })
    .limit(batchSize)
    .select("_id")
    .lean();
  if (due.length === 0) return 0;
  const res = await WebhookInbox.updateMany(
    { _id: { $in: due.map((r) => r._id) } },
    {
      $set: { payload: null, payloadBytes: 0, payloadReaped: true },
    },
  );
  return res.modifiedCount ?? 0;
}

export async function sweepWebhookRetryQueue(
  batchSize: number = SWEEP_BATCH,
): Promise<WebhookRetryJobResult> {
  const now = new Date();
  const orphanCutoff = new Date(now.getTime() - ORPHAN_RECEIVED_AGE_MS);
  // Pick failed rows whose backoff has elapsed AND `received` rows that look
  // orphaned (route enqueued during a Redis blip, or worker died mid-process).
  // Both states are safe to feed back into `replayWebhookInbox` — succeeded
  // rows short-circuit, and the inbox unique key prevents double-ingest.
  const rows = await WebhookInbox.find({
    $or: [
      {
        status: "failed",
        nextRetryAt: { $lte: now },
        attempts: { $lt: WEBHOOK_RETRY_MAX_ATTEMPTS },
      },
      { status: "received", receivedAt: { $lte: orphanCutoff } },
    ],
  })
    .sort({ receivedAt: 1 })
    .limit(batchSize)
    .select("_id provider")
    .lean();

  let succeeded = 0;
  let failed = 0;
  let deadLettered = 0;
  let skipped = 0;

  for (const row of rows) {
    const result = isCourierInboxProvider(row.provider as string)
      ? await replayCourierInbox({ inboxId: row._id })
      : await replayWebhookInbox({ inboxId: row._id });
    switch (result.status) {
      case "succeeded":
        succeeded += 1;
        break;
      case "dead_lettered":
        deadLettered += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
    }
  }

  // Piggyback the payload reap on the same tick — it shares Redis bandwidth
  // budget with the retry sweep but runs against a different partial index,
  // so it doesn't compete for the same rows. Failure is logged but does not
  // fail the tick: dedup correctness doesn't depend on reap success.
  let payloadsReaped = 0;
  try {
    payloadsReaped = await reapWebhookPayloads();
  } catch (err) {
    console.error("[webhook-retry] payload reap failed", (err as Error).message);
  }

  return {
    picked: rows.length,
    succeeded,
    failed,
    deadLettered,
    skipped,
    payloadsReaped,
  };
}

export function registerWebhookRetryWorker() {
  return registerWorker<unknown, WebhookRetryJobResult>(
    QUEUE_NAMES.webhookRetry,
    async (job: Job<unknown>) => {
      const res = await sweepWebhookRetryQueue();
      if (res.picked > 0 || res.payloadsReaped > 0) {
        console.log(
          `[webhook-retry] job=${job.id} picked=${res.picked} ok=${res.succeeded} retry=${res.failed} dlq=${res.deadLettered} skipped=${res.skipped} reaped=${res.payloadsReaped}`,
        );
      }
      return res;
    },
    { concurrency: 1 },
  );
}

export async function scheduleWebhookRetry(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Promise<void> {
  if (intervalMs <= 0) {
    console.log("[webhook-retry] disabled (intervalMs<=0)");
    return;
  }
  const q = getQueue(QUEUE_NAMES.webhookRetry);
  const repeatables = await q.getRepeatableJobs();
  await Promise.all(
    repeatables
      .filter((r) => r.name === REPEAT_JOB_NAME)
      .map((r) => q.removeRepeatableByKey(r.key)),
  );
  await q.add(
    REPEAT_JOB_NAME,
    {},
    {
      repeat: { every: intervalMs },
      jobId: REPEAT_JOB_NAME,
    },
  );
  console.log(`[webhook-retry] scheduled every ${intervalMs}ms`);
}
