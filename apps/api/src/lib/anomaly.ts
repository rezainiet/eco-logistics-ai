import { Types } from "mongoose";
import {
  AuditLog,
  Order,
  Payment,
  WebhookInbox,
} from "@ecom/db";
import { writeAdminAudit } from "./audit.js";

/**
 * Lightweight anomaly detection for the admin observability surface.
 *
 * Each check compares a short window (last hour) against a reference
 * window (preceding 24h, excluding the short window). When the short
 * window's rate is materially higher than the reference rate AND the
 * absolute count is non-trivial, we fire an `alert.fired` audit row that
 * the admin alert dashboard surfaces.
 *
 * The detection is deliberately blunt — z-score-style comparisons against
 * a 24h baseline catch the obvious shift-in-distribution failures without
 * chasing seasonal precision. Tuning the thresholds is cheap: env vars
 * gate every numeric knob.
 *
 * Contract: each detector returns null when there is no anomaly, or an
 * Alert object when one fires. The caller decides whether to write it.
 */

export interface Alert {
  kind:
    | "payment_spike"
    | "webhook_failure_spike"
    | "automation_failure_spike"
    | "fraud_spike";
  severity: "info" | "warning" | "critical";
  shortCount: number;
  baselineRate: number;
  shortRate: number;
  message: string;
  meta?: Record<string, unknown>;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface WindowCounts {
  shortCount: number; // last hour
  baselineCount: number; // preceding 23h (24h window minus the short window)
}

function rates(counts: WindowCounts): { shortRate: number; baselineRate: number } {
  return {
    shortRate: counts.shortCount, // count per hour
    baselineRate: counts.baselineCount / 23, // mean per hour over baseline
  };
}

/**
 * Decide whether the short-window rate is anomalous against the baseline.
 *
 *  - shortCount must clear the absolute floor (otherwise sparse data
 *    produces noisy alerts; you can't have a "spike" of 2 events).
 *  - shortRate must exceed baselineRate × multiplier OR baselineRate must
 *    be zero with shortCount above floor (unprecedented activity).
 */
function isAnomalous(opts: {
  shortCount: number;
  shortRate: number;
  baselineRate: number;
  floor: number;
  multiplier: number;
}): boolean {
  if (opts.shortCount < opts.floor) return false;
  if (opts.baselineRate === 0) return opts.shortCount >= opts.floor;
  return opts.shortRate >= opts.baselineRate * opts.multiplier;
}

async function countPaymentsInWindow(since: Date, until: Date): Promise<number> {
  return Payment.countDocuments({
    provider: "manual",
    createdAt: { $gte: since, $lt: until },
  });
}

export async function detectPaymentSpike(now = new Date()): Promise<Alert | null> {
  const shortStart = new Date(now.getTime() - HOUR_MS);
  const baselineStart = new Date(now.getTime() - DAY_MS);
  const [shortCount, dayCount] = await Promise.all([
    countPaymentsInWindow(shortStart, now),
    countPaymentsInWindow(baselineStart, now),
  ]);
  const baselineCount = Math.max(0, dayCount - shortCount);
  const { shortRate, baselineRate } = rates({ shortCount, baselineCount });
  if (
    isAnomalous({
      shortCount,
      shortRate,
      baselineRate,
      floor: 10,
      multiplier: 3,
    })
  ) {
    return {
      kind: "payment_spike",
      severity: shortCount >= 30 ? "critical" : "warning",
      shortCount,
      baselineRate,
      shortRate,
      message: `Manual payment submissions spiked: ${shortCount} in last hour vs ${baselineRate.toFixed(1)}/h baseline`,
      meta: { dayCount, baselineCount },
    };
  }
  return null;
}

export async function detectWebhookFailureSpike(
  now = new Date(),
): Promise<Alert | null> {
  const shortStart = new Date(now.getTime() - HOUR_MS);
  const baselineStart = new Date(now.getTime() - DAY_MS);
  const [shortCount, dayCount] = await Promise.all([
    WebhookInbox.countDocuments({
      status: "failed",
      updatedAt: { $gte: shortStart, $lt: now },
    }),
    WebhookInbox.countDocuments({
      status: "failed",
      updatedAt: { $gte: baselineStart, $lt: now },
    }),
  ]);
  const baselineCount = Math.max(0, dayCount - shortCount);
  const { shortRate, baselineRate } = rates({ shortCount, baselineCount });
  if (
    isAnomalous({
      shortCount,
      shortRate,
      baselineRate,
      floor: 5,
      multiplier: 4,
    })
  ) {
    return {
      kind: "webhook_failure_spike",
      severity: shortCount >= 25 ? "critical" : "warning",
      shortCount,
      baselineRate,
      shortRate,
      message: `Webhook failures spiked: ${shortCount} in last hour vs ${baselineRate.toFixed(1)}/h baseline`,
      meta: { dayCount, baselineCount },
    };
  }
  return null;
}

export async function detectAutomationFailureSpike(
  now = new Date(),
): Promise<Alert | null> {
  const shortStart = new Date(now.getTime() - HOUR_MS);
  const baselineStart = new Date(now.getTime() - DAY_MS);
  const failureActions = [
    "automation.auto_book_failed",
    "automation.confirmation_sms_failed",
    "automation.watchdog_exhausted",
  ];
  const [shortCount, dayCount] = await Promise.all([
    AuditLog.countDocuments({
      action: { $in: failureActions },
      at: { $gte: shortStart, $lt: now },
    }),
    AuditLog.countDocuments({
      action: { $in: failureActions },
      at: { $gte: baselineStart, $lt: now },
    }),
  ]);
  const baselineCount = Math.max(0, dayCount - shortCount);
  const { shortRate, baselineRate } = rates({ shortCount, baselineCount });
  if (
    isAnomalous({
      shortCount,
      shortRate,
      baselineRate,
      floor: 10,
      multiplier: 3,
    })
  ) {
    return {
      kind: "automation_failure_spike",
      severity: shortCount >= 50 ? "critical" : "warning",
      shortCount,
      baselineRate,
      shortRate,
      message: `Automation failures spiked: ${shortCount} in last hour vs ${baselineRate.toFixed(1)}/h baseline`,
      meta: { dayCount, baselineCount },
    };
  }
  return null;
}

export async function detectFraudSpike(now = new Date()): Promise<Alert | null> {
  const shortStart = new Date(now.getTime() - HOUR_MS);
  const baselineStart = new Date(now.getTime() - DAY_MS);
  const [shortCount, dayCount] = await Promise.all([
    Order.countDocuments({
      "fraud.level": "high",
      createdAt: { $gte: shortStart, $lt: now },
    }),
    Order.countDocuments({
      "fraud.level": "high",
      createdAt: { $gte: baselineStart, $lt: now },
    }),
  ]);
  const baselineCount = Math.max(0, dayCount - shortCount);
  const { shortRate, baselineRate } = rates({ shortCount, baselineCount });
  if (
    isAnomalous({
      shortCount,
      shortRate,
      baselineRate,
      floor: 10,
      multiplier: 2.5,
    })
  ) {
    return {
      kind: "fraud_spike",
      severity: shortCount >= 50 ? "critical" : "warning",
      shortCount,
      baselineRate,
      shortRate,
      message: `High-risk orders spiked: ${shortCount} in last hour vs ${baselineRate.toFixed(1)}/h baseline`,
      meta: { dayCount, baselineCount },
    };
  }
  return null;
}

/**
 * Dedupe key for the in-store rate-limit. We don't want a long-running
 * anomaly to fire 60 times in an hour. The audit row carries a
 * dedupeKey in meta so the worker can refuse to re-fire within the
 * cooldown.
 */
export function alertDedupeKey(kind: Alert["kind"]): string {
  // Snap to hour granularity so the same anomaly-kind alert only fires
  // once per hour.
  const hour = Math.floor(Date.now() / HOUR_MS);
  return `${kind}:${hour}`;
}

/**
 * Run every detector. Each is independent — one failing doesn't gate the
 * others. Returns the alerts that fired (post-dedupe).
 */
export async function runAnomalyDetection(): Promise<Alert[]> {
  const fired: Alert[] = [];
  const detectors = [
    detectPaymentSpike,
    detectWebhookFailureSpike,
    detectAutomationFailureSpike,
    detectFraudSpike,
  ];
  for (const detector of detectors) {
    try {
      const result = await detector();
      if (!result) continue;
      const dedupeKey = alertDedupeKey(result.kind);
      // Refuse to fire if we already wrote this dedupeKey within the hour.
      const existing = await AuditLog.findOne({
        action: "alert.fired",
        "meta.dedupeKey": dedupeKey,
      })
        .select("_id")
        .lean();
      if (existing) continue;
      await writeAdminAudit({
        actorType: "system",
        action: "alert.fired",
        subjectType: "system",
        subjectId: new Types.ObjectId(),
        meta: {
          dedupeKey,
          kind: result.kind,
          severity: result.severity,
          message: result.message,
          shortCount: result.shortCount,
          baselineRate: result.baselineRate,
          shortRate: result.shortRate,
          ...result.meta,
        },
      });
      fired.push(result);

      // Fan-out to admins. The audit row is already written and is the
      // source of truth — this is a side-effect that delivers in-app /
      // email / SMS based on each admin's preferences. Lazy import keeps
      // the dependency cycle clean (admin-alerts → email/sms → env), and
      // any delivery failure surfaces in the dispatcher's error array but
      // never reaches back into the detector loop.
      void (async () => {
        try {
          const { deliverAdminAlert } = await import("./admin-alerts.js");
          await deliverAdminAlert({ ...result, dedupeKey });
        } catch (err) {
          console.error(
            "[anomaly] admin alert delivery failed",
            (err as Error).message,
          );
        }
      })();
    } catch (err) {
      console.error("[anomaly] detector failed", (err as Error).message);
    }
  }
  return fired;
}
