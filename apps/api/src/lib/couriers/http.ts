import { CourierError, type CourierErrorCode, type CourierName } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse<T> {
  status: number;
  ok: boolean;
  data: T;
}

/**
 * fetch with AbortController-backed timeout. Returns parsed JSON (or raw text if
 * the body isn't JSON). Throws CourierError for transport failures and timeouts.
 */
export async function httpRequest<T = unknown>(
  url: string,
  opts: HttpRequestOptions,
  provider: CourierName,
): Promise<HttpResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
  }
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  onRetry?: (err: CourierError, attempt: number) => void;
}

/**
 * Retry with jittered exponential backoff for errors flagged `retryable`.
 * Non-retryable errors bubble up on the first failure.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 300;
  const maxMs = opts.maxMs ?? 3_000;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof CourierError) || !err.retryable || i === attempts - 1) {
        throw err;
      }
      opts.onRetry?.(err, i + 1);
      const delay = Math.min(maxMs, baseMs * 2 ** i) * (0.75 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export function classifyHttpStatus(status: number): { code: CourierErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: "auth_failed", retryable: false };
  if (status === 400 || status === 422) return { code: "invalid_input", retryable: false };
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status >= 500) return { code: "provider_error", retryable: true };
  return { code: "provider_error", retryable: false };
}
