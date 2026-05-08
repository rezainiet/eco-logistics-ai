import type { BrandingColors, BrandingConfig } from "./types.js";
import { hexToHslComponents } from "./derive.js";

/**
 * Render a `:root { --brand: ...; }` CSS blob from a BrandingConfig.
 *
 * Output uses HSL components ("76 92% 64%") so the blob composes cleanly
 * with Tailwind utilities that already reference `hsl(var(--brand))`.
 *
 * The blob is intended to be injected once per page in a server component
 * via `<style>{renderBrandingCss(brand)}</style>`. The first paint already
 * has the right tokens — no FOUC, no client-side roundtrip, no hydration
 * mismatch.
 */
export function renderBrandingCss(input: BrandingConfig | BrandingColors): string {
  const colors: BrandingColors =
    "colors" in input ? input.colors : input;

  const tokens: Record<string, string | undefined> = {
    "--brand": hexToHslComponents(colors.brand) ?? undefined,
    "--brand-hover": hexToHslComponents(colors.brandHover) ?? undefined,
    "--brand-active": hexToHslComponents(colors.brandActive) ?? undefined,
    "--brand-fg": hexToHslComponents(colors.brandFg) ?? undefined,
  };

  const lines = Object.entries(tokens)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([k, v]) => `  ${k}: ${v};`);

  if (lines.length === 0) return ":root {}";
  return `:root {\n${lines.join("\n")}\n}`;
}

/** Returns just the inline-style object form for places that prefer JSX. */
export function brandingStyleVars(
  input: BrandingConfig | BrandingColors,
): Record<string, string> {
  const colors: BrandingColors =
    "colors" in input ? input.colors : input;
  const out: Record<string, string> = {};
  const brand = hexToHslComponents(colors.brand);
  const brandHover = hexToHslComponents(colors.brandHover);
  const brandActive = hexToHslComponents(colors.brandActive);
  const brandFg = hexToHslComponents(colors.brandFg);
  if (brand) out["--brand"] = brand;
  if (brandHover) out["--brand-hover"] = brandHover;
  if (brandActive) out["--brand-active"] = brandActive;
  if (brandFg) out["--brand-fg"] = brandFg;
  return out;
}
