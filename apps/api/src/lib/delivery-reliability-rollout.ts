import { Types } from "mongoose";
import { env } from "../env.js";

/**
 * delivery-reliability-rollout — single source of truth for the three
 * Delivery Reliability gates (write / read / analytics) and the optional
 * staged-rollout merchant allowlist.
 *
 * Gate semantics (per-merchant):
 *   gate(flag, allowlist, merchantId) =
 *     flag === true
 *     AND (allowlist is empty OR merchantId in allowlist)
 *
 * Backwards compatibility:
 *   - When `DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS` is empty/unset (the
 *     default), the allowlist clause collapses to `true` and each gate
 *     behaves identically to its env-flag-only S4–S7 form.
 *   - When the env is set to a non-empty list, each gate additionally
 *     requires the merchantId to be a member.
 *
 * Hard rules (binding):
 *   - Pure read of `env`. No DB I/O. No I/O at all.
 *   - Never throws. Invalid inputs degrade to `false` (gate closed).
 *   - The allowlist parser is computed once on first call and cached for
 *     the lifetime of the process. Restart to apply env changes — same
 *     contract as every other env-driven flag in this codebase.
 */

let _allowlistCache: ReadonlySet<string> | null = null;
let _allowlistRaw: string | null = null;

function parseAllowlist(): ReadonlySet<string> {
  const raw = env.DELIVERY_RELIABILITY_ROLLOUT_MERCHANTS ?? "";
  if (_allowlistCache !== null && _allowlistRaw === raw) {
    return _allowlistCache;
  }
  const set = new Set<string>();
  if (raw.length > 0) {
    for (const piece of raw.split(",")) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      // Defensive: only accept syntactically valid ObjectId hex strings.
      if (!Types.ObjectId.isValid(trimmed)) continue;
      // Normalise to canonical hex (lowercase, no surrounding whitespace).
      try {
        set.add(new Types.ObjectId(trimmed).toHexString());
      } catch {
        /* swallow — already filtered by isValid, defence-in-depth */
      }
    }
  }
  _allowlistCache = set;
  _allowlistRaw = raw;
  return set;
}

function merchantHexId(value: unknown): string | null {
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (value == null) return null;
  if (typeof value === "string") {
    if (!Types.ObjectId.isValid(value)) return null;
    try {
      return new Types.ObjectId(value).toHexString();
    } catch {
      return null;
    }
  }
  // Mongoose docs / lean rows expose merchantId as `Buffer | ObjectId | string`.
  // Force-coerce via `String()` and re-validate.
  try {
    const s = String(value);
    if (!Types.ObjectId.isValid(s)) return null;
    return new Types.ObjectId(s).toHexString();
  } catch {
    return null;
  }
}

function isInAllowlist(merchantId: unknown): boolean {
  const list = parseAllowlist();
  if (list.size === 0) return true; // empty allowlist = ALL merchants pass
  const hex = merchantHexId(merchantId);
  if (!hex) return false;
  return list.has(hex);
}

/* -------------------------------------------------------------------------- */
/* Public per-merchant gates                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Should the chokepoint fan-out (`recordCustomerOutcome` /
 * `recordAddressOutcome`) fire for this terminal transition? Replaces the
 * raw `env.DELIVERY_RELIABILITY_WRITE_ENABLED` check at the chokepoint.
 */
export function isWriteEnabledForMerchant(merchantId: unknown): boolean {
  if (!env.DELIVERY_RELIABILITY_WRITE_ENABLED) return false;
  return isInAllowlist(merchantId);
}

/**
 * Should `loadDeliveryReliability` issue aggregate reads + classifier
 * invocation for this `getOrder` call? Replaces the raw
 * `env.DELIVERY_RELIABILITY_READ_ENABLED` check inside the read helper.
 */
export function isReadEnabledForMerchant(merchantId: unknown): boolean {
  if (!env.DELIVERY_RELIABILITY_READ_ENABLED) return false;
  return isInAllowlist(merchantId);
}

/**
 * Should the four analytics tRPC procedures answer for this merchant?
 * Replaces the global `assertReliabilityAnalyticsEnabled()` check.
 */
export function isAnalyticsEnabledForMerchant(merchantId: unknown): boolean {
  if (!env.DELIVERY_RELIABILITY_ANALYTICS_ENABLED) return false;
  return isInAllowlist(merchantId);
}

/* -------------------------------------------------------------------------- */
/* Introspection — for verifyDeliveryReliability + admin observability        */
/* -------------------------------------------------------------------------- */

export interface RolloutStateSnapshot {
  /** Process-level flags. */
  flags: {
    write: boolean;
    read: boolean;
    analytics: boolean;
    observability: boolean;
  };
  /** Number of merchants in the allowlist. 0 means "all merchants pass". */
  allowlistSize: number;
  /** True when the allowlist has at least one entry — i.e., staged rollout. */
  staged: boolean;
  /**
   * Effective rollout phase derived from the flag matrix:
   *   - "off"           → write off
   *   - "writes_only"   → write on, read off (warm-up)
   *   - "reads_on"      → write on, read on, analytics off (dogfood)
   *   - "ga"            → all three on, allowlist empty (general availability)
   *   - "staged_ga"     → all three on, allowlist non-empty
   *   - "partial"       → any other combination (mid-flip)
   */
  phase:
    | "off"
    | "writes_only"
    | "reads_on"
    | "ga"
    | "staged_ga"
    | "partial";
}

export function getRolloutState(): RolloutStateSnapshot {
  const flags = {
    write: env.DELIVERY_RELIABILITY_WRITE_ENABLED,
    read: env.DELIVERY_RELIABILITY_READ_ENABLED,
    analytics: env.DELIVERY_RELIABILITY_ANALYTICS_ENABLED,
    observability: env.DELIVERY_RELIABILITY_OBSERVABILITY_ENABLED,
  };
  const allowlistSize = parseAllowlist().size;
  const staged = allowlistSize > 0;

  let phase: RolloutStateSnapshot["phase"];
  if (!flags.write) {
    phase = "off";
  } else if (flags.write && !flags.read) {
    phase = "writes_only";
  } else if (flags.write && flags.read && !flags.analytics) {
    phase = "reads_on";
  } else if (flags.write && flags.read && flags.analytics) {
    phase = staged ? "staged_ga" : "ga";
  } else {
    phase = "partial";
  }

  return { flags, allowlistSize, staged, phase };
}

/**
 * Per-merchant snapshot — useful for the admin/debug surface to confirm
 * a specific merchantId's effective rollout state without exposing the
 * full allowlist.
 */
export function getMerchantRolloutSnapshot(merchantId: unknown): {
  inAllowlist: boolean;
  writeEnabled: boolean;
  readEnabled: boolean;
  analyticsEnabled: boolean;
} {
  const inAllowlist = isInAllowlist(merchantId);
  return {
    inAllowlist,
    writeEnabled: isWriteEnabledForMerchant(merchantId),
    readEnabled: isReadEnabledForMerchant(merchantId),
    analyticsEnabled: isAnalyticsEnabledForMerchant(merchantId),
  };
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

/** Test-only — drops the cached allowlist so re-reading env in tests works. */
export function __resetRolloutAllowlistCache(): void {
  _allowlistCache = null;
  _allowlistRaw = null;
}

export const __TEST = {
  parseAllowlist,
  merchantHexId,
  isInAllowlist,
};
