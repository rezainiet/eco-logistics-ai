import { CourierError, type CourierName } from "./types.js";

/**
 * Per-key circuit breaker for courier API calls.
 *
 * The audit flagged courier adapters as a HIGH risk: 15s fetch timeout × 3
 * retries × 3-courier auto-book chain = up to 135s of order-flow blocking
 * during a partial Pathao / RedX / Steadfast outage. The breaker caps every
 * logical call at 5 seconds wall-time, fast-fails when the upstream is
 * known to be unhealthy, and self-heals via a half-open probe.
 *
 * Three states:
 *
 *   closed     → normal operation; failures are counted, successes reset
 *                the count. After `failureThreshold` consecutive failures
 *                the breaker trips → open.
 *   open       → every call fast-fails with `circuit_open` for
 *                `openDurationMs`. No upstream traffic, no waiting.
 *   half_open  → after the cooldown, the NEXT call is allowed through as
 *                a probe. If it succeeds → closed (and counters reset);
 *                if it fails → straight back to open. While the probe is
 *                in flight, all other concurrent calls fast-fail so we
 *                don't stampede a recovering upstream.
 *
 * Keying: callers pass a stable key like `pathao:account-12`. We deliberately
 * key on (provider, accountId) — one merchant's bad credentials must not
 * trip the breaker for everyone else on the same provider. The metrics
 * surface keeps the per-key view so an admin can see which accounts are
 * tripping.
 *
 * Wall-time guarantee: every fn() call runs under an AbortSignal whose
 * deadline is `totalBudgetMs` (default 5000). When the deadline fires:
 *   - the fn() promise loses the race to a synthetic timeout
 *   - the AbortSignal fires so any inner `fetch` / `withRetry` can react
 *   - the failure counter increments
 * The deadline is the headline contract — even an unresponsive upstream
 * cannot hold a worker beyond 5 seconds.
 */

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerConfig {
  /** Consecutive failures in closed state before tripping to open. */
  failureThreshold: number;
  /** How long to stay open before allowing a half-open probe. */
  openDurationMs: number;
  /** Wall-time ceiling for a single fn() call. */
  totalBudgetMs: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  openDurationMs: 30_000,
  totalBudgetMs: 5_000,
};

interface BreakerEntry {
  key: string;
  provider: CourierName | "unknown";
  state: BreakerState;
  failureCount: number;
  /**
   * Earliest moment a call may attempt (open → half-open transition). When
   * `state === "open"` and `Date.now() < openUntil` we fast-fail. Once the
   * deadline passes we lazily flip the state to half_open on the next call.
   */
  openUntil: number;
  /**
   * Half-open probe lock. Set to true while a single probe call is in
   * flight; concurrent calls during this window fast-fail. Reset on
   * probe completion (regardless of outcome).
   */
  probeInflight: boolean;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  totalSuccesses: number;
  totalFailures: number;
  totalFastFails: number;
  totalTrips: number;
}

const breakers = new Map<string, BreakerEntry>();

function getEntry(key: string, provider: CourierName | "unknown"): BreakerEntry {
  let entry = breakers.get(key);
  if (!entry) {
    entry = {
      key,
      provider,
      state: "closed",
      failureCount: 0,
      openUntil: 0,
      probeInflight: false,
      lastFailureAt: null,
      lastSuccessAt: null,
      totalSuccesses: 0,
      totalFailures: 0,
      totalFastFails: 0,
      totalTrips: 0,
    };
    breakers.set(key, entry);
  }
  return entry;
}

function providerFromKey(key: string): CourierName | "unknown" {
  const colon = key.indexOf(":");
  const head = colon >= 0 ? key.slice(0, colon) : key;
  const candidates: CourierName[] = [
    "pathao",
    "steadfast",
    "redx",
    "ecourier",
    "paperfly",
    "other",
  ];
  return (candidates as readonly string[]).includes(head)
    ? (head as CourierName)
    : "unknown";
}

function recordFailure(entry: BreakerEntry, cfg: BreakerConfig): void {
  entry.totalFailures++;
  entry.lastFailureAt = Date.now();
  if (entry.state === "half_open") {
    // Half-open probe failed — straight back to open with a fresh cooldown.
    entry.state = "open";
    entry.openUntil = Date.now() + cfg.openDurationMs;
    entry.totalTrips++;
    return;
  }
  entry.failureCount++;
  if (entry.failureCount >= cfg.failureThreshold) {
    entry.state = "open";
    entry.openUntil = Date.now() + cfg.openDurationMs;
    entry.totalTrips++;
  }
}

function recordSuccess(entry: BreakerEntry): void {
  entry.totalSuccesses++;
  entry.lastSuccessAt = Date.now();
  entry.failureCount = 0;
  entry.state = "closed";
  entry.openUntil = 0;
}

/**
 * Fast-fail error thrown when the breaker is open. `retryable: true` so
 * upstream retry layers (e.g. the auto-book fallback chain) move on to
 * the next courier without lingering.
 */
export function circuitOpenError(provider: CourierName | "unknown"): CourierError {
  return new CourierError("circuit_open", `circuit open for ${provider}`, {
    retryable: true,
    provider: provider === "unknown" ? undefined : provider,
  });
}

