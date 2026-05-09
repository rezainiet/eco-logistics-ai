import { env } from "../../../env.js";
import type {
  ExternalProviderAdapter,
  ProviderFetchInput,
  ProviderFetchResult,
} from "./types.js";

/**
 * RedX external-delivery adapter — Phase 4A stub.
 *
 * Same posture as the Pathao / Steadfast stubs. When the real customer-
 * history-lookup endpoint becomes available, the implementation drops
 * into a `boundedFetch({ input, work })` call inside `fetchHistory`
 * with the appropriate error classifier.
 *
 * Stable error codes reachable from this adapter:
 *   - stub_unconfigured
 */

export const redxAdapter: ExternalProviderAdapter = {
  name: "redx",
  sourceVersion: "redx-stub-v1",

  isConfigured(): boolean {
    if (!env.EXTERNAL_DELIVERY_REDX_ENABLED) return false;
    return false;
  },

  async fetchHistory(_input: ProviderFetchInput): Promise<ProviderFetchResult> {
    return {
      ok: false,
      error: "stub_unconfigured",
      detail:
        "redx external-delivery history adapter is a Phase 4A stub; real HTTP call lands when API access is wired",
      durationMs: 0,
      timedOut: false,
    };
  },
};
