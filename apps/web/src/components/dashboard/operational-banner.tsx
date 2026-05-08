"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, Clock, Info } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useVisibilityInterval } from "@/lib/use-visibility-interval";

/**
 * Reads the merchant's recent in-app notifications and surfaces ONE plain-
 * language banner for the most-pressing operational issue. Pure read-only
 * derivation from existing data — no backend changes, no new endpoints.
 *
 * Priority order (only the highest-priority alert renders):
 *   1. Courier booking exhausted in last 24h          → re-auth prompt
 *   2. SMS gateway failures in last 24h               → balance / limit explanation
 *   3. Background queue (Redis) failures in last hour → recovery reassurance
 *   4. Many confirmations sent in the last 10 min     → "this takes a few minutes" hint
 *
 * If none of these conditions are met, the banner renders nothing.
 */
export function OperationalBanner() {
  const interval = useVisibilityInterval(60_000);
  const notifications = trpc.notifications.list.useQuery(
    { limit: 25, onlyUnread: false } as never,
    { staleTime: 30_000, refetchInterval: interval },
  );
  const orders = trpc.orders.listOrders.useQuery(
    { limit: 50 } as never,
    { staleTime: 30_000 },
  );

  if (notifications.isLoading) return null;
  if (notifications.isError) return null;

  type NotificationItem = {
    kind: string;
    title: string;
    body: string | null;
    createdAt: string | Date;
  };
  const items = (notifications.data?.items ?? []) as NotificationItem[];
  const now = Date.now();
  const within = (item: NotificationItem, ms: number) =>
    now - new Date(item.createdAt).getTime() <= ms;

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  // 1. Courier booking exhausted — highest priority because the merchant's
  //    orders are stuck waiting for a working courier connection.
  const courierFailures = items.filter(
    (n) => n.kind === "automation.watchdog_exhausted" && within(n, DAY),
  );
  if (courierFailures.length > 0) {
    return (
      <Banner
        tone="danger"
        icon={AlertTriangle}
        title={`Courier booking failed for ${courierFailures.length} order${courierFailures.length === 1 ? "" : "s"}`}
        body="Your courier connection may need re-authorization. Open Settings → Couriers and reconnect, then re-try the affected orders."
        ctaLabel="Open courier settings"
        ctaHref="/dashboard/settings?tab=couriers"
      />
    );
  }

  // 2. SMS gateway failures (we surface the DLR-fired fraud.pending_review
  //    notifications whose body indicates the gateway rejected the message).
  const smsFailures = items.filter(
    (n) =>
      n.kind === "fraud.pending_review" &&
      within(n, DAY) &&
      typeof n.body === "string" &&
      /confirmation sms|gateway|sms/i.test(n.body),
  );
  if (smsFailures.length >= 3) {
    return (
      <Banner
        tone="warning"
        icon={AlertTriangle}
        title={`${smsFailures.length} confirmation messages failed to send`}
        body="SMS delivery failed — this is usually due to gateway rate limits or insufficient SMS balance. Top up your SSL Wireless balance or wait a few minutes and retry."
      />
    );
  }

  // 3. Background queue trouble — usually a transient Redis blip. We tell
  //    the merchant we're handling it so they don't worry.
  const queueFailures = items.filter(
    (n) => n.kind === "queue.enqueue_failed" && within(n, HOUR),
  );
  if (queueFailures.length > 0) {
    return (
      <Banner
        tone="info"
        icon={Info}
        title="Background tasks delayed briefly"
        body="We had trouble queueing some background jobs. The system is recovering automatically — no action needed. Reach out to support if this banner stays for more than 10 minutes."
      />
    );
  }

  // 4. Many confirmations queued — proactive hint when the merchant has
  //    just bulk-uploaded. Derived from the orders list already loaded by
  //    the page, so no extra round-trip.
  if (!orders.isLoading && !orders.isError) {
    type OrderRow = {
      automation?: {
        state?: string;
        confirmationSentAt?: string | Date | null;
      };
      createdAt?: string | Date;
    };
    const recent: OrderRow[] = orders.data?.items ?? [];
    const TEN_MIN = 10 * 60 * 1000;
    const queuedCount = recent.filter((o) => {
      const state = o.automation?.state;
      if (state !== "pending_confirmation") return false;
      const sentAt = o.automation?.confirmationSentAt;
      // Either not yet sent OR sent in the last 10 minutes.
      if (!sentAt) return true;
      return now - new Date(sentAt).getTime() <= TEN_MIN;
    }).length;
    if (queuedCount >= 20) {
      return (
        <Banner
          tone="info"
          icon={Clock}
          title={`Sending ${queuedCount} confirmation messages`}
          body="This may take a few minutes — the SMS gateway processes them in batches. No action needed; you can keep working."
        />
      );
    }
  }

  return null;
}

function Banner({
  tone,
  icon: Icon,
  title,
  body,
  ctaLabel,
  ctaHref,
}: {
  tone: "info" | "warning" | "danger";
  icon: typeof AlertTriangle;
  title: string;
  body: string;
  ctaLabel?: string;
  ctaHref?: string;
}) {
  const styles =
    tone === "danger"
      ? "border-danger-border bg-danger-subtle text-danger"
      : tone === "warning"
        ? "border-warning-border bg-warning-subtle text-warning"
        : "border-info-border bg-info-subtle text-info";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mb-4 flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between ${styles}`}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="min-w-0 space-y-0.5 text-xs">
          <p className="font-semibold">{title}</p>
          <p className="opacity-90">{body}</p>
        </div>
      </div>
      {ctaLabel && ctaHref ? (
        <Link
          href={ctaHref}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-md border border-current px-3 text-2xs font-medium hover:bg-current/10"
        >
          {ctaLabel}
          <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}
