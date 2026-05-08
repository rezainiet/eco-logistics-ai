import type { BrandingConfig, BrandingPatch } from "./types.js";

/**
 * Deep-merge a `BrandingPatch` onto a complete `BrandingConfig`.
 *
 * Only known keys are merged; arrays (keywords) are replaced wholesale;
 * `undefined` values are skipped (so "field cleared" is signaled by `null`,
 * which the caller may convert to default before patching).
 *
 * The result is always a complete BrandingConfig — no `Partial<>` leakage —
 * which is the invariant every consumer depends on.
 */
export function mergeBranding(
  base: BrandingConfig,
  patch: BrandingPatch,
): BrandingConfig {
  return {
    ...base,
    name: patch.name ?? base.name,
    legalName: patch.legalName ?? base.legalName,
    tagline: patch.tagline ?? base.tagline,
    shortTagline: patch.shortTagline ?? base.shortTagline,
    productCategory: patch.productCategory ?? base.productCategory,
    defaultLocale: patch.defaultLocale ?? base.defaultLocale,
    homeUrl: patch.homeUrl ?? base.homeUrl,
    statusPageUrl: patch.statusPageUrl ?? base.statusPageUrl,
    termsUrl: patch.termsUrl ?? base.termsUrl,
    privacyUrl: patch.privacyUrl ?? base.privacyUrl,
    supportUrl: patch.supportUrl ?? base.supportUrl,
    supportEmail: patch.supportEmail ?? base.supportEmail,
    privacyEmail: patch.privacyEmail ?? base.privacyEmail,
    salesEmail: patch.salesEmail ?? base.salesEmail,
    helloEmail: patch.helloEmail ?? base.helloEmail,
    noReplyEmail: patch.noReplyEmail ?? base.noReplyEmail,
    colors: { ...base.colors, ...(patch.colors ?? {}) },
    assets: { ...base.assets, ...(patch.assets ?? {}) },
    email: { ...base.email, ...(patch.email ?? {}) },
    seo: {
      ...base.seo,
      ...(patch.seo ?? {}),
      keywords: patch.seo?.keywords ?? base.seo.keywords,
    },
    operational: { ...base.operational, ...(patch.operational ?? {}) },
  };
}
