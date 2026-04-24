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
  extremeCod: 30,
  duplicatePhone: 10,
  duplicatePhoneHeavy: 25,
  priorReturns: 22,
  priorCancelled: 14,
  suspiciousDistrict: 16,
  fakeNamePattern: 18,
  unreachableHistory: 20,
  ipVelocity: 16,
  duplicateAddress: 22,
  velocityBreach: 28,
  // Blocked lists are treated as hard-match signals — a single hit pushes the
  // order past the HIGH threshold on its own (weight > mediumMax + lowMax).
  blockedPhone: 100,
  blockedAddress: 100,
} as const;

const HIGH_COD_BDT = 4000;
const EXTREME_COD_BDT = 10000;
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

export type RiskLevel = "low" | "medium" | "high";
export type ReviewStatus =
  | "not_required"
  | "pending_call"
  | "verified"
  | "rejected"
  | "no_answer";

export interface RiskSignal {
  key: string;
  weight: number;
  detail: string;
}

export interface RiskResult {
  riskScore: number;
  level: RiskLevel;
  reasons: string[];
  signals: RiskSignal[];
  reviewStatus: ReviewStatus;
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
}

export interface RiskOptions {
  suspiciousDistricts?: string[];
  highCodBdt?: number;
  extremeCodBdt?: number;
  blockedPhones?: string[];
  blockedAddresses?: string[];
  /** 0 disables the velocity signal entirely. */
  velocityThreshold?: number;
}

function classifyLevel(score: number): RiskLevel {
  if (score <= RISK_TIERS.lowMax) return "low";
  if (score <= RISK_TIERS.mediumMax) return "medium";
  return "high";
}

