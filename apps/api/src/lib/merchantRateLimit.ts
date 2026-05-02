import { getRedis } from "./redis.js";

/**
 * Per-merchant token bucket — Redis-backed, atomic via a Lua script.
 *
 * Why per-merchant (not per-IP): the upstream rate limiter on the HTTP edge
 * (middleware/rateLimit.ts) protects the API process from a single IP DoS,
 * but it cannot tell that a Shopify webhook delivery and a dashboard manual
 * import both belong to the same merchant — an over-eager merchant can fan
 * 10k orders into the same queue and starve every other tenant.
 *
 * Why a token bucket (not a fixed-window counter): bursts are *legitimate*
 * for an e-commerce flow — the merchant just ran a flash-sale ad and 800
 * orders land in a minute. Fixed-window cuts that off at the first 60s
 * boundary; a token bucket lets the burst through (up to capacity) and only
 * throttles sustained over-spend.
 *
 * Why Lua (not WATCH/MULTI): the read-modify-write of a token bucket has to
 * be atomic across many api processes hitting the same Redis instance. A
 * Lua script runs server-side as a single command — no inter-process race.
 *
 * The bucket is silently disabled when Redis is unreachable (dev mode);
 * production callers should treat that as a cluster fault, not a free pass.
 */

const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])      -- tokens per millisecond (× 1e6 for precision)
local capacity = tonumber(ARGV[2])  -- bucket capacity in tokens
local cost = tonumber(ARGV[3])      -- tokens to consume on this call
local now = tonumber(ARGV[4])       -- ms epoch

local data = redis.call('HMGET', key, 'tokens', 'updatedAt')
local tokens = tonumber(data[1])
local updatedAt = tonumber(data[2])
if tokens == nil then
  tokens = capacity * 1e6
  updatedAt = now
end
local elapsed = math.max(0, now - updatedAt)
tokens = math.min(capacity * 1e6, tokens + elapsed * rate)

local allowed = 0
local retryAfterMs = 0
if tokens >= cost * 1e6 then
  tokens = tokens - cost * 1e6
  allowed = 1
else
  -- Compute when enough tokens will accumulate.
  local deficit = cost * 1e6 - tokens
  retryAfterMs = math.ceil(deficit / rate)
end

