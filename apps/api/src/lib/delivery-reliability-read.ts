import { Types } from "mongoose";
import {
  AddressReliability,
  COURIER_PERF_GLOBAL_DISTRICT,
  CourierPerformance,
  CustomerReliability,
} from "@ecom/db";
import {
  classifyDeliveryReliability,
  type AddressQualityHint,
  type AddressReliabilityStats,
  type ClassifyDeliveryReliabilityInput,
  type CourierLaneStats,
  type CustomerReliabilityStats,
  type DeliveryReliabilityResult,
  type DeliveryReliabilityTier,
} from "./delivery-reliability.js";
import { hashPhoneForNetwork } from "./fraud-network.js";
import { normalizeDistrict } from "./district.js";
import { isReadEnabledForMerchant } from "./delivery-reliability-rollout.js";

/**
 * delivery-reliability-read — observation-only read surface for the v1
 * Delivery Reliability layer.
 *
 * Loads the per-merchant aggregates (CustomerReliability, AddressReliability,
 * CourierPerformance), maps them onto the pure classifier's structural
 * input shapes, and returns a merchant-renderable result. The classifier
 * itself never touches Mongo — this module is the only read-side adapter.
 *
 * Hard rules (binding):
 *   - Pure read path. NEVER writes, NEVER enqueues, NEVER mutates fraud
 *     state, NEVER triggers automation, NEVER persists classifier output.
 *   - NEVER throws back into the caller. Every read failure degrades to
 *     a `tier: "no_data"` (or treats that axis as absent).
 *   - Bounded query count: at most THREE per call (one per axis), all
 *     issued in parallel via `Promise.allSettled`.
 *   - Gated behind `DELIVERY_RELIABILITY_READ_ENABLED`. When the flag is
 *     off, returns `null` immediately — no DB I/O, no classifier call,
 *     no allocations beyond the early return.
 *   - Cooperates with the chokepoint's writer flag: when writes are off
 *     (the warm-up window), aggregates may be empty → classifier returns
 *     `no_data` cleanly.
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type DeliveryReliabilityConfidence =
  | "high"
  | "medium"
  | "low"
  | "unknown";

export interface DeliveryReliabilityReadResult {
  score: number;
  tier: DeliveryReliabilityTier;
  signals: DeliveryReliabilityResult["signals"];
  confidence: DeliveryReliabilityConfidence;
  samplesConsidered: DeliveryReliabilityResult["samplesConsidered"];
  computedAt: Date;
  /** True when at least one contributing axis row was past the staleness cutoff. */
  stale: boolean;
  /** Convenience flag: tier === "no_data". */
  noData: boolean;
}

export interface LoadDeliveryReliabilityInput {
  merchantId: Types.ObjectId | string;
  /** Buyer phone in any form — hashed internally before lookup. */
  phone?: string | null;
  /** Order's stored `source.addressHash` (token-sorted SHA-256[:32]). */
  addressHash?: string | null;
  /** Courier slug (`pathao` / `redx` / `steadfast` / ...). */
  courier?: string | null;
  /** Order destination district — normalised before lookup. */
  district?: string | null;
  /** Optional thana — passed through to the classifier (informational). */
  thana?: string | null;
  /** Order's stored `address.quality` subdoc — passed through. */
  addressQuality?: AddressQualityHint | null;
  /** Reference timestamp; defaults to `new Date()`. Injectable for tests. */
  now?: Date;
}

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

const STALE_DAYS = 180;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;
const COURIER_COLD_START_OBSERVATIONS = 10;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function safeMerchantOid(value: unknown): Types.ObjectId | null {
  if (value instanceof Types.ObjectId) return value;
  if (value == null) return null;
  try {
    const s = typeof value === "string" ? value : String(value);
    if (!Types.ObjectId.isValid(s)) return null;
    return new Types.ObjectId(s);
  } catch {
    return null;
  }
}

function safeNow(value: Date | undefined): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  return new Date();
}

