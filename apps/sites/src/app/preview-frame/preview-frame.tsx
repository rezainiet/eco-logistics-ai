"use client";

import { useEffect, useState, type MouseEvent } from "react";
import { PREVIEW_MESSAGE_SOURCE, type PreviewRenderMessage, parsePreviewMessage } from "@ecom/landing";
import { LandingRenderer, assetEnv } from "@ecom/landing/react";
import { EditOverlay } from "./edit-overlay";

/**
 * Receives drafts from the dashboard over postMessage.
 *
 * Trust rules:
 *   - Only messages whose `event.origin` is an allowed editor origin are
 *     read; everything else is ignored (the page's CSP frame-ancestors also
 *     limits who can embed it at all).
 *   - The payload must parse as a preview message; the spec is re-validated
 *     and content is resolved by the renderer like any stored content.
 *   - Asset URLs come from this app's configuration, never from the parent.
 *   - Links are inert: clicking a CTA in the preview never navigates. In
 *     click-to-edit mode a click selects the element instead and its schema
 *     path is posted back — only to the origin whose draft we are rendering.
 */
function parentOriginOf(): string | null {
  const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (ancestors && ancestors.length > 0) return ancestors[0] ?? null;
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
}

export function PreviewFrame({ allowedOrigins, assetBaseUrl }: { allowedOrigins: string[]; assetBaseUrl: string }) {
  const [msg, setMsg] = useState<PreviewRenderMessage | null>(null);
  // Origin of the editor whose drafts we render — click-to-edit replies go only there.
  const [editorOrigin, setEditorOrigin] = useState<string | null>(null);

  useEffect(() => {
    // Phones and tablets use overlay scrollbars; a classic desktop scrollbar
    // would eat ~15px of the device width and make the preview narrower than
    // the real page. The frame still scrolls.
    document.documentElement.style.scrollbarWidth = "none";
  }, []);

  useEffect(() => {
    const allowed = new Set(allowedOrigins);
    const onMessage = (event: MessageEvent) => {
      if (!allowed.has(event.origin)) return;
      const parsed = parsePreviewMessage(event.data);
      if (!parsed) return;
      setMsg(parsed);
      setEditorOrigin(event.origin);
    };
    window.addEventListener("message", onMessage);
    // Announce readiness to the embedding editor — only to its exact origin,
    // and only if that origin is allowed.
    if (window.parent !== window) {
      const parentOrigin = parentOriginOf();
      if (parentOrigin && allowed.has(parentOrigin)) {
        window.parent.postMessage({ source: PREVIEW_MESSAGE_SOURCE, type: "ready" }, parentOrigin);
      }
    }
    return () => window.removeEventListener("message", onMessage);
  }, [allowedOrigins]);

  const stopLinks = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    e.preventDefault();
    // Same-page section anchors still scroll inside the preview.
    if (href.startsWith("#")) document.getElementById(href.slice(1))?.scrollIntoView({ behavior: "smooth" });
  };

  if (!msg) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-white text-sm text-neutral-400">
        Waiting for the editor…
      </main>
    );
  }
  const editing = msg.edit !== undefined;
  return (
    <div onClickCapture={editing ? undefined : stopLinks}>
      <LandingRenderer
        spec={msg.spec}
        content={msg.content}
        locale={msg.locale}
        env={{ ...assetEnv(assetBaseUrl), editable: editing, catalog: msg.catalog }}
        className="min-h-screen"
      />
      {editing ? <EditOverlay spec={msg.spec} locale={msg.locale} selected={msg.edit?.selected ?? null} parentOrigin={editorOrigin} /> : null}
    </div>
  );
}
