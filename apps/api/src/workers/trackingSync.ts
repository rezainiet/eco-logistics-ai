import type { Job } from "bullmq";
import { Types } from "mongoose";
import { env } from "../env.js";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import { pickOrdersToSync, syncOrderTracking, type SyncResult } from "../server/tracking.js";

const REPEAT_JOB_NAME = "tracking-sync:repeat";

export interface TrackingSyncJobData {
  batchSize?: number;
  maxAgeMin?: number;
}

export interface TrackingSyncJobResult {
  picked: number;
  synced: number;
  statusChanges: number;
  errors: number;
}

async function processBatch(data: TrackingSyncJobData): Promise<TrackingSyncJobResult> {
  const batchSize = data.batchSize ?? env.TRACKING_SYNC_BATCH;
  const maxAgeMs = (data.maxAgeMin ?? env.TRACKING_SYNC_INTERVAL_MIN) * 60_000;
  const orders = await pickOrdersToSync(batchSize, maxAgeMs);
  if (orders.length === 0) {
    return { picked: 0, synced: 0, statusChanges: 0, errors: 0 };
  }

  const results: SyncResult[] = [];
  // Small concurrency window — couriers rate-limit us, so fan out in chunks
  // instead of hammering all N tracking numbers in one go.
  const CONCURRENCY = 4;
  for (let i = 0; i < orders.length; i += CONCURRENCY) {
    const slice = orders.slice(i, i + CONCURRENCY);
    const batch = await Promise.all(
      slice.map((o) =>
        syncOrderTracking({
          _id: o._id as Types.ObjectId,
          merchantId: o.merchantId as Types.ObjectId,
          order: o.order as never,
          logistics: o.logistics as never,
        }).catch((err: Error) => ({ orderId: String(o._id), error: err.message }) as SyncResult),
      ),
    );
    results.push(...batch);
  }

  return {
    picked: orders.length,
    synced: results.filter((r) => !r.skipped && !r.error).length,
    statusChanges: results.filter((r) => r.statusTransition).length,
    errors: results.filter((r) => r.error).length,
  };
}

export function registerTrackingSyncWorker() {
  return registerWorker<TrackingSyncJobData, TrackingSyncJobResult>(
    QUEUE_NAMES.tracking,
    async (job: Job<TrackingSyncJobData>) => {
      const res = await processBatch(job.data ?? {});
      if (res.statusChanges > 0 || res.errors > 0) {
        console.log(
          `[tracking-sync] job=${job.id} picked=${res.picked} synced=${res.synced} changes=${res.statusChanges} errors=${res.errors}`,
        );
      }
      return res;
    },
    { concurrency: 1 },
  );
}

/**
 * Register a BullMQ repeatable job so the worker runs every N minutes. Idempotent
 * — re-registering with the same key replaces the schedule.
 */
export async function scheduleTrackingSync(): Promise<void> {
  if (env.TRACKING_SYNC_INTERVAL_MIN <= 0) {
    console.log("[tracking-sync] disabled (TRACKING_SYNC_INTERVAL_MIN=0)");
    return;
  }
  const q = getQueue(QUEUE_NAMES.tracking);
  // Remove any older repeatable schedules (e.g. after a cadence change on deploy).
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
      repeat: { every: env.TRACKING_SYNC_INTERVAL_MIN * 60_000 },
      jobId: REPEAT_JOB_NAME,
    },
  );
  console.log(
    `[tracking-sync] scheduled every ${env.TRACKING_SYNC_INTERVAL_MIN}m (batch=${env.TRACKING_SYNC_BATCH})`,
  );
}
