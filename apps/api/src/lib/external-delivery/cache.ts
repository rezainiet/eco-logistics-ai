import { env } from "../../env.js";
import { getRedis } from "../redis.js";

/**
 * external-delivery / cache — Redis-backed profile cache.
 *
 * Hard rules (binding):
 *   - NEVER throws back to the caller. Any Redis outage degrades the
 *     get to a miss and the set to a no-op.
 *   - Versioned key prefix. A future Phase 4B schema bump can drop
 *     the prefix to invalidate cleanly without rewriting rows.
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

function cacheKey(phoneHash: string): string {
  return `${KEY_PREFIX}${phoneHash}`;
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

/** Read a cached profile payload by phoneHash. Returns hit=false on
 *  any cache miss, parse failure, or Redis outage — the caller is
 *  expected to fall through to the Mongo profile read. */
export async function getCachedProfile(
  phoneHash: string,
): Promise<CacheGetResult> {
  if (!phoneHash || typeof phoneHash !== "string") {
    return { hit: false, payload: null };
  }
  let raw: string | null = null;
  try {
    raw = await getRedis().get(cacheKey(phoneHash));
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
  phoneHash: string,
  payload: ExternalProfileCachePayload,
): Promise<{ ok: boolean }> {
  if (!phoneHash || typeof phoneHash !== "string") return { ok: false };
  const serialized = (() => {
    try {
      return JSON.stringify(payload);
    } catch {
      return null;
    }
  })();
  if (!serialized) return { ok: false };
  try {
    await getRedis().set(cacheKey(phoneHash), serialized, "EX", ttlSeconds());
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Invalidate a cached profile — used by admin tooling and by the
 *  orchestrator when it detects a parse_error on read. */
export async function invalidateCachedProfile(
  phoneHash: string,
): Promise<{ ok: boolean }> {
  if (!phoneHash || typeof phoneHash !== "string") return { ok: false };
  try {
    await getRedis().del(cacheKey(phoneHash));
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
