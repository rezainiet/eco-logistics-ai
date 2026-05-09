import type { ExternalProviderAdapter } from "./types.js";
import { bdcourierAdapter } from "./bdcourier.js";
import { pathaoAdapter } from "./pathao.js";
import { redxAdapter } from "./redx.js";
import { steadfastAdapter } from "./steadfast.js";

export * from "./types.js";
export { boundedFetch } from "./bounded.js";
export {
  bdcourierAdapter,
  pathaoAdapter,
  redxAdapter,
  steadfastAdapter,
};

/**
 * Default adapter set for the orchestrator. Order matters only for
 * `aggregate.contributingProviders` (preserved as input order).
 *
 * BDCourier is listed first because it is the platform-service
 * adapter (real HTTP) — when it returns ok and the per-merchant
 * stubs are unconfigured, BDCourier alone drives the aggregate
 * cleanly. When the per-merchant stubs land real implementations
 * later, BDCourier becomes one signal among many — the variance
 * across providers feeds `mixed_delivery_history`.
 *
 * To add a 5th provider:
 *   1. Add the canonical name to EXTERNAL_DELIVERY_PROVIDERS in the
 *      model module (`packages/db/src/models/externalDeliveryProfile.ts`).
 *   2. Add a per-provider env flag.
 *   3. Implement an adapter satisfying ExternalProviderAdapter.
 *   4. Append to this array.
 */
export const DEFAULT_EXTERNAL_PROVIDERS: ReadonlyArray<ExternalProviderAdapter> = [
  bdcourierAdapter,
  pathaoAdapter,
  steadfastAdapter,
  redxAdapter,
];
