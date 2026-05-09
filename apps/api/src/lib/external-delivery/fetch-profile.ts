import { Types } from "mongoose";
import {
  EXTERNAL_DELIVERY_PIPELINE_VERSION,
  ExternalDeliveryProfile,
} from "@ecom/db";
import { env } from "../../env.js";
import {
  getCachedProfile,
  invalidateCachedProfile,
  setCachedProfile,
  type CacheKeyParts,
} from "./cache.js";
import { normalizeAndHashBdPhone } from "./normalization.js";
import {
  aggregateProviders,
  type AggregateResult,
  type ProviderResultLike,
} from "./aggregation.js";
import { classifyExternalDeliverySignals } from "./signals.js";
import {
  DEFAULT_EXTERNAL_PROVIDERS,
  type ExternalProviderAdapter,
  type ProviderFetchResult,
} from "./providers/index.js";
import {
  recordExternalDeliveryObservability,
  recordProviderLatency,
} from "../observability/external-delivery.js";

/**
 * external-delivery / fetch-profile — orchestrator for the cache-first
 * MERCHANT-SCOPED courier-history backfill pipeline.
 *
 * Cold-start helper. Every result is per-(merchant, phone): the data
 * was fetched using THIS merchant's connected courier credentials
 * against THIS merchant's own historical orders.
 *
 * Hard rules (binding):
 *   - NEVER throws back to the caller. All error paths resolve a
 *     ProfileResult or null.
 *   - NEVER blocks ingest. NEVER touches the chokepoint. NEVER writes
 *     any operational aggregate.
 *   - Master-flag-gated (EXTERNAL_DELIVERY_ENABLED). When off, returns
 *     null immediately — no DB / Redis / provider touch.
 *   - In-flight dedupe per (process, merchantId, phoneHash): two
 *     callers asking for the same key see at most one provider fan-
 *     out per stale window.
 *   - Bounded provider timeout. Partial-failure tolerant.
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface ExternalProfileResult {
  merchantId: string;
  phoneHash: string;
  normalizedPhone: string;
  providers: Record<
    string,
    {
      configured: boolean;
      ok: boolean;
      total: number;
      delivered: number;
      rto: number;
      cancelled: number;
      successRate: number | null;
      lastFetchedAt: Date | null;
      sourceVersion: string;
      error?: string;
    }
  >;
  aggregate: AggregateResult;
  signals: ReturnType<typeof classifyExternalDeliverySignals>;
  freshness: {
    fetchedAt: Date;
    expiresAt: Date;
    stale: boolean;
  };
  pipelineVersion: string;
  /** True when the result came from Redis. */
  source: "cache" | "mongo" | "providers";
}

/* -------------------------------------------------------------------------- */
/* In-process dedupe registry                                                 */
/* -------------------------------------------------------------------------- */

const inFlight = new Map<string, Promise<ExternalProfileResult | null>>();

function flightKey(merchantHex: string, phoneHash: string): string {
  return `${merchantHex}|${phoneHash}`;
}

/* -------------------------------------------------------------------------- */
/* Public entry                                                               */
/* -------------------------------------------------------------------------- */

export interface FetchProfileInput {
  merchantId: Types.ObjectId | string;
  /** Free-form phone — normalised internally. */
  phone: string;
  /** Override default provider set (test injection). */
  providers?: ReadonlyArray<ExternalProviderAdapter>;
  /** Override default timeout (test injection). */
  timeoutMs?: number;
}

/**
 * Cache-first fetch.
 *
 *   1. Master-flag check — return null when off.
 *   2. Normalise + hash the phone, resolve merchantId.
 *   3. Redis cache get → return on hit IF still fresh.
 *   4. Mongo profile read → return IF still fresh.
 *   5. Provider fan-out (bounded, partial-failure tolerant) using
 *      THIS merchant's credentials per provider.
 *   6. Aggregate + signals + persist Mongo + write Redis.
 *
 * Returns null when:
 *   - master flag off, OR
 *   - merchantId unusable, OR
 *   - phone unusable, OR
 *   - all storage layers AND providers failed.
 */
