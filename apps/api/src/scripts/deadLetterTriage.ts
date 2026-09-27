/**
 * Dead-letter triage — READ-ONLY report of PendingJob rows.
 *
 *   MONGODB_URI=… tsx src/scripts/deadLetterTriage.ts [--max-age-hours 24] [--json]
 *
 * Classifies every PendingJob row (pending AND exhausted) with
 * lib/dead-letter-triage.ts against the current order / merchant state and
 * prints counts per queue, job and category. It performs no writes, no
 * replays and no deletes, and prints no customer data (ids only).
 *
 * Replaying is intentionally not offered here: a replay of an automatic
 * courier booking creates a real shipment, so any replay is a separate,
 * explicitly approved step that acts only on `safe_candidate` rows.
 */
import mongoose, { Types } from "mongoose";
import { Merchant, Order, PendingJob } from "@ecom/db";
import {
  classifyDeadLetter,
  DEFAULT_MAX_ORDER_JOB_AGE_MS,
  merchantIdOf,
  orderIdOf,
  type TriageCategory,
} from "../lib/dead-letter-triage.js";
import { isBullSafeJobId } from "../lib/queue-ids.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const maxAgeHours = Number(flag("--max-age-hours") ?? DEFAULT_MAX_ORDER_JOB_AGE_MS / 3_600_000);
const asJson = args.includes("--json");

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is required");
  process.exit(2);
}

await mongoose.connect(uri, { readPreference: "secondaryPreferred", serverSelectionTimeoutMS: 20_000 });
try {
  const now = new Date();
  const rows = await PendingJob.find({})
    .select("queueName jobName status data jobOpts createdAt lastError attempts")
    .lean();

  const orderIds = [...new Set(rows.map((r) => orderIdOf(r as never)).filter((x): x is string => !!x))];
  const merchantIds = [...new Set(rows.map((r) => merchantIdOf(r as never)).filter((x): x is string => !!x))];
  const orders = new Map(
    (
      await Order.find({ _id: { $in: orderIds.map((id) => new Types.ObjectId(id)) } })
        .select("merchantId order.status logistics.trackingNumber automation.state")
        .lean()
    ).map((o) => [String(o._id), o]),
  );
  const merchants = new Map(
    (
      await Merchant.find({ _id: { $in: merchantIds.map((id) => new Types.ObjectId(id)) } })
        .select("automationConfig.autoBookEnabled")
        .lean()
    ).map((m) => [String(m._id), m]),
  );

  type Bucket = { total: number; byStatus: Record<string, number>; byCategory: Partial<Record<TriageCategory, number>>; legacyUnsafeJobId: number };
  const buckets = new Map<string, Bucket>();
  const safeCandidates: Array<{ pendingJobId: string; queue: string; job: string; orderId: string | null; ageHours: number }> = [];

  for (const r of rows) {
    const orderId = orderIdOf(r as never);
    const merchantId = merchantIdOf(r as never);
    const o = orderId ? orders.get(orderId) : undefined;
    // An order that belongs to a different merchant than the job claims is treated as missing.
    const orderFacts =
      orderId === null
        ? undefined
        : o && String(o.merchantId) === merchantId
          ? {
              status: String(o.order?.status ?? ""),
              hasTrackingNumber: !!o.logistics?.trackingNumber,
              automationState: (o as { automation?: { state?: string } }).automation?.state ?? null,
            }
          : null;
    const m = merchantId ? merchants.get(merchantId) : undefined;
    const result = classifyDeadLetter(
      { queueName: r.queueName, jobName: r.jobName, createdAt: r.createdAt as Date, data: r.data },
      {
        now,
        order: orderFacts,
        merchantAutoBookEnabled: m ? (m as { automationConfig?: { autoBookEnabled?: boolean } }).automationConfig?.autoBookEnabled === true : null,
        maxOrderJobAgeMs: maxAgeHours * 3_600_000,
      },
    );
    const key = `${r.queueName} / ${r.jobName}`;
    const b = buckets.get(key) ?? { total: 0, byStatus: {}, byCategory: {}, legacyUnsafeJobId: 0 };
    b.total++;
    b.byStatus[r.status] = (b.byStatus[r.status] ?? 0) + 1;
    b.byCategory[result.category] = (b.byCategory[result.category] ?? 0) + 1;
    const jobId = (r.jobOpts as { jobId?: unknown } | null)?.jobId;
    if (typeof jobId === "string" && !isBullSafeJobId(jobId)) b.legacyUnsafeJobId++;
    buckets.set(key, b);
    if (result.category === "safe_candidate") {
      safeCandidates.push({
        pendingJobId: String(r._id),
        queue: r.queueName,
        job: r.jobName,
        orderId,
        ageHours: Math.round((now.getTime() - new Date(r.createdAt as Date).getTime()) / 3_600_000),
      });
    }
  }

  const report = {
    generatedAt: now.toISOString(),
    maxOrderJobAgeHours: maxAgeHours,
    totalRows: rows.length,
    queues: Object.fromEntries([...buckets.entries()].sort((a, b) => b[1].total - a[1].total)),
    safeCandidates,
  };
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Dead-letter triage (read-only) — ${report.generatedAt}, max order-job age ${maxAgeHours}h`);
    console.log(`Total PendingJob rows: ${rows.length}\n`);
    for (const [key, b] of Object.entries(report.queues)) {
      console.log(`${key}: ${b.total}  status=${JSON.stringify(b.byStatus)}  legacyUnsafeJobId=${b.legacyUnsafeJobId}`);
      console.log(`    ${JSON.stringify(b.byCategory)}`);
    }
    console.log(`\nSafe replay candidates: ${safeCandidates.length}`);
    for (const c of safeCandidates) console.log(`  ${c.pendingJobId} ${c.queue}/${c.job} order=${c.orderId ?? "-"} age=${c.ageHours}h`);
    console.log("\nNo rows were replayed, changed or deleted.");
  }
} finally {
  await mongoose.disconnect();
}