/**
 * Wall-time-bounded breaker call. The signal passed to fn() fires when
 * either the breaker's totalBudgetMs deadline elapses, OR the caller's
 * own signal aborts (if one is provided via opts.parentSignal).
 */
export async function withBreaker<T>(
  key: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: Partial<BreakerConfig> & { parentSignal?: AbortSignal } = {},
): Promise<T> {
  const cfg: BreakerConfig = {
    failureThreshold: opts.failureThreshold ?? DEFAULT_BREAKER_CONFIG.failureThreshold,
    openDurationMs: opts.openDurationMs ?? DEFAULT_BREAKER_CONFIG.openDurationMs,
    totalBudgetMs: opts.totalBudgetMs ?? DEFAULT_BREAKER_CONFIG.totalBudgetMs,
  };
  const provider = providerFromKey(key);
  const entry = getEntry(key, provider);
  const now = Date.now();

  // 1. Open-state gating + lazy half-open transition
  if (entry.state === "open") {
    if (now < entry.openUntil) {
      entry.totalFastFails++;
      throw circuitOpenError(provider);
    }
    // Cooldown elapsed — flip to half_open. The first call through gets
    // the probe slot; concurrent siblings still fast-fail.
    entry.state = "half_open";
    entry.probeInflight = false;
  }
  if (entry.state === "half_open") {
    if (entry.probeInflight) {
      entry.totalFastFails++;
      throw circuitOpenError(provider);
    }
    entry.probeInflight = true;
  }

  // 2. Set up the budget signal. Combine with parent signal if present
  // so a higher-level deadline (e.g. an HTTP request that already has a
  // budget) cascades down to the courier call.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, cfg.totalBudgetMs);
  const onParentAbort = () => controller.abort();
  if (opts.parentSignal) {
    if (opts.parentSignal.aborted) controller.abort();
    else opts.parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  // 3. Race fn() against the budget. We use a dedicated timeout promise
  // because some upstream code paths (notably node:fetch) honour the
  // signal but still leak microtasks; the race guarantees we resolve at
  // exactly totalBudgetMs even if fn() is unresponsive to its signal.
  let timedOut = false;
  const budgetTimer = new Promise<never>((_, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(
        new CourierError(
          "timeout",
          `breaker total budget (${cfg.totalBudgetMs}ms) exceeded`,
          { retryable: true, provider: provider === "unknown" ? undefined : provider },
        ),
      );
    }, cfg.totalBudgetMs);
  });

  try {
    const result = await Promise.race([fn(controller.signal), budgetTimer]);
    if (entry.state === "half_open") {
      entry.probeInflight = false;
    }
    recordSuccess(entry);
    return result as T;
  } catch (err) {
    if (entry.state === "half_open") {
      entry.probeInflight = false;
    }
    recordFailure(entry, cfg);
    // If we tripped the budget timer, surface a timeout error tagged with
    // breaker context (more useful than a downstream AbortError).
    if (timedOut && !(err instanceof CourierError)) {
      throw new CourierError(
        "timeout",
        `breaker total budget (${cfg.totalBudgetMs}ms) exceeded`,
        { retryable: true, provider: provider === "unknown" ? undefined : provider },
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (opts.parentSignal) {
      opts.parentSignal.removeEventListener("abort", onParentAbort);
    }
  }
}

// ---- Observability ---------------------------------------------------------

export interface BreakerSnapshot {
  key: string;
  provider: CourierName | "unknown";
  state: BreakerState;
  failureCount: number;
  openUntil: number;
  totalSuccesses: number;
  totalFailures: number;
  totalFastFails: number;
  totalTrips: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

export function snapshotBreakers(): BreakerSnapshot[] {
  const out: BreakerSnapshot[] = [];
  for (const e of breakers.values()) {
    out.push({
      key: e.key,
      provider: e.provider,
      state: e.state,
      failureCount: e.failureCount,
      openUntil: e.openUntil,
      totalSuccesses: e.totalSuccesses,
      totalFailures: e.totalFailures,
      totalFastFails: e.totalFastFails,
      totalTrips: e.totalTrips,
      lastFailureAt: e.lastFailureAt,
      lastSuccessAt: e.lastSuccessAt,
    });
  }
  return out;
}

/** Returns the current state for a single key, or "closed" if unseen. */
export function breakerStateOf(key: string): BreakerState {
  return breakers.get(key)?.state ?? "closed";
}

/**
 * Force a breaker into a specific state. Intended for ops emergency
 * recovery (manual reset) and tests. Production callers should let the
 * breaker manage itself.
 */
export function forceBreakerState(
  key: string,
  state: BreakerState,
  opts: { openDurationMs?: number } = {},
): void {
  const entry = getEntry(key, providerFromKey(key));
  entry.state = state;
  if (state === "closed") {
    entry.failureCount = 0;
    entry.openUntil = 0;
    entry.probeInflight = false;
  } else if (state === "open") {
    // Without an explicit openUntil, every call would immediately flip to
    // half_open since `now >= 0` always. Default to 30s so the forced
    // state actually holds.
    entry.openUntil = Date.now() + (opts.openDurationMs ?? 30_000);
    entry.probeInflight = false;
  } else {
    // half_open
    entry.probeInflight = false;
  }
}

/** Test helper — wipe all breaker state. */
export function __resetBreakersForTests(): void {
  breakers.clear();
}