redis.call('HSET', key, 'tokens', tokens, 'updatedAt', now)
redis.call('EXPIRE', key, 3600)
return {allowed, retryAfterMs, math.floor(tokens / 1e6)}
`;

let scriptSha: string | null = null;

async function ensureScriptLoaded(): Promise<string> {
  if (scriptSha) return scriptSha;
  const client = getRedis();
  scriptSha = (await client.script("LOAD", TOKEN_BUCKET_LUA)) as string;
  return scriptSha;
}

export interface BucketConfig {
  /** Burst capacity (max tokens the bucket holds). */
  capacity: number;
  /** Sustained refill rate, tokens per second. */
  refillPerSecond: number;
  /** Cost of a single consume — usually 1 (one job = one token). */
  costPerCall?: number;
}

export interface BucketResult {
  allowed: boolean;
  /** Tokens remaining after this call. */
  remaining: number;
  /** When refused, ms to wait before the next retry can possibly succeed. */
  retryAfterMs: number;
}

/**
 * Per-queue defaults, sized for production-scale tenants (target: 100k–1M
 * orders/day per merchant). Bucket = burst headroom; refill = sustained
 * throughput. A 1M orders/day merchant averages ~12 orders/sec — refill must
 * comfortably exceed that on every per-order queue (book + sms).
 *
 * Sizing rule: refillPerSecond ≥ 4× peak sustained orders/sec for the
 * merchant's tier, capacity ≥ 60s of refill so a flash-sale burst clears
 * inside one minute without throttle. Per-merchant isolation means one
 * tenant burning their bucket NEVER affects another tenant — there is no
 * shared capacity here.
 */
export const DEFAULT_BUCKET_BUDGETS: Record<string, BucketConfig> = {
  default: { capacity: 200, refillPerSecond: 20 },
  // Courier webhooks fan ~6 events/delivery; 1M orders/day = ~70 evt/sec sustained.
  "webhook-process": { capacity: 2_000, refillPerSecond: 200 },
  // Auto-booking: one job per order. 1M orders/day ≈ 12 ord/sec; 20/sec gives 60% headroom.
  "automation-book": { capacity: 500, refillPerSecond: 20 },
  // Confirmation/transactional SMS: one per order, plus retries + alerts.
  "automation-sms": { capacity: 1_000, refillPerSecond: 50 },
  // Tracking sync polls per active shipment; capped lower because it's pull-not-push.
  "tracking-sync": { capacity: 500, refillPerSecond: 25 },
  // Bulk CSV import — burst tolerant, sustained throughput matters less.
  "commerce-import": { capacity: 1_000, refillPerSecond: 50 },
};

function bucketKey(scope: string, merchantId: string): string {
  return `bucket:${scope}:${merchantId}`;
}

/**
 * Try to consume `cost` tokens from the merchant's bucket for `scope` (the
 * queue name). Returns `{ allowed, remaining, retryAfterMs }`. NEVER throws
 * — Redis errors devolve to "allowed" so a caching-layer outage doesn't take
 * down the whole queue. Production redis monitoring catches the underlying
 * issue; we don't want to fail closed on a transient blip.
 */
export async function consumeMerchantTokens(
  scope: string,
  merchantId: string,
  config: BucketConfig = DEFAULT_BUCKET_BUDGETS[scope] ??
    DEFAULT_BUCKET_BUDGETS.default!,
): Promise<BucketResult> {
  const cost = config.costPerCall ?? 1;
  const ratePerMs = config.refillPerSecond / 1000;
  // Lua precision: multiply by 1e6 so we can do integer-math on sub-millisecond
  // refill rates without losing accuracy. The script reverses on the way out.
  const rateScaled = ratePerMs * 1e6;
  const now = Date.now();
  let client;
  try {
    client = getRedis();
  } catch {
    // No Redis (dev) — fail open.
    return { allowed: true, remaining: config.capacity, retryAfterMs: 0 };
  }
  try {
    const sha = await ensureScriptLoaded();
    const result = (await client.evalsha(
      sha,
      1,
      bucketKey(scope, merchantId),
      String(rateScaled),
      String(config.capacity),
      String(cost),
      String(now),
    )) as [number, number, number];
    return {
      allowed: result[0] === 1,
      retryAfterMs: result[1] ?? 0,
      remaining: result[2] ?? 0,
    };
  } catch (err) {
    // NOSCRIPT (script flushed) — reload and retry once.
    if ((err as { message?: string }).message?.includes("NOSCRIPT")) {
      scriptSha = null;
      try {
        const sha = await ensureScriptLoaded();
        const result = (await client.evalsha(
          sha,
          1,
          bucketKey(scope, merchantId),
          String(rateScaled),
          String(config.capacity),
          String(cost),
          String(now),
        )) as [number, number, number];
        return {
          allowed: result[0] === 1,
          retryAfterMs: result[1] ?? 0,
          remaining: result[2] ?? 0,
        };
      } catch (retryErr) {
        console.error(
          "[merchant-rate-limit] redis retry failed",
          (retryErr as Error).message,
        );
        return { allowed: true, remaining: config.capacity, retryAfterMs: 0 };
      }
    }
    console.error(
      "[merchant-rate-limit] redis error",
      (err as Error).message,
    );
    return { allowed: true, remaining: config.capacity, retryAfterMs: 0 };
  }
}

/** Test helper — wipes a merchant's bucket so test runs don't bleed state. */
export async function __resetMerchantBucket(
  scope: string,
  merchantId: string,
): Promise<void> {
  try {
    await getRedis().del(bucketKey(scope, merchantId));
  } catch {
    /* no-op */
  }
}
