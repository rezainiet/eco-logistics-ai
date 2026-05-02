import { createHash } from "node:crypto";
import { Types } from "mongoose";
import { CallLog, Order } from "@ecom/db";

/**
 * Deterministic risk scoring engine. Pure-ish: given the order draft + a few
 * pre-fetched history aggregates, emits a stable 0-100 score, the signals
 * that contributed, and a level (low/medium/high).
 *
 * Weights are intentionally conservative — a single moderate signal shouldn't
 * flip to HIGH on its own; we want *combinations* of bad signals to trigger
 * manual review. This keeps false-positives low when merchants are new and
 * history is sparse.
 *
 * v2 additions (sprint Fraud v2):
 *   - duplicate_address signal (same normalized address reused by N phones)
 *   - blocked_phone / blocked_address signals (merchant-curated blacklists,
 *     auto-HIGH with max weight so a single hit forces review)
 *   - velocity_breach signal (N orders for same phone inside a window)
 *   - time-decayed history: every contributing past order is weighted by
 *     exp(-ageDays / halfLife) so old returns fade out
 *   - expanded fake-name heuristics (placeholder list, keyboard walks,
 *     vowel-less tokens, Bangla placeholders)
 */

export const RISK_TIERS = {
  lowMax: 39,
  mediumMax: 69,
} as const;

// Weights sum to well over 100 so no single signal guarantees high-risk,
// but several compounding signals reliably do. Cap at 100 at the end.
const WEIGHTS = {
  highCod: 18,
  extremeCod: 40,
  duplicatePhone: 10,
  duplicatePhoneHeavy: 25,
  priorReturns: 22,
  priorCancelled: 14,
  suspiciousDistrict: 16,
  fakeNamePattern: 25,
  unreachableHistory: 20,
  ipVelocity: 16,
  duplicateAddress: 22,
  // Rapid-fire orders from a single phone inside the velocity window are
  // a textbook fraud pattern (one buyer fanning out multiple deliveries
  // before a courier rejects any of them). Weight is set above the
  // medium/high boundary (69) so a single occurrence auto-lands HIGH on
  // its own, matching the merchant-facing "this should be reviewed"
  // expectation. Tunable per-merchant via `velocityThreshold`.
  velocityBreach: 75,
  // Garbage phones (all-same-digit, wrong country/format) are flagged on their
  // own — they're never legitimate. Heavy enough that combined with any one
  // other signal the order tips into HIGH.
  garbagePhone: 30,
  // Blocked lists are treated as hard-match signals — a single hit pushes the
  // order past the HIGH threshold on its own (weight > mediumMax + lowMax).
  blockedPhone: 100,
  blockedAddress: 100,
} as const;

/**
 * Static fallbacks. Used when the merchant has no order history yet — once
 * `p75OrderValue` / `avgOrderValue` are available we derive thresholds from
 * those instead, so a high-ticket merchant doesn't trip "high COD" on every
 * order and a low-ticket merchant doesn't sleep on a 5x outlier.
 */
const HIGH_COD_BDT = 4000;
const EXTREME_COD_BDT = 10000;
/** Floor that dynamic thresholds can't drop beneath — protects very-new merchants. */
const HIGH_COD_FLOOR = 1500;
const EXTREME_COD_FLOOR = 4000;
/** Multipliers applied to the merchant's p75 order value to derive thresholds. */
const HIGH_COD_P75_MULTIPLIER = 1.5;
const EXTREME_COD_P75_MULTIPLIER = 3.0;
/** Gold-tier definition — buyers with this much delivered history bypass soft signals. */
const GOLD_TIER_MIN_DELIVERED = 5;
const GOLD_TIER_MIN_SUCCESS_RATE = 0.85;
const SILVER_TIER_MIN_DELIVERED = 3;
const SILVER_TIER_MIN_SUCCESS_RATE = 0.7;
/** Default base rate for the P(RTO) calibration when the merchant has no tuning yet. */
const DEFAULT_BASE_RTO_RATE = 0.18;
/** Stable identifier for the platform-default weight set. */
export const DEFAULT_WEIGHTS_VERSION = "v2.0";
const DUP_PHONE_WARN = 3;
const DUP_PHONE_HEAVY = 6;
const IP_VELOCITY_WINDOW_MS = 10 * 60 * 1000;
const IP_VELOCITY_THRESHOLD = 5;
const ADDRESS_REUSE_THRESHOLD = 3; // distinct phones on the same address
const DEFAULT_HISTORY_HALF_LIFE_DAYS = 30;
/** History window cap — don't scan beyond this many days regardless of decay. */
const HISTORY_LOOKBACK_DAYS = 365;

const DEFAULT_SUSPICIOUS_DISTRICTS = new Set([
  "unknown",
  "n/a",
  "na",
  "test",
]);

// --- Fake-name heuristics ------------------------------------------------
// Loose on purpose — the call-center agent is the real arbiter; we just need
// to flag obvious filler entries. Order matters: hit the cheapest checks first.
const FAKE_NAME_REGEXES: RegExp[] = [
  /^(.)\1{2,}$/i, // "aaaa", "xxx"
  /^[^a-zA-Zঀ-৿]+$/, // only digits/punct (Bangla block included)
  /\b(test|fake|asdf|qwerty|xxx|dummy|sample|demo|tbd|na|no\s*name|noname|unknown|random|john\s*doe|jane\s*doe|abc|xyz|lorem|ipsum)\b/i,
  // Keyboard walks (row-wise & column-wise) of length ≥ 4.
  /(qwert|werty|ertyu|rtyui|tyuio|yuiop|asdfg|sdfgh|dfghj|fghjk|ghjkl|zxcvb|xcvbn|cvbnm)/i,
  /^(.)(.)\1\2$/i, // "abab"-style two-char alternation
];

