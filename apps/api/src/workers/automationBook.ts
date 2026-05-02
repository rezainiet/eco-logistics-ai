import type { Job } from "bullmq";
import { Types } from "mongoose";
import { Order, MAX_ATTEMPTED_COURIERS } from "@ecom/db";
import { adapterFor, type CourierName } from "../lib/couriers/index.js";
import { getQueue, QUEUE_NAMES, registerWorker, safeEnqueue } from "../lib/queue.js";
import { writeAudit } from "../lib/audit.js";
import { dispatchNotification } from "../lib/notifications.js";
import { recordCourierBookFailure, selectBestCourier } from "../lib/courier-intelligence.js";
import { Merchant } from "@ecom/db";
import { updateOrderWithVersion } from "../lib/orderConcurrency.js";

/**
 * Auto-book worker.
 *
 * The createOrder mutation enqueues a job here when the automation engine
 * decides the order should be auto-booked. The worker runs the booking
 * asynchronously, with bounded concurrency, exponential backoff, and a
 * critical-tier merchant alert when the retry budget is exhausted.
 *
 * Key invariants:
 *  - Only books orders that are still in `pending` or `confirmed`. Anything
 *    else is treated as a no-op success (the merchant or another path beat
 *    us to it).
 *  - Idempotent: two enqueues for the same order race the existing
 *    `trackingNumber` guard inside `bookSingleShipment`; the second loses
 *    cleanly without throwing.
 *  - Never modifies fraud, tracking, or risk state directly.
 */

const REPEAT_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 30_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 100 },
};

export interface AutoBookJobData {
  orderId: string;
  merchantId: string;
  userId: string;
  /**
   * Courier to try this attempt. Optional — when absent the worker calls
   * the intelligence engine to pick. Required on retry-with-fallback to
   * pin the next-best candidate.
   */
  courier?: string;
  /**
   * Couriers already attempted in this order's lifecycle. The intelligence
   * engine excludes these when picking. Bounds the fallback chain.
   */
  attempted?: string[];
}

export interface AutoBookJobResult {
  ok: boolean;
  status: "booked" | "skipped" | "failed";
  trackingNumber?: string;
  error?: string;
}

/**
 * Enqueue an auto-book job. Never blocks the caller. Returns a promise so
 * the caller can `void` it explicitly.
 */
export async function enqueueAutoBook(input: AutoBookJobData): Promise<void> {
  // jobId encodes the attempt count so the fallback chain (which enqueues a
  // new job after the current one fails) doesn't collide on the same id.
  // Re-enqueue of the SAME attempt (e.g. retry-after-process-crash) still
  // collapses thanks to the deterministic suffix.
  const attemptCount = input.attempted?.length ?? 0;
  const jobId = `auto-book:${input.orderId}` + (attemptCount > 0 ? `:try-${attemptCount}` : "");
  await safeEnqueue(
    QUEUE_NAMES.automationBook,
    "auto-book",
    input,
    {
      ...REPEAT_OPTS,
      jobId,
    },
    {
      merchantId: input.merchantId,
      orderId: input.orderId,
      description: "auto-book",
    },
  );
}

/**
 * Pull the order's current status fresh, refuse to book if it's already
 * past the bookable window or has a tracking number. Returns "skipped" so
 * the worker treats it as a deterministic terminal state — no retries.
 *
 * The fallback chain caps total attempts at `MAX_ATTEMPTED_COURIERS`
 * (imported from @ecom/db so the document-level $slice cap, the schema's
 * array-length validator, and the worker's retry limit all agree on a
 * single number).
 */
const FALLBACK_MAX_COURIERS = MAX_ATTEMPTED_COURIERS;

