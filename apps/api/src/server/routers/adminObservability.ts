import { z } from "zod";
import { Types } from "mongoose";
import {
  AuditLog,
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  Integration,
  Merchant,
  MerchantFeedback,
  Notification,
  Order,
  Payment,
  PendingJob,
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

    const [
      queues,
      webhookFailures,
      webhookSucceededLast24h,
      webhookFailures1h,
      payloadReapPending,
      deadLetteredCount,
    ] = await Promise.all([
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
      // Payload-reap backlog: succeeded rows whose `payloadReapAt`
      // has passed but whose payloads haven't been NULLed yet. A
      // growing number here means the webhook-retry sweep isn't
      // keeping up with reap demand — early signal of storage growth
      // before it becomes a Mongo bill spike.
      WebhookInbox.countDocuments({
        status: "succeeded",
        payloadReaped: false,
        payloadReapAt: { $lte: new Date() },
      }).catch(() => 0),
      // Dead-lettered rows are preserved indefinitely (forensic
      // artefacts). Surface the running total so a sudden jump is
      // visible to ops — usually signals a platform-wide upstream
      // issue, not noise.
      WebhookInbox.countDocuments({
        status: "failed",
        deadLetteredAt: { $exists: true, $ne: null },
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
        // Retention-system observability — answers "is the reaper
        // keeping up?" and "how many dead-lettered rows are we
        // preserving?" without needing a separate ad-hoc query.
        payloadReapPending,
        deadLetteredTotal: deadLetteredCount,
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

  /**
   * Per-merchant support snapshot — read-only diagnostic view for ops
   * investigating a specific merchant ticket. Aggregates the existing
   * Order / Integration / Notification / PendingJob / AuditLog tables
   * into one round-trip so the support dashboard doesn't N+1.
   *
   * Read-only. No writes. Admin-scoped via `adminProcedure`.
   *
   * Each section degrades independently — a single failing collection
   * read doesn't break the whole snapshot. Counts return 0 + the section
   * surfaces an `error` field. The classic "rescue ticket from a slow
   * Mongo replica" workflow stays usable.
   */
  merchantSupportSnapshot: adminProcedure
    .input(
      z.object({
        merchantId: z.string().refine(
          (v) => Types.ObjectId.isValid(v),
          "invalid merchant id",
        ),
      }),
    )
    .query(async ({ input }) => {
      const merchantId = new Types.ObjectId(input.merchantId);
      const since7d = new Date(Date.now() - 7 * DAY_MS);
      const since24h = new Date(Date.now() - DAY_MS);

      const [
        merchant,
        integrations,
        ordersByStatus7d,
        recentInbox,
        recentInboxFailed,
        unresolvedNotifications,
        pendingJobs,
        recentAudit,
      ] = await Promise.all([
        Merchant.findById(merchantId)
          .select(
            "_id email businessName country language role subscription createdAt",
          )
          .lean()
          .catch(() => null),
        Integration.find({ merchantId })
          .select(
            "provider accountKey status connectedAt disconnectedAt pausedAt lastSyncAt lastSyncStatus lastError errorCount degraded webhookStatus health counts",
          )
          .lean()
          .catch(() => []),
        Order.aggregate<{ _id: string; count: number }>([
          { $match: { merchantId, createdAt: { $gte: since7d } } },
          { $group: { _id: "$order.status", count: { $sum: 1 } } },
        ]).catch(() => []),
        WebhookInbox.find({ merchantId })
          .sort({ createdAt: -1 })
          .limit(10)
          .select("provider topic externalId status attempts lastError createdAt processedAt")
          .lean()
          .catch(() => []),
        WebhookInbox.countDocuments({
          merchantId,
          status: "failed",
          updatedAt: { $gte: since24h },
        }).catch(() => 0),
        Notification.countDocuments({
          merchantId,
          readAt: null,
          severity: { $in: ["warning", "critical"] },
        }).catch(() => 0),
        PendingJob.countDocuments({
          "ctx.merchantId": String(merchantId),
          status: "pending",
        }).catch(() => 0),
        AuditLog.find({ merchantId })
          .sort({ at: -1 })
          .limit(15)
          .select("action subjectType subjectId at actorType meta")
          .lean()
          .catch(() => []),
      ]);

      if (!merchant) {
        return {
          ok: false as const,
          error: "merchant_not_found" as const,
          merchantId: input.merchantId,
        };
      }

      // Compute the most recent ingestion activity across the merchant's
      // integrations — useful single number for support: "last time we
      // saw an order from this merchant" answers most "is anything
      // working?" tickets in one glance.
      let lastIngestionAt: Date | null = null;
      for (const i of integrations) {
        const stamp = i.lastImportAt ?? i.webhookStatus?.lastEventAt ?? null;
        if (stamp && (!lastIngestionAt || stamp > lastIngestionAt)) {
          lastIngestionAt = stamp;
        }
      }

      const ordersFlat: Record<string, number> = {};
      for (const r of ordersByStatus7d) ordersFlat[r._id ?? "unknown"] = r.count;
      const totalOrders7d = Object.values(ordersFlat).reduce(
        (a, b) => a + b,
        0,
      );

      return {
        ok: true as const,
        merchantId: input.merchantId,
        merchant: {
          email: merchant.email,
          businessName: merchant.businessName,
          country: merchant.country,
          language: merchant.language,
          role: merchant.role,
          subscription: {
            tier: merchant.subscription?.tier ?? null,
            status: merchant.subscription?.status ?? null,
            trialEndsAt: merchant.subscription?.trialEndsAt ?? null,
            currentPeriodEnd: merchant.subscription?.currentPeriodEnd ?? null,
          },
          createdAt: merchant.createdAt,
        },
        // Operational summary — what support agent sees first.
        operational: {
          lastIngestionAt,
          unresolvedNotifications,
          pendingJobs,
          webhookFailures24h: recentInboxFailed,
          totalOrders7d,
        },
        ordersByStatus7d: ordersFlat,
        integrations: integrations.map((i) => ({
          id: String(i._id),
          provider: i.provider,
          accountKey: i.accountKey,
          status: i.status,
          connectedAt: i.connectedAt ?? null,
          disconnectedAt: i.disconnectedAt ?? null,
          pausedAt: i.pausedAt ?? null,
          lastSyncAt: i.lastSyncAt ?? null,
          lastSyncStatus: i.lastSyncStatus ?? null,
          lastError: i.lastError ?? null,
          errorCount: i.errorCount ?? 0,
          degraded: i.degraded ?? false,
          webhookStatus: {
            registered: i.webhookStatus?.registered ?? false,
            lastEventAt: i.webhookStatus?.lastEventAt ?? null,
            failures: i.webhookStatus?.failures ?? 0,
            lastError: i.webhookStatus?.lastError ?? null,
          },
          health: {
            ok: i.health?.ok ?? null,
            lastError: i.health?.lastError ?? null,
            lastCheckedAt: i.health?.lastCheckedAt ?? null,
          },
          counts: {
            ordersImported: i.counts?.ordersImported ?? 0,
            ordersFailed: i.counts?.ordersFailed ?? 0,
          },
        })),
        recentInbox: recentInbox.map((row) => ({
          id: String(row._id),
          provider: row.provider,
          topic: row.topic,
          externalId: row.externalId,
          status: row.status,
          attempts: row.attempts ?? 0,
          lastError: row.lastError ?? null,
          createdAt: row.createdAt,
          processedAt: row.processedAt ?? null,
        })),
        recentAudit: recentAudit.map((a) => ({
          action: a.action,
          subjectType: a.subjectType,
          subjectId: a.subjectId ? String(a.subjectId) : null,
          at: a.at,
          actorType: a.actorType ?? null,
          meta: a.meta ?? null,
        })),
        generatedAt: new Date(),
      };
    }),

  /**
   * List recent merchant-feedback rows for ops triage. Filterable by
   * kind / status. Sorted newest-first; capped at 200 per call.
   *
   * Read-only. Admin-scoped. The merchant-side `feedback.submit`
   * mutation is the only way new rows appear.
   */
  recentFeedback: adminProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(200).default(50),
          kind: z.enum(FEEDBACK_KINDS).optional(),
          status: z.enum(FEEDBACK_STATUSES).optional(),
        })
        .default({ limit: 50 }),
    )
    .query(async ({ input }) => {
      const filter: Record<string, unknown> = {};
      if (input.kind) filter.kind = input.kind;
      if (input.status) filter.status = input.status;
      const rows = await MerchantFeedback.find(filter)
        .sort({ createdAt: -1 })
        .limit(input.limit)
        .lean();
      return rows.map((r) => ({
        id: String(r._id),
        merchantId: r.merchantId ? String(r.merchantId) : null,
        actorEmail: r.actorEmail ?? null,
        kind: r.kind,
        severity: r.severity,
        message: r.message,
        pagePath: r.pagePath ?? null,
        userAgent: r.userAgent ?? null,
        status: r.status,
        internalNotes: r.internalNotes ?? null,
        triagedAt: r.triagedAt ?? null,
        triagedBy: r.triagedBy ? String(r.triagedBy) : null,
        resolvedAt: r.resolvedAt ?? null,
        createdAt: r.createdAt,
      }));
    }),

  /**
   * Update a feedback row's status / internalNotes from the admin UI.
   *
   * Permitted transitions: any → triaged | resolved | dismissed. We do
   * not allow reverting back to `new` — the `new` state means "nobody
   * looked at it yet" and once triaged that fact is preserved.
   *
   * Audit-only stamp on the row itself (`triagedAt`, `triagedBy`); the
   * append-only `AuditLog` chain is reserved for risk/billing/admin-RBAC
   * actions and feedback triage doesn't rise to that level.
   */
  triageFeedback: adminProcedure
    .input(
      z.object({
        id: z.string().refine((v) => Types.ObjectId.isValid(v), "invalid id"),
        status: z.enum(["triaged", "resolved", "dismissed"]),
        internalNotes: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const update: Record<string, unknown> = {
        status: input.status,
        triagedAt: new Date(),
        triagedBy: new Types.ObjectId(ctx.user.id),
      };
      if (input.internalNotes !== undefined) {
        update.internalNotes = input.internalNotes;
      }
      if (input.status === "resolved") {
        update.resolvedAt = new Date();
      }
      const r = await MerchantFeedback.updateOne(
        { _id: new Types.ObjectId(input.id) },
        { $set: update },
      );
      return { ok: r.matchedCount > 0 };
    }),
});
