import { type Locale, SUPPORTED_LOCALES, isLocale } from "./locales.js";
import {
  type ContentIssue,
  type PageContent,
  type TemplateSpec,
  defaultContent,
  templateDefaultLocale,
  templateLocales,
  validateContent,
} from "./spec.js";

/**
 * Localized page content: one PageContent per enabled locale, stored in a
 * single page / revision record.
 *
 *   { bn: { hero: { headline: "…" }, … }, en: { hero: { headline: "…" }, … } }
 *
 * A page has `locales` (enabled, ordered) and a `defaultLocale` served at
 * the page root; any other enabled locale is served at `/<locale>`.
 */
export type LocalizedContent = Partial<Record<Locale, PageContent>>;

export interface LocaleSettings {
  locales: Locale[];
  defaultLocale: Locale;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * True when `raw` is keyed by locale. Template specs may not use locale
 * codes as section ids (parseTemplateSpec enforces it), so this check is
 * unambiguous against legacy single-locale content.
 */
export function isLocalizedShape(raw: unknown): raw is LocalizedContent {
  if (!isPlainObject(raw)) return false;
  const keys = Object.keys(raw);
  return keys.length > 0 && keys.every((k) => isLocale(k));
}

/**
 * Read stored page content in either shape. Content saved before locales
 * existed is a bare PageContent and is treated as English.
 */
export function readLocalized(raw: unknown): LocalizedContent {
  if (isLocalizedShape(raw)) return raw;
  return { en: (isPlainObject(raw) ? raw : {}) as PageContent };
}

/** Normalise locale settings: known locales, de-duplicated, default included. */
export function normalizeLocaleSettings(
  locales: unknown,
  defaultLocale: unknown,
  fallback: Locale = "en",
): LocaleSettings {
  const list = Array.isArray(locales) ? locales.filter(isLocale) : [];
  const unique = [...new Set(list)];
  const def = isLocale(defaultLocale) ? defaultLocale : unique[0] ?? fallback;
  if (!unique.includes(def)) unique.unshift(def);
  return { locales: unique, defaultLocale: def };
}

export function defaultLocalizedContent(spec: TemplateSpec, locales: Locale[]): LocalizedContent {
  const out: LocalizedContent = {};
  for (const locale of locales) out[locale] = defaultContent(spec, locale);
  return out;
}

/** Locales a page may use with this template (intersection, template order). */
export function allowedLocales(spec: TemplateSpec): Locale[] {
  return templateLocales(spec);
}

export function initialLocale(spec: TemplateSpec, requested?: unknown): Locale {
  const allowed = templateLocales(spec);
  if (isLocale(requested) && allowed.includes(requested)) return requested;
  return templateDefaultLocale(spec);
}

/**
 * Validate content for every enabled locale. Issue paths are prefixed with
 * the locale (`bn.hero.headline`). Content for locales that are not enabled,
 * or keys that are not locales, is rejected.
 */
export function validateLocalizedContent(
  spec: TemplateSpec,
  raw: unknown,
  settings: LocaleSettings,
  mode: "draft" | "publish",
): { ok: boolean; content: LocalizedContent; issues: ContentIssue[] } {
  const issues: ContentIssue[] = [];
  const content: LocalizedContent = {};
  if (!isPlainObject(raw)) {
    return { ok: false, content, issues: [{ path: "", message: "Content must be an object keyed by language" }] };
  }
  const allowed = templateLocales(spec);
  for (const key of Object.keys(raw)) {
    if (!isLocale(key)) issues.push({ path: key, message: `Unknown language "${key}"` });
    else if (!settings.locales.includes(key)) issues.push({ path: key, message: `Language "${key}" is not enabled for this page` });
  }
  for (const locale of settings.locales) {
    if (!allowed.includes(locale)) {
      issues.push({ path: locale, message: `This template does not support "${locale}"` });
      continue;
    }
    const r = validateContent(spec, raw[locale] ?? {}, mode, locale);
    content[locale] = r.content;
    for (const i of r.issues) issues.push({ path: i.path ? `${locale}.${i.path}` : locale, message: i.message });
  }
  return { ok: issues.length === 0, content, issues };
}

export { SUPPORTED_LOCALES };
