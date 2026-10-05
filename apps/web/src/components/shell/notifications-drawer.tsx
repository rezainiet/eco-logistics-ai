"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertCircle,
  CheckCheck,
  CheckCircle2,
  Clock,
  Inbox,
  Info,
  LifeBuoy,
  Loader2,
  Package,
  PhoneOff,
  Plug,
  Scale,
  ShieldAlert,
  ShoppingBag,
  TrendingUp,
  Truck,
  type LucideIcon,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { EmptyState } from "@/components/ui/empty-state";
import { trpc } from "@/lib/trpc";
import { formatRelative } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { type AlertKind, buildAccountAlerts } from "@/lib/notifications/account-alerts";
import { CATEGORY_LABEL, type InboxCategory, inboxRows, inboxUnread } from "@/lib/notifications/inbox";

const ALERT_ICON: Record<AlertKind, LucideIcon> = {
  billing_past_due: AlertCircle,
  trial_expired: AlertCircle,
  trial_ending: Clock,
  quota_blocked: AlertCircle,
  quota_warning: TrendingUp,
  review_pending: ShieldAlert,
  review_no_answer: PhoneOff,
};

const CATEGORY_ICON: Record<InboxCategory, LucideIcon> = {
  order: ShoppingBag,
  verification: ShieldAlert,
  courier: Truck,
  stock: Package,
  integration: Plug,
  account: Info,
  compliance: Scale,
  recovery: LifeBuoy,
};

type NotificationTone = "danger" | "warning" | "info" | "success";

type NotificationItem = {
  id: string;
  tone: NotificationTone;
  icon: LucideIcon;
  title: string;
  body?: string;
  href?: string;
  timestamp?: Date | string;
  /** Inbox notification id — opening the row marks it read. */
  noticeId?: string;
  /** Inbox rows only: already read (shown muted). */
  read?: boolean;
  /** Inbox rows only: small category label. */
  label?: string;
};

const PAGE = 20;

/**
 * The merchant inbox (stored notifications: orders, verification, courier,
 * stock, integrations, account). The "unread" view is shared by the drawer
 * and the bell: the bell counts its `unread`, the drawer lists its rows.
 */
function useInboxUnread() {
  return trpc.notifications.inbox.useInfiniteQuery(
    { filter: "unread", limit: PAGE },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, staleTime: 30_000 },
  );
}

const TONE_BADGE: Record<NotificationTone, string> = {
  danger: "bg-danger-subtle text-danger",
  warning: "bg-warning-subtle text-warning",
  info: "bg-info-subtle text-info",
  success: "bg-success-subtle text-success",
};

type NotificationsDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unreadCount: number;
};