async function bookOrThrow(
  data: AutoBookJobData,
): Promise<AutoBookJobResult> {
  const merchantOid = new Types.ObjectId(data.merchantId);
  const orderOid = new Types.ObjectId(data.orderId);

  // Read the current order + the merchant's enabled couriers + automationConfig
  // in a single round-trip each.
  const order = await Order.findOne({ _id: orderOid, merchantId: merchantOid })
    .select("orderNumber order.status logistics.trackingNumber customer.district automation.attemptedCouriers automation.pinnedCourier version")
    .lean();
  if (!order) {
    void writeAudit({
      merchantId: merchantOid,
      actorId: merchantOid,
      actorType: "system",
      action: "automation.worker_skipped",
      subjectType: "order",
      subjectId: orderOid,
      meta: {
        worker: "auto-book",
        reason: "order_not_found",
        expected: "bookable_status",
      },
    }).catch(() => {});
    return { ok: true, status: "skipped", error: "order not found" };
  }
  if (order.logistics?.trackingNumber) {
    // Idempotent re-entry: a sibling path beat us to it. Not strictly
    // a state-mismatch skip; left silent to keep the audit log signal-
    // to-noise high.
    return { ok: true, status: "skipped", error: "already booked" };
  }
  if (!["pending", "confirmed", "packed"].includes(order.order.status)) {
    void writeAudit({
      merchantId: merchantOid,
      actorId: merchantOid,
      actorType: "system",
      action: "automation.worker_skipped",
      subjectType: "order",
      subjectId: orderOid,
      meta: {
        worker: "auto-book",
        reason: "state_mismatch",
        expected: "pending|confirmed|packed",
        actual: order.order.status,
      },
    }).catch(() => {});
    return {
      ok: true,
      status: "skipped",
      error: `order status ${order.order.status} — not bookable`,
    };
  }

  // ---- 1. Resolve the courier to try this attempt -----------------------
  let pickedCourier = data.courier?.trim().toLowerCase();
  const attemptedAlready = new Set(
    [
      ...(data.attempted ?? []),
      ...((order as { automation?: { attemptedCouriers?: string[] } }).automation?.attemptedCouriers ?? []),
    ].map((c) => c.toLowerCase()),
  );

  // Per-order pin override — first attempt only. The pin lands in
  // attemptedCouriers after this run, so the fallback chain still
  // runs the intelligence engine if the pinned courier fails.
  if (!pickedCourier && (data.attempted?.length ?? 0) === 0) {
    const pin = (order as { automation?: { pinnedCourier?: string } }).automation?.pinnedCourier;
    if (pin && !attemptedAlready.has(pin.toLowerCase())) {
      pickedCourier = pin.toLowerCase();
    }
  }

  let selectionReason: string | null = null;
  let selectionBreakdown: unknown = null;

  if (!pickedCourier) {
    // Run the intelligence engine — first attempt OR fallback enqueue.
    const merchant = await Merchant.findById(merchantOid)
      .select("automationConfig couriers")
      .lean();
    const enabled = ((merchant as { couriers?: Array<{ name: string; enabled?: boolean }> } | null)?.couriers ?? [])
      .filter((c) => c.enabled !== false)
      .map((c) => c.name.toLowerCase());
    const candidates = enabled.filter((c) => !attemptedAlready.has(c));
    if (candidates.length === 0) {
      return {
        ok: true,
        status: "skipped",
        error: attemptedAlready.size > 0
          ? "all couriers exhausted by fallback"
          : "no enabled courier",
      };
    }
    const preferred = (merchant as { automationConfig?: { autoBookCourier?: string } } | null)
      ?.automationConfig?.autoBookCourier ?? null;
    const district =
      (order as { customer?: { district?: string } }).customer?.district ?? "_GLOBAL_";
    const selection = await selectBestCourier({
      merchantId: merchantOid,
      district,
      candidates,
      preferredCourier: preferred,
    });
    if (!selection.best) {
      return { ok: true, status: "skipped", error: selection.reason };
    }
    pickedCourier = selection.best;
    selectionReason = selection.reason;
    selectionBreakdown = selection.ranked.slice(0, 3).map((r) => ({
      courier: r.courier,
      score: Math.round(r.score),
      matchedOn: r.matchedOn,
      observations: r.breakdown.observations,
    }));
  }

  // Stamp the selection (idempotent — same courier on retry is a no-op).
  // Aggregation-pipeline update: $setUnion gives us $addToSet semantics
  // (dedupe), then $slice caps the array at MAX_ATTEMPTED_COURIERS so a
  // runaway retry loop or off-by-one in the fallback chain can NEVER grow
  // the document beyond the configured cap.
  //
  // Aggregation-pipeline updates can't combine with `$inc` (Mongo rejects
  // mixed operator+pipeline), so the version bump rides inside the pipeline
  // via `$add`. The CAS filter on `version` still protects against stale
  // overwrites — a concurrent restore/rescore that lands here makes us
  // miss-and-skip rather than re-stamping a courier the merchant just
  // un-selected.
  const stampedVersion = (order as { version?: number }).version ?? 0;
  await Order.updateOne(
    { _id: orderOid, merchantId: merchantOid, version: stampedVersion },
    [
      {
        $set: {
          "automation.selectedCourier": pickedCourier,
          ...(selectionReason ? { "automation.selectionReason": selectionReason.slice(0, 200) } : {}),
          ...(selectionBreakdown ? { "automation.selectionBreakdown": selectionBreakdown } : {}),
          "automation.attemptedCouriers": {
            $slice: [
              { $setUnion: [{ $ifNull: ["$automation.attemptedCouriers", []] }, [pickedCourier]] },
              -MAX_ATTEMPTED_COURIERS,
            ],
          },
          version: { $add: [{ $ifNull: ["$version", 0] }, 1] },
        },
      },
    ],
  );

  // ---- 2. Try the booking -----------------------------------------------
  const { bookSingleShipment } = await import("../server/routers/orders.js");
  const res = await bookSingleShipment({
    merchantId: merchantOid,
    userId: data.userId,
    orderId: data.orderId,
    courier: pickedCourier as CourierName,
  });

  if (res.ok) {
    // Monotonic post-success flag — booking already succeeded, this is just
    // accounting metadata for analytics. No CAS needed (the field only ever
    // transitions false→true and we only land here after bookSingleShipment
    // returned ok), but we still bump version to keep the contract honest:
    // every mutating write moves the counter forward.
    void Order.updateOne(
      { _id: orderOid },
      { $set: { "automation.bookedByAutomation": true }, $inc: { version: 1 } },
    );
    void writeAudit({
      merchantId: merchantOid,
      actorId: merchantOid,
      actorType: "system",
      action: "automation.auto_booked",
      subjectType: "order",
      subjectId: orderOid,
      meta: {
        courier: pickedCourier,
        trackingNumber: res.value.trackingNumber,
        reason: selectionReason,
      },
    });
    return { ok: true, status: "booked", trackingNumber: res.value.trackingNumber };
  }

  // ---- 3. Failure → fallback enqueue (if we have couriers left) ---------
  // BullMQ's standard `attempts` retry would re-attempt the SAME courier;
  // we instead push a new job for the NEXT-best courier (different jobId
  // so it doesn't collapse with this one). We only do this if we haven't
  // hit the per-order cap. The current job is still marked failed so the
  // standard retry-exhaustion handler can fire if NO courier worked.
  // Record the failure so future selections downrank this courier
  // immediately (1h decaying penalty).
  const orderDistrict =
    (order as { customer?: { district?: string } }).customer?.district ?? "_GLOBAL_";
  void recordCourierBookFailure({
    merchantId: merchantOid,
    courier: pickedCourier,
    district: orderDistrict,
  }).catch((err) =>
    console.error("[automation-book] failure record failed:", (err as Error).message),
  );

  const attemptedNext = [...attemptedAlready, pickedCourier];
  if (attemptedNext.length < FALLBACK_MAX_COURIERS) {
    void writeAudit({
      merchantId: merchantOid,
      actorId: merchantOid,
      actorType: "system",
      action: "automation.auto_book_failed",
      subjectType: "order",
      subjectId: orderOid,
      meta: {
        courier: pickedCourier,
        error: res.error,
        attempted: attemptedNext,
        willFallback: true,
      },
    });
    void enqueueAutoBook({
      orderId: data.orderId,
      merchantId: data.merchantId,
      userId: data.userId,
      attempted: attemptedNext,
      // No `courier` — selection runs again excluding `attempted`.
    }).catch((err) =>
      console.error("[automation-book] fallback enqueue failed:", (err as Error).message),
    );
    // Return success-on-skip so this job doesn't keep retrying the same
    // courier under BullMQ's attempts policy. The fallback is the retry.
    return { ok: true, status: "skipped", error: `fallback queued (${pickedCourier} failed)` };
  }

  // No more couriers — let BullMQ count this as a real failure so the
  // retry-exhaustion notification fires.
  throw new Error(res.error ?? `auto-book failed on ${pickedCourier}`);
}

