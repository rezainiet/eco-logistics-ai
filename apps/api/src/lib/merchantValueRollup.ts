import { Types } from "mongoose";
import { Order } from "@ecom/db";

/**
 * Per-merchant order-value rollup. Powers the dynamic COD thresholds in the
 * risk engine — a high-ticket electronics merchant shouldn't trip "high COD"
 * on every order, and a low-ticket apparel merchant shouldn't sleep on a
 * 5x outlier. We compute mean + 75th-percentile from the merchant's last 90
 * days of resolved orders.
 *
 * Caching: keyed by merchantId in-process for `CACHE_TTL_MS` (10 min) so a
 * burst of orders from the same merchant doesn't fan out to 100x identical
 * aggregations. Cache is best-effort; cold start re-derives on demand.
 */

interface RollupValue {
  avgOrderValue: number;
  p75OrderValue: number;
  resolvedSampleSize: number;
  computedAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
/** Lookback window — last 90 days captures seasonality without lagging too far. */
const LOOKBACK_DAYS = 90;
/** Minimum resolved orders before p75 is considered statistically meaningful. */
const MIN_SAMPLE_FOR_P75 = 20;

const cache = new Map<string, RollupValue>();

export function __resetMerchantValueRollupCache(): void {
  cache.clear();
}

export interface MerchantValueRollup {
  avgOrderValue?: number;
  p75OrderValue?: number;
  resolvedSampleSize: number;
}

export async function getMerchantValueRollup(
  merchantId: Types.ObjectId,
): Promise<MerchantValueRollup> {
  const key = String(merchantId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return {
      avgOrderValue: cached.avgOrderValue || undefined,
      p75OrderValue: cached.p75OrderValue || undefined,
      resolvedSampleSize: cached.resolvedSampleSize,
    };
  }

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000);
  // Pull resolved orders only — pending orders don't yet say anything about
  // the merchant's actual basket. `delivered` carries the highest signal
  // (the customer paid + accepted), but RTO + cancelled are still bona-fide
  // attempts at this price point so we include them in the sample.
  const rows = await Order.find(
    {
      merchantId,
      "order.status": { $in: ["delivered", "rto", "cancelled"] },
      createdAt: { $gte: since },
    },
    { "order.cod": 1 },
  )
    .lean()
    .limit(5000);

  const cods = rows
    .map((r) => (r as { order?: { cod?: number } })?.order?.cod ?? 0)
    .filter((n): n is number => Number.isFinite(n) && n > 0);

  if (cods.length === 0) {
    cache.set(key, {
      avgOrderValue: 0,
      p75OrderValue: 0,
      resolvedSampleSize: 0,
      computedAt: Date.now(),
    });
    return { resolvedSampleSize: 0 };
  }

  cods.sort((a, b) => a - b);
  const avg = cods.reduce((s, n) => s + n, 0) / cods.length;
  // p75 is the value at the 75th percentile index (Math.floor for stability).
  const p75Index = Math.min(cods.length - 1, Math.floor(cods.length * 0.75));
  const p75 = cods[p75Index]!;

  const value: RollupValue = {
    avgOrderValue: Math.round(avg),
    p75OrderValue: Math.round(p75),
    resolvedSampleSize: cods.length,
    computedAt: Date.now(),
  };
  cache.set(key, value);

  return {
    avgOrderValue: value.avgOrderValue || undefined,
    // Suppress p75 surfaces when the sample is too small to be meaningful;
    // ingest will fall back to avgOrderValue, which the risk engine widens
    // a bit (×1.2) to compensate for the noisier signal.
    p75OrderValue:
      cods.length >= MIN_SAMPLE_FOR_P75 ? value.p75OrderValue : undefined,
    resolvedSampleSize: cods.length,
  };
}