const PLACEHOLDER_NAMES = new Set(
  [
    "name",
    "customer",
    "buyer",
    "user",
    "client",
    "recipient",
    "anonymous",
    "nobody",
    "someone",
    "mr",
    "mrs",
    "ms",
    "sir",
    "madam",
    "নাম", // Bangla "name"
    "ক্রেতা", // "buyer"
    "গ্রাহক", // "customer"
  ].map((s) => s.toLowerCase()),
);

function isFakeNamePattern(rawName: string): boolean {
  const name = rawName.trim();
  if (name.length < 3) return true;
  const lower = name.toLowerCase();
  if (PLACEHOLDER_NAMES.has(lower)) return true;
  if (FAKE_NAME_REGEXES.some((re) => re.test(name))) return true;
  // Single-token vowelless / consonant-walk (e.g. "bcdfg", "xkcd").
  const latinTokens = lower.split(/\s+/).filter((t) => /^[a-z]+$/.test(t));
  if (latinTokens.length === 1 && latinTokens[0]!.length >= 4 && !/[aeiouy]/.test(latinTokens[0]!)) {
    return true;
  }
  return false;
}

// --- Address fingerprint -------------------------------------------------
/**
 * Produces a stable SHA-256 fingerprint of `address + district`. The input
 * is lowercased, stripped of punctuation + collapsed whitespace, and tokens
 * are sorted so "House 1, Road 2, Dhaka" == "road 2 house 1 dhaka". This
 * lets us match addresses written in different orders while still being
 * robust to typos via tokenisation.
 *
 * Returns `null` when the address is empty or shorter than 4 meaningful
 * characters (don't fingerprint junk — it would collide heavily).
 */
export function hashAddress(address: string, district?: string): string | null {
  const raw = `${address ?? ""} ${district ?? ""}`.toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9ঀ-৿\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 4) return null;
  const tokens = cleaned.split(" ").filter(Boolean).sort();
  if (tokens.length === 0) return null;
  return createHash("sha256").update(tokens.join("|")).digest("hex").slice(0, 32);
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D+/g, "");
}

/**
 * Garbage-phone detector. A phone is garbage if it is structurally invalid or
 * a placeholder. Catches the obvious cases that no merchant blocklist will
 * ever cover: all-same-digit ("00000000000", "1111111111"), too-short/too-long,
 * or doesn't match the Bangladesh mobile shape (+8801XXXXXXXXX or 01XXXXXXXXX).
 *
 * Conservative: returns false for anything that *might* be a real foreign
 * number, since we don't want to false-positive merchants serving expats.
 */
function isGarbagePhone(rawPhone: string): boolean {
  const digits = normalizePhone(rawPhone);
  if (digits.length < 7 || digits.length > 15) return true;
  if (/^(\d)\1+$/.test(digits)) return true; // all-same-digit
  // BD mobile shape — if the number *looks* like a BD attempt (starts with
  // 880, 0, or has 11 digits) but doesn't match the canonical pattern, treat
  // as garbage. Foreign numbers (no leading 880/0) are left alone.
  const looksBD = digits.startsWith("880") || digits.startsWith("0") || digits.length === 11;
  if (looksBD) {
    // Canonical: 8801[3-9]XXXXXXXX  (13 digits) or 01[3-9]XXXXXXXX (11 digits).
    const canonical = /^(8801[3-9]\d{8}|01[3-9]\d{8})$/;
    if (!canonical.test(digits)) return true;
  }
  return false;
}

export type RiskLevel = "low" | "medium" | "high";
export type CustomerTier = "new" | "standard" | "silver" | "gold";

export interface DynamicThresholds {
  highCod: number;
  extremeCod: number;
  /** Where the threshold came from — surfaced in the agent UI. */
  source: "merchant_p75" | "merchant_avg" | "merchant_override" | "platform_default";
}
export type ReviewStatus =
  | "not_required"
  | "optional_review"
  | "pending_call"
  | "verified"
  | "rejected"
  | "no_answer";

export interface RiskSignal {
  key: string;
  weight: number;
  detail: string;
}

export type ConfidenceLabel = "Safe" | "Verify" | "Risky";

export interface RiskResult {
  riskScore: number;
  level: RiskLevel;
  reasons: string[];
  signals: RiskSignal[];
  reviewStatus: ReviewStatus;
  /** 0-100, mirror of (100 − riskScore). Higher = more trusted. */
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  /** True when one or more rules forced HIGH regardless of weight sum. */
  hardBlocked: boolean;
  /**
   * Calibrated probability that this order will end in RTO. Logistic over the
   * weight sum, anchored at the merchant's base RTO rate. The dashboard will
   * surface this as "P(RTO) = 23%" — easier for non-technical merchants to
   * reason about than a 0–100 score.
   */
  pRto: number;
  pRtoPct: number;
  /** Trust band derived from this customer's delivered/RTO history. */
  customerTier: CustomerTier;
  /** Thresholds actually applied + where they came from. */
  dynamicThresholds: DynamicThresholds;
  /** Identifier of the weight set used (for the feedback loop). */
  weightsVersion: string;
}

