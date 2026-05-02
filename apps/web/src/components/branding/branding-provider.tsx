"use client";

import { useMemo, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { hexToHsl, readableFg } from "./branding";

/**
 * Reads `merchants.getProfile().branding` and injects the merchant's accent
 * colour into the dashboard's CSS custom properties.
 *
 * The whole theme — buttons, active sidebar items, hero ring, "Up next"
 * pill, badges — already references `--brand` / `--brand-hover` /
 * `--brand-active` / `--brand-fg`. By rewriting those four variables on a
 * single wrapping `<div>`, the entire dashboard re-themes at once with no
 * per-component edits.
 *
 * - `--brand`: the merchant's hex converted to "H S% L%"
 * - `--brand-hover`: same colour, lightness reduced by ~6
 * - `--brand-active`: lightness reduced by ~12
 * - `--brand-fg`: black or white based on luminance, so contrast holds even
 *   when a merchant picks a very pale accent
 *
 * Falls through silently when the query is loading or the merchant hasn't
 * picked a brand yet — the global token from `globals.css` stays in effect.
 * SSR is rendered with no override; the first hydration paint applies the
 * merchant accent without flicker because the override is just a class
 * toggle, not a re-render of every coloured surface.
 */
export function BrandingProvider({ children }: { children: ReactNode }) {
  const profile = trpc.merchants.getProfile.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const hex = profile.data?.branding?.primaryColor;

  const styleVars = useMemo<React.CSSProperties | undefined>(() => {
    if (!hex) return undefined;
    const hsl = hexToHsl(hex);
    if (!hsl) return undefined;
    const hover = `${hsl.h} ${hsl.s}% ${Math.max(0, hsl.l - 6)}%`;
    const active = `${hsl.h} ${hsl.s}% ${Math.max(0, hsl.l - 12)}%`;
    const fg = readableFg(hex);
    return {
      // CSS custom properties on a wrapping div cascade down to every child
      // that consumes them via hsl(var(--brand)) etc.
      ["--brand" as never]: `${hsl.h} ${hsl.s}% ${hsl.l}%`,
      ["--brand-hover" as never]: hover,
      ["--brand-active" as never]: active,
      ["--brand-fg" as never]: fg === "white" ? "0 0% 100%" : "0 0% 0%",
    } as React.CSSProperties;
  }, [hex]);

  // Always render the wrapper so the children's tree shape doesn't change
  // between "no branding" and "branding loaded". The style attribute is just
  // empty when there's no override.
  return (
    <div style={styleVars} data-branding={hex ? "applied" : "default"}>
      {children}
    </div>
  );
}