/** Pure function: same inputs → same outputs. */
export function computeRisk(
  order: RiskInputOrder,
  history: RiskHistory,
  opts: RiskOptions = {},
): RiskResult {
  const signals: RiskSignal[] = [];
  const reasons: string[] = [];

  const highCod = opts.highCodBdt ?? HIGH_COD_BDT;
  const extremeCod = opts.extremeCodBdt ?? EXTREME_COD_BDT;

  // --- Merchant blacklists (hard signals, run first) ---------------------
  const normalizedPhone = normalizePhone(order.customer.phone);
  const blockedPhoneHit = (opts.blockedPhones ?? [])
    .map((p) => normalizePhone(p))
    .filter(Boolean)
    .some((p) => p === normalizedPhone);
  if (blockedPhoneHit) {
    signals.push({
      key: "blocked_phone",
      weight: WEIGHTS.blockedPhone,
      detail: `Phone on merchant blocklist`,
    });
    reasons.push("Phone on merchant blocklist");
  }

  const blockedAddressHit =
    order.addressHash != null &&
    (opts.blockedAddresses ?? []).some((h) => h === order.addressHash);
  if (blockedAddressHit) {
    signals.push({
      key: "blocked_address",
      weight: WEIGHTS.blockedAddress,
      detail: `Address on merchant blocklist`,
    });
    reasons.push("Address on merchant blocklist");
  }

  // --- COD magnitude -----------------------------------------------------
  if (order.cod >= extremeCod) {
    signals.push({
      key: "extreme_cod",
      weight: WEIGHTS.extremeCod,
      detail: `COD ৳${order.cod.toLocaleString()} ≥ ৳${extremeCod.toLocaleString()}`,
    });
    reasons.push(`Very high COD (৳${order.cod.toLocaleString()})`);
  } else if (order.cod >= highCod) {
    signals.push({
      key: "high_cod",
      weight: WEIGHTS.highCod,
      detail: `COD ৳${order.cod.toLocaleString()} ≥ ৳${highCod.toLocaleString()}`,
    });
    reasons.push(`High COD (৳${order.cod.toLocaleString()})`);
  }

  // --- Phone duplication -------------------------------------------------
  if (history.phoneOrdersCount >= DUP_PHONE_HEAVY) {
    signals.push({
      key: "duplicate_phone_heavy",
      weight: WEIGHTS.duplicatePhoneHeavy,
      detail: `${history.phoneOrdersCount.toFixed(1)} weighted prior orders from this phone`,
    });
    reasons.push(`${Math.round(history.phoneOrdersCount)} prior orders from this phone`);
  } else if (history.phoneOrdersCount >= DUP_PHONE_WARN) {
    signals.push({
      key: "duplicate_phone",
      weight: WEIGHTS.duplicatePhone,
      detail: `${history.phoneOrdersCount.toFixed(1)} weighted prior orders from this phone`,
    });
    reasons.push(`Repeat phone (${Math.round(history.phoneOrdersCount)} prior)`);
  }

  // --- Prior negative outcomes (decayed) ---------------------------------
  if (history.phoneReturnedCount > 0) {
    signals.push({
      key: "prior_returns",
      weight: WEIGHTS.priorReturns,
      detail: `${history.phoneReturnedCount.toFixed(1)} weighted prior return(s)`,
    });
    reasons.push(
      `${Math.max(1, Math.round(history.phoneReturnedCount))} prior return${
        history.phoneReturnedCount < 1.5 ? "" : "s"
      }`,
    );
  }

  if (history.phoneCancelledCount >= 2) {
    signals.push({
      key: "prior_cancelled",
      weight: WEIGHTS.priorCancelled,
      detail: `${history.phoneCancelledCount.toFixed(1)} weighted prior cancellations`,
    });
    reasons.push(`${Math.round(history.phoneCancelledCount)} prior cancellations`);
  }

  // --- District / name heuristics ---------------------------------------
  const districts = new Set(
    (opts.suspiciousDistricts ?? []).map((d) => d.trim().toLowerCase()),
  );
  DEFAULT_SUSPICIOUS_DISTRICTS.forEach((d) => districts.add(d));
  const district = order.customer.district.trim().toLowerCase();
  if (!district || districts.has(district)) {
    signals.push({
      key: "suspicious_district",
      weight: WEIGHTS.suspiciousDistrict,
      detail: district ? `District "${order.customer.district}" flagged` : "Missing district",
    });
    reasons.push(district ? `Suspicious district: ${order.customer.district}` : "Missing district");
  }

  if (isFakeNamePattern(order.customer.name)) {
    signals.push({
      key: "fake_name_pattern",
      weight: WEIGHTS.fakeNamePattern,
      detail: `Name "${order.customer.name}" matches fake/gibberish pattern`,
    });
    reasons.push(`Suspicious name pattern`);
  }

  // --- Call history ------------------------------------------------------
  if (history.phoneUnreachableCount >= 2) {
    signals.push({
      key: "unreachable_history",
      weight: WEIGHTS.unreachableHistory,
      detail: `${history.phoneUnreachableCount.toFixed(1)} weighted unreachable attempts`,
    });
    reasons.push(
      `Previously unreachable (${Math.round(history.phoneUnreachableCount)}×)`,
    );
  }

  // --- Real-time velocity -----------------------------------------------
  if (history.ipRecentCount >= IP_VELOCITY_THRESHOLD) {
    signals.push({
      key: "ip_velocity",
      weight: WEIGHTS.ipVelocity,
      detail: `${history.ipRecentCount} orders from same IP recently`,
    });
    reasons.push(`High order velocity from same IP`);
  }

  const velocityThreshold = opts.velocityThreshold ?? 0;
  if (velocityThreshold > 0 && history.phoneVelocityCount >= velocityThreshold) {
    signals.push({
      key: "velocity_breach",
      weight: WEIGHTS.velocityBreach,
      detail: `${history.phoneVelocityCount} orders from this phone inside window`,
    });
    reasons.push(`Order velocity breach on this phone`);
  }

  // --- Address reuse -----------------------------------------------------
  if (history.addressDistinctPhones >= ADDRESS_REUSE_THRESHOLD) {
    signals.push({
      key: "duplicate_address",
      weight: WEIGHTS.duplicateAddress,
      detail: `${history.addressDistinctPhones} different phones shipped to this address`,
    });
    reasons.push(
      `Address shared across ${history.addressDistinctPhones} phone numbers`,
    );
  } else if (history.addressReturnedCount > 0) {
    // Address has a prior RTO even if not widely reused — still a yellow flag.
    signals.push({
      key: "duplicate_address",
      weight: WEIGHTS.duplicateAddress / 2,
      detail: `${history.addressReturnedCount.toFixed(1)} prior return(s) at this address`,
    });
    reasons.push(`Previous return at this address`);
  }

  const raw = signals.reduce((sum, s) => sum + s.weight, 0);
  const riskScore = Math.min(100, Math.round(raw));
  const level = classifyLevel(riskScore);

  return {
    riskScore,
    level,
    reasons,
    signals,
    reviewStatus: level === "high" ? "pending_call" : "not_required",
  };
}

/**
 * Apply exponential decay to an event that happened `ageDays` ago. Half-life
 * of 30 days ≈ an event from 90 days ago counts for 1/8. Half-life of 0
 * disables decay entirely (callers get raw event counts back).
 */
function decayWeight(ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  if (ageDays <= 0) return 1;
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
  let phoneReturnedCount = 0;
  let phoneCancelledCount = 0;
  for (const row of phoneOrders) {
    const age = row.createdAt
      ? Math.max(0, (now - row.createdAt.getTime()) / 86400_000)
      : 0;
    const w = decayWeight(age, halfLifeDays);
    phoneOrdersCount += w;
    const status = row.order?.status;
    if (status === "rto") phoneReturnedCount += w;
    if (status === "cancelled") phoneCancelledCount += w;
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
    phoneReturnedCount,
    phoneCancelledCount,
    phoneUnreachableCount,
    ipRecentCount: ipRecent,
    phoneVelocityCount: phoneVelocity,
    addressDistinctPhones: distinctPhones.size,
    addressReturnedCount,
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
  DUP_PHONE_WARN,
  DUP_PHONE_HEAVY,
  IP_VELOCITY_THRESHOLD,
  ADDRESS_REUSE_THRESHOLD,
  DEFAULT_HISTORY_HALF_LIFE_DAYS,
  classifyLevel,
  decayWeight,
  isFakeNamePattern,
  hashAddress,
};
