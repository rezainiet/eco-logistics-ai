/**
 * Content locales. A landing page carries content for one or more of
 * these, keyed by locale (`{ bn: {...}, en: {...} }`), with one default
 * locale served at the page root. Adding a locale later means adding it
 * here plus its UI strings (react/strings.ts) and font stack (sections.ts).
 */
export const SUPPORTED_LOCALES = ["en", "bn"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, { native: string; english: string }> = {
  en: { native: "English", english: "English" },
  bn: { native: "বাংলা", english: "Bangla" },
};

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

/** Script used for the page's primary text — drives font and typography choices. */
export function localeScript(locale: Locale): "latin" | "bengali" {
  return locale === "bn" ? "bengali" : "latin";
}
