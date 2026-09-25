import type { CSSProperties } from "react";
import { type NumeralMode, NUMERAL_MODES } from "../format.js";
import type { Locale } from "../locales.js";
import { sectionTypeKey } from "../sections.js";
import { safeColor } from "../safe.js";
import { type PageContent, type TemplateSpec, effectiveSections, resolveContent } from "../spec.js";
import { fontStack } from "../vocab.js";
import type { RenderEnv } from "./primitives.js";
import { SECTION_COMPONENTS } from "./sections.js";

const RADIUS: Record<string, string> = { sharp: "0px", soft: "0.75rem", round: "1.5rem" };

const THEME_FALLBACK = {
  primary: "#4f46e5",
  onPrimary: "#ffffff",
  accent: "#f59e0b",
  background: "#ffffff",
  surface: "#f8fafc",
  text: "#0f172a",
  muted: "#475569",
};

/**
 * Per-script typography. Latin display type is set tight; Bangla needs
 * normal tracking (negative tracking breaks up conjuncts visually) and
 * taller line boxes so matras above and below the headline never clip.
 * Hind Siliguri tops out at 700, so Bangla display weight is 700 — never a
 * browser-synthesised faux bold.
 */
const TYPOGRAPHY: Record<Locale, Record<string, string>> = {
  en: {
    "--lp-tracking": "-0.025em",
    "--lp-tracking-eyebrow": "0.08em",
    "--lp-eyebrow-case": "uppercase",
    "--lp-lh-heading": "1.12",
    "--lp-lh-snug": "1.35",
    "--lp-lh-body": "1.65",
    "--lp-weight-display": "800",
    "--lp-weight-heading": "700",
  },
  bn: {
    "--lp-tracking": "0",
    "--lp-tracking-eyebrow": "0",
    "--lp-eyebrow-case": "none",
    "--lp-lh-heading": "1.4",
    "--lp-lh-snug": "1.5",
    "--lp-lh-body": "1.8",
    "--lp-weight-display": "700",
    "--lp-weight-heading": "700",
  },
};

/**
 * The typography boundary. Theme tokens → CSS custom properties, plus an
 * explicit reset of everything a host page could otherwise leak into the
 * page (font-feature-settings, letter-spacing, text-transform, word
 * spacing). Each colour is re-validated as #rrggbb and the font comes from
 * a fixed allowlist, so no merchant string reaches a style attribute as-is.
 */
export function themeStyle(theme: Record<string, unknown> | undefined, locale: Locale = "en"): CSSProperties {
  const color = (key: keyof typeof THEME_FALLBACK) => safeColor(theme?.[key]) ?? THEME_FALLBACK[key];
  return {
    ...TYPOGRAPHY[locale],
    "--lp-primary": color("primary"),
    "--lp-on-primary": color("onPrimary"),
    "--lp-accent": color("accent"),
    "--lp-bg": color("background"),
    "--lp-surface": color("surface"),
    "--lp-text": color("text"),
    "--lp-muted": color("muted"),
    "--lp-radius": RADIUS[String(theme?.radius)] ?? RADIUS.soft,
    fontFamily: fontStack(String(theme?.font ?? "system"), locale),
    fontFeatureSettings: "normal",
    fontVariantLigatures: "normal",
    fontKerning: "normal",
    letterSpacing: "normal",
    wordSpacing: "normal",
    textTransform: "none",
    lineHeight: "var(--lp-lh-body)",
    overflowWrap: "break-word",
    WebkitFontSmoothing: "antialiased",
    textRendering: "optimizeLegibility",
    backgroundColor: "var(--lp-bg)",
    color: "var(--lp-text)",
  } as CSSProperties;
}

function numeralMode(theme: Record<string, unknown> | undefined): NumeralMode {
  const v = theme?.numerals;
  return typeof v === "string" && (NUMERAL_MODES as readonly string[]).includes(v) ? (v as NumeralMode) : "auto";
}

export interface LandingRendererProps {
  spec: TemplateSpec;
  /** Untrusted stored content for `locale`. Re-validated here before any component sees it. */
  content: unknown;
  env: RenderEnv;
  locale?: Locale;
  className?: string;
}

/**
 * The one landing-page renderer — used by the public site, the editor's
 * device preview, draft preview and admin template preview (the last three
 * via the preview frame in apps/sites). Server-component compatible.
 */
export function LandingRenderer({ spec, content, env, locale = "en", className }: LandingRendererProps) {
  const resolved: PageContent = resolveContent(spec, content, locale);
  const sections = effectiveSections(spec, locale);
  const theme = resolved[sections.find((s) => s.type === "theme")?.id ?? ""];
  const sectionEnv: RenderEnv = { ...env, locale, numerals: numeralMode(theme) };
  return (
    <div className={className} style={themeStyle(theme, locale)} lang={locale} data-landing-root="">
      {sections.map((section) => {
        if (!section.visual) return null;
        const Component = SECTION_COMPONENTS[sectionTypeKey(section.type, section.typeVersion)];
        if (!Component) return null;
        return (
          <section
            key={section.id}
            id={section.id}
            data-section-type={section.type}
            className="scroll-mt-4"
            {...(env.editable ? { "data-lp-section": section.id } : {})}
          >
            <Component id={section.id} values={resolved[section.id] ?? {}} env={sectionEnv} />
          </section>
        );
      })}
    </div>
  );
}
