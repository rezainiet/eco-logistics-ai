import { z } from "zod";
import { Types } from "mongoose";
import {
  AreaReliability,
  AuditLog,
  CourierLane,
  CourierPerformance,
  EXTERNAL_DELIVERY_PROVIDERS,
  ExternalDeliveryProfile,
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
import {
  getMerchantRolloutSnapshot,
  getRolloutState,
} from "../../lib/delivery-reliability-rollout.js";
import { snapshotReliabilityCounters } from "../../lib/observability/delivery-reliability.js";
import { reconcileSlice } from "../../lib/delivery-reliability-reconciliation.js";
import { loadReliabilityHealthSnapshot } from "../../lib/delivery-reliability-analytics.js";
import {
  reconcileAreaReliabilitySlice,
  reconcileCourierLaneSlice,
  reconcileCourierPerformanceSlice,
} from "../../lib/courier-reconciliation.js";
import {
  checkAreaReliabilityIntegrity,
  checkCourierLaneIntegrity,
  checkCourierPerformanceIntegrity,
} from "../../lib/lane-integrity.js";
import {
  snapshotHotKeys,
  snapshotLaneCounters,
} from "../../lib/observability/lane-intelligence.js";
import {
  getOrFetchExternalProfile,
  getInflightSize,
} from "../../lib/external-delivery/fetch-profile.js";
import {
  snapshotExternalDeliveryCounters,
  snapshotProviderLatency,
} from "../../lib/observability/external-delivery.js";
import {
  DEFAULT_EXTERNAL_PROVIDERS,
  type ExternalProviderAdapter,
} from "../../lib/external-delivery/providers/index.js";
import { parseBdCourierResponse } from "../../lib/external-delivery/providers/bdcourier.js";
import { hashPhoneForNetwork } from "../../lib/fraud-network.js";

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

  /* ======================================================================
   * Delivery Reliability — admin operational surfaces (S10).
   *
   * SAFETY CONTRACT (binding):
   *   - Read-only. Never writes. Never enqueues. Never triggers replay.
   *   - Admin-only via `adminProcedure`.
   *   - Lightweight — bounded scans only; no realtime subscriptions.
   *   - Surfaces existing state (rollout flags, in-process counters,
   *     reconciliation drift sample). Does NOT mutate any aggregate
   *     row, does NOT trigger repair (repair is CLI-only).
   * ====================================================================== */
  deliveryReliabilityRolloutState: adminProcedure
    .input(
      z
        .object({ merchantId: z.string().optional() })
        .optional()
        .default({}),
    )
    .query(({ input }) => {
      const state = getRolloutState();
      const counters = snapshotReliabilityCounters();
      const merchantSnapshot =
        input?.merchantId && Types.ObjectId.isValid(input.merchantId)
          ? getMerchantRolloutSnapshot(new Types.ObjectId(input.merchantId))
          : null;
      return {
        rollout: state,
        observabilityCounters: counters,
        merchant: merchantSnapshot,
        generatedAt: new Date(),
      };
    }),

  deliveryReliabilityMerchantHealth: adminProcedure
    .input(z.object({ merchantId: z.string().min(1) }))
    .query(async ({ input }) => {
      if (!Types.ObjectId.isValid(input.merchantId)) {
        return null;
      }
      return loadReliabilityHealthSnapshot({
        merchantId: new Types.ObjectId(input.merchantId),
      });
    }),

  deliveryReliabilityDriftSample: adminProcedure
    .input(
      z.object({
        merchantId: z.string().min(1),
        axis: z.enum(["customer", "address"]).default("customer"),
        scanLimit: z.number().int().min(1).max(10_000).optional(),
      }),
    )
    .query(async ({ input }) => {
      if (!Types.ObjectId.isValid(input.merchantId)) {
        return null;
      }
      return reconcileSlice({
        merchantId: new Types.ObjectId(input.merchantId),
        axis: input.axis,
        scanLimit: input.scanLimit,
      });
    }),

  /* ======================================================================
   *                Phase 3.5 — lane intelligence diagnostics
   * ====================================================================== */

  /**
   * Single-row integrity check for a CourierPerformance bucket. Pure
   * function — no scan, no reconciler. Returns IntegrityReport.
   */
  courierPerformanceIntegrity: adminProcedure
    .input(
      z.object({
        merchantId: z.string().min(1),
        courier: z.string().min(1).max(60),
        district: z.string().min(1).max(100),
      }),
    )
    .query(async ({ input }) => {
      if (!Types.ObjectId.isValid(input.merchantId)) return null;
      const row = await CourierPerformance.findOne({
        merchantId: new Types.ObjectId(input.merchantId),
        courier: input.courier.toLowerCase(),
        district: input.district,
      })
        .lean()
        .exec();
      return {
        exists: !!row,
        report: checkCourierPerformanceIntegrity(row, { now: new Date() }),
        sample: row
          ? {
              deliveredCount: row.deliveredCount,
              rtoCount: row.rtoCount,
              cancelledCount: row.cancelledCount,
              totalDeliveryHours: row.totalDeliveryHours,
              lastOutcomeAt: row.lastOutcomeAt,
            }
          : null,
      };
    }),

  /**
   * Single-row integrity check for a CourierLane bucket.
   */
  courierLaneIntegrity: adminProcedure
    .input(
      z.object({
        merchantId: z.string().min(1),
        courier: z.string().min(1).max(60),
        district: z.string().min(1).max(100),
        thana: z.string().min(1).max(100),
      }),
    )
    .query(async ({ input }) => {
      if (!Types.ObjectId.isValid(input.merchantId)) return null;
      const row = await CourierLane.findOne({
        merchantId: new Types.ObjectId(input.merchantId),
        courier: input.courier.toLowerCase(),
        district: input.district.toLowerCase(),
        thana: input.thana.toLowerCase(),
      })
        .lean()
        .exec();
      return {
        exists: !!row,
        report: checkCourierLaneIntegrity(row, { now: new Date() }),
        sample: row
          ? {
              deliveredCount: row.deliveredCount,
              rtoCount: row.rtoCount,
              cancelledCount: row.cancelledCount,
              totalDeliveryHours: row.totalDeliveryHours,
              attempt1Delivered: row.attempt1Delivered,
              attempt2Delivered: row.attempt2Delivered,
              attempt3PlusDelivered: row.attempt3PlusDelivered,
              firstOutcomeAt: row.firstOutcomeAt,
              lastOutcomeAt: row.lastOutcomeAt,
              pipelineVersion: row.pipelineVersion,
            }
          : null,
      };
    }),

  /**
   * Single-row integrity check for an AreaReliability bucket.
   */
  areaReliabilityIntegrity: adminProcedure
    .input(
      z.object({
        merchantId: z.string().min(1),
        division: z.string().min(1).max(100),
        district: z.string().min(1).max(100),
        thana: z.string().min(1).max(100),
      }),
    )
    .query(async ({ input }) => {
      if (!Types.ObjectId.isValid(input.merchantId)) return null;
      const row = await AreaReliability.findOne({
        merchantId: new Types.ObjectId(input.merchantId),
        division: input.division.toLowerCase(),
        district: input.district.toLowerCase(),
        thana: input.thana.toLowerCase(),
      })
        .lean()
        .exec();
      return {
        exists: !!row,
        report: checkAreaReliabilityIntegrity(row, { now: new Date() }),
        sample: row
          ? {
              deliveredCount: row.deliveredCount,
              rtoCount: row.rtoCount,
              cancelledCount: row.cancelledCount,
              unreachableCount: row.unreachableCount,
              recent7dDelivered: row.recent7dDelivered,
              recent7dRto: row.recent7dRto,
              recent7dCancelled: row.recent7dCancelled,
              recent7dWindowStartedAt: row.recent7dWindowStartedAt,
              firstOutcomeAt: row.firstOutcomeAt,
              lastOutcomeAt: row.lastOutcomeAt,
              pipelineVersion: row.pipelineVersion,
            }
          : null,
      };
    }),

  /**
   * Bounded reconciliation slice for CourierPerformance. Per-merchant,
   * optional courier filter. Read-only; never repairs.
   */
  courierPerformanceDriftSample: adminProcedure
    .input(
      z.object({
        merchantId: z.string().min(1),
        courier: z.string().max(60).optional(),
        scanLimit: z.number().int().min(1).max(10_000).optional(),
      }),
    )
    .query(async ({ input }) => {
      if (!Types.ObjectId.isValid(input.merchantId)) return null;
      return reconcileCourierPerformanceSlice({
        merchantId: new Types.ObjectId(input.merchantId),
        courier: input.courier,
        scanLimit: input.scanLimit,
      });
    }),

  /**
   * Bounded reconciliation slice for CourierLane.
   */
  courierLaneDriftSample: adminProcedure
    .input(
      z.object({
        merchantId: z.string().min(1),
        courier: z.string().max(60).optional(),
        scanLimit: z.number().int().min(1).max(10_000).optional(),
      }),
    )
    .query(async ({ input }) => {
      if (!Types.ObjectId.isValid(input.merchantId)) return null;
      return reconcileCourierLaneSlice({
        merchantId: new Types.ObjectId(input.merchantId),
        courier: input.courier,
        scanLimit: input.scanLimit,
      });
    }),

  /**
   * Bounded reconciliation slice for AreaReliability.
   */
  areaReliabilityDriftSample: adminProcedure
    .input(
      z.object({
        merchantId: z.string().min(1),
        scanLimit: z.number().int().min(1).max(10_000).optional(),
      }),
    )
    .query(async ({ input }) => {
      if (!Types.ObjectId.isValid(input.merchantId)) return null;
      return reconcileAreaReliabilitySlice({
        merchantId: new Types.ObjectId(input.merchantId),
        scanLimit: input.scanLimit,
      });
    }),

  /**
   * Per-process snapshot of the lane intelligence counters + hot-key
   * top-N. Per-pod view; aggregating across pods is left to the log
   * aggregator (every event is structured-logged).
   */
  laneObservabilitySnapshot: adminProcedure
    .input(
      z
        .object({
          topN: z.number().int().min(1).max(100).optional(),
        })
        .optional()
        .default({}),
    )
    .query(({ input }) => {
      return {
        counters: snapshotLaneCounters(),
        hotKeys: snapshotHotKeys(input?.topN ?? 20),
        generatedAt: new Date(),
      };
    }),

  /* ======================================================================
   *          Phase 4A admin tooling — external-delivery diagnostics
   * ====================================================================== */

  /**
   * Inspect a single (merchantId, phone) external profile. Returns
   * the full canonical shape — provider snapshots, aggregate, signals,
   * freshness, source path. NEVER exposes raw provider payloads or
   * API keys (parser already discards reports[] and per-courier
   * breakdowns at write time).
   *
   * `forceFetch=true` bypasses cache + Mongo freshness and triggers
   * a fresh provider fan-out — intended for staging verification.
   */
  externalProfileLookup: adminProcedure
    .input(
      z.object({
        merchantId: z.string().min(1),
        phone: z.string().min(1).max(64),
        forceFetch: z.boolean().optional().default(false),
      }),
    )
    .query(async ({ input }) => {
      if (!Types.ObjectId.isValid(input.merchantId)) {
        return { ok: false as const, error: "invalid_merchant_id" };
      }
      const profile = await getOrFetchExternalProfile({
        merchantId: input.merchantId,
        phone: input.phone,
        forceFetch: input.forceFetch,
      });
      if (!profile) {
        return {
          ok: true as const,
          exists: false,
          profile: null,
          diagnostic: {
            forceFetchUsed: input.forceFetch,
          },
        };
      }
      const failedProvidersCount = Object.values(profile.providers).filter(
        (p) => p.configured && !p.ok,
      ).length;
      return {
        ok: true as const,
        exists: true,
        profile,
        diagnostic: {
          source: profile.source,
          isFresh: !profile.freshness.stale,
          contributingProvidersCount:
            profile.aggregate.contributingProviders.length,
          failedProvidersCount,
          forceFetchUsed: input.forceFetch,
        },
      };
    }),

  /**
   * List profiles for a given signal flag. Bounded; admin-only.
   * Optionally scope to a single merchant. Output is intentionally
   * minimal (phoneHash + counters + signals) — never raw phone,
   * never order ids, never raw provider payloads.
   */
  externalProfileCohort: adminProcedure
    .input(
      z.object({
        merchantId: z.string().optional(),
        signal: z.enum([
          "strong_delivery_history",
          "elevated_return_pattern",
          "sparse_history",
          "mixed_delivery_history",
        ]),
        limit: z.number().int().min(1).max(100).optional().default(25),
      }),
    )
    .query(async ({ input }) => {
      const filter: Record<string, unknown> = {
        [`signals.${input.signal}`]: true,
      };
      if (input.merchantId) {
        if (!Types.ObjectId.isValid(input.merchantId)) {
          return { rows: [], truncated: false };
        }
        filter.merchantId = new Types.ObjectId(input.merchantId);
      }
      const limit = Math.max(1, Math.min(100, input.limit));
      const rows = (await ExternalDeliveryProfile.find(filter)
        .select(
          "merchantId phoneHash aggregate signals freshness pipelineVersion updatedAt",
        )
        .sort({ updatedAt: -1 })
        .limit(limit + 1)
        .lean()
        .exec()) as Array<{
        merchantId: { toString(): string };
        phoneHash: string;
        aggregate?: {
          total?: number;
          delivered?: number;
          rto?: number;
          cancelled?: number;
          successRate?: number | null;
          contributingProviders?: string[];
        };
        signals?: Record<string, boolean | undefined>;
        freshness?: { fetchedAt?: Date; expiresAt?: Date; stale?: boolean };
        pipelineVersion?: string;
        updatedAt?: Date;
      }>;
      const truncated = rows.length > limit;
      const trimmed = truncated ? rows.slice(0, limit) : rows;
      return {
        rows: trimmed.map((r) => ({
          merchantId: String(r.merchantId),
          // phoneHash is admin-readable but NOT a phone number; the raw
          // phone never appears in the cohort output.
          phoneHash: r.phoneHash,
          aggregate: {
            total: r.aggregate?.total ?? 0,
            delivered: r.aggregate?.delivered ?? 0,
            rto: r.aggregate?.rto ?? 0,
            cancelled: r.aggregate?.cancelled ?? 0,
            successRate: r.aggregate?.successRate ?? null,
            contributingProviders: r.aggregate?.contributingProviders ?? [],
          },
          signals: {
            strong_delivery_history:
              r.signals?.strong_delivery_history ?? false,
            elevated_return_pattern:
              r.signals?.elevated_return_pattern ?? false,
            sparse_history: r.signals?.sparse_history ?? true,
            mixed_delivery_history:
              r.signals?.mixed_delivery_history ?? false,
          },
          freshness: {
            fetchedAt: r.freshness?.fetchedAt ?? null,
            expiresAt: r.freshness?.expiresAt ?? null,
            stale: !!r.freshness?.stale,
          },
          pipelineVersion: r.pipelineVersion,
          updatedAt: r.updatedAt,
        })),
        truncated,
      };
    }),

  /**
   * Run the canonical parser against a pasted JSON payload. Pure
   * function — no I/O, never persists. Used for malformed-payload
   * replay during staging verification: ops captures a real
   * BDCourier response from logs and verifies the parser handles it
   * (or surfaces a parser gap).
   */
  externalProviderParserDryRun: adminProcedure
    .input(
      z.object({
        provider: z.enum(["bdcourier"]),
        payload: z.unknown(),
      }),
    )
    .query(({ input }) => {
      // Bound payload size defensively — admin tools shouldn't paste
      // multi-megabyte responses through tRPC.
      const serialized = (() => {
        try {
          return JSON.stringify(input.payload);
        } catch {
          return null;
        }
      })();
      if (!serialized || serialized.length > 64_000) {
        return {
          ok: false as const,
          error: "payload_too_large_or_unserialisable",
        };
      }
      if (input.provider === "bdcourier") {
        const r = parseBdCourierResponse(input.payload);
        return r;
      }
      return { ok: false as const, error: "unknown_provider" as const };
    }),

  /**
   * Aggregate counts + observability counter snapshot for the
   * external-delivery subsystem. Bounded; admin-only.
   */
  externalProfileStats: adminProcedure.query(async () => {
    const totalProfiles = await ExternalDeliveryProfile.estimatedDocumentCount();
    const [strong, elevated, sparse, mixed, stale] = await Promise.all([
      ExternalDeliveryProfile.countDocuments({
        "signals.strong_delivery_history": true,
      }),
      ExternalDeliveryProfile.countDocuments({
        "signals.elevated_return_pattern": true,
      }),
      ExternalDeliveryProfile.countDocuments({
        "signals.sparse_history": true,
      }),
      ExternalDeliveryProfile.countDocuments({
        "signals.mixed_delivery_history": true,
      }),
      ExternalDeliveryProfile.countDocuments({
        "freshness.expiresAt": { $lt: new Date() },
      }),
    ]);
    return {
      totalProfiles,
      profilesWithSignal: {
        strong_delivery_history: strong,
        elevated_return_pattern: elevated,
        sparse_history: sparse,
        mixed_delivery_history: mixed,
      },
      staleProfiles: stale,
      observabilityCounters: snapshotExternalDeliveryCounters(),
      generatedAt: new Date(),
    };
  }),

  /**
   * Per-provider configured state + latency / timeout / failure
   * statistics. Returns NEVER the API key, NEVER the URL with a key,
   * NEVER raw error bodies — only bounded summary metrics.
   */
  externalProviderHealth: adminProcedure.query(() => {
    const latencyByProvider = new Map(
      snapshotProviderLatency().map((p) => [p.provider, p]),
    );
    const adapters: ExternalProviderAdapter[] = DEFAULT_EXTERNAL_PROVIDERS.slice();
    const providers = adapters.map((a) => {
      const latency = latencyByProvider.get(a.name) ?? {
        provider: a.name,
        count: 0,
        meanMs: 0,
        maxMs: 0,
        timeoutCount: 0,
        failureCount: 0,
      };
      return {
        name: a.name,
        configured: a.isConfigured(),
        sourceVersion: a.sourceVersion,
        latency: {
          count: latency.count,
          meanMs: Math.round(latency.meanMs),
          maxMs: Math.round(latency.maxMs),
          timeoutCount: latency.timeoutCount,
          failureCount: latency.failureCount,
        },
      };
    });
    return {
      providers,
      catalogue: [...EXTERNAL_DELIVERY_PROVIDERS],
      generatedAt: new Date(),
    };
  }),

  /**
   * Cache hit/miss ratio + in-flight dedupe size. Per-process; cross-
   * pod aggregation lives at the log-aggregator layer.
   */
  externalCacheMetrics: adminProcedure.query(() => {
    const counters = snapshotExternalDeliveryCounters();
    return {
      cacheHit: counters.cacheHit,
      cacheMiss: counters.cacheMiss,
      cacheHitRatio: counters.cacheHitRatio,
      inflightDedupeSize: getInflightSize(),
      generatedAt: new Date(),
    };
  }),

  /**
   * List Shopify integrations whose stored credentials predate the
   * expiring-token rollout (no `refreshToken` and no
   * `accessTokenExpiresAt`). These integrations work in best-effort
   * mode — every Admin API call may surface a 403 if Shopify rejects
   * the legacy non-expiring token. Surfacing them here lets ops
   * proactively reach out to affected merchants with a "reconnect
   * required" prompt before order ingest goes silently broken.
   *
   * Read-only query — no migration is performed. The expected next
   * step after this list is an operator-driven email campaign or
   * an in-app banner; either is out of scope here.
   */
  legacyShopifyTokens: adminProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(500).default(100),
        })
        .default({ limit: 100 }),
    )
    .query(async ({ input }) => {
      const rows = await Integration.find({
        provider: "shopify",
        status: { $in: ["connected", "error"] },
        $or: [
          { "credentials.refreshToken": { $in: [null, undefined, ""] } },
          { "credentials.accessTokenExpiresAt": { $in: [null, undefined] } },
        ],
      })
        .select("_id merchantId accountKey status connectedAt lastError health webhookStatus")
        .sort({ connectedAt: 1 })
        .limit(input.limit)
        .lean();

      // Pull merchant emails for the operator's outreach list. Cheap
      // because we already have the bounded id set from the previous
      // query — no full-collection scan.
      const merchantIds = rows
        .map((r) => r.merchantId)
        .filter((id): id is Types.ObjectId => !!id);
      const merchants = await Merchant.find({ _id: { $in: merchantIds } })
        .select("_id email businessName")
        .lean();
      const merchantById = new Map(
        merchants.map((m) => [String(m._id), m]),
      );

      return {
        count: rows.length,
        rows: rows.map((r) => {
          const merchant = merchantById.get(String(r.merchantId));
          return {
            integrationId: String(r._id),
            merchantId: String(r.merchantId),
            merchantEmail: merchant?.email ?? null,
            merchantName: merchant?.businessName ?? null,
            shopDomain: r.accountKey,
            status: r.status,
            connectedAt: r.connectedAt ?? null,
            lastError: r.lastError ?? null,
            webhookRegistered: r.webhookStatus?.registered ?? false,
            healthOk: r.health?.ok ?? null,
          };
        }),
        generatedAt: new Date(),
      };
    }),
});
