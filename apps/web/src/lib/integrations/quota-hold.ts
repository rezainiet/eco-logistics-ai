/**
 * Orders held because the monthly order quota is used up — how the
 * Integrations → Issues page presents them. The API holds such orders in
 * the webhook inbox (`needs_attention`, skipReason `order_quota_exceeded`);
 * they are received and stored, never created past the quota, and replayed
 * once there is capacity. Pure: the page passes in `listIssues` data.
 */

export const ORDER_QUOTA_REASON = "order_quota_exceeded";

export const UPGRADE_HREF = "/dashboard/billing";

export interface OrderQuotaLike {
  used: number;
  limit: number | null;
  /** Room for at least one more order right now. */
  available: boolean;
  planName: string;
}

export function isQuotaHeld(row: { skipReason?: string | null }): boolean {
  return row.skipReason === ORDER_QUOTA_REASON;
}

/** Replaying a held order only makes sense once there is room for it; other issues can always be replayed. */
export function canReplayIssue(row: { skipReason?: string | null }, quota: OrderQuotaLike | null | undefined): boolean {
  return !isQuotaHeld(row) || !!quota?.available;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The banner above the issues list; null when nothing is held. */
export function quotaHoldBanner(
  heldCount: number,
  quota: OrderQuotaLike | null | undefined,
): { title: string; body: string; tone: "warning" | "success"; showUpgrade: boolean; showReplay: boolean } | null {
  if (heldCount <= 0) return null;
  const held = plural(heldCount, "order is", "orders are");
  if (quota?.available) {
    return {
      title: `${held} held — you have order capacity again`,
      body: "They were received and kept safe while your monthly order quota was used up. Replay them now to create the orders.",
      tone: "success",
      showUpgrade: false,
      showReplay: true,
    };
  }
  const cap = quota && quota.limit !== null ? `${quota.used.toLocaleString("en-US")} / ${quota.limit.toLocaleString("en-US")} orders` : "your orders";
  return {
    title: `${held} held — monthly order quota reached`,
    body: `Your ${quota?.planName ?? "current"} plan has used ${cap} this month. New store orders are received and kept safe here — nothing is lost — but not created until there is room. Upgrade your plan, or wait for the monthly reset, then replay them.`,
    tone: "warning",
    showUpgrade: true,
    showReplay: false,
  };
}
