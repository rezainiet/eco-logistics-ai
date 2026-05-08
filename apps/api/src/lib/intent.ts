/**
 * Intent Intelligence v1 — pure-function commitment scoring.
 *
 * The job:
 *   given the buyer's storefront-side behavioral sessions linked to this
 *   order (via `resolveIdentityForOrder`), produce an explainable 0–100
 *   commitment score, a tier label, and a set of human-readable signals
 *   the merchant can act on.
 *
 * The contract:
 *   - Pure function. Same inputs → same outputs. No DB calls, no clock
 *     reads aside from `computedAt`, no environment lookups.
 *   - No ML, no LLM, no opaque "AI" — every contribution carries a fixed
 *     integer weight and a `detail` string the UI can show verbatim.
 *   - Observation-only. v1 does NOT feed the risk score; we observe
 *     against `FraudPrediction.outcome` for ≥14 days before wiring into
 *     `computeRisk` (covered in roadmap Phase 7).
 *
 * Inputs are typed with a structural shape (`SessionInput`) — not the
 * Mongoose `TrackingSession` document — so this module stays test-friendly
 * and doesn't pull `@ecom/db` into the unit-test bundle.
 */

import type { Types } from "mongoose";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type IntentTier = "verified" | "implicit" | "unverified" | "no_data";

/** Stable signal keys — UI maps these to localized copy. */
export const INTENT_SIGNAL_KEYS = [
  "no_session_data",         // catch-all when no resolved session matched the order
  "repeat_visitor",          // session.repeatVisitor === true OR multi-session count
  "deep_engagement",         // productViews >= 3 OR maxScrollDepth >= 50
  "long_dwell",              // total durationMs >= 60s
  "funnel_completion",       // checkoutSubmit / checkoutStart >= 0.5
  "organic_landing",         // direct/organic — not paid social
  "multi_session_converter", // anonId observed across multiple days before order
  "confirmation_delivered",  // outbound SMS DLR landed (set by re-score, optional)
  "confirmation_replied",    // buyer replied YES with code (set by re-score, optional)
  "fast_confirmation",       // reply within 1h of prompt (set by re-score, optional)
] as const;
export type IntentSignalKey = (typeof INTENT_SIGNAL_KEYS)[number];

export interface IntentSignal {
  key: IntentSignalKey;
  weight: number;
  /** Operator-readable rationale. Surfaced verbatim in the dashboard. */
  detail: string;
}

export interface IntentResult {
  score: number;          // 0..100
  tier: IntentTier;
  signals: IntentSignal[];
  /** Number of distinct sessions that contributed (0 when no_data). */
  sessionsConsidered: number;
  computedAt: Date;
}

/**
 * Structural shape we read from. Matches a subset of the Mongoose
 * TrackingSession document. Listed explicitly so this file doesn't need
 * the model import (keeps the unit-test bundle lean).
 */
export interface SessionInput {
  pageViews?: number;
  productViews?: number;
  addToCartCount?: number;
  checkoutStartCount?: number;
  checkoutSubmitCount?: number;
  maxScrollDepth?: number;
  durationMs?: number;
  repeatVisitor?: boolean;
  landingPath?: string | null;
  campaign?: {
    source?: string | null;
    medium?: string | null;
    name?: string | null;
  } | null;
  firstSeenAt?: Date | null;
  lastSeenAt?: Date | null;
}

/**
 * Optional confirmation data layered on top of pure session input. Reserved
 * for a future re-score path that fires after DLR/reply lands. Not used at
 * order ingest in v1 (the order is fresh, no reply yet).
 */
