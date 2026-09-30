"use client";

import { useMemo, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { brandStyleVars } from "./branding";

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
 * The four values come from `brandStyleVars` (shared @ecom/branding
 * derivation): `--brand-fg` is whichever of black/white contrasts better,
 * and hover/active shift lightness away from that label colour, so every
 * state stays ≥ WCAG AA for any accent.
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

  // CSS custom properties on a wrapping div cascade down to every child
  // that consumes them via hsl(var(--brand)) etc.
  const styleVars = useMemo(() => brandStyleVars(hex) as React.CSSProperties | undefined, [hex]);

  // Always render the wrapper so the children's tree shape doesn't change
  // between "no branding" and "branding loaded". The style attribute is just
  // empty when there's no override.
  return (
    <div style={styleVars} data-branding={hex ? "applied" : "default"}>
      {children}
    </div>
  );
}
