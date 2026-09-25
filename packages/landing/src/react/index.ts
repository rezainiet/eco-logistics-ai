export { LandingRenderer, themeStyle } from "./renderer.js";
export type { LandingRendererProps } from "./renderer.js";
export { SECTION_COMPONENTS } from "./sections.js";
export type { SectionProps } from "./sections.js";
export { Icon, RichText, CtaButton, ProductCard, PriceRow, DiscountBadge, PaymentBadge, ctxOf } from "./primitives.js";
export type { RenderEnv, ProductValue, Ctx } from "./primitives.js";
export { uiStrings } from "./strings.js";
export type { UiStrings } from "./strings.js";

/** Build a RenderEnv that serves assets from `<base>/<assetId>`. */
export function assetEnv(baseUrl: string | null | undefined) {
  const base = (baseUrl ?? "").replace(/\/+$/, "");
  return {
    assetUrl: (assetId: string) => (base && /^[a-f0-9]{24}$/.test(assetId) ? `${base}/${assetId}` : null),
  };
}