export interface RiskInputOrder {
  cod: number;
  customer: { name: string; phone: string; address?: string; district: string };
  ip?: string;
  addressHash?: string | null;
}

/**
 * Decay-weighted history aggregates. `*Count` fields carry the *decayed*
 * count — callers that need raw counts should compute their own aggregate.
 * Velocity-window counts (recent activity) are raw — decay doesn't apply at
 * the minute granularity.
 */
export interface RiskHistory {
  phoneOrdersCount: number;
  phoneReturnedCount: number;
  phoneCancelledCount: number;
  phoneUnreachableCount: number;
  ipRecentCount: number;
  phoneVelocityCount: number;
  addressDistinctPhones: number;
  addressReturnedCount: number;
  /** Decayed delivered count — optional so existing callers stay source-compat. */
  phoneDeliveredCount?: number;
  /** Raw (un-decayed) totals — for reputation reporting in the agent UI. */
  phoneTotalRaw?: number;
  phoneDeliveredRaw?: number;
  phoneReturnedRaw?: number;
  phoneCancelledRaw?: number;
}

export interface RiskOptions {
  suspiciousDistricts?: string[];
  highCodBdt?: number;
  extremeCodBdt?: number;
  blockedPhones?: string[];
  blockedAddresses?: string[];
  /** 0 disables the velocity signal entirely. */
  velocityThreshold?: number;
  /**
   * Merchant's 75th-percentile resolved-order COD. When supplied AND the
   * merchant hasn't pinned an explicit `highCodBdt`, thresholds derive from
   * this. Pulled from MerchantStats by the ingest layer.
   */
  p75OrderValue?: number;
  /** Mean order value — fallback when we have too few orders for a reliable p75. */
  avgOrderValue?: number;
  /**
   * Per-signal weight multipliers from the monthly tuner. Each multiplier
   * scales the platform default; missing keys mean "use default". Multipliers
   * are clamped to [0, 3] to bound runaway adjustments.
   */
  weightOverrides?: Record<string, number> | Map<string, number>;
  /** Anchor for the P(RTO) calibration; 0–1, defaults to platform mean. */
  baseRtoRate?: number;
  /** Version tag of the weight set in effect (carried into RiskResult). */
  weightsVersion?: string;
}

function classifyLevel(score: number): RiskLevel {
  if (score <= RISK_TIERS.lowMax) return "low";
  if (score <= RISK_TIERS.mediumMax) return "medium";
  return "high";
}

/**
 * Pick the COD thresholds for this scoring run. Precedence:
 *   1. Merchant explicit override (`opts.highCodBdt` / `opts.extremeCodBdt`)
 *   2. Derived from merchant's 75th-percentile resolved-order COD
 *   3. Derived from merchant's mean (when p75 isn't available yet)
 *   4. Platform defaults (HIGH_COD_BDT / EXTREME_COD_BDT)
 *
 * Floors clamp the dynamic path so a brand-new merchant with three ৳200
 * orders doesn't end up with a "high COD" threshold of ৳300.
 */
function resolveDynamicThresholds(opts: RiskOptions): DynamicThresholds {
  if (opts.highCodBdt != null || opts.extremeCodBdt != null) {
    return {
      highCod: opts.highCodBdt ?? HIGH_COD_BDT,
      extremeCod: opts.extremeCodBdt ?? EXTREME_COD_BDT,
      source: "merchant_override",
    };
  }
  if (opts.p75OrderValue && opts.p75OrderValue > 0) {
    const high = Math.max(
      HIGH_COD_FLOOR,
      Math.round(opts.p75OrderValue * HIGH_COD_P75_MULTIPLIER),
    );
    const extreme = Math.max(
      EXTREME_COD_FLOOR,
      Math.round(opts.p75OrderValue * EXTREME_COD_P75_MULTIPLIER),
      high + 1,
    );
    return { highCod: high, extremeCod: extreme, source: "merchant_p75" };
  }
  if (opts.avgOrderValue && opts.avgOrderValue > 0) {
    const high = Math.max(
      HIGH_COD_FLOOR,
      Math.round(opts.avgOrderValue * HIGH_COD_P75_MULTIPLIER * 1.2),
    );
    const extreme = Math.max(
      EXTREME_COD_FLOOR,
      Math.round(opts.avgOrderValue * EXTREME_COD_P75_MULTIPLIER * 1.2),
      high + 1,
    );
    return { highCod: high, extremeCod: extreme, source: "merchant_avg" };
  }
  return {
    highCod: HIGH_COD_BDT,
    extremeCod: EXTREME_COD_BDT,
    source: "platform_default",
  };
}

/**
 * Bucket the buyer into a trust tier from delivered / resolved history.
 * Gold buyers (>=5 deliveries, >85% success) bypass behavioural signals
 * (velocity, fake-name) — they've earned it. Soft signals only; hard
 * blocks (blocked_phone, garbage_phone) still fire so a stolen-account
 * scenario isn't laundered through a high-trust phone.
 */
export function classifyCustomerTier(history: RiskHistory): CustomerTier {
  const delivered = history.phoneDeliveredRaw ?? 0;
  const returned = history.phoneReturnedRaw ?? 0;
  const cancelled = history.phoneCancelledRaw ?? 0;
  const resolved = delivered + returned + cancelled;
  if (resolved === 0) return "new";
  const successRate = delivered / resolved;
  if (
    delivered >= GOLD_TIER_MIN_DELIVERED &&
    successRate > GOLD_TIER_MIN_SUCCESS_RATE
  ) {
    return "gold";
  }
  if (
    delivered >= SILVER_TIER_MIN_DELIVERED &&
    successRate >= SILVER_TIER_MIN_SUCCESS_RATE
  ) {
    return "silver";
  }
  return "standard";
}

