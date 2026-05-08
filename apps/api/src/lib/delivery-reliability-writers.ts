import { Types } from "mongoose";
import {
  AddressReliability,
  ADDRESS_RELIABILITY_DISTINCT_PHONES_CAP,
  CustomerReliability,
  type AddressReliabilityOutcome,
  type CustomerReliabilityOutcome,
} from "@ecom/db";
import { recordReliabilityOutcome } from "./observability/delivery-reliability.js";

/**
 * delivery-reliability writers — best-effort, never-throw aggregate
 * upserts for the v1 Delivery Reliability Intelligence layer.
 *
 * Single intended caller: `applyTrackingEvents`'s terminal-transition
 * fan-out (S4). The chokepoint guarantees at-most-once invocation per
 * real `(prevStatus → terminalStatus)` transition (`$nin newKeys` +
 * status guard + `nextStatus !== prevStatus` gate). The helpers
 * themselves do NOT dedupe; they trust the caller's gating.
 *
 * Forbidden behaviour (binding contract — see
 * `docs/audits/delivery-reliability-engineering-execution-map.md` §3):
 *   - ❌ read Order, Merchant, or any other model
 *   - ❌ enqueue BullMQ jobs
 *   - ❌ mutate fraud / automation / MerchantStats / FraudPrediction /
 *        FraudSignal / CourierPerformance
 *   - ❌ invoke `applyTrackingEvents` (cyclic)
 *   - ❌ throw back into the caller — every error path resolves silently
 *   - ❌ run inside a Mongo transaction
 *   - ❌ return data the caller is supposed to use (return type `void`)
 *
 * Observability: this file is silent on success. A `console.error` on
 * caught throw mirrors the existing `recordCourierOutcome` pattern in
 * `lib/courier-intelligence.ts`. Structured-log emission and per-process
 * counters land in S5; do not add them here.
 */

const COUNTER_FIELD: Record<CustomerReliabilityOutcome, string> = {
  delivered: "deliveredCount",
  rto: "rtoCount",
  cancelled: "cancelledCount",
};

const VALID_OUTCOMES = ["delivered", "rto", "cancelled"] as const;

/* -------------------------------------------------------------------------- */
/* Defensive normalizers                                                      */
/* -------------------------------------------------------------------------- */

function normalizeHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return trimmed;
}

