/**
 * @ecom/branding — centralized SaaS branding.
 *
 * Pure data + helpers; no Mongoose, no React, no I/O. Both apps/web and
 * apps/api consume this package. The Mongo-backed store lives in apps/api
 * (and writes a Mongoose model exported from @ecom/db); it's wired into
 * `getBranding()` via the optional `fetch` parameter.
 */

export type {
  BrandingConfig,
  BrandingPatch,
  BrandingColors,
  BrandingAsset,
  BrandingAssets,
  BrandingEmail,
  BrandingSeo,
  BrandingOperational,
  BrandingKey,
} from "./types.js";

export { DEFAULT_BRANDING, defaultInitials } from "./defaults.js";

export {
  hexToRgb,
  hexToHsl,
  hexToHslComponents,
  rgbToHsl,
  hslToHex,
  readableFg,
  relativeLuminance,
  adjustL,
  deriveBrandActive,
} from "./derive.js";

export type { HSL } from "./derive.js";

export { renderBrandingCss, brandingStyleVars } from "./cssVars.js";

export { buildRootMetadata } from "./metadata.js";
export type { RootBrandingMetadata, BuildRootMetadataOpts } from "./metadata.js";

export { parseEnvOverrides, listOverriddenFields } from "./env.js";

export { mergeBranding } from "./merge.js";

export {
  brandingPatchSchema,
  colorsPatchSchema,
  emailPatchSchema,
  seoPatchSchema,
  operationalPatchSchema,
  assetsPatchSchema,
  assetPatchSchema,
} from "./schema.js";
export type { BrandingPatchInput } from "./schema.js";

export {
  getBranding,
  getBrandingSync,
  invalidateBranding,
  BRANDING_CACHE_TTL_MS,
} from "./resolver.js";
export type { BrandingResolverOptions } from "./resolver.js";