/** Soft signals a Gold-tier buyer is allowed to bypass. */
const GOLD_TIER_BYPASS_KEYS = new Set<string>([
  "velocity_breach",
  "fake_name_pattern",
  "duplicate_phone",
  "duplicate_phone_heavy",
]);

/**
 * Apply per-signal weight overrides from the monthly tuner. Multiplier of
 * 1.0 keeps the platform default; <1 dampens a noisy signal; >1 amplifies a
 * predictive one. Clamped to [0, 3] so a regression in the tuner can't
 * cascade into pathological scoring.
 */
function effectiveWeight(
  key: keyof typeof WEIGHTS,
  overrides: RiskOptions["weightOverrides"],
): number {
  const baseline = WEIGHTS[key];
  if (!overrides) return baseline;
  const lookup =
    overrides instanceof Map
      ? overrides.get(key as string)
      : (overrides as Record<string, number>)[key as string];
  if (typeof lookup !== "number" || !Number.isFinite(lookup)) return baseline;
  const clamped = Math.max(0, Math.min(3, lookup));
  return Math.round(baseline * clamped);
}

/**
 * Convert weight-sum to a calibrated P(RTO). Logistic curve anchored so the
 * platform-default mid-score (50) maps to the merchant's base RTO rate.
 * Higher scores climb toward 1; lower scores collapse toward 0. The
 * `scale = 18` makes the band between LOW (39) and HIGH (70) a meaningful
 * 4×–5× probability swing, matching how merchants perceive these tiers.
 */
function scoreToProbability(score: number, baseRate: number): number {
  const anchor = Math.max(0.001, Math.min(0.999, baseRate));
  // Logit of the base rate is the "0-offset" — at score 50 the curve passes
  // through the merchant's base rate exactly.
  const logitBase = Math.log(anchor / (1 - anchor));
  const z = (score - 50) / 18 + logitBase;
  return 1 / (1 + Math.exp(-z));
}