export function registerAutomationBookWorker() {
  const worker = registerWorker<AutoBookJobData, AutoBookJobResult>(
    QUEUE_NAMES.automationBook,
    async (job: Job<AutoBookJobData>) => bookOrThrow(job.data),
    { concurrency: 4 },
  );

  worker.on("failed", (job, err) => {
    if (!job) return;
    const exhausted =
      job.opts.attempts !== undefined && (job.attemptsMade ?? 0) >= job.opts.attempts;
    if (!exhausted) return;

    const data = job.data;
    const merchantOid = (() => {
      try {
        return new Types.ObjectId(data.merchantId);
      } catch {
        return null;
      }
    })();
    if (!merchantOid) return;

    const orderOid = (() => {
      try {
        return new Types.ObjectId(data.orderId);
      } catch {
        return null;
      }
    })();

    void writeAudit({
      merchantId: merchantOid,
      actorId: merchantOid,
      actorType: "system",
      action: "automation.auto_book_failed",
      subjectType: "order",
      subjectId: orderOid ?? merchantOid,
      meta: {
        courier: data.courier,
        attempts: job.attemptsMade,
        error: err.message?.slice(0, 500),
      },
    }).catch(() => {});

    // Critical-severity inbox row + (if merchant has a phone) SMS.
    void dispatchNotification({
      merchantId: merchantOid,
      kind: "integration.webhook_failed",
      severity: "critical",
      title: `Auto-booking failed for order ${data.orderId.slice(-6)}`,
      body: `We tried ${job.attemptsMade} times to auto-book this order with ${data.courier} but the courier kept rejecting it. Please review and book manually.`,
      subjectType: "order",
      subjectId: orderOid ?? undefined,
      dedupeKey: `auto_book_failed:${data.orderId}`,
      meta: { courier: data.courier, error: err.message?.slice(0, 500) },
    }).catch((e) => console.error("[automation-book] notify failed", e));
  });

  return worker;
}

/**
 * Hook a queue-level "exhausted retries" notifier. Mounted alongside the
 * worker. Once a job hits attemptsMade === attempts AND failed, fire a
 * critical merchant notification + audit row so the merchant sees a clear
 * "auto-book failed for ORD-XYZ" alert.
 */
export function attachAutoBookFailureSink(): void {
  const queue = getQueue(QUEUE_NAMES.automationBook);
  queue.on("error", (err) => console.error("[automation-book] queue error", err));
  // BullMQ Worker 'failed' fires per-attempt; the *exhausted* check is
  // attemptsMade === attempts. We can't attach to the Worker here without
  // re-creating it — instead we attach directly inside registerAutomationBookWorker.
}

/**
 * Test-only — pull the configured retry policy. Asserts the production
 * defaults haven't drifted.
 */
export const __TEST = { REPEAT_OPTS };