export async function getOrFetchExternalProfile(
  input: FetchProfileInput,
): Promise<ExternalProfileResult | null> {
  if (!env.EXTERNAL_DELIVERY_ENABLED) return null;
  if (!input || typeof input !== "object") return null;

  const merchantOid = (() => {
    if (input.merchantId instanceof Types.ObjectId) return input.merchantId;
    try {
      const s = String(input.merchantId);
      return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
    } catch {
      return null;
    }
  })();
  if (!merchantOid) return null;
  const merchantHex = merchantOid.toHexString();

  const normalized = normalizeAndHashBdPhone(input.phone);
  if (!normalized) return null;
  const { normalized: normalizedPhone, phoneHash } = normalized;

  // In-flight dedupe per (process, merchantHex, phoneHash).
  const key = flightKey(merchantHex, phoneHash);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = runOnce(
    merchantOid,
    merchantHex,
    phoneHash,
    normalizedPhone,
    input.providers ?? DEFAULT_EXTERNAL_PROVIDERS,
    input.timeoutMs ?? env.EXTERNAL_DELIVERY_PROVIDER_TIMEOUT_MS,
  );
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

async function runOnce(
  merchantOid: Types.ObjectId,
  merchantHex: string,
  phoneHash: string,
  normalizedPhone: string,
  providers: ReadonlyArray<ExternalProviderAdapter>,
  timeoutMs: number,
): Promise<ExternalProfileResult | null> {
  const cacheParts: CacheKeyParts = { merchantHex, phoneHash };

  // Step 3 — Redis cache.
  const cached = await getCachedProfile(cacheParts);
  if (cached.hit && cached.payload) {
    const payload = cached.payload.body as ExternalProfileResult | undefined;
    if (payload && isFresh(payload.freshness)) {
      recordExternalDeliveryObservability({
        event: "external_profile_cache_hit",
        merchantId: merchantHex,
        phoneHash,
      });
      return { ...payload, source: "cache" };
    }
    // Stale-in-cache — fall through.
  } else if (cached.warning === "parse_error") {
    void invalidateCachedProfile(cacheParts);
    recordExternalDeliveryObservability({
      event: "external_profile_cache_miss",
      merchantId: merchantHex,
      phoneHash,
      reason: cached.warning,
    });
  } else {
    recordExternalDeliveryObservability({
      event: "external_profile_cache_miss",
      merchantId: merchantHex,
      phoneHash,
      reason: cached.warning,
    });
  }

  // Step 4 — Mongo profile.
  const stored = await readStoredProfile(merchantOid, merchantHex, phoneHash);
  if (stored && isFresh(stored.freshness)) {
    void setCachedProfile(cacheParts, {
      body: stored,
      fetchedAt: stored.freshness.fetchedAt.getTime(),
    });
    return { ...stored, source: "mongo" };
  }

  // Step 5 — provider fan-out.
  recordExternalDeliveryObservability({
    event: "external_profile_fetch_started",
    merchantId: merchantHex,
    phoneHash,
    meta: { providers: providers.length },
  });
  const fanout = await fanOutProviders(
    providers,
    merchantHex,
    normalizedPhone,
    timeoutMs,
    phoneHash,
  );

  // Step 6 — aggregate + signals + persist + cache.
  const profile = await persistProfile({
    merchantOid,
    merchantHex,
    phoneHash,
    normalizedPhone,
    providers: fanout,
  });
  if (!profile) {
    recordExternalDeliveryObservability({
      event: "external_profile_fetch_failed",
      merchantId: merchantHex,
      phoneHash,
      reason: "persist_failed",
    });
    return null;
  }

  recordExternalDeliveryObservability({
    event: "external_profile_fetch_completed",
    merchantId: merchantHex,
    phoneHash,
    meta: {
      contributing: profile.aggregate.contributingProviders.length,
      total: profile.aggregate.total,
    },
  });
  return profile;
}

function isFresh(freshness: { expiresAt: Date | string }): boolean {
  const t = freshness.expiresAt instanceof Date
    ? freshness.expiresAt.getTime()
    : new Date(freshness.expiresAt).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() < t;
}

async function readStoredProfile(
  merchantOid: Types.ObjectId,
  merchantHex: string,
  phoneHash: string,
): Promise<ExternalProfileResult | null> {
  try {
    const row = await ExternalDeliveryProfile.findOne({
      merchantId: merchantOid,
      phoneHash,
    })
      .lean()
      .exec();
    if (!row) return null;
    return rowToResult(row, merchantHex);
  } catch (err) {
    recordExternalDeliveryObservability({
      event: "external_profile_fetch_failed",
      merchantId: merchantHex,
      phoneHash,
      reason: "mongo_read_failed",
      error: (err as Error).message?.slice(0, 200),
    });
    return null;
  }
}

interface RowShape {
  phoneHash: string;
  normalizedPhone: string;
  providers?: Map<string, unknown> | Record<string, unknown>;
  aggregate?: {
    total: number;
    delivered: number;
    rto: number;
    cancelled: number;
    successRate?: number | null;
    contributingProviders?: string[];
  };
  signals?: Partial<ReturnType<typeof classifyExternalDeliverySignals>>;
  freshness?: {
    fetchedAt?: Date | null;
    expiresAt?: Date | null;
    stale?: boolean;
  };
  pipelineVersion?: string;
}

function rowToResult(row: RowShape, merchantHex: string): ExternalProfileResult {
  const providers: ExternalProfileResult["providers"] = {};
  const map: Record<string, unknown> = (() => {
    if (!row.providers) return {};
    if (row.providers instanceof Map) {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of row.providers) obj[k] = v;
      return obj;
    }
    return row.providers as Record<string, unknown>;
  })();
  for (const [name, raw] of Object.entries(map)) {
    const v = raw as ExternalProfileResult["providers"][string];
    providers[name] = {
      configured: !!v?.configured,
      ok: !!v?.ok,
      total: typeof v?.total === "number" ? v.total : 0,
      delivered: typeof v?.delivered === "number" ? v.delivered : 0,
      rto: typeof v?.rto === "number" ? v.rto : 0,
      cancelled: typeof v?.cancelled === "number" ? v.cancelled : 0,
      successRate: typeof v?.successRate === "number" ? v.successRate : null,
      lastFetchedAt: v?.lastFetchedAt ? new Date(v.lastFetchedAt) : null,
      sourceVersion: typeof v?.sourceVersion === "string" ? v.sourceVersion : "",
      error: v?.error,
    };
  }
  const aggregate: AggregateResult = {
    total: row.aggregate?.total ?? 0,
    delivered: row.aggregate?.delivered ?? 0,
    rto: row.aggregate?.rto ?? 0,
    cancelled: row.aggregate?.cancelled ?? 0,
    successRate: row.aggregate?.successRate ?? null,
    contributingProviders: row.aggregate?.contributingProviders ?? [],
  };
  const signals = {
    strong_delivery_history: row.signals?.strong_delivery_history ?? false,
    elevated_return_pattern: row.signals?.elevated_return_pattern ?? false,
    sparse_history: row.signals?.sparse_history ?? true,
    mixed_delivery_history: row.signals?.mixed_delivery_history ?? false,
  };
  const fetchedAt = row.freshness?.fetchedAt ?? new Date(0);
  const expiresAt = row.freshness?.expiresAt ?? new Date(0);
  return {
    merchantId: merchantHex,
    phoneHash: row.phoneHash,
    normalizedPhone: row.normalizedPhone,
    providers,
    aggregate,
    signals,
    freshness: {
      fetchedAt: fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt),
      expiresAt: expiresAt instanceof Date ? expiresAt : new Date(expiresAt),
      stale: !!row.freshness?.stale,
    },
    pipelineVersion: row.pipelineVersion ?? EXTERNAL_DELIVERY_PIPELINE_VERSION,
    source: "mongo",
  };
}