/** Pure function: same inputs → same outputs. */
export function computeRisk(
  order: RiskInputOrder,
  history: RiskHistory,
  opts: RiskOptions = {},
): RiskResult {
  const signals: RiskSignal[] = [];
  const reasons: string[] = [];
  // Hard-block triggers — any one forces HIGH regardless of the weight sum.
  // Tracked separately so we can surface the *cause* in audit + UI.
  const hardBlockCauses: string[] = [];

  const dynamicThresholds = resolveDynamicThresholds(opts);
  const highCod = dynamicThresholds.highCod;
  const extremeCod = dynamicThresholds.extremeCod;
  const customerTier = classifyCustomerTier(history);
  const weightFor = (k: keyof typeof WEIGHTS) =>
    effectiveWeight(k, opts.weightOverrides);
  const isBypassed = (key: string) =>
    customerTier === "gold" && GOLD_TIER_BYPASS_KEYS.has(key);

  // --- Garbage-phone (structural) — HARD BLOCK. A phone that doesn't pass
  // the BD format check or is all-same-digit is never legitimate. We refuse
  // to ship to it without manual review.
  let garbagePhone = false;
  if (isGarbagePhone(order.customer.phone)) {
    garbagePhone = true;
    signals.push({
      key: "garbage_phone",
      weight: weightFor("garbagePhone"),
      detail: `Phone "${order.customer.phone}" is structurally invalid or a placeholder`,
    });
    reasons.push("Phone number is invalid or a placeholder");
    hardBlockCauses.push("garbage_phone");
  }

  // --- Merchant blacklists — HARD BLOCK. Merchant explicitly opted these
  // numbers/addresses out; we honor it without a margin of error.
  const normalizedPhone = normalizePhone(order.customer.phone);
  const blockedPhoneHit = (opts.blockedPhones ?? [])
    .map((p) => normalizePhone(p))
    .filter(Boolean)
    .some((p) => p === normalizedPhone);
  if (blockedPhoneHit) {
    signals.push({
      key: "blocked_phone",
      weight: weightFor("blockedPhone"),
      detail: `Phone on merchant blocklist`,
    });
    reasons.push("Phone is on the merchant block-list");
    hardBlockCauses.push("blocked_phone");
  }

  const blockedAddressHit =
    order.addressHash != null &&
    (opts.blockedAddresses ?? []).some((h) => h === order.addressHash);
  if (blockedAddressHit) {
    signals.push({
      key: "blocked_address",
      weight: weightFor("blockedAddress"),
      detail: `Address on merchant blocklist`,
    });
    reasons.push("Delivery address is on the merchant block-list");
    hardBlockCauses.push("blocked_address");
  }

  // --- COD magnitude -----------------------------------------------------
  let extremeCodHit = false;
  if (order.cod >= extremeCod) {
    extremeCodHit = true;
    signals.push({
      key: "extreme_cod",
      weight: weightFor("extremeCod"),
      detail: `COD ৳${order.cod.toLocaleString()} ≥ ৳${extremeCod.toLocaleString()}`,
    });
    reasons.push(`Very high COD amount: ৳${order.cod.toLocaleString()}`);
  } else if (order.cod >= highCod) {
    signals.push({
      key: "high_cod",
      weight: weightFor("highCod"),
      detail: `COD ৳${order.cod.toLocaleString()} ≥ ৳${highCod.toLocaleString()}`,
    });
    reasons.push(`High COD amount: ৳${order.cod.toLocaleString()}`);
  }

  // --- Phone duplication -------------------------------------------------
  // Gold-tier buyers earn this bypass: a repeat customer is *expected* to
  // have many prior orders. Standard/silver buyers still trip the signal.
  if (history.phoneOrdersCount >= DUP_PHONE_HEAVY && !isBypassed("duplicate_phone_heavy")) {
    signals.push({
      key: "duplicate_phone_heavy",
      weight: weightFor("duplicatePhoneHeavy"),
      detail: `${history.phoneOrdersCount.toFixed(1)} weighted prior orders from this phone`,
    });
    reasons.push(
      `Same phone used in ${Math.round(history.phoneOrdersCount)} previous orders`,
    );
  } else if (
    history.phoneOrdersCount >= DUP_PHONE_WARN &&
    !isBypassed("duplicate_phone")
  ) {
    signals.push({
      key: "duplicate_phone",
      weight: weightFor("duplicatePhone"),
      detail: `${history.phoneOrdersCount.toFixed(1)} weighted prior orders from this phone`,
    });
    reasons.push(
      `Same phone used in ${Math.round(history.phoneOrdersCount)} previous orders`,
    );
  }

  // --- Prior negative outcomes (decayed) ---------------------------------
  if (history.phoneReturnedCount > 0) {
    signals.push({
      key: "prior_returns",
      weight: weightFor("priorReturns"),
      detail: `${history.phoneReturnedCount.toFixed(1)} weighted prior return(s)`,
    });
    const n = Math.max(1, Math.round(history.phoneReturnedCount));
    reasons.push(
      `Customer has ${n} previous failed deliver${n === 1 ? "y" : "ies"} (RTO)`,
    );
  }

  if (history.phoneCancelledCount >= 2) {
    signals.push({
      key: "prior_cancelled",
      weight: weightFor("priorCancelled"),
      detail: `${history.phoneCancelledCount.toFixed(1)} weighted prior cancellations`,
    });
    reasons.push(
      `Customer cancelled ${Math.round(history.phoneCancelledCount)} previous orders`,
    );
  }

  // --- Reputation: low success rate when ≥3 prior outcomes -----------------
  // Counts only orders that have *resolved* (delivered/returned/cancelled);
  // pending shipments don't count for or against the customer yet.
  // Raw fields are optional in RiskHistory so the bulk-upload caller doesn't
  // have to compute them — that path skips this signal.
  const deliveredRaw = history.phoneDeliveredRaw ?? 0;
  const returnedRaw = history.phoneReturnedRaw ?? 0;
  const cancelledRaw = history.phoneCancelledRaw ?? 0;
  const priorResolved = deliveredRaw + returnedRaw + cancelledRaw;
  if (priorResolved >= 3) {
    const successRate = deliveredRaw / priorResolved;
    if (successRate < 0.4) {
      const weight =
        successRate < 0.2 ? weightFor("priorReturns") : weightFor("priorCancelled");
      signals.push({
        key: "low_success_rate",
        weight,
        detail: `Success rate ${Math.round(successRate * 100)}% (${deliveredRaw}/${priorResolved})`,
      });
      reasons.push(
        `Only ${Math.round(successRate * 100)}% of past orders were delivered (${deliveredRaw} of ${priorResolved})`,
      );
    }
  }

  // --- District / name heuristics ---------------------------------------
  const districts = new Set(
    (opts.suspiciousDistricts ?? []).map((d) => d.trim().toLowerCase()),
  );
  DEFAULT_SUSPICIOUS_DISTRICTS.forEach((d) => districts.add(d));
  const district = order.customer.district.trim().toLowerCase();
  let suspiciousDistrictHit = false;
  if (!district || districts.has(district)) {
    suspiciousDistrictHit = true;
    signals.push({
      key: "suspicious_district",
      weight: weightFor("suspiciousDistrict"),
      detail: district ? `District "${order.customer.district}" flagged` : "Missing district",
    });
    reasons.push(
      district
        ? `Delivery district "${order.customer.district}" is on the suspicious list`
        : "Delivery district is missing",
    );
  }

  if (isFakeNamePattern(order.customer.name) && !isBypassed("fake_name_pattern")) {
    signals.push({
      key: "fake_name_pattern",
      weight: weightFor("fakeNamePattern"),
      detail: `Name "${order.customer.name}" matches fake/gibberish pattern`,
    });
    reasons.push(
      `Customer name "${order.customer.name}" looks like a placeholder or fake entry`,
    );
  }

  // --- Hard-block COMBO: extreme COD + suspicious district. Either alone
  // doesn't force HIGH, but the combination is consistently a fraud pattern
  // in BD COD (large prepaid-without-prepaid + ambiguous delivery zone).
  if (extremeCodHit && suspiciousDistrictHit) {
    hardBlockCauses.push("extreme_cod_in_suspicious_district");
    reasons.push(
      "Very high COD into a suspicious district — auto-flagged for review",
    );
  }

  // --- Call history ------------------------------------------------------
  if (history.phoneUnreachableCount >= 2) {
    signals.push({
      key: "unreachable_history",
      weight: weightFor("unreachableHistory"),
      detail: `${history.phoneUnreachableCount.toFixed(1)} weighted unreachable attempts`,
    });
    reasons.push(
      `Customer was unreachable on ${Math.round(history.phoneUnreachableCount)} previous call attempt(s)`,
    );
  }

  // --- Real-time velocity -----------------------------------------------
  if (history.ipRecentCount >= IP_VELOCITY_THRESHOLD) {
    signals.push({
      key: "ip_velocity",
      weight: weightFor("ipVelocity"),
      detail: `${history.ipRecentCount} orders from same IP recently`,
    });
    reasons.push(
      `${history.ipRecentCount} orders placed from the same IP in the last few minutes`,
    );
  }

  // Default: 3 orders from the same phone inside the velocity window. Set
  // opts.velocityThreshold to a different positive number to override, or to
  // a negative number (e.g. -1) to disable on a per-merchant basis.
  const velocityThreshold = opts.velocityThreshold ?? 3;
  if (
    velocityThreshold > 0 &&
    history.phoneVelocityCount >= velocityThreshold &&
    !isBypassed("velocity_breach")
  ) {
    signals.push({
      key: "velocity_breach",
      weight: weightFor("velocityBreach"),
      detail: `${history.phoneVelocityCount} orders from this phone inside window`,
    });
    reasons.push(
      `${history.phoneVelocityCount} orders from this phone in the last few minutes`,
    );
  }

  // --- Address reuse -----------------------------------------------------
  if (history.addressDistinctPhones >= ADDRESS_REUSE_THRESHOLD) {
    signals.push({
      key: "duplicate_address",
      weight: weightFor("duplicateAddress"),
      detail: `${history.addressDistinctPhones} different phones shipped to this address`,
    });
    reasons.push(
      `Same address used by ${history.addressDistinctPhones} different phone numbers`,
    );
  } else if (history.addressReturnedCount > 0) {
    // Address has a prior RTO even if not widely reused — still a yellow flag.
    signals.push({
      key: "duplicate_address",
      weight: weightFor("duplicateAddress") / 2,
      detail: `${history.addressReturnedCount.toFixed(1)} prior return(s) at this address`,
    });
    reasons.push(`Previous failed delivery at this address`);
  }

  const raw = signals.reduce((sum, s) => sum + s.weight, 0);
  let riskScore = Math.min(100, Math.round(raw));
  const hardBlocked = hardBlockCauses.length > 0;
  // Hard block forces HIGH (>= mediumMax + 1) and pins the score to ≥85 so
  // the queue ranks these above any computed-medium order.
  if (hardBlocked) {
    riskScore = Math.max(riskScore, 85);
  }
  const level = classifyLevel(riskScore);

  // Confidence is the inverse of risk — what the merchant sees on the order
  // card. Labels: 0–39 risk → "Safe", 40–69 → "Verify", 70+ → "Risky".
  const confidence = Math.max(0, Math.min(100, 100 - riskScore));
  const confidenceLabel: ConfidenceLabel =
    level === "low" ? "Safe" : level === "medium" ? "Verify" : "Risky";

  // Calibrated probability — the user-facing scalar moving forward. Hard
  // blocks pin to ≥0.95 since the merchant has explicitly opted these out
  // (no point hedging the probability when policy already decided).
  const baseRate =
    typeof opts.baseRtoRate === "number" && opts.baseRtoRate > 0 && opts.baseRtoRate < 1
      ? opts.baseRtoRate
      : DEFAULT_BASE_RTO_RATE;
  let pRto = scoreToProbability(riskScore, baseRate);
  if (hardBlocked) pRto = Math.max(pRto, 0.95);
  const pRtoPct = Math.round(pRto * 1000) / 10; // one decimal place

  return {
    riskScore,
    level,
    reasons,
    signals,
    reviewStatus:
      level === "high"
        ? "pending_call"
        : level === "medium"
          ? "optional_review"
          : "not_required",
    confidence,
    confidenceLabel,
    hardBlocked,
    pRto,
    pRtoPct,
    customerTier,
    dynamicThresholds,
    weightsVersion: opts.weightsVersion ?? DEFAULT_WEIGHTS_VERSION,
  };
}

