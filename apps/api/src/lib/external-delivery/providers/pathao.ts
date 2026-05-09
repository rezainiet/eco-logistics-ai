import { env } from "../../../env.js";
import type {
  ExternalProviderAdapter,
  ProviderFetchInput,
  ProviderFetchResult,
} from "./types.js";

/**
 * Pathao external-delivery adapter — Phase 4A stub.
 *
 * Pathao does not currently expose a public customer-history-lookup
 * endpoint at https://api-hermes.pathao.com. Merchants with private /
 * affiliate access can drop their HTTP call into the `work` block of
 * `boundedFetch` once they have it; until then the adapter reports
 * `configured: false` so the orchestrator excludes it from the
 * aggregate cleanly.
 *
 * Stable error codes reachable from this adapter:
 *   - stub_unconfigured  (env flag off OR no real implementation yet)
 */

export const pathaoAdapter: ExternalProviderAdapter = {
  name: "pathao",
  sourceVersion: "pathao-stub-v1",

  isConfigured(): boolean {
    if (!env.EXTERNAL_DELIVERY_PATHAO_ENABLED) return false;
    // Future: check that PATHAO_HISTORY_API_KEY (or whatever the real
    // contract requires) is present. Returning false here keeps the
    // orchestrator behaviour identical until real wiring lands.
    return false;
  },

  async fetchHistory(_input: ProviderFetchInput): Promise<ProviderFetchResult> {
    return {
      ok: false,
      error: "stub_unconfigured",
      detail:
        "pathao external-delivery history adapter is a Phase 4A stub; real HTTP call lands when API access is wired",
      durationMs: 0,
      timedOut: false,
    };
  },
};
