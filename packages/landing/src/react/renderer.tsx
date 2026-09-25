import type { CSSProperties } from "react";
import { FONT_STACKS, type FontKey, sectionTypeKey } from "../sections.js";
import { safeColor } from "../safe.js";
import { type PageContent, type TemplateSpec, effectiveSections, resolveContent } from "../spec.js";
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
 * Theme tokens → CSS custom properties. Each value is re-validated as a
 * #rrggbb literal and the font is looked up in a fixed allowlist, so no
 * merchant string is ever written into a style attribute as-is.
 */
export function themeStyle(theme: Record<string, unknown> | undefined): CSSProperties {
  const color = (key: keyof typeof THEME_FALLBACK) => safeColor(theme?.[key]) ?? THEME_FALLBACK[key];
  const font = FONT_STACKS[(theme?.font as FontKey) ?? "system"] ?? FONT_STACKS.system;
  return {
    "--lp-primary": color("primary"),
    "--lp-on-primary": color("onPrimary"),
    "--lp-accent": color("accent"),
    "--lp-bg": color("background"),
    "--lp-surface": color("surface"),
    "--lp-text": color("text"),
    "--lp-muted": color("muted"),
    "--lp-radius": RADIUS[String(theme?.radius)] ?? RADIUS.soft,
    fontFamily: font,
    backgroundColor: "var(--lp-bg)",
    color: "var(--lp-text)",
  } as CSSProperties;
}

export interface LandingRendererProps {
  spec: TemplateSpec;
  /** Untrusted stored content. Re-validated here before any component sees it. */
  content: unknown;
  env: RenderEnv;
  className?: string;
}

/**
 * The one landing-page renderer — used by the dashboard live preview, the
 * full-page draft preview, admin template preview, and the public site.
 * Server-component compatible (no hooks, no client state).
 */
export function LandingRenderer({ spec, content, env, className }: LandingRendererProps) {
  const resolved: PageContent = resolveContent(spec, content);
  const sections = effectiveSections(spec);
  const theme = resolved[sections.find((s) => s.type === "theme")?.id ?? ""];
  return (
    <div className={className} style={themeStyle(theme)} data-landing-root="">
      {sections.map((section) => {
        if (!section.visual) return null;
        const Component = SECTION_COMPONENTS[sectionTypeKey(section.type, section.typeVersion)];
        if (!Component) return null;
        return (
          <section key={section.id} id={section.id} data-section-type={section.type} className="scroll-mt-4">
            <Component id={section.id} values={resolved[section.id] ?? {}} env={env} />
          </section>
        );
      })}
    </div>
  );
}