/**
 * Apply exponential decay to an event that happened `ageDays` ago. Half-life
 * of 30 days ≈ an event from 90 days ago counts for 1/8. Half-life of 0
 * disables decay entirely (callers get raw event counts back).
 */
function decayWeight(ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  // Clamp near-zero ages to a full unit weight. Without this, three orders
  // created back-to-back accumulate to 2.9999993, missing the `>= 3`
  // duplicate-phone threshold (DUP_PHONE_WARN) due to fp arithmetic in
  // Math.pow(2, -tinyDelta/halfLife).
  if (ageDays < 0.001) return 1;
  return Math.pow(2, -ageDays / halfLifeDays);
}

export interface CollectRiskHistoryArgs {
  merchantId: Types.ObjectId;
  phone: string;
  ip?: string;
  addressHash?: string | null;
  /** Current order id to exclude (so rescore doesn't count itself). */
  excludeOrderId?: Types.ObjectId;
  halfLifeDays?: number;
  velocityWindowMin?: number;
}

/**
 * Fetches the phone / IP / address history needed by computeRisk. Kept
 * separate so unit tests can exercise scoring without touching Mongo.
 *
 * Uses a single aggregation per resource (phones → orders, addresses →
 * orders) to keep the lookup cheap even for busy merchants.
 */
