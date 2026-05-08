/**
 * Centralized SaaS branding types.
 *
 * Pure data shapes — no Mongoose, no React, no I/O. Both `apps/web` (SSR +
 * client) and `apps/api` (workers, tRPC, scripts) import these. The
 * Mongoose model in `@ecom/db` casts to/from `BrandingConfig` at the
 * boundary; everything else in the codebase consumes the plain object.
 */

/** Singleton key for the SaaS-level brand. Reserved for future multi-brand. */
export type BrandingKey = string;

export interface BrandingColors {
  brand: string;
  brandHover: string;
  brandActive: string;
  brandFg: string;
  accent?: string;
  surfaceBase: string;
  fg: string;
}

export interface BrandingAsset {
  url: string;
  widthPx?: number;
  heightPx?: number;
  alt?: string;
}

export interface BrandingAssets {
  logo: BrandingAsset;
  logoDark?: BrandingAsset;
  logoMono?: BrandingAsset;
  favicon: BrandingAsset;
  appleTouchIcon?: BrandingAsset;
  ogImage: BrandingAsset;
  twitterImage?: BrandingAsset;
  emailLogo?: BrandingAsset;
}

export interface BrandingEmail {
  senderName: string;
  senderAddress: string;
  replyTo?: string;
  footer: string;
  accentColor?: string;
  ctaTextDefault: string;
  supportLine: string;
}

export interface BrandingSeo {
  metaTitleTemplate: string;
  metaTitleDefault: string;
  metaDescription: string;
  keywords: string[];
  twitterHandle?: string;
  ogSiteName: string;
}

export interface BrandingOperational {
  onboardingWelcomeCopy: string;
  dashboardWelcomeCopy: string;
  sdkGlobalName: string;
  sdkConsolePrefix: string;
  smsBrand: string;
  stripeProductPrefix: string;
  woocommerceWebhookPrefix: string;
}

export interface BrandingConfig {
  key: BrandingKey;
  name: string;
  legalName: string;
  tagline: string;
  shortTagline: string;
  productCategory: string;
  defaultLocale: string;
  homeUrl: string;
  statusPageUrl: string;
  termsUrl: string;
  privacyUrl: string;
  supportUrl: string;
  supportEmail: string;
  privacyEmail: string;
  salesEmail: string;
  helloEmail: string;
  noReplyEmail: string;
  colors: BrandingColors;
  assets: BrandingAssets;
  email: BrandingEmail;
  seo: BrandingSeo;
  operational: BrandingOperational;
  version: number;
  updatedAt: string;
}

export type BrandingPatch = Partial<{
  name: string;
  legalName: string;
  tagline: string;
  shortTagline: string;
  productCategory: string;
  defaultLocale: string;
  homeUrl: string;
  statusPageUrl: string;
  termsUrl: string;
  privacyUrl: string;
  supportUrl: string;
  supportEmail: string;
  privacyEmail: string;
  salesEmail: string;
  helloEmail: string;
  noReplyEmail: string;
  colors: Partial<BrandingColors>;
  assets: Partial<BrandingAssets>;
  email: Partial<BrandingEmail>;
  seo: Partial<BrandingSeo>;
  operational: Partial<BrandingOperational>;
}>;
