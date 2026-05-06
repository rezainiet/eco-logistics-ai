import type { Job } from "bullmq";
import { Types } from "mongoose";
import { QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import { replayWebhookInbox } from "../server/ingest.js";

/**
 * Webhook processing worker.
 *
 * Consumes `webhook-process` jobs minted by `/api/integrations/webhook/...`.
 * Each job carries an inbox row id; the worker hands it to
 * `replayWebhookInbox` which normalizes the stored payload, runs the ingest
 * pipeline, and updates the row's status (succeeded / failed + nextRetryAt).
 *
 * Why a separate worker from `webhook-retry`:
 *  - `webhook-retry` is a sweep — it wakes every minute and scans the inbox
 *    for failed rows whose `nextRetryAt` has elapsed. Latency is bounded by
 *    the sweep interval, which is fine for retries but not for first delivery.
 *  - `webhook-process` is event-driven — the route enqueues a job the moment
 *    the inbox row is stamped, so first-delivery latency stays sub-second
 *    even under burst.
 *
 * Concurrency is set high so a 10k-event burst drains in parallel; BullMQ's
 * Redis-backed queue is the actual rate limit.
 */

interface WebhookProcessJobData {
  inboxId: string;
}

export interface WebhookProcessJobResult {
  /**
   * Mirrors the inbox row's terminal `status` after `replayWebhookInbox`
   * runs. `needs_attention` covers normalization-skip envelopes
   * (missing phone, etc.) that aren't retryable — the merchant has to
   * fix the storefront before subsequent deliveries succeed.
   */
  status:
    | "succeeded"
    | "failed"
    | "dead_lettered"
    | "skipped"
    | "needs_attention";
  attempts: number;
  duplicate?: boolean;
  orderId?: string;
}

export function registerWebhookProcessWorker() {
  return registerWorker<WebhookProcessJobData, WebhookProcessJobResult>(
    QUEUE_NAMES.webhookProcess,
    async (job: Job<WebhookProcessJobData>) => {
      const { inboxId } = job.data;
      if (!inboxId || !Types.ObjectId.isValid(inboxId)) {
        return { status: "skipped", attempts: 0 };
      }
      const result = await replayWebhookInbox({
        inboxId: new Types.ObjectId(inboxId),
      });
      // Retry policy lives in `webhook-retry` (which respects `nextRetryAt`
      // on the inbox row). We deliberately do NOT throw here on "failed" so
      // BullMQ's own retry doesn't fight the sweep — the row already carries
      // the canonical attempts counter + backoff schedule.
      return {
        status: result.status,
        attempts: result.attempts,
        duplicate: result.duplicate,
        orderId: result.orderId,
      };
    },
    { concurrency: 8 },
  );
}
