/**
 * campaignClassification — single source of truth for how a tracking
 * session's UTM attribution maps into Cordon's four user-facing campaign
 * categories: organic / paid_social / direct / unknown.
 *
 * Used by:
 *   - the analytics campaign-source procedure
 *   - (future) cohort-level RTO scoring
 *   - (future) merchant ad-quality scoring
 *   - (future) intent-engine v2 organic_landing signal calibration
 *
 * Pure function. Same input → same output. The lexicons are deliberately
 * conservative — anything we can't classify falls into `unknown`, never
 * `direct`. `direct` requires the explicit "no source AND no medium"
 * shape so we don't accidentally call mistyped paid traffic "direct".
 *
 * Mirrors the heuristic in `lib/intent.ts` (`isPaidSocial` /
 * `isOrganicSearch`) — keeping the rules in lockstep matters because the
 * dashboard says "this campaign is paid social" while the intent score
 * says "buyer arrived organic". Drift between the two is a merchant-trust
 * regression.
 */

/**
 * Final categorisation surface. `no_session` is returned by aggregation
 * handlers (not this module) — it represents "we never observed a session
 * for this order"; this module classifies sessions we DID observe.
 */
export type CampaignCategory = "organic" | "paid_social" | "direct" | "unknown";

/** Source domains we recognize as paid-social ad targets. Matched on the
 *  exact lowercased source slug — the lexicon is small on purpose. */
const PAID_SOCIAL_SOURCES = new Set([
  "facebook", "fb", "instagram", "ig", "tiktok", "tt",
  "youtube", "yt", "twitter", "x", "snapchat",
]);

/** Mediums that imply paid traffic regardless of source domain. */
const PAID_MEDIUMS = new Set([
  "cpc", "ppc", "paid", "paid_social", "paidsocial",
  "social_paid", "display", "banner",
]);

/**
 * Categorise a session's campaign attribution.
 *
 * Decision order (longer-tail rules first so they win over fallbacks):
 *   1. Paid-medium match → paid_social.
 *   2. Medium === "organic" → organic.
 *   3. Source === "google" with no medium / organic medium → organic.
 *   4. Known paid-social source + paid-shaped medium → paid_social.
 *   5. Empty source AND empty medium → direct.
 *   6. Anything else → unknown.
 */
export function categoriseCampaign(c?: {
  source?: string | null;
  medium?: string | null;
}): CampaignCategory {
  const source = (c?.source ?? "").toLowerCase().trim();
  const medium = (c?.medium ?? "").toLowerCase().trim();
  if (medium && PAID_MEDIUMS.has(medium)) return "paid_social";
  if (medium === "organic") return "organic";
  if (source === "google" && (!medium || medium === "organic")) return "organic";
  if (
    source &&
    PAID_SOCIAL_SOURCES.has(source) &&
    medium &&
    /(cpc|paid|social)/i.test(medium)
  ) {
    return "paid_social";
  }
  if (!source && !medium) return "direct";
  return "unknown";
}

/** Test surface — never imported by production code. */
export const __TEST = {
  PAID_SOCIAL_SOURCES,
  PAID_MEDIUMS,
};
