import type { Job } from "bullmq";
import { Types } from "mongoose";
import {
  Merchant,
  RecoveryTask,
  TrackingEvent,
  TrackingSession,
  Notification,
} from "@ecom/db";
import { getQueue, QUEUE_NAMES, registerWorker } from "../lib/queue.js";
import { writeAudit } from "../lib/audit.js";
import { landingCartSnapshot } from "../lib/recovery/landing.js";
import { sendDueRecoveryEmails, type RecoveryEmailSender } from "../lib/recovery/email.js";
import {
  cartRecoveryEligible,
  cartRecoveryTiers,
  type SubscriptionAccessInput,
} from "../lib/entitlements.js";

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
 *
 * Scan strategy (audit CR-2): the sweep used to take the newest 200
 * candidates across ALL merchants, already-tasked sessions included — once
 * 200 newer sessions existed, older untasked ones were never reached, and
 * the merchant-less query fit none of the merchant-prefixed indexes. Now it
 * walks merchant by merchant on the `{merchantId, abandonedCart, lastSeenAt}`
 * index, oldest first, drops sessions that already have a task BEFORE they
 * count toward anything, and caps only task CREATIONS per merchant per tick.
 * Every tick therefore makes progress through the untasked backlog (FIFO),
 * so no eligible session can be starved.
 */

const REPEAT_JOB_NAME = "cart-recovery:sweep";
/** Candidates fetched per page (one RecoveryTask lookup per page). */
const PAGE_SIZE = 200;
/** Upper bound on NEW tasks per merchant per tick (bounds write volume). */
const MAX_CREATE_PER_MERCHANT = 500;
const DEFAULT_INTERVAL_MS = 5 * 60_000; // 5 minutes
const MIN_AGE_MS = 30 * 60_000; // 30 minutes after last_seen
const RECOVERY_WINDOW_MS = 7 * 24 * 60_000 * 60; // 7 days

export interface CartRecoveryJobResult {
  scanned: number;
  created: number;
  expired: number;
  /** Candidates skipped because a RecoveryTask already exists for them. */
  alreadyTasked: number;
  /** Merchants swept (entitled to Cart Recovery). */
  merchants: number;
  /** Merchants on a recovery-capable tier skipped for their subscription state. */
  ineligible: number;
  /** Automatic recovery emails (landing-page carts) this tick. */
  emailsSent: number;
  emailsFailed: number;
  emailsSuppressed: number;
  emailsCancelled: number;
}

export interface CartRecoverySweepOptions {
  /** Clock override (tests). */
  now?: number;
  /** Override MAX_CREATE_PER_MERCHANT (tests). */
  maxCreatePerMerchant?: number;
  /** Email transport override (tests). Defaults to the platform `sendEmail`. */
  sendEmail?: RecoveryEmailSender;
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

export async function sweepCartRecovery(
  opts: CartRecoverySweepOptions = {},
): Promise<CartRecoveryJobResult> {
  const now = opts.now ?? Date.now();
  const ageCutoff = new Date(now - MIN_AGE_MS);
  const windowFloor = new Date(now - RECOVERY_WINDOW_MS);
  const createCap = opts.maxCreatePerMerchant ?? MAX_CREATE_PER_MERCHANT;

  // Expire stale pending tasks first — don't keep nagging the agent about
  // carts that abandoned a week ago.
  const expiredResult = await RecoveryTask.updateMany(
    { status: "pending", expiresAt: { $lte: new Date(now) } },
    { $set: { status: "expired" } },
  );

  let scanned = 0;
  let created = 0;
  let alreadyTasked = 0;
  let merchants = 0;
  let ineligible = 0;
  const emails = { sent: 0, failed: 0, suppressed: 0, cancelled: 0 };
  const newTasksByMerchant = new Map<string, number>();

  // Merchant by merchant, so every query is tenant-scoped and index-backed.
  // Only merchants entitled to Cart Recovery (canonical entitlement: the
  // plan's behaviorAnalytics feature + a billable subscription — the same
  // access the recovery API grants). Tracking events from other merchants
  // are still collected; they just never become recovery tasks.
  const merchantCursor = Merchant.find({ "subscription.tier": { $in: cartRecoveryTiers() } })
    .select("_id subscription")
    .lean()
    .cursor();
  for await (const m of merchantCursor) {
    const sub = (m as { subscription?: SubscriptionAccessInput }).subscription;
    if (!sub || !cartRecoveryEligible(sub, now)) {
      ineligible += 1;
      continue;
    }
    merchants += 1;
    const merchantId = m._id as Types.ObjectId;
    const r = await sweepMerchant({ merchantId, ageCutoff, windowFloor, createCap });
    scanned += r.scanned;
    created += r.created;
    alreadyTasked += r.alreadyTasked;
    if (r.created > 0) newTasksByMerchant.set(String(merchantId), r.created);
    // Automatic recovery email for this (entitled) merchant's due tasks.
    const e = await sendDueRecoveryEmails({ merchantId, now, send: opts.sendEmail });
    emails.sent += e.sent;
    emails.failed += e.failed;
    emails.suppressed += e.suppressed;
    emails.cancelled += e.cancelled;
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
      action: "recovery.tasks_created",
      subjectType: "merchant",
      subjectId: merchantId,
      meta: { kind: "cart_recovery_batch", count },
    });
  }

  return {
    scanned,
    created,
    expired: expiredResult.modifiedCount ?? 0,
    alreadyTasked,
    merchants,
    ineligible,
    emailsSent: emails.sent,
    emailsFailed: emails.failed,
    emailsSuppressed: emails.suppressed,
    emailsCancelled: emails.cancelled,
  };
}

