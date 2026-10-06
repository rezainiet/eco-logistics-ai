import { Types } from "mongoose";
import type { NotificationKind } from "@ecom/db";

/**
 * The merchant inbox — which stored notifications the dashboard bell and
 * drawer show, how they are grouped, and where each one links.
 *
 * Same store as every other notification (models/notification.ts, written
 * through lib/notifications.ts#dispatchNotification and its dedupe keys);
 * this only decides what is merchant-facing. Left out on purpose:
 *   - queue.enqueue_failed / queue.stalled — infrastructure; surfaced by
 *     the dashboard's operational banner, not as per-merchant actions
 *   - admin.alert — platform anomaly fan-out to admins
 *   - automation.watchdog_exhausted — reserved, never written
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

export const INBOX_KIND_CATEGORY = {
  "order.new": "order",
  "fraud.pending_review": "verification",
  "fraud.rescored_high": "verification",
  "fraud.velocity_breach": "verification",
  "fraud.blocked_match": "verification",
  "automation.stale_pending": "verification",
  "order.customer_rejected": "verification",
  "order.delivery_issue": "courier",
  "order.returned": "courier",
  "order.courier_cancel_required": "courier",
  "order.booking_failed": "courier",
  "stock.low": "stock",
  "stock.out": "stock",
  "order.stock_issue": "stock",
  "integration.webhook_failed": "integration",
  "integration.webhook_needs_attention": "integration",
  "subscription.plan_downgrade_enforced": "account",
  "subscription.order_quota_reached": "account",
  "subscription.renewal_due": "account",
  "account.welcome": "account",
  "gdpr.data_request_received": "compliance",
  "recovery.cart_pending": "recovery",
} as const satisfies Partial<Record<NotificationKind, InboxCategory>>;

export type InboxKind = keyof typeof INBOX_KIND_CATEGORY;

export const INBOX_KINDS = Object.keys(INBOX_KIND_CATEGORY) as InboxKind[];

const VERIFICATION_KINDS = new Set<string>(
  Object.entries(INBOX_KIND_CATEGORY)
    .filter(([, c]) => c === "verification")
    .map(([k]) => k),
);

/**
 * Every in-app destination a notification may link to: each is an
 * existing dashboard page (tests/notification-inbox.test.ts checks the
 * page files) and the query parameter it acts on.
 */
export const INBOX_ROUTES = {
  orderFocus: "/dashboard/orders", // ?focus=<orderId> opens the order
  reviewOrder: "/dashboard/fraud-review", // ?id=<orderId> selects it in the review queue
  productStock: "/dashboard/products", // ?stock=<productId> opens its stock dialog
  integrationIssues: "/dashboard/settings/integrations/issues",
  integrations: "/dashboard/settings/integrations",
  billing: "/dashboard/settings/billing",
  recovery: "/dashboard/recovery",
  gettingStarted: "/dashboard/getting-started",
} as const;

const ALLOWED_PATHS = new Set<string>(Object.values(INBOX_ROUTES));

const isId = (v: unknown): v is Types.ObjectId | string =>
  !!v && Types.ObjectId.isValid(String(v)) && /^[a-f0-9]{24}$/i.test(String(v));

/** Accepts a stored link only if it is one of the known pages (query kept). */
function allowedStoredLink(link: string | null | undefined): string | null {
  if (!link || !link.startsWith("/dashboard")) return null;
  const path = link.split(/[?#]/)[0]!.replace(/\/$/, "");
  return ALLOWED_PATHS.has(path) ? link : null;
}

export interface InboxLinkInput {
  kind: string;
  link?: string | null;
  subjectType?: string | null;
  subjectId?: unknown;
}

/**
 * Where a notification opens. Derived from what it is about — the order,
 * the product, the integration — so rows written with an older or broken
 * link (e.g. `/dashboard/orders/<id>`, `/dashboard/orders?id=`, or the
 * integrations page instead of its issues list) still land correctly.
 * Review alerts open the review queue only on plans that have it;
 * otherwise the order itself. Returns null rather than a guessed link.
 */
export function resolveInboxLink(n: InboxLinkInput, ctx: { fraudReview: boolean }): string | null {
  const id = isId(n.subjectId) ? String(n.subjectId) : null;
  if (n.subjectType === "product" && id) return `${INBOX_ROUTES.productStock}?stock=${id}`;
  if (n.subjectType === "order" && id) {
    if (VERIFICATION_KINDS.has(n.kind) && ctx.fraudReview && n.kind !== "order.customer_rejected") {
      return `${INBOX_ROUTES.reviewOrder}?id=${id}`;
    }
    return `${INBOX_ROUTES.orderFocus}?focus=${id}`;
  }
  switch (n.kind) {
    case "integration.webhook_failed":
    case "integration.webhook_needs_attention":
    case "subscription.order_quota_reached":
      return INBOX_ROUTES.integrationIssues;
    case "subscription.plan_downgrade_enforced":
      return INBOX_ROUTES.integrations;
    case "subscription.renewal_due":
      return INBOX_ROUTES.billing;
    case "recovery.cart_pending":
      return INBOX_ROUTES.recovery;
    case "account.welcome":
      return INBOX_ROUTES.gettingStarted;
    default:
      return allowedStoredLink(n.link);
  }
}

export function inboxCategoryOf(kind: string): InboxCategory {
  return (INBOX_KIND_CATEGORY as Record<string, InboxCategory>)[kind] ?? "account";
}
