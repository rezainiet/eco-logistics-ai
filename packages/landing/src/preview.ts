import { type Locale, isLocale } from "./locales.js";
import { type TemplateSpec, parseTemplateSpec } from "./spec.js";

/**
 * Editor ↔ preview-frame protocol.
 *
 * The dashboard never renders landing pages itself. It embeds the public
 * renderer (apps/sites, preview host) in an iframe sized to a real device
 * viewport and posts the draft to it. Same app, same CSS, same fonts, same
 * components as the published page — PREVIEW = PUBLISHED PAGE.
 *
 *   frame  → parent : { source, type: "ready" }
 *   parent → frame  : { source, type: "render", spec, content, locale }
 *
 * The frame accepts messages only from configured editor origins and only
 * in this exact shape; the spec is re-validated and content is resolved by
 * the renderer like any stored content.
 */
export const PREVIEW_MESSAGE_SOURCE = "confirmx-landing-preview" as const;

export const PREVIEW_DEVICES = {
  desktop: { width: 1440, height: 900, label: "Desktop" },
  tablet: { width: 768, height: 1024, label: "Tablet" },
  mobile: { width: 390, height: 844, label: "Mobile" },
} as const;
export type PreviewDevice = keyof typeof PREVIEW_DEVICES;

export interface PreviewRenderMessage {
  source: typeof PREVIEW_MESSAGE_SOURCE;
  type: "render";
  spec: TemplateSpec;
  content: unknown;
  locale: Locale;
}

const MAX_MESSAGE_BYTES = 400_000;

export function parsePreviewMessage(data: unknown): PreviewRenderMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.source !== PREVIEW_MESSAGE_SOURCE || m.type !== "render") return null;
  if (!isLocale(m.locale)) return null;
  try {
    if (JSON.stringify(data).length > MAX_MESSAGE_BYTES) return null;
  } catch {
    return null;
  }
  const spec = parseTemplateSpec(m.spec);
  if (!spec.ok) return null;
  return { source: PREVIEW_MESSAGE_SOURCE, type: "render", spec: spec.spec, content: m.content, locale: m.locale };
}
