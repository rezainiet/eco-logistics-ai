import { randomBytes } from "node:crypto";
import { getRedis } from "./redis.js";

/**
 * Per-merchant session ledger backed by Redis.
 *
 * Why a server-side ledger when JWTs are already stateless: a stateless JWT
 * cannot be revoked. Until expiry (14 days for refresh, 1 hour for access)
 * a stolen token is a free pass. The ledger flips that — every access path
 * verifies the sid claim against this store, so revocation is instant.
 *
 * Layout:
 *   - `session:{merchantId}:{sid}` → JSON record (TTL = ttlSec)
 *   - `sessions:{merchantId}`     → SET of sids (TTL refreshed on each session)
 *
 * The set lets `revokeAllSessions` work in one O(N) sweep at logout-all /
 * password-change time without scanning the whole keyspace.
 *
 * Fallback: when REDIS_URL is unset (dev/test), an in-process Map is used.
 * Single-process only — production MUST run with Redis.
 */

const DEFAULT_SESSION_TTL_S = 14 * 24 * 60 * 60; // 14d, matches refresh JWT

export interface SessionRecord {
  merchantId: string;
  createdAt: number;
  ip: string | null;
  userAgent: string | null;
  lastSeenAt: number;
}

const memoryByKey = new Map<string, SessionRecord>();
const memoryByMerchant = new Map<string, Set<string>>();

function sessionKey(merchantId: string, sid: string): string {
  return `session:${merchantId}:${sid}`;
}
function setKey(merchantId: string): string {
  return `sessions:${merchantId}`;
}

function tryRedis() {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

export function newSessionId(): string {
  return randomBytes(16).toString("hex");
}

export interface CreateSessionArgs {
  merchantId: string;
  ip: string | null;
  userAgent: string | null;
  /** Override TTL — defaults to 14d to match the refresh-cookie lifetime. */
  ttlSec?: number;
}

export async function createSession(args: CreateSessionArgs): Promise<string> {
  const sid = newSessionId();
  const record: SessionRecord = {
    merchantId: args.merchantId,
    createdAt: Date.now(),
    ip: args.ip,
    userAgent: args.userAgent,
    lastSeenAt: Date.now(),
  };
  const ttl = args.ttlSec ?? DEFAULT_SESSION_TTL_S;

  const redis = tryRedis();
  if (redis) {
    const k = sessionKey(args.merchantId, sid);
    const sk = setKey(args.merchantId);
    // Pipeline so the per-session record + the merchant index drop together.
    await redis
      .multi()
      .set(k, JSON.stringify(record), "EX", ttl)
      .sadd(sk, sid)
      .expire(sk, ttl)
      .exec();
  } else {
    memoryByKey.set(sessionKey(args.merchantId, sid), record);
    let set = memoryByMerchant.get(args.merchantId);
    if (!set) {
      set = new Set();
      memoryByMerchant.set(args.merchantId, set);
    }
    set.add(sid);
  }
  return sid;
}

export async function sessionExists(
  merchantId: string,
  sid: string,
): Promise<boolean> {
  const redis = tryRedis();
  if (redis) {
    const v = await redis.get(sessionKey(merchantId, sid));
    return v !== null;
  }
  return memoryByKey.has(sessionKey(merchantId, sid));
}

export async function touchSession(
  merchantId: string,
  sid: string,
): Promise<void> {
  // Lightweight last-seen bump — fire-and-forget from the hot path.
  const redis = tryRedis();
  if (redis) {
    const k = sessionKey(merchantId, sid);
    const raw = await redis.get(k);
    if (!raw) return;
    try {
      const rec = JSON.parse(raw) as SessionRecord;
      rec.lastSeenAt = Date.now();
      const ttl = await redis.ttl(k);
      await redis.set(k, JSON.stringify(rec), "EX", Math.max(60, ttl));
    } catch {
      /* swallow — touching is best-effort */
    }
    return;
  }
  const rec = memoryByKey.get(sessionKey(merchantId, sid));
  if (rec) rec.lastSeenAt = Date.now();
}

/**
 * Atomic-ish rotate: revoke the old sid and mint a fresh one. The two ops
 * are split so a race where two refresh calls land on the same sid resolves
 * cleanly — first one in wins, second one finds the sid already gone and
 * returns null, and the caller forces re-login.
 */
export async function rotateSession(args: {
  merchantId: string;
  oldSid: string;
  ip: string | null;
  userAgent: string | null;
  ttlSec?: number;
}): Promise<string | null> {
  const exists = await sessionExists(args.merchantId, args.oldSid);
  if (!exists) return null;
  await revokeSession(args.merchantId, args.oldSid);
  return createSession({
    merchantId: args.merchantId,
    ip: args.ip,
    userAgent: args.userAgent,
    ttlSec: args.ttlSec,
  });
}

export async function revokeSession(
  merchantId: string,
  sid: string,
): Promise<void> {
  const redis = tryRedis();
  if (redis) {
    await redis
      .multi()
      .del(sessionKey(merchantId, sid))
      .srem(setKey(merchantId), sid)
      .exec();
    return;
  }
  memoryByKey.delete(sessionKey(merchantId, sid));
  memoryByMerchant.get(merchantId)?.delete(sid);
}

/**
 * Invalidate every active session for a merchant. Used by `/logout-all`
 * and the password-reset flow — the assumption being that a password
 * change implies "force every device to log in again". Returns the number
 * of sessions that were dropped, for audit + UI feedback.
 */
export async function revokeAllSessions(merchantId: string): Promise<number> {
  const redis = tryRedis();
  if (redis) {
    const sids = await redis.smembers(setKey(merchantId));
    if (sids.length === 0) return 0;
    const multi = redis.multi();
    for (const s of sids) multi.del(sessionKey(merchantId, s));
    multi.del(setKey(merchantId));
    await multi.exec();
    return sids.length;
  }
  const set = memoryByMerchant.get(merchantId);
  if (!set || set.size === 0) return 0;
  const count = set.size;
  for (const sid of set) memoryByKey.delete(sessionKey(merchantId, sid));
  memoryByMerchant.delete(merchantId);
  return count;
}

export async function listSessions(
  merchantId: string,
): Promise<Array<{ sid: string; record: SessionRecord }>> {
  const redis = tryRedis();
  if (redis) {
    const sids = await redis.smembers(setKey(merchantId));
    if (sids.length === 0) return [];
    const records = await Promise.all(
      sids.map(async (sid) => {
        const raw = await redis.get(sessionKey(merchantId, sid));
        if (!raw) return null;
        try {
          return { sid, record: JSON.parse(raw) as SessionRecord };
        } catch {
          return null;
        }
      }),
    );
    return records.filter(
      (r): r is { sid: string; record: SessionRecord } => r !== null,
    );
  }
  const set = memoryByMerchant.get(merchantId);
  if (!set) return [];
  const out: Array<{ sid: string; record: SessionRecord }> = [];
  for (const sid of set) {
    const rec = memoryByKey.get(sessionKey(merchantId, sid));
    if (rec) out.push({ sid, record: rec });
  }
  return out;
}

/** Test helper — wipes the in-memory state. */
export function __resetSessionsForTests(): void {
  memoryByKey.clear();
  memoryByMerchant.clear();
}