interface FanoutEntry extends ProviderResultLike {
  raw: ProviderFetchResult;
  configured: boolean;
  sourceVersion: string;
  lastFetchedAt: Date | null;
}

async function fanOutProviders(
  providers: ReadonlyArray<ExternalProviderAdapter>,
  merchantHex: string,
  normalizedPhone: string,
  timeoutMs: number,
  phoneHash: string,
): Promise<FanoutEntry[]> {
  const results: FanoutEntry[] = [];
  const tasks = providers.map(async (a) => {
    const configured = a.isConfigured();
    if (!configured) {
      results.push({
        name: a.name,
        configured: false,
        ok: false,
        total: 0,
        delivered: 0,
        rto: 0,
        cancelled: 0,
        successRate: null,
        sourceVersion: a.sourceVersion,
        lastFetchedAt: null,
        raw: {
          ok: false,
          error: "stub_unconfigured",
          durationMs: 0,
          timedOut: false,
        },
      });
      return;
    }
    const r = await a.fetchHistory({
      merchantId: merchantHex,
      normalizedPhone,
      timeoutMs,
    });
    recordProviderLatency({
      provider: a.name,
      durationMs: r.durationMs,
      ok: r.ok,
      timedOut: !r.ok && r.timedOut,
    });
    if (!r.ok && r.timedOut) {
      recordExternalDeliveryObservability({
        event: "external_provider_timeout",
        merchantId: merchantHex,
        phoneHash,
        provider: a.name,
        durationMs: r.durationMs,
      });
    }
    if (r.ok) {
      results.push({
        name: a.name,
        configured: true,
        ok: true,
        total: r.total,
        delivered: r.delivered,
        rto: r.rto,
        cancelled: r.cancelled,
        successRate: r.successRate,
        sourceVersion: a.sourceVersion,
        lastFetchedAt: new Date(),
        raw: r,
      });
    } else {
      results.push({
        name: a.name,
        configured: true,
        ok: false,
        total: 0,
        delivered: 0,
        rto: 0,
        cancelled: 0,
        successRate: null,
        sourceVersion: a.sourceVersion,
        lastFetchedAt: new Date(),
        raw: r,
      });
    }
  });
  await Promise.allSettled(tasks);

  const okCount = results.filter((r) => r.ok).length;
  const failedCount = results.filter((r) => r.configured && !r.ok).length;
  if (okCount > 0 && failedCount > 0) {
    recordExternalDeliveryObservability({
      event: "external_provider_partial_failure",
      merchantId: merchantHex,
      phoneHash,
      meta: { ok: okCount, failed: failedCount },
    });
  }
  return results;
}