export async function collectRiskHistory(
  args: CollectRiskHistoryArgs,
): Promise<RiskHistory> {
  const halfLifeDays = args.halfLifeDays ?? DEFAULT_HISTORY_HALF_LIFE_DAYS;
  const velocityWindowMs = (args.velocityWindowMin ?? 10) * 60_000;
  const now = Date.now();
  const lookbackSince = new Date(now - HISTORY_LOOKBACK_DAYS * 86400_000);
  const velocitySince = new Date(now - velocityWindowMs);
  const ipWindowSince = new Date(now - IP_VELOCITY_WINDOW_MS);

  const phoneOrdersPromise = Order.find(
    {
      merchantId: args.merchantId,
      "customer.phone": args.phone,
      createdAt: { $gte: lookbackSince },
      ...(args.excludeOrderId ? { _id: { $ne: args.excludeOrderId } } : {}),
    },
    { "order.status": 1, createdAt: 1 },
  )
    .lean()
    .then((rows) => rows as Array<{ order?: { status?: string }; createdAt?: Date }>);

  const addressOrdersPromise = args.addressHash
    ? Order.find(
        {
          merchantId: args.merchantId,
          "source.addressHash": args.addressHash,
          createdAt: { $gte: lookbackSince },
          ...(args.excludeOrderId ? { _id: { $ne: args.excludeOrderId } } : {}),
        },
        { "customer.phone": 1, "order.status": 1, createdAt: 1 },
      )
        .lean()
        .then(
          (rows) =>
            rows as Array<{
              customer?: { phone?: string };
              order?: { status?: string };
              createdAt?: Date;
            }>,
        )
    : Promise.resolve([]);

  const unreachablePromise = CallLog.find(
    {
      merchantId: args.merchantId,
      customerPhone: args.phone,
      answered: false,
      timestamp: { $gte: lookbackSince },
    },
    { timestamp: 1 },
  )
    .lean()
    .then((rows) => rows as Array<{ timestamp?: Date }>);

  const ipRecentPromise = args.ip
    ? Order.countDocuments({
        merchantId: args.merchantId,
        "source.ip": args.ip,
        createdAt: { $gte: ipWindowSince },
        ...(args.excludeOrderId ? { _id: { $ne: args.excludeOrderId } } : {}),
      })
    : Promise.resolve(0);

  const velocityPromise = Order.countDocuments({
    merchantId: args.merchantId,
    "customer.phone": args.phone,
    createdAt: { $gte: velocitySince },
    ...(args.excludeOrderId ? { _id: { $ne: args.excludeOrderId } } : {}),
  });

  const [phoneOrders, addressOrders, unreachable, ipRecent, phoneVelocity] =
    await Promise.all([
      phoneOrdersPromise,
      addressOrdersPromise,
      unreachablePromise,
      ipRecentPromise,
      velocityPromise,
    ]);

  let phoneOrdersCount = 0;
  let phoneDeliveredCount = 0;
  let phoneReturnedCount = 0;
  let phoneCancelledCount = 0;
  let phoneTotalRaw = 0;
  let phoneDeliveredRaw = 0;
  let phoneReturnedRaw = 0;
  let phoneCancelledRaw = 0;
  for (const row of phoneOrders) {
    const age = row.createdAt
      ? Math.max(0, (now - row.createdAt.getTime()) / 86400_000)
      : 0;
    const w = decayWeight(age, halfLifeDays);
    phoneOrdersCount += w;
    phoneTotalRaw += 1;
    const status = row.order?.status;
    if (status === "delivered") {
      phoneDeliveredCount += w;
      phoneDeliveredRaw += 1;
    } else if (status === "rto") {
      phoneReturnedCount += w;
      phoneReturnedRaw += 1;
    } else if (status === "cancelled") {
      phoneCancelledCount += w;
      phoneCancelledRaw += 1;
    }
  }

  let addressReturnedCount = 0;
  const distinctPhones = new Set<string>();
  for (const row of addressOrders) {
    if (row.customer?.phone) distinctPhones.add(row.customer.phone);
    if (row.order?.status === "rto" && row.createdAt) {
      const age = Math.max(0, (now - row.createdAt.getTime()) / 86400_000);
      addressReturnedCount += decayWeight(age, halfLifeDays);
    }
  }
  // Current phone shouldn't count toward "distinct phones on this address".
  distinctPhones.delete(args.phone);

  let phoneUnreachableCount = 0;
  for (const row of unreachable) {
    const age = row.timestamp
      ? Math.max(0, (now - row.timestamp.getTime()) / 86400_000)
      : 0;
    phoneUnreachableCount += decayWeight(age, halfLifeDays);
  }

  return {
    phoneOrdersCount,
    phoneDeliveredCount,
    phoneReturnedCount,
    phoneCancelledCount,
    phoneUnreachableCount,
    ipRecentCount: ipRecent,
    phoneVelocityCount: phoneVelocity,
    addressDistinctPhones: distinctPhones.size,
    addressReturnedCount,
    phoneTotalRaw,
    phoneDeliveredRaw,
    phoneReturnedRaw,
    phoneCancelledRaw,
  };
}

/**
 * Batch variant of `collectRiskHistory` for the bulk-upload path. Computes
 * phone + address history for up to N unique keys in two aggregations total,
 * instead of N per key. Call once per CSV, then look up by phone/address.
 */
