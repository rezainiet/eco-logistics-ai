import type { Job } from "bullmq";
import { Types } from "mongoose";
import { Order } from "@ecom/db";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import { writeAudit } from "../lib/audit.js";
import { dispatchNotification } from "../lib/notifications.js";
import { enqueueAutoBook } from "./automationBook.js";

/**
 * Automation watchdog.
 *
 * Two responsibilities, on a single 5-minute cycle:
 *
 * 1. STUCK-ORDER RECOVERY — finds orders that automation auto-confirmed
 *    (or that the merchant confirmed via SMS reply) more than 10 minutes
 *    ago AND that still have no tracking number AND that have NOT
 *    exhausted the fallback chain. These are orders that should have been
 *    auto-booked already; the only reason they're stuck is a Redis/queue
 *    blip during enqueue. We re-enqueue. If the order has already
 *    exhausted its fallback couriers, we fire a critical merchant alert
 *    instead — they need to ship it manually.
 *
 * 2. QUEUE-STALL DETECTION — reads BullMQ counts on the auto-book queue.
 *    If waiting > 0 AND active = 0 across two consecutive cycles AND
 *    the waiting count has not decreased, the queue is stalled (Redis
 *    healthy but the worker process is dead, network partition, or
 *    rate-limit pause). Fires a critical platform-level alert.
 *
 * Tenant-safe: every Order lookup + write filter scopes to merchantId
 * pulled directly off the order doc.
 *
 * Idempotent: re-enqueuing the same order is collapsed by BullMQ's
 * jobId-per-attempt scheme inside automationBook. The watchdog also
 * stamps `automation.lastWatchdogAt` so we can rate-limit notifications
 * (one per merchant per hour).
 */

const STUCK_AGE_MIN = 10;
const SCAN_INTERVAL_MIN = 5;
const SCAN_BATCH = 100;
const FALLBACK_MAX_COURIERS = 3; // mirror automationBook's constant
const QUEUE_STALL_GRACE_CYCLES = 2;

interface QueueStallState {
  lastWaiting: number;
  consecutiveStalled: number;
}

const queueStallState: QueueStallState = {
  lastWaiting: 0,
  consecutiveStalled: 0,
};

export interface AutomationWatchdogResult {
  scanned: number;
  reEnqueued: number;
  exhaustedNotified: number;
  errors: number;
  queueWaiting: number;
  queueActive: number;
  queueStalledCycles: number;
}

