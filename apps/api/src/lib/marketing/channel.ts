import type { Touch } from "@ecom/landing";
import { PAID_MEDIUMS } from "../../server/services/intelligence/campaignClassification.js";

/**
 * Marketing channel of one attribution touch — derived on the server, never
 * taken from the browser.
 *
 *   meta | google | tiktok   the platform the visit came from, paid or not
 *   organic                  unpaid search (or utm_medium=organic)
 *   referral                 another website linked here
 *   other                    tagged with UTM, but no known platform
 *   direct                   no attributable signal at all
 *
 * Reported alongside it, for orders with no attribution record:
 *   untracked                orders from other channels (dashboard, CSV,
 *                            integrations) or placed before attribution
 *
 * `paid` = an ad-click id was present or utm_medium is a paid medium (the
 * same lexicon the storefront campaign classification uses).
 */
export const MARKETING_CHANNELS = ["meta", "google", "tiktok", "organic", "referral", "other", "direct"] as const;
export type MarketingChannel = (typeof MARKETING_CHANNELS)[number];
export type ReportChannel = MarketingChannel | "untracked";

const PLATFORM_SOURCES: Record<"meta" | "google" | "tiktok", ReadonlySet<string>> = {
  meta: new Set(["facebook", "fb", "instagram", "ig", "meta", "messenger", "audience_network", "an"]),
  google: new Set(["google", "adwords", "googleads", "google_ads", "youtube", "yt", "gdn"]),
  tiktok: new Set(["tiktok", "tt", "tiktok_ads", "tiktokads"]),
};

const CLICK_ID_PLATFORM: Record<string, "meta" | "google" | "tiktok" | undefined> = {
  fbclid: "meta",
  gclid: "google",
  gbraid: "google",
  wbraid: "google",
  ttclid: "tiktok",
};

const SOCIAL_HOSTS: Array<[RegExp, "meta" | "tiktok"]> = [
  [/(^|\.)(facebook\.com|fb\.com|fb\.me|m\.me|messenger\.com|instagram\.com)$/, "meta"],
  [/(^|\.)tiktok\.com$/, "tiktok"],
];
const SEARCH_HOST = /(^|\.)(google\.[a-z.]+|bing\.com|yahoo\.com|duckduckgo\.com|yandex\.[a-z.]+|baidu\.com|ecosia\.org)$/;

export function classifyTouch(t: Pick<Touch, "source" | "medium" | "clickIdType" | "referrerHost"> | null | undefined): {
  channel: MarketingChannel;
  paid: boolean;
} {
  if (!t) return { channel: "direct", paid: false };
  const source = (t.source ?? "").trim().toLowerCase();
  const medium = (t.medium ?? "").trim().toLowerCase();
  const host = (t.referrerHost ?? "").trim().toLowerCase();
  const paid = !!t.clickIdType || (!!medium && (PAID_MEDIUMS.has(medium) || /(^|[_-])(cpc|ppc|paid)([_-]|$)/.test(medium)));

  const byClick = t.clickIdType ? CLICK_ID_PLATFORM[t.clickIdType] : undefined;
  if (byClick) return { channel: byClick, paid: true };
  for (const [platform, sources] of Object.entries(PLATFORM_SOURCES) as Array<["meta" | "google" | "tiktok", ReadonlySet<string>]>) {
    if (source && sources.has(source)) return { channel: platform, paid };
  }
  if (medium === "organic") return { channel: "organic", paid: false };
  if (!source && host) {
    if (SEARCH_HOST.test(host)) return { channel: "organic", paid: false };
    for (const [re, platform] of SOCIAL_HOSTS) if (re.test(host)) return { channel: platform, paid: false };
  }
  if (source || medium || t.clickIdType) return { channel: "other", paid };
  if (host) return { channel: "referral", paid: false };
  return { channel: "direct", paid: false };
}