function safeString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isAxisStale(
  row: { lastOutcomeAt?: Date | null } | null | undefined,
  now: Date,
): boolean {
  if (!row?.lastOutcomeAt) return false;
  const t = row.lastOutcomeAt instanceof Date
    ? row.lastOutcomeAt.getTime()
    : new Date(row.lastOutcomeAt as unknown as string).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t > STALE_MS;
}

function tierToConfidence(
  tier: DeliveryReliabilityTier,
): DeliveryReliabilityConfidence {
  switch (tier) {
    case "verified":
      return "high";
    case "implicit":
      return "medium";
    case "unverified":
      return "low";
    default:
      return "unknown";
  }
}

function pickSettled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

/* -------------------------------------------------------------------------- */
/* Per-axis Mongoose-row → classifier-input mappers                           */
/* -------------------------------------------------------------------------- */

interface CustomerReliabilityRow {
  deliveredCount?: number;
  rtoCount?: number;
  cancelledCount?: number;
  firstOutcomeAt?: Date | null;
  lastOutcomeAt?: Date | null;
}

interface AddressReliabilityRow {
  deliveredCount?: number;
  rtoCount?: number;
  cancelledCount?: number;
  distinctPhoneHashes?: string[];
  firstOutcomeAt?: Date | null;
  lastOutcomeAt?: Date | null;
}

interface CourierPerformanceRow {
  deliveredCount?: number;
  rtoCount?: number;
  cancelledCount?: number;
  totalDeliveryHours?: number;
  district?: string;
  lastOutcomeAt?: Date | null;
}

function mapCustomer(
  row: CustomerReliabilityRow | null,
): CustomerReliabilityStats | null {
  if (!row) return null;
  return {
    deliveredCount: row.deliveredCount,
    rtoCount: row.rtoCount,
    cancelledCount: row.cancelledCount,
    firstOutcomeAt: row.firstOutcomeAt ?? null,
    lastOutcomeAt: row.lastOutcomeAt ?? null,
  };
}

function mapAddress(
  row: AddressReliabilityRow | null,
): AddressReliabilityStats | null {
  if (!row) return null;
  return {
    deliveredCount: row.deliveredCount,
    rtoCount: row.rtoCount,
    cancelledCount: row.cancelledCount,
    distinctPhoneCount: Array.isArray(row.distinctPhoneHashes)
      ? row.distinctPhoneHashes.length
      : 0,
    firstOutcomeAt: row.firstOutcomeAt ?? null,
    lastOutcomeAt: row.lastOutcomeAt ?? null,
  };
}

