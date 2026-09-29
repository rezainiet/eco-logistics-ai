import { classifyMeter, type UsageMeterLike } from "@/lib/billing/meters";

/**
 * Account alerts — the things that need the merchant's attention. Single
 * source for BOTH the notification bell's unread count and the alert rows
 * in the notifications drawer, so the badge can never count something the
 * drawer doesn't show (the "1 unread" / "You're all caught up" mismatch).
 *
 * Pure: takes the already-fetched tRPC data, returns plain objects. The
 * drawer adds icons and may append informational rows (missed calls, a
 * "saved money today" note) that are not alerts and are never counted.
 */

export type AlertTone = "danger" | "warning" | "info" | "success";

export type AlertKind =
  | "billing_past_due"
  | "trial_expired"
  | "trial_ending"
  | "quota_blocked"
  | "quota_warning"
  | "review_pending"
  | "review_no_answer";

export interface AccountAlert {
  id: string;
  kind: AlertKind;
  tone: AlertTone;
  title: string;
  body: string;
  href: string;
}

export interface AccountAlertInputs {
  subscription?: {
    status?: string | null;
    trialExpired?: boolean | null;
    trialDaysLeft?: number | null;
  } | null;
  meters?: ReadonlyArray<UsageMeterLike> | null;
  reviewQueue?: { pending?: number | null; noAnswer?: number | null } | null;
}

// Human copy for raw camelCase metric identifiers.
const METRIC_LABELS: Record<string, string> = {
  fraudReviewsUsed: "fraud reviews this month",
  fraudReviews: "fraud reviews this month",
  smsSent: "SMS messages this month",
  smsUsed: "SMS messages this month",
  ordersIngested: "orders this month",
  ordersUsed: "orders this month",
  ordersCreated: "orders this month",
  shipmentsBooked: "shipments this month",
  callsInitiated: "calls this month",
  callMinutesUsed: "call minutes this month",
  webhookEvents: "webhook events this month",
};

export function humanMetric(metric: string): string {
  if (METRIC_LABELS[metric]) return METRIC_LABELS[metric]!;
  return metric.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
}

export function buildAccountAlerts(input: AccountAlertInputs): AccountAlert[] {
  const out: AccountAlert[] = [];

  const sub = input.subscription;
  if (sub?.status === "past_due") {
    out.push({
      id: "billing:past-due",
      kind: "billing_past_due",
      tone: "danger",
      title: "Subscription past due",
      body: "Submit a payment to restore access to your dashboard.",
      href: "/dashboard/billing",
    });
  }
  if (sub?.trialExpired) {
    out.push({
      id: "billing:trial-expired",
      kind: "trial_expired",
      tone: "danger",
      title: "Trial has ended",
      body: "Choose a plan to keep using ConfirmX.",
      href: "/dashboard/billing",
    });
  }
  // "Ends soon" only while the trial is still running — never next to "Trial has ended".
  if (!sub?.trialExpired && sub?.status === "trial" && typeof sub.trialDaysLeft === "number" && sub.trialDaysLeft <= 3) {
    out.push({
      id: "billing:trial-soon",
      kind: "trial_ending",
      tone: "warning",
      title: `Trial ends in ${sub.trialDaysLeft} day${sub.trialDaysLeft === 1 ? "" : "s"}`,
      body: "Upgrade now to avoid interruption.",
      href: "/dashboard/billing",
    });
  }

  // One alert per meter that is actually at / near its limit. A feature
  // outside the plan (limit 0, nothing used) is not an alert.
  for (const m of input.meters ?? []) {
    const state = classifyMeter(m);
    if (state === "blocked") {
      out.push({
        id: `usage:blocked:${m.metric}`,
        kind: "quota_blocked",
        tone: "danger",
        title: `Quota exceeded: ${humanMetric(m.metric)}`,
        body: "Upgrade your plan to keep operating.",
        href: "/dashboard/billing",
      });
    } else if (state === "warning") {
      const pct = Math.round((m.ratio ?? 0) * 100);
      out.push({
        id: `usage:warn:${m.metric}`,
        kind: "quota_warning",
        tone: "warning",
        title: `${pct}% of ${humanMetric(m.metric)} quota used`,
        body: "Consider upgrading before you hit the limit.",
        href: "/dashboard/billing",
      });
    }
  }

  const pending = input.reviewQueue?.pending ?? 0;
  if (pending > 0) {
    out.push({
      id: "fraud:pending",
      kind: "review_pending",
      tone: "warning",
      title: `${pending} order${pending === 1 ? "" : "s"} pending call review`,
      body: "These orders cannot be booked until reviewed.",
      href: "/dashboard/fraud-review",
    });
  }
  const noAnswer = input.reviewQueue?.noAnswer ?? 0;
  if (noAnswer > 0) {
    out.push({
      id: "fraud:noanswer",
      kind: "review_no_answer",
      tone: "danger",
      title: `${noAnswer} order${noAnswer === 1 ? "" : "s"} marked no answer`,
      body: "Try calling again or reject if unreachable.",
      href: "/dashboard/fraud-review",
    });
  }

  return out;
}
