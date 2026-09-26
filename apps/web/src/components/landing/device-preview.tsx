"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Monitor, Smartphone, Tablet } from "lucide-react";
import {
  type CatalogProduct,
  type Locale,
  PREVIEW_DEVICES,
  PREVIEW_MESSAGE_SOURCE,
  type PreviewDevice,
  type PreviewSelectMessage,
  type TemplateSpec,
  parsePreviewSelect,
} from "@ecom/landing";
import { cn } from "@/lib/utils";

/**
 * Device preview. The dashboard never renders a landing page itself: it
 * embeds the public renderer (apps/sites, preview host) in an iframe whose
 * viewport is the real device width — 1440 / 768 / 390 px — and posts the
 * draft to it. Media queries, fonts and CSS are exactly the published
 * page's, so PREVIEW = PUBLISHED PAGE. The iframe is scaled down only when
 * the device is wider than the space available.
 */

export function previewUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_LANDING_PREVIEW_URL;
  if (configured) return configured.replace(/\/+$/, "");
  return process.env.NODE_ENV === "production" ? null : "http://preview.localhost:3002";
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function DeviceToggle({
  device,
  onChange,
  className,
}: {
  device: PreviewDevice;
  onChange: (d: PreviewDevice) => void;
  className?: string;
}) {
  const icons = { desktop: Monitor, tablet: Tablet, mobile: Smartphone } as const;
  return (
    <div role="radiogroup" aria-label="Preview device" className={cn("inline-flex rounded-lg bg-surface-raised p-1", className)}>
      {(Object.keys(PREVIEW_DEVICES) as PreviewDevice[]).map((d) => {
        const Icon = icons[d];
        const active = d === device;
        return (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(d)}
            className={cn(
              "inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 text-xs font-medium",
              active ? "bg-surface text-fg shadow-sm" : "text-fg-subtle hover:text-fg",
            )}
            title={`${PREVIEW_DEVICES[d].label} · ${PREVIEW_DEVICES[d].width}px`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{PREVIEW_DEVICES[d].label}</span>
            <span className="text-fg-faint">{PREVIEW_DEVICES[d].width}</span>
          </button>
        );
      })}
    </div>
  );
}

export function DevicePreview({
  spec,
  content,
  locale,
  device,
  viewportHeight,
  interactive = true,
  className,
  title = "Landing page preview",
  edit,
  catalog,
}: {
  spec: TemplateSpec;
  content: unknown;
  locale: Locale;
  device: PreviewDevice;
  /** Visible height in CSS px of the dashboard. Defaults to the device height (scaled). */
  viewportHeight?: number;
  /** Thumbnails pass false: no pointer events, lazy loading. */
  interactive?: boolean;
  className?: string;
  title?: string;
  /**
   * Click-to-edit: the frame outlines editable elements and reports clicks.
   * `selected` is echoed to the frame so the highlight survives device
   * switches and reloads. Omit for plain previews and thumbnails.
   */
  edit?: { selected: string | null; onSelect: (msg: PreviewSelectMessage) => void };
  /** Products linked to the page (live data) — catalog product grids preview with them. */
  catalog?: CatalogProduct[];
}) {
  const url = previewUrl();
  const target = url ? originOf(url) : null;
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ready, setReady] = useState(false);
  const { width: deviceWidth, height: deviceHeight } = PREVIEW_DEVICES[device];

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const post = useCallback(() => {
    const win = frame.current?.contentWindow;
    if (!win || !target) return;
    win.postMessage(
      {
        source: PREVIEW_MESSAGE_SOURCE,
        type: "render",
        spec,
        content,
        locale,
        ...(edit ? { edit: { selected: edit.selected } } : {}),
        ...(catalog ? { catalog } : {}),
      },
      target,
    );
  }, [spec, content, locale, target, edit?.selected, !!edit, catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSelect = useRef(edit?.onSelect);
  onSelect.current = edit?.onSelect;

  // The frame announces itself when its listener is attached.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== target || e.source !== frame.current?.contentWindow) return;
      const data = e.data as { source?: string; type?: string } | null;
      if (data?.source !== PREVIEW_MESSAGE_SOURCE) return;
      if (data.type === "ready") setReady(true);
      if (data.type === "select") {
        const sel = parsePreviewSelect(e.data);
        if (sel) onSelect.current?.(sel);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [target]);

  // Push every change (lightly debounced while typing).
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(post, 120);
    return () => clearTimeout(t);
  }, [ready, post]);

  if (!url || !target) {
    return (
      <div className={cn("flex items-center justify-center rounded-lg border border-dashed border-stroke/12 p-8 text-center text-sm text-fg-subtle", className)}>
        Live preview is not configured (NEXT_PUBLIC_LANDING_PREVIEW_URL).
      </div>
    );
  }

  const scale = width > 0 ? Math.min(1, width / deviceWidth) : 0;
  const visibleHeight = viewportHeight ?? Math.round(deviceHeight * scale);
  const frameHeight = scale > 0 ? Math.round(visibleHeight / scale) : deviceHeight;

  return (
    <div ref={box} className={cn("relative w-full", className)} style={{ height: visibleHeight || undefined }}>
      {scale > 0 ? (
        <div
          className={cn("absolute top-0 overflow-hidden bg-white", deviceWidth * scale < width && "rounded-lg shadow-sm ring-1 ring-black/10")}
          style={{
            width: deviceWidth * scale,
            height: visibleHeight,
            left: Math.max(0, (width - deviceWidth * scale) / 2),
          }}
        >
          <iframe
            ref={frame}
            src={`${url}/`}
            title={title}
            // Scripts are needed to render; same-origin keeps the frame's own
            // origin (it is a different origin from the dashboard, so this
            // does not grant it access to the dashboard). No top navigation,
            // popups or forms.
            sandbox="allow-scripts allow-same-origin"
            loading={interactive ? "eager" : "lazy"}
            tabIndex={interactive ? 0 : -1}
            aria-hidden={interactive ? undefined : true}
            onLoad={() => setTimeout(post, 50)}
            className={cn("origin-top-left border-0", !interactive && "pointer-events-none")}
            style={{ width: deviceWidth, height: frameHeight, transform: `scale(${scale})` }}
          />
        </div>
      ) : null}
    </div>
  );
}