/**
 * One merchant's slice of the sweep. Oldest eligible session first; each
 * page of candidates is checked against existing RecoveryTasks in one
 * indexed lookup, and only untasked sessions are upserted (still guarded by
 * the unique {merchantId, sessionId} index, so concurrent sweeps can't
 * double-create).
 */
async function sweepMerchant(args: {
  merchantId: Types.ObjectId;
  ageCutoff: Date;
  windowFloor: Date;
  createCap: number;
}): Promise<{ scanned: number; created: number; alreadyTasked: number }> {
  const { merchantId, ageCutoff, windowFloor, createCap } = args;
  let scanned = 0;
  let created = 0;
  let alreadyTasked = 0;

  // Equality on merchantId + abandonedCart and a range on lastSeenAt match
  // the {merchantId:1, abandonedCart:1, lastSeenAt:-1} index (scanned in
  // reverse for oldest-first); the remaining predicates filter that range.
  const cursor = TrackingSession.find({
    merchantId,
    abandonedCart: true,
    lastSeenAt: { $gte: windowFloor, $lte: ageCutoff },
    converted: { $ne: true },
    resolvedOrderId: { $exists: false },
    $or: [{ phone: { $exists: true, $ne: null } }, { email: { $exists: true, $ne: null } }],
  })
    .sort({ lastSeenAt: 1 })
    .select("_id sessionId merchantId phone email lastSeenAt addToCartCount checkoutSubmitCount resolvedOrderId")
    .lean()
    .cursor({ batchSize: PAGE_SIZE });

  let page: CartScanRow[] = [];
  const flush = async (): Promise<boolean> => {
    if (page.length === 0) return true;
    const rows = page;
    page = [];
    scanned += rows.length;
    const existing = await RecoveryTask.find({
      merchantId,
      sessionId: { $in: rows.map((r) => r.sessionId) },
    })
      .select("sessionId")
      .lean();
    const tasked = new Set(existing.map((t) => t.sessionId));
    for (const row of rows) {
      if (tasked.has(row.sessionId)) {
        alreadyTasked += 1;
        continue;
      }
      if (!row.phone && !row.email) continue;
      if ((row.checkoutSubmitCount ?? 0) > 0) continue;
      if (created >= createCap) return false; // budget spent — next tick continues from here
      if (await createTask(merchantId, row)) created += 1;
    }
    return true;
  };

  for await (const row of cursor) {
    page.push(row as CartScanRow);
    if (page.length >= PAGE_SIZE && !(await flush())) break;
  }
  if (created < createCap) await flush();
  await cursor.close();
  return { scanned, created, alreadyTasked };
}

/** Upsert one RecoveryTask; true only when this call created it. */
async function createTask(merchantId: Types.ObjectId, session: CartScanRow): Promise<boolean> {
  let { cartValue, topProducts } = await estimateCartFromEvents({
    merchantId,
    sessionId: session.sessionId,
  });
  // A ConfirmX landing-page cart can be restored by a link, so it also gets
  // the automatic recovery email (when the buyer left an email address).
  // Its saved cart is exact, so it also gives the cart value and products.
  const landing = await landingCartSnapshot(merchantId, session.sessionId);
  const restorable = !!landing && landing.lines.length > 0;
  if (restorable) {
    cartValue = Math.round(landing!.lines.reduce((sum, l) => sum + l.price * l.quantity, 0));
    topProducts = [...new Set(landing!.lines.map((l) => l.name).filter(Boolean))].slice(0, 5);
  }
  try {
    // $setOnInsert so re-runs are idempotent and we never overwrite an
    // agent's contacted/dismissed state.
    const result = await RecoveryTask.updateOne(
      { merchantId, sessionId: session.sessionId },
      {
        $setOnInsert: {
          merchantId,
          sessionId: session.sessionId,
          trackingSessionId: session._id,
          phone: session.phone ?? undefined,
          email: session.email ?? undefined,
          cartValue,
          topProducts,
          abandonedAt: session.lastSeenAt,
          status: "pending",
          expiresAt: new Date(session.lastSeenAt.getTime() + RECOVERY_WINDOW_MS),
          source: restorable ? "landing_page" : "storefront",
          ...(restorable
            ? {
                landingPageId: new Types.ObjectId(landing!.landing.pageId),
                landingHost: landing!.landing.host,
                landingLocale: landing!.landing.locale,
                ...(session.email ? { emailRecovery: { state: "queued", attempts: 0 } } : {}),
              }
            : {}),
        },
      },
      { upsert: true },
    );
    return (result.upsertedCount ?? 0) > 0;
  } catch (err) {
    // A concurrent sweep won the upsert race on the unique index.
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

export function registerCartRecoveryWorker() {
  return registerWorker<unknown, CartRecoveryJobResult>(
    QUEUE_NAMES.cartRecovery,
    async (job: Job<unknown>) => {
      const res = await sweepCartRecovery();
      if (res.scanned > 0 || res.expired > 0 || res.emailsSent > 0 || res.emailsFailed > 0) {
        console.log(
          `[cart-recovery] job=${job.id} merchants=${res.merchants} scanned=${res.scanned} created=${res.created} alreadyTasked=${res.alreadyTasked} expired=${res.expired} emailsSent=${res.emailsSent} emailsFailed=${res.emailsFailed}`,
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
