/**
 * @ecom/landing — the landing-page template system.
 *
 * This entry point is pure data + validation (zod only; no React, no
 * Mongoose, no I/O) so the API can import it at runtime. React section
 * components and the renderer live behind `@ecom/landing/react`, shared by
 * the dashboard editor preview and the public renderer (apps/sites), so
 * there is exactly one rendering implementation.
 */

export {
  FIELD_TYPES,
  CTA_ACTION_KINDS,
  valueSchemaFor,
  emptyValueFor,
  isEmptyValue,
  newRepeaterItem,
  ctaValueSchema,
  imageValueSchema,
} from "./fields.js";
export type { FieldDef, FieldType, ImageValue, CtaAction, CtaValue } from "./fields.js";

export {
  SECTION_TYPES,
  ICON_NAMES,
  FONT_STACKS,
  SOCIAL_NETWORKS,
  getSectionType,
  listSectionTypes,
  sectionTypeKey,
} from "./sections.js";
export type { SectionTypeDef, IconName, FontKey } from "./sections.js";

export {
  SPEC_VERSION,
  parseTemplateSpec,
  effectiveSections,
  defaultContent,
  validateContent,
  coerceContent,
  resolveContent,
  canonicalJson,
} from "./spec.js";
export type {
  TemplateSpec,
  TemplateSpecSection,
  FieldOverride,
  EffectiveField,
  EffectiveSection,
  ContentIssue,
  PageContent,
  SectionContent,
} from "./spec.js";

export { ctaHref, hasCta } from "./cta.js";
export type { ResolvedHref } from "./cta.js";

export { resolveSeo } from "./seo.js";
export type { ResolvedSeo } from "./seo.js";

export {
  SYSTEM_TEMPLATES,
  TEMPLATE_CATEGORIES,
  blankTemplateSpec,
} from "./templates.js";
export type { SystemTemplateDef, TemplateCategory } from "./templates.js";

export {
  RESERVED_SLUGS,
  SLUG_MIN,
  SLUG_MAX,
  normalizeSlug,
  validateSlug,
  normalizeHost,
  extractLandingLabel,
  landingPublicUrl,
} from "./host.js";
export type { SlugCheck } from "./host.js";

export {
  safeUrl,
  safeColor,
  cleanText,
  parseRichText,
  isExternalHref,
  phoneDigits,
  HEX_COLOR_RE,
  ASSET_ID_RE,
} from "./safe.js";
export type { RichBlock, RichInline } from "./safe.js";

/** Largest serialized page content the API accepts (bytes of JSON). */
export const MAX_CONTENT_BYTES = 200_000;
/** Largest landing-page image accepted by the interim asset store. */
export const MAX_ASSET_BYTES = 700 * 1024;
export const ALLOWED_ASSET_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
