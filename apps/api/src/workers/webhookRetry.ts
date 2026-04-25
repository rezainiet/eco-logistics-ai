import type { Job } from "bullmq";
import { WebhookInbox } from "@ecom/db";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import { replayWebhookInbox, WEBHOOK_RETRY_MAX_ATTEMPTS } from "../server/ingest.js";

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

export interface WebhookRetryJobResult {
  picked: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
  skipped: number;
}

export async function sweepWebhookRetryQueue(
  batchSize: number = SWEEP_BATCH,
): Promise<WebhookRetryJobResult> {
  const now = new Date();
  const rows = await WebhookInbox.find({
    status: "failed",
    nextRetryAt: { $lte: now },
    attempts: { $lt: WEBHOOK_RETRY_MAX_ATTEMPTS },
  })
    .sort({ nextRetryAt: 1 })
    .limit(batchSize)
    .select("_id")
    .lean();

  let succeeded = 0;
  let failed = 0;
  let deadLettered = 0;
  let skipped = 0;

  for (const row of rows) {
    const result = await replayWebhookInbox({ inboxId: row._id });
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

  return { picked: rows.length, succeeded, failed, deadLettered, skipped };
}

export function registerWebhookRetryWorker() {
  return registerWorker<unknown, WebhookRetryJobResult>(
    QUEUE_NAMES.webhookRetry,
    async (job: Job<unknown>) => {
      const res = await sweepWebhookRetryQueue();
      if (res.picked > 0) {
        console.log(
          `[webhook-retry] job=${job.id} picked=${res.picked} ok=${res.succeeded} retry=${res.failed} dlq=${res.deadLettered} skipped=${res.skipped}`,
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
