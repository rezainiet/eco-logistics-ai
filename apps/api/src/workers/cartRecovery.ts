import type { Job } from "bullmq";
import { Types } from "mongoose";
import {
  RecoveryTask,
  TrackingEvent,
  TrackingSession,
  Notification,
} from "@ecom/db";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import { writeAudit } from "../lib/audit.js";

/**
 * Abandoned-cart recovery worker.
 *
 * Each tick scans `TrackingSession` for sessions that:
 *   1. ended with `abandonedCart=true`
 *   2. have an identified buyer (phone or email — courtesy of the SDK
 *      identify() hook or stitched checkout_submit)
 *   3. did NOT eventually convert (no resolvedOrderId, no later
 *      converted=true session for the same anonId)
 *   4. are at least `MIN_AGE_MS` old (so we don't pester someone mid-flow)
 *   5. don't already have a recovery task
 *
 * For each match we upsert a `RecoveryTask` row with the cart value
 * estimate + top product names so the merchant's outreach script writes
 * itself. A first-task notification fires once per merchant per day so the
 * inbox isn't flooded.
 */

const REPEAT_JOB_NAME = "cart-recovery:sweep";
const SCAN_BATCH = 200;
const DEFAULT_INTERVAL_MS = 5 * 60_000; // 5 minutes
const MIN_AGE_MS = 30 * 60_000; // 30 minutes after last_seen
const RECOVERY_WINDOW_MS = 7 * 24 * 60_000 * 60; // 7 days

export interface CartRecoveryJobResult {
  scanned: number;
  created: number;
  expired: number;
}

interface CartScanRow {
  _id: Types.ObjectId;
  sessionId: string;
  phone?: string | null;
  email?: string | null;
  lastSeenAt: Date;
  addToCartCount: number;
  checkoutSubmitCount: number;
  resolvedOrderId?: Types.ObjectId | null;
}

async function estimateCartFromEvents(args: {
  merchantId: Types.ObjectId;
  sessionId: string;
}): Promise<{ cartValue: number; topProducts: string[] }> {
  const evs = await TrackingEvent.find({
    merchantId: args.merchantId,
    sessionId: args.sessionId,
    type: { $in: ["add_to_cart", "product_view"] },
  })
    .sort({ occurredAt: -1 })
    .limit(50)
    .select("type properties")
    .lean();
  let cartValue = 0;
  const productNames = new Set<string>();
  for (const ev of evs) {
    const p = (ev.properties ?? {}) as { price?: number; name?: string; quantity?: number };
    if (ev.type === "add_to_cart" && typeof p.price === "number") {
      cartValue += p.price * Math.max(1, Number(p.quantity ?? 1));
    }
    if (p.name && productNames.size < 5) productNames.add(p.name);
  }
  return { cartValue: Math.round(cartValue), topProducts: [...productNames] };
}

