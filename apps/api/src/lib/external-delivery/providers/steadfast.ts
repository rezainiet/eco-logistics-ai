import { env } from "../../../env.js";
import type {
  ExternalProviderAdapter,
  ProviderFetchInput,
  ProviderFetchResult,
} from "./types.js";

/**
 * Steadfast external-delivery adapter — Phase 4A stub.
 *
 * Steadfast's portal at https://portal.packzy.com offers per-order
 * tracking but no public customer-history-lookup endpoint. The
 * adapter's contract is the same regardless: when configured, it
 * issues one call per `fetchHistory` invocation and returns the
 * normalised counters; when unconfigured, it reports
 * `stub_unconfigured` and the orchestrator excludes it.
 *
 * Stable error codes reachable from this adapter:
 *   - stub_unconfigured
 */

export const steadfastAdapter: ExternalProviderAdapter = {
  name: "steadfast",
  sourceVersion: "steadfast-stub-v1",

  isConfigured(): boolean {
    if (!env.EXTERNAL_DELIVERY_STEADFAST_ENABLED) return false;
    return false;
  },

  async fetchHistory(_input: ProviderFetchInput): Promise<ProviderFetchResult> {
    return {
      ok: false,
      error: "stub_unconfigured",
      detail:
        "steadfast external-delivery history adapter is a Phase 4A stub; real HTTP call lands when API access is wired",
      durationMs: 0,
      timedOut: false,
    };
  },
};
