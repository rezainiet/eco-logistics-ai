import { z } from "zod";

/**
 * zod schemas for the admin Branding Panel input.
 *
 * Validation is permissive (most fields optional) because the panel sends a
 * patch, not a full document. The server-side resolver merges the patch
 * onto the current document before persisting.
 */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const hex = z
  .string()
  .regex(HEX_RE, "expected a 6-digit hex like #C6F84F");

const url = z.string().url();
const email = z.string().email();
const nonEmptyShort = z.string().trim().min(1).max(120);
const nonEmptyMedium = z.string().trim().min(1).max(280);

export const colorsPatchSchema = z
  .object({
    brand: hex.optional(),
    brandHover: hex.optional(),
    brandActive: hex.optional(),
    brandFg: hex.optional(),
    accent: hex.optional(),
    surfaceBase: hex.optional(),
    fg: hex.optional(),
  })
  .strict();

export const assetPatchSchema = z
  .object({
    url: z.string().min(1),
    widthPx: z.number().int().positive().optional(),
    heightPx: z.number().int().positive().optional(),
    alt: z.string().max(120).optional(),
  })
  .strict();

const ogAssetPatchSchema = assetPatchSchema.extend({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const assetsPatchSchema = z
  .object({
    logo: assetPatchSchema.optional(),
    logoDark: assetPatchSchema.optional(),
    logoMono: assetPatchSchema.optional(),
    favicon: assetPatchSchema.optional(),
    appleTouchIcon: assetPatchSchema.optional(),
    ogImage: ogAssetPatchSchema.optional(),
    twitterImage: assetPatchSchema.optional(),
    emailLogo: assetPatchSchema.optional(),
  })
  .strict();

export const emailPatchSchema = z
  .object({
    senderName: nonEmptyShort.optional(),
    senderAddress: email.optional(),
    replyTo: email.optional(),
    footer: nonEmptyMedium.optional(),
    accentColor: hex.optional(),
    ctaTextDefault: nonEmptyShort.optional(),
    supportLine: nonEmptyMedium.optional(),
  })
  .strict();

export const seoPatchSchema = z
  .object({
    metaTitleTemplate: z
      .string()
      .min(1)
      .refine((v) => v.includes("%s"), "template must contain %s")
      .optional(),
    metaTitleDefault: nonEmptyShort.optional(),
    metaDescription: z.string().max(320).optional(),
    keywords: z.array(z.string().min(1).max(64)).max(20).optional(),
    twitterHandle: z
      .string()
      .regex(/^@[A-Za-z0-9_]{1,15}$/, "expected @handle")
      .optional(),
    ogSiteName: nonEmptyShort.optional(),
  })
  .strict();

export const operationalPatchSchema = z
  .object({
    onboardingWelcomeCopy: z.string().max(320).optional(),
    dashboardWelcomeCopy: z.string().max(320).optional(),
    sdkGlobalName: z
      .string()
      .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "must be a valid JS identifier")
      .optional(),
    sdkConsolePrefix: z
      .string()
      .regex(/^\[[a-z0-9_-]{1,16}\]$/, "format like [cordon]")
      .optional(),
    smsBrand: z.string().min(1).max(40).optional(),
    stripeProductPrefix: z.string().min(1).max(40).optional(),
    woocommerceWebhookPrefix: z.string().min(1).max(40).optional(),
  })
  .strict();

export const brandingPatchSchema = z
  .object({
    name: nonEmptyShort.optional(),
    legalName: nonEmptyShort.optional(),
    tagline: nonEmptyShort.optional(),
    shortTagline: nonEmptyShort.optional(),
    productCategory: nonEmptyMedium.optional(),
    defaultLocale: z
      .string()
      .regex(/^[a-z]{2}(_[A-Z]{2})?$/, "expected ll or ll_CC")
      .optional(),
    homeUrl: url.optional(),
    statusPageUrl: url.optional(),
    termsUrl: z.string().min(1).optional(),
    privacyUrl: z.string().min(1).optional(),
    supportUrl: url.optional(),
    supportEmail: email.optional(),
    privacyEmail: email.optional(),
    salesEmail: email.optional(),
    helloEmail: email.optional(),
    noReplyEmail: email.optional(),
    colors: colorsPatchSchema.optional(),
    assets: assetsPatchSchema.optional(),
    email: emailPatchSchema.optional(),
    seo: seoPatchSchema.optional(),
    operational: operationalPatchSchema.optional(),
  })
  .strict();

export type BrandingPatchInput = z.infer<typeof brandingPatchSchema>;
