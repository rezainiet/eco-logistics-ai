import { env } from "../../env.js";
import { getRedis } from "../redis.js";

/**
 * external-delivery / cache — Redis-backed profile cache.
 *
 * Hard rules (binding):
 *   - NEVER throws back to the caller. Any Redis outage degrades the
 *     get to a miss and the set to a no-op.
 *   - Versioned + merchant-scoped key prefix. Each (merchantId,
 *     phoneHash) lives at its own key — no cross-merchant cache
 *     collisions, no leak risk if one merchant's profile is
 *     accidentally serialised back to another.
 *   - JSON-serialised payloads. Provider snapshots must not contain
 *     functions / cyclic refs (the model schema enforces this).
 *   - TTL driven by `EXTERNAL_DELIVERY_TTL_HOURS`; clamped at the env
 *     boundary to [1, 168].
 */

const KEY_PREFIX = "extdp:v1:";

export interface ExternalProfileCachePayload {
  /** Mongo-shape payload, JSON-stringified at write time. The cache
   *  layer doesn't know the field shape — that lives in the
   *  orchestrator. */
  body: unknown;
  /** Server-time (ms epoch) the snapshot was last fetched from
   *  upstream. Lets the cache reader skip a stale entry even when
   *  Redis hasn't expired the TTL yet (clock-skew safety). */
  fetchedAt: number;
}

export interface CacheKeyParts {
  /** Merchant-id hex — already toHexString'd by the caller. */
  merchantHex: string;
  phoneHash: string;
}

function cacheKey(parts: CacheKeyParts): string {
  return `${KEY_PREFIX}${parts.merchantHex}:${parts.phoneHash}`;
}

function ttlSeconds(): number {
  const hours = env.EXTERNAL_DELIVERY_TTL_HOURS;
  return Math.max(60, hours * 60 * 60);
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface CacheGetResult {
  hit: boolean;
  payload: ExternalProfileCachePayload | null;
  /** "redis_unavailable" / "parse_error" surfaces the failure mode for
   *  observability without exposing a Redis error to the caller. */
  warning?: "redis_unavailable" | "parse_error";
}

function isValidParts(parts: CacheKeyParts | null | undefined): parts is CacheKeyParts {
  return !!(
    parts &&
    typeof parts.merchantHex === "string" &&
    parts.merchantHex.length > 0 &&
    typeof parts.phoneHash === "string" &&
    parts.phoneHash.length > 0
  );
}

/** Read a cached profile payload by (merchantId, phoneHash). Returns
 *  hit=false on any cache miss, parse failure, or Redis outage — the
 *  caller is expected to fall through to the Mongo profile read. */
export async function getCachedProfile(
  parts: CacheKeyParts,
): Promise<CacheGetResult> {
  if (!isValidParts(parts)) {
    return { hit: false, payload: null };
  }
  let raw: string | null = null;
  try {
    raw = await getRedis().get(cacheKey(parts));
  } catch {
    return { hit: false, payload: null, warning: "redis_unavailable" };
  }
  if (raw === null) return { hit: false, payload: null };
  try {
    const parsed = JSON.parse(raw) as ExternalProfileCachePayload;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.fetchedAt !== "number"
    ) {
      return { hit: false, payload: null, warning: "parse_error" };
    }
    return { hit: true, payload: parsed };
  } catch {
    return { hit: false, payload: null, warning: "parse_error" };
  }
}

/** Persist a profile payload under the configured TTL. Returns
 *  ok=false on Redis outage; the orchestrator continues without
 *  blocking. */
export async function setCachedProfile(
  parts: CacheKeyParts,
  payload: ExternalProfileCachePayload,
): Promise<{ ok: boolean }> {
  if (!isValidParts(parts)) return { ok: false };
  const serialized = (() => {
    try {
      return JSON.stringify(payload);
    } catch {
      return null;
    }
  })();
  if (!serialized) return { ok: false };
  try {
    await getRedis().set(cacheKey(parts), serialized, "EX", ttlSeconds());
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Invalidate a cached profile — used by admin tooling and by the
 *  orchestrator when it detects a parse_error on read. */
export async function invalidateCachedProfile(
  parts: CacheKeyParts,
): Promise<{ ok: boolean }> {
  if (!isValidParts(parts)) return { ok: false };
  try {
    await getRedis().del(cacheKey(parts));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  KEY_PREFIX,
  cacheKey,
  ttlSeconds,
};
