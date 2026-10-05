/**
 * Courier outcome notices from the in-app inbox (written by the API's
 * tracking pipeline). Unread ones are alerts: the bell counts them and the
 * drawer lists them; opening one marks it read.
 */

export const COURIER_NOTICE_KINDS = [
  "order.delivery_issue",
  "order.returned",
  "order.courier_cancel_required",
] as const;

export interface CourierNoticeLike {
  id: string;
  severity: "info" | "warning" | "critical" | string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string | Date;
}

export interface CourierNoticeRow {
  id: string;
  noticeId: string;
  tone: "danger" | "warning";
  title: string;
  body?: string;
  href?: string;
  timestamp: string | Date;
}

/** Inbox rows → drawer rows. Critical (cancel at courier) reads as danger. */
export function courierNoticeRows(items: readonly CourierNoticeLike[]): CourierNoticeRow[] {
  return items.map((n) => ({
    id: `notice:${n.id}`,
    noticeId: n.id,
    tone: n.severity === "critical" ? "danger" : "warning",
    title: n.title,
    ...(n.body ? { body: n.body } : {}),
    // Only in-app links are followed from the drawer.
    ...(n.link && n.link.startsWith("/dashboard") ? { href: n.link } : {}),
    timestamp: n.createdAt,
  }));
}
