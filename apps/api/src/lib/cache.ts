import type { Redis } from "ioredis";
import { getRedis } from "./redis.js";

function tryGetRedis(): Redis | null {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

const inflight = new Map<string, Promise<unknown>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Envelope<T> = { value: T; expiresAt: number };

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
  opts: { staleSeconds?: number } = {},
): Promise<T> {
  const client = tryGetRedis();
  const staleTtl = opts.staleSeconds ?? ttlSeconds * 3;

  if (!client) {
    const existing = inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  let raw: string | null = null;
  try {
    raw = await client.get(key);
  } catch {
    raw = null;
  }

  if (raw) {
    try {
      const env_ = JSON.parse(raw) as Envelope<T>;
      if (env_.expiresAt > Date.now()) return env_.value;
      if (env_.expiresAt + staleTtl * 1000 > Date.now()) {
        refreshInBackground(client, key, ttlSeconds, staleTtl, fn);
        return env_.value;
      }
    } catch {
      // corrupted envelope → fall through to recompute
    }
  }

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const p = (async () => {
    const lockKey = `lock:${key}`;
    const gotLock = await client.set(lockKey, "1", "EX", 30, "NX").catch(() => null);

    if (!gotLock) {
      await sleep(150);
      const again = await client.get(key).catch(() => null);
      if (again) {
        try {
          return (JSON.parse(again) as Envelope<T>).value;
        } catch {
          // fall through
        }
      }
    }

    try {
      const value = await fn();
      const envelope: Envelope<T> = { value, expiresAt: Date.now() + ttlSeconds * 1000 };
      await client.setex(key, ttlSeconds + staleTtl, JSON.stringify(envelope)).catch(() => {});
      return value;
    } finally {
      if (gotLock) client.del(lockKey).catch(() => {});
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

function refreshInBackground<T>(
  client: Redis,
  key: string,
  ttl: number,
  staleTtl: number,
  fn: () => Promise<T>,
) {
  if (inflight.has(key)) return;
  const p = (async () => {
    const gotLock = await client.set(`lock:${key}`, "1", "EX", 30, "NX").catch(() => null);
    if (!gotLock) return;
    try {
      const value = await fn();
      const envelope: Envelope<T> = { value, expiresAt: Date.now() + ttl * 1000 };
      await client.setex(key, ttl + staleTtl, JSON.stringify(envelope));
    } catch (err) {
      console.error("[cache] background refresh failed for", key, err);
    } finally {
      await client.del(`lock:${key}`).catch(() => {});
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
}

export async function invalidate(key: string): Promise<void> {
  const client = tryGetRedis();
  if (!client) return;
  await client.del(key).catch(() => {});
}
