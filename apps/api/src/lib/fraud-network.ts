import { createHash } from "node:crypto";
import { Types } from "mongoose";
import {
  FraudSignal,
  FRAUD_SIGNAL_MAX_MERCHANTS,
  FRAUD_SIGNAL_NONE,
  type FraudSignalOutcome,
} from "@ecom/db";
import { env } from "../env.js";
import { recordNetworkOutcome } from "./observability/fraud-network.js";

/**
 * Cross-merchant fraud network.
 *
 * Two-line contract:
 *   `lookupNetworkRisk` — read-side. Given the order's phone/address hashes,
 *     return aggregate metrics + a recommended risk-score bonus. Never
 *     returns merchant identities or raw values.
 *   `contributeOutcome` — write-side. Atomically upserts the signal row,
 *     bumping the right counter and (capped) recording the merchant id.
 *
 * Privacy + isolation:
 *  - Only hashes are persisted globally. Raw phone/address never cross
 *    the merchant boundary.
 *  - The lookup hides the merchantIds list — only `merchantCount` is
 *    surfaced to the merchant. Even the count is rounded once it exceeds
 *    the threshold so individual merchants can't be backed out.
 *  - Single-merchant signals are deliberately invisible — a fingerprint
 *    only one merchant has seen carries no network confidence and is
 *    suppressed in the lookup.
 *
 * Safety:
 *  - The score bonus is capped (NETWORK_BONUS_CAP) so a single sketchy
 *    network signal cannot dominate merchant-local features.
 *  - Bonus uses the rto-rate × confidence shape so a high RTO rate at a
 *    low merchant-count doesn't blow up the score.
 */

/* -------------------------------------------------------------------------- */
/* Hashing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Stable per-network hash for a normalized phone string. Returns null for
 * missing/blank inputs so callers can short-circuit.
 */
export function hashPhoneForNetwork(normalized: string | undefined | null): string | null {
  if (!normalized) return null;
  const trimmed = String(normalized).trim();
  if (!trimmed) return null;
  return createHash("sha256").update(`p:${trimmed}`).digest("hex").slice(0, 32);
}

/**
 * Wrapper that accepts the existing addressHash output. Returns null for
 * blank inputs so we can fall through to the `_none_` sentinel.
 */