async function persistProfile(args: {
  merchantOid: Types.ObjectId;
  merchantHex: string;
  phoneHash: string;
  normalizedPhone: string;
  providers: FanoutEntry[];
}): Promise<ExternalProfileResult | null> {
  const aggregate = aggregateProviders(args.providers);
  const signals = classifyExternalDeliverySignals(aggregate, args.providers);
  const now = new Date();
  const ttlMs = env.EXTERNAL_DELIVERY_TTL_HOURS * 60 * 60 * 1000;
  const expiresAt = new Date(now.getTime() + ttlMs);

  const providerSubdocs: Record<string, unknown> = {};
  for (const p of args.providers) {
    providerSubdocs[p.name] = {
      configured: p.configured,
      ok: p.ok,
      total: p.total,
      delivered: p.delivered,
      rto: p.rto,
      cancelled: p.cancelled,
      successRate: p.successRate,
      lastFetchedAt: p.lastFetchedAt,
      sourceVersion: p.sourceVersion,
      ...(p.raw && !p.raw.ok && p.raw.error
        ? { error: p.raw.error }
        : {}),
    };
  }

  const update = {
    $set: {
      merchantId: args.merchantOid,
      phoneHash: args.phoneHash,
      normalizedPhone: args.normalizedPhone,
      providers: providerSubdocs,
      aggregate: {
        total: aggregate.total,
        delivered: aggregate.delivered,
        rto: aggregate.rto,
        cancelled: aggregate.cancelled,
        successRate: aggregate.successRate,
        contributingProviders: aggregate.contributingProviders,
      },
      signals,
      freshness: { fetchedAt: now, expiresAt, stale: false },
      pipelineVersion: EXTERNAL_DELIVERY_PIPELINE_VERSION,
    },
  };

  try {
    await ExternalDeliveryProfile.updateOne(
      { merchantId: args.merchantOid, phoneHash: args.phoneHash },
      update,
      { upsert: true },
    );
  } catch (err) {
    recordExternalDeliveryObservability({
      event: "external_profile_fetch_failed",
      merchantId: args.merchantHex,
      phoneHash: args.phoneHash,
      reason: "mongo_write_failed",
      error: (err as Error).message?.slice(0, 200),
    });
    return null;
  }

  const result: ExternalProfileResult = {
    merchantId: args.merchantHex,
    phoneHash: args.phoneHash,
    normalizedPhone: args.normalizedPhone,
    providers: providerSubdocs as ExternalProfileResult["providers"],
    aggregate,
    signals,
    freshness: { fetchedAt: now, expiresAt, stale: false },
    pipelineVersion: EXTERNAL_DELIVERY_PIPELINE_VERSION,
    source: "providers",
  };

  void setCachedProfile(
    { merchantHex: args.merchantHex, phoneHash: args.phoneHash },
    { body: result, fetchedAt: now.getTime() },
  );
  return result;
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  inFlight,
  isFresh,
  flightKey,
};