export interface ConfirmationInput {
  /** From `Order.automation.confirmationDeliveryStatus`. */
  deliveryStatus?: "pending" | "delivered" | "failed" | "unknown";
  /** From `Order.automation.confirmationSentAt`. */
  sentAt?: Date | null;
  /** True when buyer replied YES via SMS — typically `automation.state === "confirmed"`
   *  with `decidedBy === "system"` (ie. SMS-driven, not manual). */
  replied?: boolean;
  /** When the reply landed. */
  repliedAt?: Date | null;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

interface AggregateSessionStats {
  pageViews: number;
  productViews: number;
  addToCartCount: number;
  checkoutStartCount: number;
  checkoutSubmitCount: number;
  maxScrollDepth: number;
  durationMs: number;
  repeatVisitor: boolean;
  spanDays: number;
  landing: string | null;
  source: string | null;
  medium: string | null;
}

function aggregate(sessions: SessionInput[]): AggregateSessionStats {
  const out: AggregateSessionStats = {
    pageViews: 0,
    productViews: 0,
    addToCartCount: 0,
    checkoutStartCount: 0,
    checkoutSubmitCount: 0,
    maxScrollDepth: 0,
    durationMs: 0,
    repeatVisitor: false,
    spanDays: 0,
    landing: null,
    source: null,
    medium: null,
  };

  let earliest: number | null = null;
  let latest: number | null = null;

  for (const s of sessions) {
    out.pageViews += s.pageViews ?? 0;
    out.productViews += s.productViews ?? 0;
    out.addToCartCount += s.addToCartCount ?? 0;
    out.checkoutStartCount += s.checkoutStartCount ?? 0;
    out.checkoutSubmitCount += s.checkoutSubmitCount ?? 0;
    out.maxScrollDepth = Math.max(out.maxScrollDepth, s.maxScrollDepth ?? 0);
    out.durationMs += s.durationMs ?? 0;
    if (s.repeatVisitor) out.repeatVisitor = true;
    if (!out.landing && s.landingPath) out.landing = s.landingPath;
    if (!out.source && s.campaign?.source) out.source = s.campaign.source;
    if (!out.medium && s.campaign?.medium) out.medium = s.campaign.medium;

    const first = s.firstSeenAt ? new Date(s.firstSeenAt).getTime() : null;
    const last = s.lastSeenAt ? new Date(s.lastSeenAt).getTime() : first;
    if (first !== null) {
      earliest = earliest === null ? first : Math.min(earliest, first);
    }
    if (last !== null) {
      latest = latest === null ? last : Math.max(latest, last);
    }
  }

  if (earliest !== null && latest !== null && latest > earliest) {
    out.spanDays = Math.floor((latest - earliest) / (24 * 60 * 60 * 1000));
  }
  return out;
}

/** Paid-social heuristic. Source/medium values that smell like paid social
 *  ad traffic. Conservative on purpose — anything we don't recognize is
 *  treated as "not paid social", which means it earns the organic bonus.
 *  Wrong direction here is benign (slight intent inflation); the strict
 *  direction would be wrong direction (under-rewarding genuine organic). */
const PAID_SOCIAL_SOURCES = new Set([
  "facebook", "fb", "instagram", "ig", "tiktok", "tt", "youtube", "yt",
  "twitter", "x", "snapchat",
]);
const PAID_MEDIUMS = new Set([
  "cpc", "ppc", "paid", "paid_social", "paidsocial", "social_paid",
  "display", "banner",
]);

function isPaidSocial(source: string | null, medium: string | null): boolean {
  if (medium && PAID_MEDIUMS.has(medium.toLowerCase())) return true;
  if (source && PAID_SOCIAL_SOURCES.has(source.toLowerCase()) &&
      medium && /(cpc|paid|social)/i.test(medium)) {
    return true;
  }
  return false;
}

function isOrganicSearch(source: string | null, medium: string | null): boolean {
  if (medium && /^organic$/i.test(medium)) return true;
  if (source && /^google$/i.test(source) && (!medium || /^organic$/i.test(medium))) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Public scorer                                                              */
/* -------------------------------------------------------------------------- */

export function computeIntentScore(
  sessions: SessionInput[] | null | undefined,
  confirmation?: ConfirmationInput,
): IntentResult {
  const arr = Array.isArray(sessions) ? sessions : [];
  if (arr.length === 0) {
    return {
      score: 0,
      tier: "no_data",
      signals: [
        {
          key: "no_session_data",
          weight: 0,
          detail:
            "No storefront session matched this order. Likely placed via dashboard, CSV import, or a storefront where the Cordon SDK is not installed.",
        },
      ],
      sessionsConsidered: 0,
      computedAt: new Date(),
    };
  }

  const a = aggregate(arr);
  const signals: IntentSignal[] = [];
  let score = 0;

  /* ---- Commitment subscore (max 40) ----
   * Weights chosen so a single-session strong-engagement-from-organic-
   * search case lands in the IMPLICIT band on its own (commitment 40 +
   * organic 15 = 55) and a multi-day-multi-session case crosses the
   * VERIFIED threshold (commitment 40 + organic 15 + multi-day 15 = 70).
   * A single-session paid-social user with confirmation-replied still
   * crosses verified (commitment 40 + reply 20 = 60... + delivered 5 = 65;
   * still implicit). Verified essentially requires either (multi-day +
   * organic) OR (any organic + confirmation reply). */

  if (a.repeatVisitor || arr.length >= 2) {
    score += 12;
    const detail =
      arr.length >= 2
        ? `Buyer visited your store across ${arr.length} sessions before placing this order.`
        : "Buyer had visited your store at least once before this session.";
    signals.push({ key: "repeat_visitor", weight: 12, detail });
  }

  if (a.productViews >= 3) {
    score += 8;
    signals.push({
      key: "deep_engagement",
      weight: 8,
      detail: `Buyer viewed ${a.productViews} products before checkout.`,
    });
  } else if (a.maxScrollDepth >= 50) {
    score += 8;
    signals.push({
      key: "deep_engagement",
      weight: 8,
      detail: `Buyer scrolled ${a.maxScrollDepth}% through the product page.`,
    });
  }

  if (a.durationMs >= 60_000) {
    score += 10;
    const seconds = Math.round(a.durationMs / 1000);
    signals.push({
      key: "long_dwell",
      weight: 10,
      detail: `Buyer spent ${seconds}s on your store before checking out.`,
    });
  }

  if (a.checkoutStartCount > 0) {
    const ratio = a.checkoutSubmitCount / a.checkoutStartCount;
    if (ratio >= 0.5) {
      score += 10;
      signals.push({
        key: "funnel_completion",
        weight: 10,
        detail: "Buyer reached the checkout submit step on their first or second try.",
      });
    }
  }

  /* ---- Engagement quality (max 30) ---- */

  const paidSocial = isPaidSocial(a.source, a.medium);
  const organicSearch = isOrganicSearch(a.source, a.medium);

  if (organicSearch) {
    score += 15;
    signals.push({
      key: "organic_landing",
      weight: 15,
      detail: `Buyer arrived from organic search (${a.source ?? "unknown engine"}).`,
    });
  } else if (!a.source && !a.medium && !paidSocial) {
    score += 10;
    signals.push({
      key: "organic_landing",
      weight: 10,
      detail: "Buyer arrived directly — no campaign attribution captured.",
    });
  }
  // Paid social earns no organic bonus. Intentional.

  if (arr.length >= 2 && a.spanDays >= 1) {
    score += 15;
    signals.push({
      key: "multi_session_converter",
      weight: 15,
      detail: `Buyer returned across ${a.spanDays} day${a.spanDays > 1 ? "s" : ""} before ordering.`,
    });
  }

  /* ---- Confirmation quality (max 30 — optional inputs) ---- */

  if (confirmation?.deliveryStatus === "delivered") {
    score += 5;
    signals.push({
      key: "confirmation_delivered",
      weight: 5,
      detail: "Order-confirmation SMS reached the buyer's handset (DLR confirmed).",
    });
  }
  if (confirmation?.replied) {
    score += 20;
    signals.push({
      key: "confirmation_replied",
      weight: 20,
      detail: "Buyer replied to confirm the order.",
    });
    if (
      confirmation.repliedAt &&
      confirmation.sentAt &&
      confirmation.repliedAt.getTime() - confirmation.sentAt.getTime() <= 60 * 60 * 1000
    ) {
      score += 5;
      signals.push({
        key: "fast_confirmation",
        weight: 5,
        detail: "Buyer replied within an hour of the prompt.",
      });
    }
  }

  /* ---- Clamp + tier ---- */

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  let tier: IntentTier;
  if (score >= 70) tier = "verified";
  else if (score >= 40) tier = "implicit";
  else tier = "unverified";

  return {
    score,
    tier,
    signals,
    sessionsConsidered: arr.length,
    computedAt: new Date(),
  };
}

/* -------------------------------------------------------------------------- */
/* Side-effecting helper — read sessions, write Order.intent                  */
/* -------------------------------------------------------------------------- */

/**
 * Read every TrackingSession resolved to this order, run `computeIntentScore`,
 * and stamp the result onto `Order.intent`.
 *
 * NEVER throws back into the caller — designed for fire-and-forget chaining
 * after `resolveIdentityForOrder`. On any DB error we log and walk away;
 * the next ingest of a sibling order re-tries cleanly.
 *
 * Observation-only contract — does NOT mutate `automation`, `fraud`, or
 * `order.status`. Only `intent` and the generic `version` counter.
 */
export async function scoreIntentForOrder(args: {
  merchantId: Types.ObjectId;
  orderId: Types.ObjectId;
}): Promise<IntentResult | null> {
  // Observability: measure DB-read latency separately from total wall time
  // so a slow Mongo can be distinguished from a slow handler. Aggregating
  // these structured logs across many ingests yields no_data rate, mean
  // tier mix, P95 latency. PII never leaves the call — only ObjectId hex
  // strings, tier label, and score scalar are emitted.
  const startedAtMs = Date.now();
  let dbReadMs = 0;
  try {
    const { Order, TrackingSession } = await import("@ecom/db");
    const t0 = Date.now();
    const sessions = (await TrackingSession.find({
      merchantId: args.merchantId,
      resolvedOrderId: args.orderId,
    })
      .select(
        "pageViews productViews addToCartCount checkoutStartCount checkoutSubmitCount maxScrollDepth durationMs repeatVisitor landingPath campaign firstSeenAt lastSeenAt",
      )
      .lean()) as unknown as SessionInput[];
    dbReadMs = Date.now() - t0;

    const result = computeIntentScore(sessions ?? []);

    // Observation-only update. We don't gate on `version` — `intent` is an
    // exclusive subdoc owned by this fire-and-forget; no other writer
    // touches it. The version bump is "good citizenship" so concurrent
    // mutations using `updateOrderWithVersion` see a fresh value.
    await Order.updateOne(
      { _id: args.orderId, merchantId: args.merchantId },
      {
        $set: {
          intent: {
            score: result.score,
            tier: result.tier,
            signals: result.signals,
            sessionsConsidered: result.sessionsConsidered,
            computedAt: result.computedAt,
          },
        },
        $inc: { version: 1 },
      },
    );

    // Single-line structured log. Fields are bounded and PII-free —
    // safe for ingestion into log aggregators. Aggregating yields:
    //   - no_data rate (count where tier=no_data / total)
    //   - tier distribution drift (group by tier over time)
    //   - DB read P95 (sort dbReadMs)
    //   - end-to-end P95 (sort totalMs)
    console.log(
      JSON.stringify({
        evt: "intent.scored",
        merchantId: String(args.merchantId),
        orderId: String(args.orderId),
        tier: result.tier,
        score: result.score,
        sessionsConsidered: result.sessionsConsidered,
        signalCount: result.signals.length,
        dbReadMs,
        totalMs: Date.now() - startedAtMs,
      }),
    );

    return result;
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "intent.scored_error",
        merchantId: String(args.merchantId),
        orderId: String(args.orderId),
        totalMs: Date.now() - startedAtMs,
        error: (err as Error).message?.slice(0, 200),
      }),
    );
    return null;
  }
}
