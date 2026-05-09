import type {
  ProviderFetchErr,
  ProviderFetchInput,
  ProviderFetchOk,
  ProviderFetchResult,
} from "./types.js";

/**
 * Shared bounded-fetch helper for external-delivery provider adapters.
 *
 * Wraps an adapter's actual work in a Promise.race against a timeout
 * timer + the caller-supplied AbortSignal. Adapters call this with a
 * function that returns either an ok payload or an Error; the helper
 * normalises the failure shape so every adapter surfaces the SAME
 * stable error codes regardless of which underlying library threw.
 */

export interface BoundedFetchArgs {
  input: ProviderFetchInput;
  /**
   * The adapter's actual work — typically an HTTP call. Returns the
   * raw counters when successful; throws on any failure (network,
   * 4xx, 5xx, malformed payload). The wrapper takes care of routing
   * the throw to the right error code.
   */
  work: (signal: AbortSignal) => Promise<{
    total: number;
    delivered: number;
    rto: number;
    cancelled: number;
  }>;
  /**
   * Adapter-specific classifier for thrown errors. Lets the adapter
   * route, e.g., a 4xx payload-shape problem to "bad_payload" vs a
   * connection reset to "http_error". Default is "unexpected".
   */
  classifyError?: (err: unknown) => ProviderFetchErr["error"];
}

export async function boundedFetch(
  args: BoundedFetchArgs,
): Promise<ProviderFetchResult> {
  const { input, work, classifyError } = args;
  const startedAt = Date.now();

  const ac = new AbortController();
  const onUpstreamAbort = () => ac.abort();
  if (input.signal) {
    if (input.signal.aborted) {
      return {
        ok: false,
        error: "aborted",
        detail: "caller signal already aborted",
        durationMs: 0,
        timedOut: false,
      };
    }
    input.signal.addEventListener("abort", onUpstreamAbort, { once: true });
  }

  const timer: NodeJS.Timeout | null = setTimeout(() => ac.abort(), input.timeoutMs);
  let timedOut = false;
  ac.signal.addEventListener("abort", () => {
    if (input.signal?.aborted) {
      // Upstream abort, not our timeout
      return;
    }
    timedOut = true;
  }, { once: true });

  try {
    const counters = await work(ac.signal);
    const denom = counters.delivered + counters.rto;
    const successRate = denom > 0 ? counters.delivered / denom : null;
    const ok: ProviderFetchOk = {
      ok: true,
      ...counters,
      successRate,
      durationMs: Date.now() - startedAt,
    };
    return ok;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (ac.signal.aborted && timedOut) {
      return { ok: false, error: "timeout", durationMs, timedOut: true };
    }
    if (input.signal?.aborted) {
      return { ok: false, error: "aborted", durationMs, timedOut: false };
    }
    const error = classifyError?.(err) ?? "unexpected";
    return {
      ok: false,
      error,
      detail: ((err as Error)?.message ?? String(err)).slice(0, 200),
      durationMs,
      timedOut: false,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (input.signal) input.signal.removeEventListener("abort", onUpstreamAbort);
  }
}
