import type { ExternalProviderAdapter } from "./types.js";
import { pathaoAdapter } from "./pathao.js";
import { redxAdapter } from "./redx.js";
import { steadfastAdapter } from "./steadfast.js";

export * from "./types.js";
export { boundedFetch } from "./bounded.js";
export { pathaoAdapter, redxAdapter, steadfastAdapter };

/**
 * Default adapter set for the orchestrator. Order matters only for
 * `aggregate.contributingProviders` (preserved as input order).
 *
 * To add a 4th provider in Phase 4B:
 *   1. Add the canonical name to EXTERNAL_DELIVERY_PROVIDERS in the
 *      model module.
 *   2. Add a per-provider env flag (EXTERNAL_DELIVERY_<NAME>_ENABLED).
 *   3. Implement an adapter satisfying ExternalProviderAdapter.
 *   4. Append to this array.
 */
export const DEFAULT_EXTERNAL_PROVIDERS: ReadonlyArray<ExternalProviderAdapter> = [
  pathaoAdapter,
  steadfastAdapter,
  redxAdapter,
];
