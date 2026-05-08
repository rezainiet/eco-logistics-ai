import { LRUCache } from "lru-cache";
import {
  BRANDING_CACHE_TTL_MS,
  DEFAULT_BRANDING,
  invalidateBranding as invalidatePackageCache,
  mergeBranding,
  type BrandingConfig,
  type BrandingPatch,
} from "@ecom/branding";
import { BrandingConfig as BrandingConfigModel } from "@ecom/db";

/**
 * Mongo-backed branding store. The thin layer that bridges
 * `@ecom/branding` (pure, framework-free) with `@ecom/db` (Mongoose).
 *
 * Why this lives in apps/api (not in @ecom/branding): the package is
 * intentionally Mongoose-free so apps/web can import it without dragging
 * the ORM into the marketing bundle. apps/web reads branding through a
 * tRPC procedure that calls `loadBrandingFromStore()` here on the API
 * side.
 *
 * Why this is its own file (not inlined in the router): workers also
 * need branding (email templates, admin SMS, woocommerce sync, stripe
 * sync) and they don't go through tRPC. A shared loader is simpler than
 * duplicating the cache + Mongo lookup in three places.
 */

const cache = new LRUCache<string, BrandingConfig>({
  max: 8,
  ttl: BRANDING_CACHE_TTL_MS,
});

/**
 * Read the persisted patch from Mongo. Returns null on any failure
 * (missing doc, Mongo down, malformed shape) so callers always have a
 * baked-in fallback. NEVER throws.
 */
export async function loadBrandingPatch(
  key = "saas",
): Promise<BrandingPatch | null> {
  try {
    const doc = await BrandingConfigModel.findOne({ key }).lean();
    if (!doc) return null;
    // Cast through unknown — Mongo's Mixed subtrees come back as plain
    // objects but the static type is `unknown`.
    const patch: BrandingPatch = {
      name: doc.name ?? undefined,
      legalName: doc.legalName ?? undefined,
      tagline: doc.tagline ?? undefined,
      shortTagline: doc.shortTagline ?? undefined,
      productCategory: doc.productCategory ?? undefined,
      defaultLocale: doc.defaultLocale ?? undefined,
      homeUrl: doc.homeUrl ?? undefined,
      statusPageUrl: doc.statusPageUrl ?? undefined,
      termsUrl: doc.termsUrl ?? undefined,
      privacyUrl: doc.privacyUrl ?? undefined,
      supportUrl: doc.supportUrl ?? undefined,
      supportEmail: doc.supportEmail ?? undefined,
      privacyEmail: doc.privacyEmail ?? undefined,
      salesEmail: doc.salesEmail ?? undefined,
      helloEmail: doc.helloEmail ?? undefined,
      noReplyEmail: doc.noReplyEmail ?? undefined,
      colors: (doc.colors as BrandingPatch["colors"]) ?? undefined,
      assets: (doc.assets as BrandingPatch["assets"]) ?? undefined,
      email: (doc.email as BrandingPatch["email"]) ?? undefined,
      seo: (doc.seo as BrandingPatch["seo"]) ?? undefined,
      operational:
        (doc.operational as BrandingPatch["operational"]) ?? undefined,
    };
    return patch;
  } catch (err) {
    console.warn(
      `[branding] loadBrandingPatch failed: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Resolve the full BrandingConfig (defaults → DB → ENV). Cached in-process.
 * Used by the API itself + workers + tRPC `branding.get` for apps/web.
 */
export async function loadBrandingFromStore(
  key = "saas",
): Promise<BrandingConfig> {
  const cached = cache.get(key);
  if (cached) return cached;

  let resolved: BrandingConfig = { ...DEFAULT_BRANDING, key };
  const patch = await loadBrandingPatch(key);
  if (patch) resolved = mergeBranding(resolved, patch);

  // Apply ENV overrides last so a deploy can pin/recover.
  const envRaw = process.env.BRANDING_OVERRIDES;
  if (envRaw) {
    try {
      const envPatch = JSON.parse(envRaw) as BrandingPatch;
      resolved = mergeBranding(resolved, envPatch);
    } catch (err) {
      console.warn(
        `[branding] BRANDING_OVERRIDES invalid JSON: ${(err as Error).message}`,
      );
    }
  }

  cache.set(key, resolved);
  return resolved;
}

/** Wipe the in-process cache. Call after every successful write. */
export function invalidateBrandingStore(key = "saas"): void {
  cache.delete(key);
  // Also wipe the package-level cache (used by `getBranding()` in code paths
  // that don't go through this store). Keeps both layers consistent.
  invalidatePackageCache();
}
