/**
 * external-delivery / aggregation — pure-function rollup over a set of
 * provider results into the aggregate counters + contributing-providers
 * list.
 *
 * Pure — no DB, no I/O. Tests run without mongodb-memory-server.
 *
 * Hard rule: only configured-AND-ok provider results contribute to the
 * aggregate. A configured-but-failed (timeout / 5xx) provider's
 * counters are NOT aggregated; the orchestrator persists the per-
 * provider failure separately so the merchant UI can surface "we tried
 * but couldn't reach Pathao right now" rather than baking the missing
 * data into the aggregate.
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface ProviderCounters {
  total: number;
  delivered: number;
  rto: number;
  cancelled: number;
  successRate: number | null;
}

export interface ProviderResultLike {
  /** Provider name, e.g. "pathao". Used for `contributingProviders`. */
  name: string;
  configured: boolean;
  ok: boolean;
  total: number;
  delivered: number;
  rto: number;
  cancelled: number;
  successRate: number | null;
}

export interface AggregateResult extends ProviderCounters {
  contributingProviders: string[];
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function safeCount(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Compute the merged aggregate over a set of provider results. Callers
 * pass the FULL set (including unconfigured / failed); the function
 * filters internally so the contributingProviders list is honest.
 *
 * `successRate` is computed as `delivered / (delivered + rto)` —
 * cancellations are excluded from the denominator because they are
 * frequently merchant-side (out of stock / merchant rejected) and
 * misrepresent buyer reliability.
 *
 * Returns successRate=null when no provider contributed any data.
 */
export function aggregateProviders(
  providers: ReadonlyArray<ProviderResultLike>,
): AggregateResult {
  const contributing: string[] = [];
  let total = 0;
  let delivered = 0;
  let rto = 0;
  let cancelled = 0;
  for (const p of providers) {
    if (!p || !p.configured || !p.ok) continue;
    contributing.push(p.name);
    total += safeCount(p.total);
    delivered += safeCount(p.delivered);
    rto += safeCount(p.rto);
    cancelled += safeCount(p.cancelled);
  }
  const denom = delivered + rto;
  const successRate = denom > 0 ? delivered / denom : null;
  return { total, delivered, rto, cancelled, successRate, contributingProviders: contributing };
}

/**
 * Compute the per-provider success-rate variance for the
 * mixed_provider_reputation signal. Returns 0 when fewer than 2
 * providers contributed (no comparison possible).
 *
 * Variance uses delivered/(delivered+rto) per provider, ignoring
 * unconfigured / failed providers.
 */
export function providerSuccessRateVariance(
  providers: ReadonlyArray<ProviderResultLike>,
): number {
  const rates: number[] = [];
  for (const p of providers) {
    if (!p || !p.configured || !p.ok) continue;
    const denom = safeCount(p.delivered) + safeCount(p.rto);
    if (denom === 0) continue;
    rates.push(safeCount(p.delivered) / denom);
  }
  if (rates.length < 2) return 0;
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const sumSq = rates.reduce((a, r) => a + (r - mean) * (r - mean), 0);
  return Math.sqrt(sumSq / rates.length);
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  safeCount,
};
