/**
 * Merchant inbox rows (trpc.notifications.inbox) → what the bell drawer
 * renders. Which notifications exist, and where each links, is decided by
 * the API (apps/api/src/lib/notification-inbox.ts); this only presents
 * them. The bell counts `unread` from the same query the drawer lists.
 */

export type InboxCategory =
  | "order"
  | "verification"
  | "courier"
  | "stock"
  | "integration"
  | "account"
  | "compliance"
  | "recovery";

export interface InboxItemLike {
  id: string;
  category: InboxCategory | string;
  severity: "info" | "warning" | "critical" | string;
  title: string;
  body: string | null;
  href: string | null;
  read: boolean;
  createdAt: string | Date;
}

export interface InboxRow {
  id: string;
  noticeId: string;
  category: InboxCategory;
  tone: "danger" | "warning" | "info";
  title: string;
  body?: string;
  href?: string;
  read: boolean;
  timestamp: string | Date;
}

const CATEGORIES = new Set<string>(["order", "verification", "courier", "stock", "integration", "account", "compliance", "recovery"]);

export const CATEGORY_LABEL: Record<InboxCategory, string> = {
  order: "Order",
  verification: "Verification",
  courier: "Courier",
  stock: "Stock",
  integration: "Integration",
  account: "Account",
  compliance: "Compliance",
  recovery: "Recovery",
};

export function inboxRows(items: readonly InboxItemLike[]): InboxRow[] {
  return items.map((n) => ({
    id: `notice:${n.id}`,
    noticeId: n.id,
    category: (CATEGORIES.has(n.category) ? n.category : "account") as InboxCategory,
    tone: n.severity === "critical" ? "danger" : n.severity === "warning" ? "warning" : "info",
    title: n.title,
    ...(n.body ? { body: n.body } : {}),
    // Only in-app dashboard links are followed from the drawer.
    ...(n.href && n.href.startsWith("/dashboard") ? { href: n.href } : {}),
    read: n.read,
    timestamp: n.createdAt,
  }));
}

/** Unread inbox notifications, from the first page of the inbox query (0 while loading). */
export function inboxUnread(data: { pages?: ReadonlyArray<{ unread: number }> } | undefined): number {
  return data?.pages?.[0]?.unread ?? 0;
}