function mapCourier(
  row: CourierPerformanceRow | null,
  now: Date,
): CourierLaneStats | null {
  if (!row) return null;
  const delivered = isFiniteNumber(row.deliveredCount) ? row.deliveredCount : 0;
  const rto = isFiniteNumber(row.rtoCount) ? row.rtoCount : 0;
  const cancelled = isFiniteNumber(row.cancelledCount) ? row.cancelledCount : 0;
  const observations = delivered + rto + cancelled;
  const successRate = observations > 0 ? delivered / observations : 0;
  const rtoRate = observations > 0 ? rto / observations : 0;
  return {
    successRate,
    rtoRate,
    observations,
    coldStart: observations < COURIER_COLD_START_OBSERVATIONS,
    stale: isAxisStale(row, now),
    matchedOn:
      row.district === COURIER_PERF_GLOBAL_DISTRICT ? "global" : "district",
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Load aggregate stats and run `classifyDeliveryReliability` against them.
 *
 * Returns:
 *   - `null` when `DELIVERY_RELIABILITY_READ_ENABLED=false` OR the input
 *     is fundamentally invalid (no merchantId).
 *   - A populated `DeliveryReliabilityReadResult` otherwise — including
 *     `tier: "no_data"` when no axis has enough evidence.
 *
 * NEVER throws. Each axis is read independently via `Promise.allSettled`
 * so a single Mongo failure on one collection does NOT cascade.
 */
export async function loadDeliveryReliability(
  input: LoadDeliveryReliabilityInput,
): Promise<DeliveryReliabilityReadResult | null> {
  if (!input || typeof input !== "object") return null;

  const merchantOid = safeMerchantOid(input.merchantId);
  if (!merchantOid) return null;

  // Per-merchant gate (S9). Replaces the raw env.DELIVERY_RELIABILITY_READ_ENABLED
  // check; behaviour is identical when the rollout allowlist is empty.
  if (!isReadEnabledForMerchant(merchantOid)) return null;

  const now = safeNow(input.now);
  const phoneHash = input.phone ? hashPhoneForNetwork(input.phone) : null;
  const addressHash = safeString(input.addressHash, 64);
  const courier = input.courier
    ? safeString(input.courier.toLowerCase(), 60)
    : null;
  const district = input.district ? normalizeDistrict(input.district) : null;
  const thana = safeString(input.thana, 100);

  // Three parallel reads — `Promise.allSettled` so a Mongo error on one
  // axis does NOT fail the whole call. A failed axis surfaces as `null`
  // input to the classifier, which is structurally indistinguishable
  // from "no data" — graceful degradation.
  const [custSettled, addrSettled, courierSettled] = await Promise.allSettled([
    phoneHash
      ? CustomerReliability.findOne({ merchantId: merchantOid, phoneHash })
          .lean<CustomerReliabilityRow>()
          .exec()
      : Promise.resolve<CustomerReliabilityRow | null>(null),
    addressHash
      ? AddressReliability.findOne({ merchantId: merchantOid, addressHash })
          .lean<AddressReliabilityRow>()
          .exec()
      : Promise.resolve<AddressReliabilityRow | null>(null),
    courier && district
      ? CourierPerformance.find({
          merchantId: merchantOid,
          courier,
          district: { $in: [district, COURIER_PERF_GLOBAL_DISTRICT] },
        })
          .lean<CourierPerformanceRow[]>()
          .exec()
      : Promise.resolve<CourierPerformanceRow[]>([]),
  ]);

  const custRow = pickSettled(custSettled);
  const addrRow = pickSettled(addrSettled);

  // Courier — prefer the per-district row when it carries enough evidence,
  // else the merchant-global aggregate. Mirrors `selectBestCourier`'s
  // matchedOn logic without re-using its scoring.
  const courierCandidates = pickSettled(courierSettled) ?? [];
  let courierRow: CourierPerformanceRow | null = null;
  if (Array.isArray(courierCandidates) && courierCandidates.length > 0) {
    const districtRow = courierCandidates.find((r) => r.district === district);
    const globalRow = courierCandidates.find(
      (r) => r.district === COURIER_PERF_GLOBAL_DISTRICT,
    );
    const districtObservations =
      ((districtRow?.deliveredCount ?? 0) as number) +
      ((districtRow?.rtoCount ?? 0) as number) +
      ((districtRow?.cancelledCount ?? 0) as number);
    courierRow =
      districtRow && districtObservations >= COURIER_COLD_START_OBSERVATIONS
        ? districtRow
        : (globalRow ?? districtRow ?? null);
  }

  const stale =
    isAxisStale(custRow, now) ||
    isAxisStale(addrRow, now) ||
    isAxisStale(courierRow, now);

  const classifierInput: ClassifyDeliveryReliabilityInput = {
    customerStats: mapCustomer(custRow),
    addressStats: mapAddress(addrRow),
    courierStats: mapCourier(courierRow, now),
    thana,
    addressQuality: input.addressQuality ?? null,
    now,
  };

  const result = classifyDeliveryReliability(classifierInput);

  return {
    score: result.score,
    tier: result.tier,
    signals: result.signals,
    confidence: tierToConfidence(result.tier),
    samplesConsidered: result.samplesConsidered,
    computedAt: result.computedAt,
    stale,
    noData: result.tier === "no_data",
  };
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  STALE_DAYS,
  STALE_MS,
  COURIER_COLD_START_OBSERVATIONS,
  tierToConfidence,
  isAxisStale,
  mapCustomer,
  mapAddress,
  mapCourier,
};