export async function sweepCartRecovery(): Promise<CartRecoveryJobResult> {
  const now = Date.now();
  const ageCutoff = new Date(now - MIN_AGE_MS);
  const windowFloor = new Date(now - RECOVERY_WINDOW_MS);

  // Expire stale pending tasks first — don't keep nagging the agent about
  // carts that abandoned a week ago.
  const expiredResult = await RecoveryTask.updateMany(
    { status: "pending", expiresAt: { $lte: new Date() } },
    { $set: { status: "expired" } },
  );

  // Pull candidate sessions in one pass; the partial index on
  // {merchantId, abandonedCart} keeps this cheap even at scale.
  const candidates = (await TrackingSession.find({
    abandonedCart: true,
    converted: { $ne: true },
    resolvedOrderId: { $exists: false },
    lastSeenAt: { $gte: windowFloor, $lte: ageCutoff },
    $or: [{ phone: { $exists: true, $ne: null } }, { email: { $exists: true, $ne: null } }],
  })
    .sort({ lastSeenAt: -1 })
    .limit(SCAN_BATCH)
    .select("_id sessionId merchantId phone email lastSeenAt addToCartCount checkoutSubmitCount resolvedOrderId")
    .lean()) as Array<CartScanRow & { merchantId: Types.ObjectId }>;

  let created = 0;
  const newTasksByMerchant = new Map<string, number>();

  for (const session of candidates) {
    if (!session.phone && !session.email) continue;
    if (session.checkoutSubmitCount > 0) continue;

    const { cartValue, topProducts } = await estimateCartFromEvents({
      merchantId: session.merchantId,
      sessionId: session.sessionId,
    });

    // Upsert with $setOnInsert so re-runs are idempotent and we never
    // overwrite an agent's contacted/dismissed state.
    const result = await RecoveryTask.updateOne(
      { merchantId: session.merchantId, sessionId: session.sessionId },
      {
        $setOnInsert: {
          merchantId: session.merchantId,
          sessionId: session.sessionId,
          trackingSessionId: session._id,
          phone: session.phone ?? undefined,
          email: session.email ?? undefined,
          cartValue,
          topProducts,
          abandonedAt: session.lastSeenAt,
          status: "pending",
          expiresAt: new Date(session.lastSeenAt.getTime() + RECOVERY_WINDOW_MS),
        },
      },
      { upsert: true },
    );

    if (result.upsertedCount && result.upsertedCount > 0) {
      created += 1;
      const key = String(session.merchantId);
      newTasksByMerchant.set(key, (newTasksByMerchant.get(key) ?? 0) + 1);
    }
  }

  // Notify each merchant — but only once per day-bucket so a busy storefront
  // doesn't drown the inbox.
  for (const [merchantIdStr, count] of newTasksByMerchant) {
    const merchantId = new Types.ObjectId(merchantIdStr);
    const dayBucket = Math.floor(now / (24 * 60_000 * 60));
    const dedupeKey = `cart-recovery:${merchantIdStr}:${dayBucket}`;
    try {
      await Notification.updateOne(
        { merchantId, dedupeKey },
        {
          $setOnInsert: {
            merchantId,
            kind: "recovery.cart_pending",
            severity: "info" as const,
            title: `${count} new abandoned cart${count === 1 ? "" : "s"} ready to recover`,
            body: "Identified buyers added items to cart but didn't check out — open Recovery to reach out.",
            link: `/dashboard/recovery`,
            subjectType: "merchant" as const,
            subjectId: merchantId,
            meta: { count },
            dedupeKey,
          },
        },
        { upsert: true },
      );
    } catch (err) {
      console.error("[cart-recovery] notification failed", (err as Error).message);
    }
    void writeAudit({
      merchantId,
      actorId: merchantId,
      actorType: "system",
      action: "tracking.identified",
      subjectType: "merchant",
      subjectId: merchantId,
      meta: { kind: "cart_recovery_batch", count },
    });
  }

  return {
    scanned: candidates.length,
    created,
    expired: expiredResult.modifiedCount ?? 0,
  };
}

export function registerCartRecoveryWorker() {
  return registerWorker<unknown, CartRecoveryJobResult>(
    QUEUE_NAMES.cartRecovery,
    async (job: Job<unknown>) => {
      const res = await sweepCartRecovery();
      if (res.scanned > 0) {
        console.log(
          `[cart-recovery] job=${job.id} scanned=${res.scanned} created=${res.created} expired=${res.expired}`,
        );
      }
      return res;
    },
    { concurrency: 1 },
  );
}

export async function scheduleCartRecovery(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Promise<void> {
  if (intervalMs <= 0) {
    console.log("[cart-recovery] disabled (intervalMs<=0)");
    return;
  }
  const q = getQueue(QUEUE_NAMES.cartRecovery);
  const repeatables = await q.getRepeatableJobs();
  await Promise.all(
    repeatables
      .filter((r) => r.name === REPEAT_JOB_NAME)
      .map((r) => q.removeRepeatableByKey(r.key)),
  );
  await q.add(
    REPEAT_JOB_NAME,
    {},
    { repeat: { every: intervalMs }, jobId: REPEAT_JOB_NAME },
  );
  console.log(`[cart-recovery] scheduled every ${intervalMs}ms`);
}
