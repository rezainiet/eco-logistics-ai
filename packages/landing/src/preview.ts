import { isEditPath } from "./edit-target.js";
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
 *   parent → frame  : { source, type: "render", spec, content, locale, edit? }
 *   frame  → parent : { source, type: "select", path, locale }   (edit mode only)
 *
 * `edit` switches the frame into click-to-edit mode: elements carry their
 * schema path, hovering outlines them and a click reports the path back.
 * `edit.selected` is the editor's current selection, so it survives device
 * switches and iframe reloads. Without `edit` the frame is a plain preview.
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
  edit?: { selected: string | null };
}

export interface PreviewSelectMessage {
  source: typeof PREVIEW_MESSAGE_SOURCE;
  type: "select";
  /** Schema path of the clicked element — untrusted; resolve with resolveEditTarget. */
  path: string;
  /** Locale the frame was rendering when clicked; the editor ignores stale ones. */
  locale: Locale;
}

const MAX_MESSAGE_BYTES = 400_000;

export function parsePreviewSelect(data: unknown): PreviewSelectMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.source !== PREVIEW_MESSAGE_SOURCE || m.type !== "select") return null;
  if (!isLocale(m.locale) || !isEditPath(m.path)) return null;
  return { source: PREVIEW_MESSAGE_SOURCE, type: "select", path: m.path, locale: m.locale };
}

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
  const msg: PreviewRenderMessage = { source: PREVIEW_MESSAGE_SOURCE, type: "render", spec: spec.spec, content: m.content, locale: m.locale };
  if (m.edit && typeof m.edit === "object") {
    const selected = (m.edit as { selected?: unknown }).selected;
    msg.edit = { selected: isEditPath(selected) ? selected : null };
  }
  return msg;
}