function normalizeMerchantOid(value: unknown): Types.ObjectId | null {
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

function normalizeOrderOid(value: unknown): Types.ObjectId | null {
  if (value == null) return null;
  if (value instanceof Types.ObjectId) return value;
  try {
    const s = typeof value === "string" ? value : String(value);
    return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
  } catch {
    return null;
  }
}

function normalizeOutcome(
  value: unknown,
): CustomerReliabilityOutcome | null {
  if (typeof value !== "string") return null;
  return (VALID_OUTCOMES as readonly string[]).includes(value)
    ? (value as CustomerReliabilityOutcome)
    : null;
}

function normalizeDistrict(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return null;
  return trimmed;
}

function normalizeNow(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  return new Date();
}

/* -------------------------------------------------------------------------- */
/* recordCustomerOutcome                                                      */
/* -------------------------------------------------------------------------- */

export interface RecordCustomerOutcomeInput {
  merchantId: Types.ObjectId | string;
  /** SHA-256 of the canonical phone, length 1..64. Empty/missing → silent return. */
  phoneHash: string;
  outcome: CustomerReliabilityOutcome;
  /** Informational only — written to `lastDistrict` when present. */
  district?: string | null;
  /** Informational only — written to `lastOrderId` when present. */
  orderId?: Types.ObjectId | string | null;
  /** Reference timestamp; defaults to `new Date()`. Injectable for tests. */
  now?: Date;
}

/**
 * Record one buyer-side delivery outcome. Atomic per-document upsert via
 * MongoDB operator-form update — single round-trip:
 *
 *   $setOnInsert:  merchantId, phoneHash, firstOutcomeAt
 *   $set:          lastDistrict, lastOrderId   (when supplied)
 *   $max:          lastOutcomeAt               (monotonic — never pulled back)
 *   $inc:          [counterField] = 1          (exactly one per call)
 *
 * Idempotency contract: the helper does NOT dedupe by orderId. Every
 * invocation increments. The chokepoint gate (status transition + dedupe
 * key) is the source of replay-safety; calling this helper outside that
 * gate WILL double-count.
 */
export async function recordCustomerOutcome(
  input: RecordCustomerOutcomeInput,
): Promise<void> {
  if (!input || typeof input !== "object") return;

  const merchantOid = normalizeMerchantOid(input.merchantId);
  const phoneHash = normalizeHash(input.phoneHash);
  const outcome = normalizeOutcome(input.outcome);
  if (!merchantOid || !phoneHash || !outcome) return;

  const now = normalizeNow(input.now);
  const district = normalizeDistrict(input.district);
  const orderOid = normalizeOrderOid(input.orderId);
  const counterField = COUNTER_FIELD[outcome];

  const setFields: Record<string, unknown> = {};
  if (district !== null) setFields.lastDistrict = district;
  if (orderOid !== null) setFields.lastOrderId = orderOid;

  const update: Record<string, unknown> = {
    $setOnInsert: {
      merchantId: merchantOid,
      phoneHash,
      firstOutcomeAt: now,
    },
    $max: { lastOutcomeAt: now },
    $inc: { [counterField]: 1 },
  };
  if (Object.keys(setFields).length > 0) update.$set = setFields;

  const startedAt = Date.now();
  try {
    await CustomerReliability.updateOne(
      { merchantId: merchantOid, phoneHash },
      update,
      { upsert: true },
    );
    recordReliabilityOutcome({
      event: "customer_updated",
      merchantId: merchantOid.toHexString(),
      axis: "customer",
      reason: outcome,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error(
      "[delivery-reliability] customer outcome write failed:",
      (err as Error)?.message ?? err,
    );
    recordReliabilityOutcome({
      event: "write_failed",
      merchantId: merchantOid.toHexString(),
      axis: "customer",
      reason: outcome,
      durationMs: Date.now() - startedAt,
      error: (err as Error)?.message,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* recordAddressOutcome                                                       */
/* -------------------------------------------------------------------------- */

export interface RecordAddressOutcomeInput {
  merchantId: Types.ObjectId | string;
  /** Output of `hashAddress(address, district)`, length 1..64. */
  addressHash: string;
  outcome: AddressReliabilityOutcome;
  /**
   * Optional buyer phone-hash to add to the bounded `distinctPhoneHashes`
   * set. Stored privacy-safe (hashed); the cap is enforced by `$slice`.
   */
  phoneHash?: string | null;
  district?: string | null;
  orderId?: Types.ObjectId | string | null;
  now?: Date;
}

/**
 * Record one address-side delivery outcome. Pipeline-form upsert is
 * required because we maintain a bounded set on `distinctPhoneHashes`
 * via `$setUnion + $slice`, which cannot coexist with regular operator
 * updates in a single Mongo call. Mirrors `lib/fraud-network.ts:contributeOutcome`.
 *
 * Pipeline updates do NOT apply Mongoose schema defaults — every counter
 * is explicitly `$ifNull`-guarded so a row inserted via this path leaves
 * the untouched counters as numeric 0 rather than `undefined`.
 *
 * Atomic per-document write. Same idempotency contract as
 * `recordCustomerOutcome` — caller (chokepoint) is the dedupe gate.
 */
export async function recordAddressOutcome(
  input: RecordAddressOutcomeInput,
): Promise<void> {
  if (!input || typeof input !== "object") return;

  const merchantOid = normalizeMerchantOid(input.merchantId);
  const addressHash = normalizeHash(input.addressHash);
  const outcome = normalizeOutcome(input.outcome);
  if (!merchantOid || !addressHash || !outcome) return;

  const now = normalizeNow(input.now);
  const phoneHash = normalizeHash(input.phoneHash);
  const district = normalizeDistrict(input.district);
  const orderOid = normalizeOrderOid(input.orderId);
  const counterField = COUNTER_FIELD[outcome];

  // Pipeline $set stage — every counter is $ifNull-guarded; the targeted
  // counter is incremented by 1; lastOutcomeAt advances monotonically via
  // the aggregation $max operator (which ignores null/missing); firstOutcomeAt
  // is set on insert only via $ifNull.
  const setStage: Record<string, unknown> = {
    merchantId: merchantOid,
    addressHash,
    firstOutcomeAt: { $ifNull: ["$firstOutcomeAt", now] },
    lastOutcomeAt: { $max: ["$lastOutcomeAt", now] },
    deliveredCount: { $ifNull: ["$deliveredCount", 0] },
    rtoCount: { $ifNull: ["$rtoCount", 0] },
    cancelledCount: { $ifNull: ["$cancelledCount", 0] },
    [counterField]: {
      $add: [{ $ifNull: [`$${counterField}`, 0] }, 1],
    },
    distinctPhoneHashes:
      phoneHash !== null
        ? {
            $slice: [
              {
                $setUnion: [
                  { $ifNull: ["$distinctPhoneHashes", []] },
                  [phoneHash],
                ],
              },
              -ADDRESS_RELIABILITY_DISTINCT_PHONES_CAP,
            ],
          }
        : { $ifNull: ["$distinctPhoneHashes", []] },
  };
  if (district !== null) setStage.lastDistrict = district;
  if (orderOid !== null) setStage.lastOrderId = orderOid;

  const startedAt = Date.now();
  try {
    await AddressReliability.updateOne(
      { merchantId: merchantOid, addressHash },
      [{ $set: setStage }],
      { upsert: true },
    );
    recordReliabilityOutcome({
      event: "address_updated",
      merchantId: merchantOid.toHexString(),
      axis: "address",
      reason: outcome,
      durationMs: Date.now() - startedAt,
      meta: { hadPhoneHash: phoneHash !== null },
    });
  } catch (err) {
    console.error(
      "[delivery-reliability] address outcome write failed:",
      (err as Error)?.message ?? err,
    );
    recordReliabilityOutcome({
      event: "write_failed",
      merchantId: merchantOid.toHexString(),
      axis: "address",
      reason: outcome,
      durationMs: Date.now() - startedAt,
      error: (err as Error)?.message,
    });
  }
}
