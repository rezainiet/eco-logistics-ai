import type { Job } from "bullmq";
import { Order, PendingAwb } from "@ecom/db";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import { writeAudit } from "../lib/audit.js";

/**
 * Pending-AWB reconciler.
 *
 * Sweeps `PendingAwb` rows that are stuck in `pending` state past the
 * stale-lock threshold (process crashed between upstream call and DB
 * write, network blip mid-write, etc). For each stale row we read the
 * current Order:
 *
 *   - Order has `trackingNumber`         → flip ledger to `succeeded`,
 *                                          release lock if still held.
 *                                          (Some other path completed
 *                                          the booking; ledger is just
 *                                          catching up.)
 *
 *   - Order has no tracking, lock is set → release lock + flip ledger
 *                                          to `abandoned` after enough
 *                                          probe attempts. The
 *                                          merchant can re-book and
 *                                          will get a new attempt
 *                                          number → new idempotency
 *                                          key. If the courier
 *                                          honoured the previous key,
 *                                          a duplicate AWB is
 *                                          impossible. If not, the
 *                                          ledger row sits as
 *                                          `abandoned` for ops to
 *                                          inspect.
 *
 *   - Order missing                      → mark ledger `orphaned`
 *                                          (deleted order, AWB may
 *                                          exist upstream). Best left
 *                                          for ops.
 *
 * NOT in this iteration: per-courier "look up by external ref" probes.
 * Those need vendor-specific endpoints and a follow-up PR. Today the
 * reconciler is conservative — it only flips ledger states it can
 * verify from our own DB, and never assumes whether the courier
 * actually created the AWB. That's why `abandoned` exists separately
 * from `succeeded`.
 */

/** A row this old without a terminal status is considered stuck. */
const STALE_PENDING_MS = 90_000; // 90s — generous over the typical adapter timeout
/** Per-row budget — after this many sweeps without resolution, mark abandoned. */
const MAX_RECONCILE_ATTEMPTS = 5;
const SWEEP_BATCH = 100;
const REPEAT_JOB_NAME = "awb-reconcile:sweep";
const DEFAULT_INTERVAL_MS = 60_000;

export interface AwbReconcileJobResult {
  picked: number;
  succeeded: number;
  abandoned: number;
  orphaned: number;
  skipped: number;
}

export async function sweepPendingAwbs(
  batchSize: number = SWEEP_BATCH,
): Promise<AwbReconcileJobResult> {
  const cutoff = new Date(Date.now() - STALE_PENDING_MS);
  const rows = await PendingAwb.find({
    status: "pending",
    requestedAt: { $lte: cutoff },
  })
    .sort({ requestedAt: 1 })
    .limit(batchSize)
    .lean();

  let succeeded = 0;
  let abandoned = 0;
  let orphaned = 0;
  let skipped = 0;

  for (const row of rows) {
    const order = await Order.findOne({ _id: row.orderId, merchantId: row.merchantId })
      .select("logistics.trackingNumber logistics.bookingInFlight")
      .lean();

    if (!order) {
      // Order no longer exists. AWB may live at the courier but we have
      // nowhere to bind it to.
      await PendingAwb.updateOne(
        { _id: row._id },
        {
          $set: {
            status: "orphaned",
            lastError: "order deleted before reconcile",
            completedAt: new Date(),
            reconciledAt: new Date(),
          },
          $inc: { reconcileAttempts: 1 },
        },
      );
      void writeAudit({
        merchantId: row.merchantId,
        actorId: row.merchantId,
        actorType: "system",
        action: "awb.reconcile.orphaned",
        subjectType: "pending_awb",
        subjectId: row._id,
        meta: { courier: row.courier, attempt: row.attempt },
      });
      orphaned += 1;
      continue;
    }

    if (order.logistics?.trackingNumber) {
      // Some other path completed the booking (e.g. the original
      // attempt's success-path Order.updateOne landed but the ledger
      // update lost the race). Catch the ledger up.
      await PendingAwb.updateOne(
        { _id: row._id },
        {
          $set: {
            status: "succeeded",
            trackingNumber: order.logistics.trackingNumber,
            completedAt: new Date(),
            reconciledAt: new Date(),
          },
          $inc: { reconcileAttempts: 1 },
        },
      );
      // Make sure the lock is released too, even if the original
      // success path missed it.
      if (order.logistics.bookingInFlight) {
        await Order.updateOne(
          { _id: row.orderId, merchantId: row.merchantId },
          { $set: { "logistics.bookingInFlight": false } },
        );
      }
      succeeded += 1;
      continue;
    }

    // No tracking number, lock may or may not be held. Increment the
    // probe counter; abandon after the budget.
    const nextAttempts = (row.reconcileAttempts ?? 0) + 1;
    if (nextAttempts >= MAX_RECONCILE_ATTEMPTS) {
      await PendingAwb.updateOne(
        { _id: row._id },
        {
          $set: {
            status: "abandoned",
            lastError:
              "reconcile budget exhausted — no tracking number on order; AWB status at courier unknown",
            completedAt: new Date(),
            reconciledAt: new Date(),
          },
          $inc: { reconcileAttempts: 1 },
        },
      );
      // Always release the lock when abandoning so the merchant can
      // try again. The next attempt gets a fresh attempt counter and
      // a fresh idempotency key.
      await Order.updateOne(
        { _id: row.orderId, merchantId: row.merchantId },
        {
          $set: { "logistics.bookingInFlight": false },
        },
      );
      void writeAudit({
        merchantId: row.merchantId,
        actorId: row.merchantId,
        actorType: "system",
        action: "awb.reconcile.abandoned",
        subjectType: "pending_awb",
        subjectId: row._id,
        meta: { courier: row.courier, attempt: row.attempt },
      });
      abandoned += 1;
      continue;
    }

    // Still within budget — bump the counter and try again next sweep.
    await PendingAwb.updateOne(
      { _id: row._id },
      {
        $inc: { reconcileAttempts: 1 },
        $set: { reconciledAt: new Date() },
      },
    );
    skipped += 1;
  }

  return { picked: rows.length, succeeded, abandoned, orphaned, skipped };
}

export function registerAwbReconcileWorker() {
  return registerWorker<unknown, AwbReconcileJobResult>(
    QUEUE_NAMES.awbReconcile,
    async (job: Job<unknown>) => {
      const res = await sweepPendingAwbs();
      if (res.picked > 0) {
        console.log(
          `[awb-reconcile] job=${job.id} picked=${res.picked} ok=${res.succeeded} abandoned=${res.abandoned} orphan=${res.orphaned} skip=${res.skipped}`,
        );
      }
      return res;
    },
    { concurrency: 1 },
  );
}

export async function scheduleAwbReconcile(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Promise<void> {
  if (intervalMs <= 0) {
    console.log("[awb-reconcile] disabled (intervalMs<=0)");
    return;
  }
  const q = getQueue(QUEUE_NAMES.awbReconcile);
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
  console.log(`[awb-reconcile] scheduled every ${intervalMs}ms`);
}
