import type { IntegrationProvider } from "@ecom/db";
import { customApiAdapter } from "./customApi.js";
import { shopifyAdapter } from "./shopify.js";
import { wooAdapter } from "./woocommerce.js";
import type { IntegrationAdapter } from "./types.js";

const ADAPTERS: Record<IntegrationProvider, IntegrationAdapter | null> = {
  shopify: shopifyAdapter,
  woocommerce: wooAdapter,
  custom_api: customApiAdapter,
  csv: null, // CSV uses the existing bulk-upload path; no adapter needed.
};

export function adapterFor(provider: IntegrationProvider): IntegrationAdapter {
  const a = ADAPTERS[provider];
  if (!a) throw new Error(`integration: no adapter registered for ${provider}`);
  return a;
}

export function hasAdapter(provider: IntegrationProvider): boolean {
  return ADAPTERS[provider] !== null;
}

export * from "./types.js";
export { shopifyAdapter, buildShopifyInstallUrl } from "./shopify.js";
export { wooAdapter } from "./woocommerce.js";
export { customApiAdapter } from "./customApi.js";
