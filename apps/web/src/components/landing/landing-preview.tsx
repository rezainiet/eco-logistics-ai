"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { TemplateSpec } from "@ecom/landing";
import { LandingRenderer, assetEnv } from "@ecom/landing/react";
import { cn } from "@/lib/utils";

/** Width the page is laid out at before being scaled into its container. */
const DESIGN_WIDTH = 1280;

/**
 * Renders a landing page with the one shared renderer (the same component
 * the public site uses). Links are inert here so clicking a CTA inside the
 * dashboard never navigates away or opens merchant-supplied URLs.
 */
export function LandingPreview({
  spec,
  content,
  assetBaseUrl,
  className,
}: {
  spec: TemplateSpec;
  content: unknown;
  assetBaseUrl: string | null;
  className?: string;
}) {
  const stopLinks = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a")) e.preventDefault();
  };
  return (
    <div className={className} onClickCapture={stopLinks}>
      <LandingRenderer spec={spec} content={content} env={assetEnv(assetBaseUrl)} />
    </div>
  );
}

/**
 * Desktop-width preview scaled to fit its container — used for the editor
 * pane and template thumbnails.
 */
export function ScaledLandingPreview({
  spec,
  content,
  assetBaseUrl,
  className,
  maxHeight,
}: {
  spec: TemplateSpec;
  content: unknown;
  assetBaseUrl: string | null;
  className?: string;
  /** Clip to this many (scaled) pixels; omit to show the whole page. */
  maxHeight?: number;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const [height, setHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const el = outer.current;
    const content_ = inner.current;
    if (!el || !content_) return;
    const measure = () => {
      const s = el.clientWidth / DESIGN_WIDTH;
      setScale(s);
      setHeight(content_.scrollHeight * s);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(content_);
    return () => ro.disconnect();
  }, []);

  const shown = maxHeight && height ? Math.min(maxHeight, height) : height;
  return (
    <div ref={outer} className={cn("relative w-full overflow-hidden", className)} style={{ height: shown }}>
      <div
        ref={inner}
        style={{ width: DESIGN_WIDTH, transform: `scale(${scale})`, transformOrigin: "top left" }}
        className="absolute left-0 top-0"
      >
        <LandingPreview spec={spec} content={content} assetBaseUrl={assetBaseUrl} />
      </div>
    </div>
  );
}