export function NotificationsDrawer({
  open,
  onOpenChange,
  unreadCount: _unreadCount,
}: NotificationsDrawerProps) {
  const utils = trpc.useUtils();
  const [view, setView] = React.useState<"unread" | "all">("unread");
  const fraudStats = trpc.fraud.getReviewStats.useQuery({ days: 7 });
  const plan = trpc.billing.getPlan.useQuery(undefined, { staleTime: 60_000 });
  const usage = trpc.billing.getUsage.useQuery(undefined, { staleTime: 60_000 });
  const inboxUnreadQuery = useInboxUnread();
  const inboxAll = trpc.notifications.inbox.useInfiniteQuery(
    { filter: "all", limit: PAGE },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, staleTime: 30_000, enabled: open && view === "all" },
  );
  const inbox = view === "unread" ? inboxUnreadQuery : inboxAll;
  const unread = inboxUnread(inboxUnreadQuery.data);
  const refresh = () => void utils.notifications.inbox.invalidate();
  const markRead = trpc.notifications.markRead.useMutation({ onSuccess: refresh });
  const markAllRead = trpc.notifications.markAllRead.useMutation({ onSuccess: refresh });
  const recentCalls = trpc.callCenter.getCallLogs.useQuery({
    limit: 5,
    callType: "all",
    cursor: null,
  });

  const alerts = React.useMemo<NotificationItem[]>(
    () =>
      // Alerts — exactly the set the bell counts (see useNotificationCount).
      buildAccountAlerts({
        subscription: plan.data?.subscription,
        meters: usage.data?.meters,
        reviewQueue: fraudStats.data?.queue,
      }).map((a) => ({ id: a.id, tone: a.tone, icon: ALERT_ICON[a.kind], title: a.title, body: a.body, href: a.href })),
    [fraudStats.data, plan.data, usage.data],
  );

  const notices = React.useMemo<NotificationItem[]>(
    () =>
      inboxRows(inbox.data?.pages.flatMap((p) => p.items) ?? []).map((n) => ({
        ...n,
        icon: CATEGORY_ICON[n.category],
        label: CATEGORY_LABEL[n.category],
      })),
    [inbox.data],
  );

  // Informational rows are not alerts and are never counted by the bell.
  const calls = React.useMemo<NotificationItem[]>(
    () =>
      (recentCalls.data?.calls ?? [])
        .filter((call) => !call.answered)
        .map((call) => ({
          id: `call:${call.id}`,
          tone: "info" as const,
          icon: PhoneOff,
          title: `Missed call: ${call.customerPhone ?? "Unknown"}`,
          body: call.deliveryStatus ? `Status: ${call.deliveryStatus}` : "Tap to retry from the call center.",
          href: "/dashboard/call-customer",
          timestamp: call.timestamp,
        })),
    [recentCalls.data],
  );

  const newestUnreadId = inboxUnreadQuery.data?.pages[0]?.items[0]?.id;
  const isLoading = fraudStats.isLoading || plan.isLoading || usage.isLoading || inbox.isLoading;
  const nothing = alerts.length === 0 && notices.length === 0 && calls.length === 0;
  const celebrate =
    nothing && view === "unread" && !!fraudStats.data?.today.codSaved && fraudStats.data.today.codSaved > 0;

  const openItem = (item: NotificationItem) => {
    if (item.noticeId && !item.read) markRead.mutate({ id: item.noticeId });
    if (item.href) onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full max-w-sm border-l border-stroke/10 bg-surface-overlay p-0"
      >
        <SheetHeader className="space-y-3 border-b border-stroke/8 px-5 py-4 text-left">
          <div>
            <SheetTitle className="text-base font-semibold text-fg">
              Notifications
            </SheetTitle>
            <SheetDescription className="text-xs text-fg-subtle">
              What needs your attention right now.
            </SheetDescription>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1" role="tablist" aria-label="Show">
              {(
                [
                  ["unread", `Unread${unread ? ` (${unread})` : ""}`],
                  ["all", "All"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={view === key}
                  onClick={() => setView(key)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    view === key ? "border-brand/40 bg-brand/10 text-fg" : "border-stroke/12 text-fg-subtle hover:text-fg",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {unread > 0 && newestUnreadId ? (
              <button
                type="button"
                onClick={() => markAllRead.mutate({ scope: "inbox", upToId: newestUnreadId })}
                disabled={markAllRead.isPending}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-fg-subtle hover:bg-surface-raised hover:text-fg disabled:opacity-50"
              >
                {markAllRead.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
                Mark all read
              </button>
            ) : null}
          </div>
        </SheetHeader>

        <div className="max-h-[calc(100vh-120px)] overflow-y-auto overflow-x-hidden px-3 py-3">
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-16 animate-shimmer rounded-md" />
              ))}
            </div>
          ) : celebrate ? (
            <ItemList
              items={[
                {
                  id: "win:cod-saved",
                  tone: "success",
                  icon: CheckCircle2,
                  title: "Nice — fraud queue saved you money today",
                  body: "Risk reviews are paying off.",
                  href: "/dashboard/fraud-review",
                },
              ]}
              onOpen={openItem}
            />
          ) : nothing ? (
            <EmptyState
              icon={Inbox}
              tone="success"
              title={view === "unread" ? "You're all caught up" : "No notifications yet"}
              description={
                view === "unread"
                  ? "No unread notifications, alerts or quota warnings."
                  : "Order, stock, courier and account notices will appear here."
              }
              className="border-0 bg-transparent"
            />
          ) : (
            <div className="space-y-4">
              {alerts.length ? <Section title="Needs attention" items={alerts} onOpen={openItem} /> : null}
              {notices.length ? (
                <Section title={view === "unread" ? "Unread" : "Recent"} items={notices} onOpen={openItem}>
                  {inbox.hasNextPage ? (
                    <button
                      type="button"
                      onClick={() => void inbox.fetchNextPage()}
                      disabled={inbox.isFetchingNextPage}
                      className="mt-1.5 w-full rounded-md border border-stroke/10 py-2 text-xs font-medium text-fg-subtle hover:bg-surface-raised hover:text-fg disabled:opacity-50"
                    >
                      {inbox.isFetchingNextPage ? "Loading…" : "Load more"}
                    </button>
                  ) : null}
                </Section>
              ) : null}
              {calls.length ? <Section title="Recent calls" items={calls} onOpen={openItem} /> : null}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Section({
  title,
  items,
  onOpen,
  children,
}: {
  title: string;
  items: NotificationItem[];
  onOpen: (item: NotificationItem) => void;
  children?: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1.5 px-1 text-2xs font-medium uppercase tracking-wide text-fg-faint">{title}</h3>
      <ItemList items={items} onOpen={onOpen} />
      {children}
    </section>
  );
}

function ItemList({ items, onOpen }: { items: NotificationItem[]; onOpen: (item: NotificationItem) => void }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item) => {
        const Icon = item.icon;
        const unread = item.noticeId ? !item.read : false;
        const className = cn(
          "flex w-full min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
          unread ? "border-brand/25 bg-brand/5" : "border-stroke/8 bg-surface",
          item.href && "hover:border-stroke/16 hover:bg-surface-raised/60",
          item.read && "opacity-75",
        );
        const content = (
          <>
            <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md", TONE_BADGE[item.tone])}>
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className={cn("break-words text-sm text-fg", unread ? "font-semibold" : "font-medium")}>{item.title}</p>
              {item.body ? <p className="break-words text-xs text-fg-subtle">{item.body}</p> : null}
              {item.timestamp || item.label ? (
                <p className="text-2xs text-fg-faint">
                  {item.label ? <span>{item.label}</span> : null}
                  {item.label && item.timestamp ? " · " : null}
                  {item.timestamp ? (
                    <time dateTime={new Date(item.timestamp).toISOString()} title={new Date(item.timestamp).toLocaleString()}>
                      {formatRelative(item.timestamp)}
                    </time>
                  ) : null}
                </p>
              ) : null}
            </div>
            {unread ? <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" aria-label="Unread" /> : null}
          </>
        );
        return (
          <li key={item.id}>
            {item.href ? (
              <Link href={item.href} onClick={() => onOpen(item)} className={className}>
                {content}
              </Link>
            ) : unread ? (
              <button type="button" onClick={() => onOpen(item)} className={className} title="Mark as read">
                {content}
              </button>
            ) : (
              <div className={className}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Unread count for the bell: the account alerts plus unread inbox
 * notifications — the same rows the drawer's Unread view renders, from the
 * same data.
 */
export function useNotificationCount(): number {
  const fraudStats = trpc.fraud.getReviewStats.useQuery({ days: 7 });
  const plan = trpc.billing.getPlan.useQuery(undefined, { staleTime: 60_000 });
  const usage = trpc.billing.getUsage.useQuery(undefined, { staleTime: 60_000 });
  const inboxUnreadQuery = useInboxUnread();
  return (
    buildAccountAlerts({
      subscription: plan.data?.subscription,
      meters: usage.data?.meters,
      reviewQueue: fraudStats.data?.queue,
    }).length + inboxUnread(inboxUnreadQuery.data)
  );
}