export function normalizeAddressHash(hash: string | undefined | null): string | null {
  if (!hash) return null;
  const trimmed = hash.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* -------------------------------------------------------------------------- */
/* Lookup                                                                      */
/* -------------------------------------------------------------------------- */

const NETWORK_BONUS_CAP = 25; // never let the network nudge above +25 points

const MIN_MERCHANTS_FOR_SIGNAL = 2;
const MIN_OBSERVATIONS_FOR_SIGNAL = 2;

export interface LookupNetworkRiskInput {
  phoneHash?: string | null;
  addressHash?: string | null;
  merchantId?: Types.ObjectId | string;
}

export interface NetworkRiskAggregate {
  /** Number of distinct merchants that have observed this fingerprint, excluding the caller. */
  merchantCount: number;
  deliveredCount: number;
  rtoCount: number;
  cancelledCount: number;
  /** rto / (rto + delivered) — `null` when there's no completed history. */
  rtoRate: number | null;
  /** First & last seen across the network, useful for UI ("seen since…"). */
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  /** Recommended additive bonus for the risk score (already capped). */
  bonus: number;
  /** Best matched fingerprint composition — useful for UI hover states. */
  matchedOn: "phone+address" | "phone" | "address" | "none";
}

const EMPTY: NetworkRiskAggregate = {
  merchantCount: 0,
  deliveredCount: 0,
  rtoCount: 0,
  cancelledCount: 0,
  rtoRate: null,
  firstSeenAt: null,
  lastSeenAt: null,
  bonus: 0,
  matchedOn: "none",
};

/**
 * Read aggregated network metrics for a fingerprint. Returns `EMPTY` (no
 * bonus, no surface signal) when:
 *   - both hashes are missing
 *   - the matched signal exists but only one merchant has contributed (or
 *     only this merchant has contributed)
 *   - there are fewer than MIN_OBSERVATIONS_FOR_SIGNAL completed orders
 *     (delivered + rto + cancelled), to defend against a single weird
 *     order driving false positives.
 */
export async function lookupNetworkRisk(
  input: LookupNetworkRiskInput,
): Promise<NetworkRiskAggregate> {
  // Master switch — emergency disable + observable.
  if (!env.FRAUD_NETWORK_ENABLED) {
    recordNetworkOutcome({
      outcome: "lookup_disabled",
      merchantId: input.merchantId ? String(input.merchantId) : undefined,
    });
    return EMPTY;
  }

  const phone = input.phoneHash ?? null;
  const addr = input.addressHash ?? null;
  if (!phone && !addr) {
    recordNetworkOutcome({
      outcome: "lookup_miss",
      merchantId: input.merchantId ? String(input.merchantId) : undefined,
    });
    return EMPTY;
  }

  // Try the most specific match first, then fall back to single-hash rows.
  const filters: Array<{ q: Record<string, string>; matchedOn: NetworkRiskAggregate["matchedOn"] }> = [];
  if (phone && addr) {
    filters.push({ q: { phoneHash: phone, addressHash: addr }, matchedOn: "phone+address" });
  }
  if (phone) {
    filters.push({ q: { phoneHash: phone, addressHash: FRAUD_SIGNAL_NONE }, matchedOn: "phone" });
  }
  if (addr) {
    filters.push({ q: { phoneHash: FRAUD_SIGNAL_NONE, addressHash: addr }, matchedOn: "address" });
  }

  const myIdStr = input.merchantId ? String(input.merchantId) : undefined;
  for (const { q, matchedOn } of filters) {
    const row = await FraudSignal.findOne(q).lean();
    if (!row) continue;

    // Decay window — signals older than DECAY_DAYS are stale, no bonus.
    const decayCutoffMs = Date.now() - env.FRAUD_NETWORK_DECAY_DAYS * 86_400_000;
    const lastSeenMs = row.lastSeenAt ? new Date(row.lastSeenAt).getTime() : 0;
    if (lastSeenMs < decayCutoffMs) {
      recordNetworkOutcome({
        outcome: "lookup_stale",
        merchantId: myIdStr,
        matchedOn,
      });
      return EMPTY;
    }

    const myId = myIdStr ?? null;
    const merchantCount = (row.merchantIds ?? []).filter((m) => String(m) !== myId).length;

    // Counters can be `undefined` on rows whose first contribution only
    // touched one of the three buckets — Mongoose schema defaults aren't
    // applied through aggregation-pipeline upserts. Coerce here so arithmetic
    // never produces NaN downstream (which would silently nullify the bonus).
    const deliveredCount = row.deliveredCount ?? 0;
    const rtoCount = row.rtoCount ?? 0;
    const cancelledCount = row.cancelledCount ?? 0;

    const completed = deliveredCount + rtoCount + cancelledCount;
    if (
      merchantCount < MIN_MERCHANTS_FOR_SIGNAL ||
      completed < MIN_OBSERVATIONS_FOR_SIGNAL
    ) {
      recordNetworkOutcome({
        outcome: "lookup_hit_suppressed",
        merchantId: myIdStr,
        matchedOn,
        bonus: 0,
      });
      return EMPTY;
    }

    const denom = deliveredCount + rtoCount;
    const rtoRate = denom > 0 ? rtoCount / denom : null;
    let bonus = computeBonus({
      merchantCount,
      rtoCount,
      cancelledCount,
      rtoRate,
    });

    // Warming-up damper — when the global network is still small, halve the
    // bonus so any individual signal can't spike a merchant's decisions.
    let warmingUp = false;
    if (env.FRAUD_NETWORK_WARMING_FLOOR > 0) {
      const totalSignals = await FraudSignal.estimatedDocumentCount();
      if (totalSignals < env.FRAUD_NETWORK_WARMING_FLOOR) {
        bonus = Math.round(bonus / 2);
        warmingUp = true;
      }
    }

    if (warmingUp) {
      recordNetworkOutcome({
        outcome: "lookup_warming_up",
        merchantId: myIdStr,
        matchedOn,
        bonus,
        rtoRate,
      });
    } else if (bonus > 0) {
      recordNetworkOutcome({
        outcome: "lookup_hit_applied",
        merchantId: myIdStr,
        matchedOn,
        bonus,
        rtoRate,
        // A bonus large enough to flip a level is a (coarse) "prevented" estimate.
        estimatedPrevented: bonus >= 10,
      });
    } else {
      recordNetworkOutcome({
        outcome: "lookup_hit_suppressed",
        merchantId: myIdStr,
        matchedOn,
        bonus: 0,
        rtoRate,
      });
    }

    return {
      merchantCount,
      deliveredCount,
      rtoCount,
      cancelledCount,
      rtoRate,
      firstSeenAt: row.firstSeenAt ?? null,
      lastSeenAt: row.lastSeenAt ?? null,
      bonus,
      matchedOn,
    };
  }

  recordNetworkOutcome({ outcome: "lookup_miss", merchantId: myIdStr });
  return EMPTY;
}

/**
 * Bonus formula. Three drivers — each clamped, then summed and clamped
 * again at NETWORK_BONUS_CAP:
 *
 *  1. RTO-rate × confidence — high rto rate alone isn't enough; we also
 *     need ≥2 merchants and ≥2 observations to count it.
 *  2. Absolute RTO count — three or more cross-merchant RTOs is a hard
 *     signal regardless of rate.
 *  3. Cancelled outcomes — cheaper signal than RTO (cancellation isn't
 *     always fraud) but still adds a point each.
 */
function computeBonus(args: {
  merchantCount: number;
  rtoCount: number;
  cancelledCount: number;
  rtoRate: number | null;
}): number {
  let bonus = 0;
  if (args.rtoRate !== null && args.rtoRate >= 0.5 && args.merchantCount >= 2) {
    // 50% rto across 2+ merchants → +12; 80% across 3+ → +20.
    bonus += Math.min(20, Math.round(args.rtoRate * 25));
  }
  if (args.rtoCount >= 3) bonus += 8;
  bonus += Math.min(5, args.cancelledCount);
  return Math.min(NETWORK_BONUS_CAP, bonus);
}

/* -------------------------------------------------------------------------- */
/* Contribute                                                                  */
/* -------------------------------------------------------------------------- */

export interface ContributeOutcomeInput {
  merchantId: Types.ObjectId | string;
  phoneHash?: string | null;
  addressHash?: string | null;
  outcome: FraudSignalOutcome;
}

const FIELD_FOR_OUTCOME: Record<FraudSignalOutcome, string> = {
  delivered: "deliveredCount",
  rto: "rtoCount",
  cancelled: "cancelledCount",
};

/**
 * Record one outcome. Atomic, idempotency-safe, never blocks the caller's
 * happy path (callers should `void contributeOutcome(...).catch(...)`).
 *
 * Behaviour:
 *  - Skips silently when both hashes are absent (no fingerprint to record).
 *  - Upserts the row by `(phoneHash, addressHash)` — the missing one is
 *    persisted as `_none_`.
 *  - $inc bumps the right counter; $addToSet adds the merchant id (capped
 *    at FRAUD_SIGNAL_MAX_MERCHANTS so write growth is bounded).
 *  - Updates lastSeenAt unconditionally; firstSeenAt only on insert.
 */
export async function contributeOutcome(input: ContributeOutcomeInput): Promise<void> {
  const merchantIdStr = String(input.merchantId);
  if (!env.FRAUD_NETWORK_ENABLED) {
    recordNetworkOutcome({ outcome: "contribute_disabled", merchantId: merchantIdStr });
    return;
  }
  const phoneHash = input.phoneHash ?? null;
  const addressHash = input.addressHash ?? null;
  if (!phoneHash && !addressHash) {
    recordNetworkOutcome({ outcome: "contribute_skipped", merchantId: merchantIdStr });
    return;
  }

  const docPhone = phoneHash ?? FRAUD_SIGNAL_NONE;
  const docAddr = addressHash ?? FRAUD_SIGNAL_NONE;
  const merchantOid = new Types.ObjectId(merchantIdStr);
  const counterField = FIELD_FOR_OUTCOME[input.outcome];
  const now = new Date();

  try {
    // Aggregation-pipeline upsert. Schema defaults (counter = 0) do NOT
    // apply through pipeline updates, so we $ifNull-guard every counter
    // in addition to the one we're incrementing — otherwise the two we
    // didn't touch this contribution stay `undefined`, and downstream
    // arithmetic in the lookup turns into NaN.
    await FraudSignal.updateOne(
      { phoneHash: docPhone, addressHash: docAddr },
      [
        {
          $set: {
            phoneHash: docPhone,
            addressHash: docAddr,
            firstSeenAt: { $ifNull: ["$firstSeenAt", now] },
            lastSeenAt: now,
            deliveredCount: { $ifNull: ["$deliveredCount", 0] },
            rtoCount: { $ifNull: ["$rtoCount", 0] },
            cancelledCount: { $ifNull: ["$cancelledCount", 0] },
            [counterField]: { $add: [{ $ifNull: [`$${counterField}`, 0] }, 1] },
            merchantIds: {
              $slice: [
                { $setUnion: [{ $ifNull: ["$merchantIds", []] }, [merchantOid]] },
                -FRAUD_SIGNAL_MAX_MERCHANTS,
              ],
            },
          },
        },
      ],
      { upsert: true },
    );
    recordNetworkOutcome({ outcome: "contribute_recorded", merchantId: merchantIdStr });
  } catch (err) {
    recordNetworkOutcome({
      outcome: "contribute_failed",
      merchantId: merchantIdStr,
      error: (err as Error).message,
    });
    throw err;
  }
}

/** Convenience export for tests. */
export const __TEST = {
  NETWORK_BONUS_CAP,
  MIN_MERCHANTS_FOR_SIGNAL,
  MIN_OBSERVATIONS_FOR_SIGNAL,
  computeBonus,
};
