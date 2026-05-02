import { z } from "zod";
import {
  AuditLog,
  Order,
  Payment,
  WebhookInbox,
} from "@ecom/db";
import { adminProcedure, router } from "../trpc.js";
import { QUEUE_NAMES, getQueue } from "../../lib/queue.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Aggregate the BullMQ counters for every known queue. Failure modes are
 * the most useful column — `failed > 0` over time signals a worker
 * regression. `waiting > active * 10` is a backpressure signal.
 *
 * Each queue read is independent so a single broken queue doesn't break
 * the whole snapshot — wrap in try/catch and surface "error" inline.
 */
async function readQueueSnapshot() {
  const out: Array<{
    name: string;
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    error: string | null;
  }> = [];
  for (const name of Object.values(QUEUE_NAMES)) {
    try {
      const q = getQueue(name);
      const counts = await q.getJobCounts(
        "waiting",
        "active",
        "completed",
        "failed",
        "delayed",
      );
      out.push({
        name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
        error: null,
      });
    } catch (err) {
      out.push({
        name,
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        error: (err as Error).message ?? "queue read failed",
      });
    }
  }
  return out;
}

export const adminObservabilityRouter = router({
  /**
   * System-health dashboard. Every read is independent; nothing here
   * mutates. Available to any admin (read-only).
   */
  systemHealth: adminProcedure.query(async () => {
    const since24h = new Date(Date.now() - DAY_MS);
    const since1h = new Date(Date.now() - HOUR_MS);

    const [queues, webhookFailures, webhookSucceededLast24h, webhookFailures1h] =
      await Promise.all([
        readQueueSnapshot(),
        WebhookInbox.countDocuments({
          status: "failed",
          updatedAt: { $gte: since24h },
        }).catch(() => 0),
        WebhookInbox.countDocuments({
          status: "succeeded",
          updatedAt: { $gte: since24h },
        }).catch(() => 0),
        WebhookInbox.countDocuments({
          status: "failed",
          updatedAt: { $gte: since1h },
        }).catch(() => 0),
      ]);

    const totalQueueBacklog = queues.reduce(
      (acc, q) => acc + q.waiting + q.delayed,
      0,
    );
    const totalQueueFailed = queues.reduce((acc, q) => acc + q.failed, 0);

    return {
      queues,
      totals: {
        backlog: totalQueueBacklog,
        active: queues.reduce((acc, q) => acc + q.active, 0),
        failed: totalQueueFailed,
      },
      webhooks: {
        failedLast24h: webhookFailures,
        failedLast1h: webhookFailures1h,
        succeededLast24h: webhookSucceededLast24h,
      },
      generatedAt: new Date(),
    };
  }),

  /**
   * Recent failed webhook rows — surfaced for inspection / replay. Only
   * the metadata, not the payload, since payloads can be large.
   */
  recentWebhookFailures: adminProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(200).default(50) })
        .default({ limit: 50 }),
    )
    .query(async ({ input }) => {
      const docs = await WebhookInbox.find({ status: "failed" })
        .sort({ updatedAt: -1 })
        .limit(input.limit)
        .select(
          "merchantId provider externalId status attempts lastError updatedAt createdAt",
        )
        .lean();
      return docs.map((d) => ({
        id: String(d._id),
        merchantId: d.merchantId ? String(d.merchantId) : null,
        provider: d.provider,
        externalId: d.externalId,
        attempts: d.attempts ?? 0,
        lastError: d.lastError ?? null,
        updatedAt: d.updatedAt,
        createdAt: d.createdAt,
      }));
    }),

  /**
   * Fraud overview — surfaces today's review queue, decision counts, and
   * 7-day risk-level distribution.
   */
  fraudOverview: adminProcedure.query(async () => {
    const since24h = new Date(Date.now() - DAY_MS);
    const since7d = new Date(Date.now() - 7 * DAY_MS);

    const [openHighRisk, decisionsLast24h, last7dByLevel] = await Promise.all([
      Order.countDocuments({
        "fraud.level": "high",
        "fraud.reviewStatus": { $in: ["pending_call", "no_answer"] },
      }).catch(() => 0),
      AuditLog.countDocuments({
        action: { $in: ["review.verified", "review.rejected", "review.no_answer"] },
        at: { $gte: since24h },
      }).catch(() => 0),
      Order.aggregate([
        { $match: { createdAt: { $gte: since7d } } },
        {
          $group: {
            _id: "$fraud.level",
            count: { $sum: 1 },
          },
        },
      ]).catch(() => [] as Array<{ _id: string | null; count: number }>),
    ]);

    const byLevel: Record<string, number> = {};
    for (const row of last7dByLevel as Array<{ _id: string | null; count: number }>) {
      byLevel[row._id ?? "unknown"] = row.count;
    }
    return {
      openHighRisk,
      decisionsLast24h,
      last7dByLevel: byLevel,
      generatedAt: new Date(),
    };
  }),

  /**
   * Payment monitoring — approval rate, suspicious counts, dual-approval
   * pending queue.
   */
  paymentOverview: adminProcedure.query(async () => {
    const since24h = new Date(Date.now() - DAY_MS);
    const since7d = new Date(Date.now() - 7 * DAY_MS);

    const [byStatus24h, byStatus7d, suspicious, pendingDual] = await Promise.all([
      Payment.aggregate([
        { $match: { createdAt: { $gte: since24h }, provider: "manual" } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]).catch(() => [] as Array<{ _id: string; count: number }>),
      Payment.aggregate([
        { $match: { createdAt: { $gte: since7d }, provider: "manual" } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]).catch(() => [] as Array<{ _id: string; count: number }>),
      Payment.countDocuments({
        provider: "manual",
        status: { $in: ["pending", "reviewed"] },
        riskScore: { $gte: 80 },
      }).catch(() => 0),
      Payment.countDocuments({
        provider: "manual",
        status: "reviewed",
        requiresDualApproval: true,
        firstApprovalBy: { $exists: true, $ne: null },
      }).catch(() => 0),
    ]);

    const flatten = (rows: Array<{ _id: string; count: number }>) => {
      const out: Record<string, number> = {
        pending: 0,
        reviewed: 0,
        approved: 0,
        rejected: 0,
      };
      for (const r of rows) {
        if (r._id) out[r._id] = (out[r._id] ?? 0) + r.count;
      }
      return out;
    };
    const last24h = flatten(byStatus24h as Array<{ _id: string; count: number }>);
    const last7d = flatten(byStatus7d as Array<{ _id: string; count: number }>);
    const total7d = Object.values(last7d).reduce((a, b) => a + b, 0);
    const approved7d = last7d.approved ?? 0;
    const approvalRate7d = total7d === 0 ? 0 : approved7d / total7d;

    return {
      last24h,
      last7d,
      approvalRate7d,
      suspiciousCount: suspicious,
      pendingDualApproval: pendingDual,
      generatedAt: new Date(),
    };
  }),
});