export async function collectRiskHistoryBatch(args: {
  merchantId: Types.ObjectId;
  phones: string[];
  addressHashes: string[];
  halfLifeDays?: number;
}): Promise<{
  byPhone: Map<string, {
    phoneOrdersCount: number;
    phoneReturnedCount: number;
    phoneCancelledCount: number;
    phoneUnreachableCount: number;
  }>;
  byAddress: Map<string, { addressDistinctPhones: number; addressReturnedCount: number }>;
}> {
  const halfLifeDays = args.halfLifeDays ?? DEFAULT_HISTORY_HALF_LIFE_DAYS;
  const now = Date.now();
  const lookbackSince = new Date(now - HISTORY_LOOKBACK_DAYS * 86400_000);

  const uniquePhones = Array.from(new Set(args.phones.filter(Boolean)));
  const uniqueAddresses = Array.from(new Set(args.addressHashes.filter(Boolean)));

  const byPhone = new Map<
    string,
    {
      phoneOrdersCount: number;
      phoneReturnedCount: number;
      phoneCancelledCount: number;
      phoneUnreachableCount: number;
    }
  >();
  for (const p of uniquePhones) {
    byPhone.set(p, {
      phoneOrdersCount: 0,
      phoneReturnedCount: 0,
      phoneCancelledCount: 0,
      phoneUnreachableCount: 0,
    });
  }

  const byAddress = new Map<
    string,
    { addressDistinctPhones: number; addressReturnedCount: number }
  >();
  for (const a of uniqueAddresses) {
    byAddress.set(a, { addressDistinctPhones: 0, addressReturnedCount: 0 });
  }

  if (uniquePhones.length > 0) {
    const phoneOrders = (await Order.find(
      {
        merchantId: args.merchantId,
        "customer.phone": { $in: uniquePhones },
        createdAt: { $gte: lookbackSince },
      },
      { "customer.phone": 1, "order.status": 1, createdAt: 1 },
    ).lean()) as Array<{
      customer?: { phone?: string };
      order?: { status?: string };
      createdAt?: Date;
    }>;
    for (const row of phoneOrders) {
      const phone = row.customer?.phone;
      if (!phone) continue;
      const bucket = byPhone.get(phone);
      if (!bucket) continue;
      const age = row.createdAt
        ? Math.max(0, (now - row.createdAt.getTime()) / 86400_000)
        : 0;
      const w = decayWeight(age, halfLifeDays);
      bucket.phoneOrdersCount += w;
      if (row.order?.status === "rto") bucket.phoneReturnedCount += w;
      if (row.order?.status === "cancelled") bucket.phoneCancelledCount += w;
    }

    const callRows = (await CallLog.find(
      {
        merchantId: args.merchantId,
        customerPhone: { $in: uniquePhones },
        answered: false,
        timestamp: { $gte: lookbackSince },
      },
      { customerPhone: 1, timestamp: 1 },
    ).lean()) as Array<{ customerPhone?: string; timestamp?: Date }>;
    for (const row of callRows) {
      const phone = row.customerPhone;
      if (!phone) continue;
      const bucket = byPhone.get(phone);
      if (!bucket) continue;
      const age = row.timestamp
        ? Math.max(0, (now - row.timestamp.getTime()) / 86400_000)
        : 0;
      bucket.phoneUnreachableCount += decayWeight(age, halfLifeDays);
    }
  }

  if (uniqueAddresses.length > 0) {
    const addrOrders = (await Order.find(
      {
        merchantId: args.merchantId,
        "source.addressHash": { $in: uniqueAddresses },
        createdAt: { $gte: lookbackSince },
      },
      {
        "customer.phone": 1,
        "source.addressHash": 1,
        "order.status": 1,
        createdAt: 1,
      },
    ).lean()) as Array<{
      customer?: { phone?: string };
      source?: { addressHash?: string };
      order?: { status?: string };
      createdAt?: Date;
    }>;
    const phoneByAddr = new Map<string, Set<string>>();
    for (const row of addrOrders) {
      const h = row.source?.addressHash;
      if (!h) continue;
      const bucket = byAddress.get(h);
      if (!bucket) continue;
      if (row.customer?.phone) {
        let set = phoneByAddr.get(h);
        if (!set) {
          set = new Set();
          phoneByAddr.set(h, set);
        }
        set.add(row.customer.phone);
      }
      if (row.order?.status === "rto" && row.createdAt) {
        const age = Math.max(0, (now - row.createdAt.getTime()) / 86400_000);
        bucket.addressReturnedCount += decayWeight(age, halfLifeDays);
      }
    }
    for (const [h, set] of phoneByAddr) {
      const bucket = byAddress.get(h);
      if (bucket) bucket.addressDistinctPhones = set.size;
    }
  }

  return { byPhone, byAddress };
}

export const __TEST = {
  WEIGHTS,
  HIGH_COD_BDT,
  EXTREME_COD_BDT,
  HIGH_COD_FLOOR,
  EXTREME_COD_FLOOR,
  HIGH_COD_P75_MULTIPLIER,
  EXTREME_COD_P75_MULTIPLIER,
  GOLD_TIER_MIN_DELIVERED,
  GOLD_TIER_MIN_SUCCESS_RATE,
  DEFAULT_BASE_RTO_RATE,
  DUP_PHONE_WARN,
  DUP_PHONE_HEAVY,
  IP_VELOCITY_THRESHOLD,
  ADDRESS_REUSE_THRESHOLD,
  DEFAULT_HISTORY_HALF_LIFE_DAYS,
  classifyLevel,
  decayWeight,
  isFakeNamePattern,
  hashAddress,
  resolveDynamicThresholds,
  scoreToProbability,
};
