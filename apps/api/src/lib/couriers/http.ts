import { CourierError, type CourierErrorCode, type CourierName } from "./types.js";
import {
  withBreaker,
  type BreakerConfig,
} from "./circuit-breaker.js";

/**
 * Per-fetch wall-time ceiling. Prior to the breaker pass this was 15s,
 * which let a single hung upstream block 45s+ once `withRetry` chained
 * its three attempts. The breaker enforces a hard 5s total budget for a
 * logical operation, so each individual fetch must fit under that — 4s
 * leaves headroom for backoff and the breaker overhead.
 */
const DEFAULT_TIMEOUT_MS = 4_000;

export interface HttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /**
   * External AbortSignal — when the breaker (or any other caller) wants
   * to cascade a deadline down to the fetch. Combined with the internal
   * timeout signal so whichever fires first aborts the request.
   */
  signal?: AbortSignal;
}

export interface HttpResponse<T> {
  status: number;
  ok: boolean;
  data: T;
}

/**
 * fetch with AbortController-backed timeout, optionally combined with a
 * parent signal supplied by the breaker. Returns parsed JSON (or raw text
 * if the body isn't JSON). Throws CourierError for transport failures and
 * timeouts.
 */
export async function httpRequest<T = unknown>(
  url: string,
  opts: HttpRequestOptions,
  provider: CourierName,
): Promise<HttpResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let onParentAbort: (() => void) | null = null;
  if (opts.signal) {
    if (opts.signal.aborted) {
      controller.abort();
    } else {
      onParentAbort = () => controller.abort();
      opts.signal.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(opts.headers ?? {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.status, ok: res.ok, data: data as T };
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === "AbortError") {
      throw new CourierError("timeout", "provider request timed out", {
        retryable: true,
        provider,
      });
    }
    throw new CourierError("network", `network error: ${(err as Error).message}`, {
      retryable: true,
      provider,
      raw: err,
    });
  } finally {
    clearTimeout(timer);
    if (opts.signal && onParentAbort) {
      opts.signal.removeEventListener("abort", onParentAbort);
    }
  }
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  onRetry?: (err: CourierError, attempt: number) => void;
  /**
   * Bail out of the retry loop when this signal aborts (e.g. the breaker's
   * 5s budget elapsed). Without this, a slow upstream that fails on every
   * attempt could drag retries past the budget.
   */
  signal?: AbortSignal;
}

/**
 * Retry with jittered exponential backoff for errors flagged `retryable`.
 * Non-retryable errors bubble up on the first failure. When `signal` is
 * supplied, the loop bails as soon as it aborts — both before invoking the
 * next attempt AND during backoff delays.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 300;
  const maxMs = opts.maxMs ?? 3_000;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (opts.signal?.aborted) {
      throw lastErr ?? abortedError();
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof CourierError) || !err.retryable || i === attempts - 1) {
        throw err;
      }
      // Honour the signal during the backoff itself — sleeping through a
      // 3s delay only to discover the budget already expired wastes the
      // entire budget on no-op waits.
      if (opts.signal?.aborted) throw err;
      opts.onRetry?.(err, i + 1);
      const delay = Math.min(maxMs, baseMs * 2 ** i) * (0.75 + Math.random() * 0.5);
      await sleepWithSignal(delay, opts.signal);
      if (opts.signal?.aborted) throw err;
    }
  }
  throw lastErr;
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortedError(): CourierError {
  return new CourierError("timeout", "request budget exceeded", {
    retryable: true,
  });
}

export function classifyHttpStatus(status: number): { code: CourierErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: "auth_failed", retryable: false };
  if (status === 400 || status === 422) return { code: "invalid_input", retryable: false };
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status >= 500) return { code: "provider_error", retryable: true };
  return { code: "provider_error", retryable: false };
}

/**
 * Convenience wrapper that composes the breaker + retry layers for a
 * courier adapter call. Adapters previously wrote
 * `withRetry(() => httpRequest(...))`; under the hardened model that
 * becomes `withCourierBreaker(key, signal => withRetry(() => httpRequest(..., {signal})))`.
 *
 * The breaker enforces the 5s total budget and per-key state machine;
 * the retry handles transient failures within that budget.
 */
export async function withCourierBreaker<T>(
  key: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: Partial<BreakerConfig> & { parentSignal?: AbortSignal } = {},
): Promise<T> {
  return withBreaker(key, fn, opts);
}
