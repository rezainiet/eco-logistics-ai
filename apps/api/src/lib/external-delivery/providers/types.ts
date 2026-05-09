/**
 * external-delivery provider adapter contract.
 *
 * Each adapter wraps a third-party courier's customer-history-lookup
 * API behind a unified shape. The orchestrator runs every adapter in
 * parallel under a single bounded timeout, then aggregates only the
 * adapters that returned configured AND ok.
 *
 * Hard rules (binding):
 *   - NEVER throws back to the orchestrator. Adapters internally
 *     try/catch every error and surface it via { ok: false, error }.
 *   - Bounded timeout enforced via AbortController + Promise.race.
 *   - Output is a flat shape — no nested adapter objects, no provider-
 *     specific metadata leaking into the aggregate.
 *   - Pure side-effects (HTTP only). No DB writes, no queue dispatches,
 *     no env mutation.
 */

export interface ProviderFetchInput {
  /**
   * Owning merchant — the adapter looks up THIS merchant's
   * `Merchant.couriers[<provider>].apiKey/apiSecret` to authenticate
   * the call. The data returned is the merchant's own historical
   * orders for the buyer phone (NOT a cross-merchant query).
   */
  merchantId: string;
  /** Canonical 13-digit BD phone ("8801XXXXXXXXX"). Already normalised. */
  normalizedPhone: string;
  /** Per-call timeout. The orchestrator passes a short value (5s default). */
  timeoutMs: number;
  /**
   * Optional caller-supplied AbortSignal. If aborted, the adapter
   * returns { ok: false, error: "aborted" }. Used by the orchestrator
   * to cancel still-in-flight fan-outs once the merchant request has
   * already been resolved.
   */
  signal?: AbortSignal;
}

export interface ProviderFetchOk {
  ok: true;
  total: number;
  delivered: number;
  rto: number;
  cancelled: number;
  /** delivered / (delivered + rto). Null when no decided history. */
  successRate: number | null;
  /** Adapter round-trip latency. */
  durationMs: number;
}

export interface ProviderFetchErr {
  ok: false;
  /** Stable error code: "stub_unconfigured" / "timeout" / "http_error" /
   *  "bad_payload" / "aborted" / "ssrf_blocked" / "unexpected". The
   *  adapter's contract is that this enumerates the set of routable
   *  failure modes. ssrf_blocked surfaces when the SSRF guard
   *  (lib/integrations/safe-fetch.ts) refused the request because the
   *  configured URL resolved to a private/loopback host — a deploy
   *  misconfiguration; loud by design so ops can triage. */
  error:
    | "stub_unconfigured"
    | "timeout"
    | "http_error"
    | "bad_payload"
    | "aborted"
    | "ssrf_blocked"
    | "unexpected";
  /** Truncated free-form detail. Never raw stack traces. */
  detail?: string;
  /** Adapter round-trip latency. */
  durationMs: number;
  timedOut: boolean;
}

export type ProviderFetchResult = ProviderFetchOk | ProviderFetchErr;

export interface ExternalProviderAdapter {
  /** Stable provider name; matches `EXTERNAL_DELIVERY_PROVIDERS`. */
  readonly name: string;
  /** Adapter version label written into the persisted snapshot. */
  readonly sourceVersion: string;
  /** Returns true when the per-provider env flag is on AND the
   *  adapter has the credentials it needs to make the call. */
  isConfigured(): boolean;
  /** Bounded fetch. Never throws; always resolves a ProviderFetchResult. */
  fetchHistory(input: ProviderFetchInput): Promise<ProviderFetchResult>;
}
