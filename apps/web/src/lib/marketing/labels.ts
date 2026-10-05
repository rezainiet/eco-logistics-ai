/**
 * Marketing report wording. Codes come from apps/api/src/lib/marketing/report.ts;
 * the web only names them — it never derives numbers of its own.
 */

export const CHANNEL_LABEL: Record<string, string> = {
  meta: "Meta (Facebook / Instagram)",
  google: "Google",
  tiktok: "TikTok",
  organic: "Organic search",
  referral: "Other websites",
  other: "Other (tagged)",
  direct: "Direct",
  untracked: "Not tracked",
};

export const TRAFFIC_LABEL: Record<string, { label: string; hint: string }> = {
  paid: { label: "Paid ads", hint: "Ad click id or a paid utm_medium" },
  organic: { label: "Organic", hint: "Search, social or another site — not paid" },
  direct: { label: "Direct", hint: "Typed or saved link, no tracking signal" },
  other: { label: "Other tagged", hint: "UTM-tagged, not an ad platform (e.g. email, SMS)" },
  untracked: { label: "Not tracked", hint: "Created outside your landing pages" },
};

export interface MarketingWarning {
  code: "paid_without_spend" | "spend_without_orders" | "cost_missing" | "courier_fee_missing" | "untracked_share";
  channel?: string;
  count?: number;
}

const plural = (n: number | undefined, one: string, many: string) => `${n ?? 0} ${(n ?? 0) === 1 ? one : many}`;

/** One plain sentence per incomplete-data warning. */
export function warningText(w: MarketingWarning): string {
  const ch = w.channel ? (CHANNEL_LABEL[w.channel] ?? w.channel) : "";
  switch (w.code) {
    case "paid_without_spend":
      return `${ch} brought ${plural(w.count, "order", "orders")} but no ${ch} ad spend is entered for this period — cost per order, ROAS and profit for it can't be shown.`;
    case "spend_without_orders":
      return `${ch} ad spend is entered but no orders are attributed to ${ch} in this period — check your ad links carry UTM tags.`;
    case "cost_missing":
      return `Product cost is not recorded for ${plural(w.count, "delivered order", "delivered orders")} — profit is shown only where every cost is known.`;
    case "courier_fee_missing":
      return `Courier fee is not recorded for ${plural(w.count, "shipped order", "shipped orders")} — profit is shown only where every cost is known.`;
    case "untracked_share":
      return `${plural(w.count, "order", "orders")} in this period came from outside your landing pages, so they have no ad source.`;
  }
}

/** "12.5%" or "—" when there was nothing to divide by. */
export function formatRate(rate: number | null | undefined): string {
  return rate === null || rate === undefined || !Number.isFinite(rate) ? "—" : `${rate}%`;
}