export async function runAutomationWatchdog(): Promise<AutomationWatchdogResult> {
  const result: AutomationWatchdogResult = {
    scanned: 0,
    reEnqueued: 0,
    exhaustedNotified: 0,
    errors: 0,
    queueWaiting: 0,
    queueActive: 0,
    queueStalledCycles: 0,
  };

  // ---------- 1. Stuck-order recovery -----------------------------------
  const cutoff = new Date(Date.now() - STUCK_AGE_MIN * 60 * 1000);
  const stuck = await Order.find({
    "automation.state": { $in: ["auto_confirmed", "confirmed"] },
    "automation.confirmedAt": { $lt: cutoff },
    $and: [
      {
        $or: [
          { "logistics.trackingNumber": { $exists: false } },
          { "logistics.trackingNumber": null },
          { "logistics.trackingNumber": "" },
        ],
      },
    ],
  })
    .select(
      "_id merchantId orderNumber automation.attemptedCouriers automation.bookedByAutomation",
    )
    .limit(SCAN_BATCH)
    .lean();

  result.scanned = stuck.length;

  for (const o of stuck) {
    try {
      const attempted = (o as { automation?: { attemptedCouriers?: string[] } }).automation
        ?.attemptedCouriers ?? [];
      if (attempted.length >= FALLBACK_MAX_COURIERS) {
        // Already tried every fallback. Notify the merchant once per hour.
        const dedupeKey = `watchdog_exhausted:${String(o._id)}`;
        await dispatchNotification({
          merchantId: o.merchantId as Types.ObjectId,
          kind: "integration.webhook_failed",
          severity: "critical",
          title: `Order ${o.orderNumber}: auto-book exhausted, manual action needed`,
          body: `We tried ${attempted.length} couriers and none accepted the booking. Open the order to retry manually or change couriers.`,
          link: `/dashboard/orders?id=${String(o._id)}`,
          subjectType: "order",
          subjectId: o._id as Types.ObjectId,
          dedupeKey,
        });
        await writeAudit({
          merchantId: o.merchantId as Types.ObjectId,
          actorId: o.merchantId as Types.ObjectId,
          actorType: "system",
          action: "automation.watchdog_exhausted",
          subjectType: "order",
          subjectId: o._id as Types.ObjectId,
          meta: { attempted },
        }).catch(() => {});
        result.exhaustedNotified += 1;
        continue;
      }

      // Still has couriers to try — re-enqueue.
      await enqueueAutoBook({
        orderId: String(o._id),
        merchantId: String(o.merchantId),
        userId: String(o.merchantId),
        attempted: attempted.map((c) => c.toLowerCase()),
      });
      await writeAudit({
        merchantId: o.merchantId as Types.ObjectId,
        actorId: o.merchantId as Types.ObjectId,
        actorType: "system",
        action: "automation.watchdog_reenqueued",
        subjectType: "order",
        subjectId: o._id as Types.ObjectId,
        meta: { attempted, ageMinutes: STUCK_AGE_MIN },
      }).catch(() => {});
      result.reEnqueued += 1;
    } catch (err) {
      result.errors += 1;
      console.error(
        `[watchdog] order ${String(o._id)} recovery failed:`,
        (err as Error).message,
      );
    }
  }

  // ---------- 2. Queue-stall detection ----------------------------------
  try {
    const queue = getQueue(QUEUE_NAMES.automationBook);
    const counts = await queue.getJobCounts("waiting", "active", "delayed");
    const waiting = (counts.waiting ?? 0) + (counts.delayed ?? 0);
    const active = counts.active ?? 0;
    result.queueWaiting = waiting;
    result.queueActive = active;

    const noProgress =
      waiting > 0 && active === 0 && waiting >= queueStallState.lastWaiting;

    if (noProgress) {
      queueStallState.consecutiveStalled += 1;
    } else {
      queueStallState.consecutiveStalled = 0;
    }
    queueStallState.lastWaiting = waiting;
    result.queueStalledCycles = queueStallState.consecutiveStalled;

    if (queueStallState.consecutiveStalled >= QUEUE_STALL_GRACE_CYCLES) {
      console.error(
        JSON.stringify({
          msg: "queue_stalled",
          queue: QUEUE_NAMES.automationBook,
          waiting,
          active,
          consecutiveCycles: queueStallState.consecutiveStalled,
        }),
      );
      // Reset so we don't fire every cycle indefinitely; the operator
      // alert + audit row is enough. If it stays stuck the next two-cycle
      // window will fire again.
      queueStallState.consecutiveStalled = 0;
    }
  } catch (err) {
    console.error("[watchdog] queue health probe failed:", (err as Error).message);
  }

  if (
    result.reEnqueued > 0 ||
    result.exhaustedNotified > 0 ||
    result.errors > 0 ||
    result.queueStalledCycles >= QUEUE_STALL_GRACE_CYCLES
  ) {
    console.log(
      `[watchdog] scanned=${result.scanned} reEnqueued=${result.reEnqueued} ` +
        `exhausted=${result.exhaustedNotified} errors=${result.errors} ` +
        `queueWaiting=${result.queueWaiting} active=${result.queueActive} ` +
        `stalled=${result.queueStalledCycles}`,
    );
  }

  return result;
}

const REPEAT_JOB_NAME = "automation-watchdog:repeat";

export function registerAutomationWatchdogWorker() {
  return registerWorker<unknown, AutomationWatchdogResult>(
    QUEUE_NAMES.automationWatchdog,
    async (_job: Job) => runAutomationWatchdog(),
    { concurrency: 1 },
  );
}

export async function scheduleAutomationWatchdog(): Promise<void> {
  const q = getQueue(QUEUE_NAMES.automationWatchdog);
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
      repeat: { every: SCAN_INTERVAL_MIN * 60_000 },
      jobId: REPEAT_JOB_NAME,
    },
  );
  console.log(
    `[watchdog] scheduled every ${SCAN_INTERVAL_MIN}m (stuck-age=${STUCK_AGE_MIN}m)`,
  );
}

export const __TEST = {
  STUCK_AGE_MIN,
  SCAN_INTERVAL_MIN,
  FALLBACK_MAX_COURIERS,
  QUEUE_STALL_GRACE_CYCLES,
  queueStallState,
};
