"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useElementHeight } from "@/lib/use-element-height";

/**
 * Bottom dock — the one place app-level, viewport-fixed notices live (e.g.
 * the bulk-reject undo banner); page-level action bars use BottomActionBar
 * below and stack on top of it. The dock sits directly above the mobile
 * bottom nav (`bottom-above-mobile-nav`, 0.75rem on md+) and publishes the
 * space it occupies as `--bottom-dock-space` on <html>, so:
 *   - page content reserves room for it (`pb-page-end` on the dashboard
 *     content wrapper), and
 *   - other bottom-anchored bars stack above it (`bottom-above-bottom-dock`)
 *     instead of overlapping it.
 *
 * Why fixed and not sticky: a bottom-sticky element can never rise above
 * the top of its containing block. When that block starts low on the page
 * (a card below the fold, or a page under the incident/billing banners on a
 * 568px phone — the orders page root starts at y=322 there) the element is
 * pinned to the block's top while it scrolls in, i.e. under the nav or the
 * dock whatever its `bottom` offset. Fixed positioning has no
 * containing-block dependency.
 */
export const BOTTOM_DOCK_ID = "app-bottom-dock";

/** Vertical gap between docked items, and between the dock and bars above it (gap-2). */
export const BOTTOM_DOCK_GAP_PX = 8;

/** Viewport-fixed frame aligned with the dashboard content column (sidebar is w-60 on md+). */
export const BOTTOM_DOCK_FRAME = "pointer-events-none fixed inset-x-0 z-30 md:left-60";
/** Same max width and gutters as the dashboard content wrapper in app/dashboard/layout.tsx. */
export const BOTTOM_DOCK_COLUMN = "mx-auto flex w-full max-w-[1400px] flex-col items-center gap-2 px-4 md:px-8";

/**
 * While the dashboard is mounted, keyboard focus and anchor jumps scroll
 * targets clear of everything fixed at the bottom (nav, dock, action bar) —
 * otherwise a Tab-focused element can land hidden behind them (WCAG 2.4.11).
 */
export const DASHBOARD_SCROLL_PADDING_BOTTOM =
  "calc(var(--app-bottom-inset) + var(--bottom-dock-space) + var(--bottom-bar-space))";

/** Space the dock takes above the nav inset: its height plus one gap, or 0 when empty. */
export function bottomDockSpace(height: number): number {
  return height > 0 ? Math.ceil(height) + BOTTOM_DOCK_GAP_PX : 0;
}

export function BottomDock() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const apply = () => root.style.setProperty("--bottom-dock-space", `${bottomDockSpace(el.offsetHeight)}px`);
    apply();
    root.style.scrollPaddingBottom = DASHBOARD_SCROLL_PADDING_BOTTOM;
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--bottom-dock-space");
      root.style.removeProperty("scroll-padding-bottom");
    };
  }, []);
  return (
    <div className={`${BOTTOM_DOCK_FRAME} bottom-above-mobile-nav`}>
      <div ref={ref} id={BOTTOM_DOCK_ID} className={BOTTOM_DOCK_COLUMN} />
    </div>
  );
}

/**
 * A page-level action bar (orders bulk actions, template "Create"): fixed to
 * the viewport above the nav and the dock, so it is always fully visible,
 * whatever the page's banners or containers do. It stays in DOM order where
 * it is rendered (keyboard / screen-reader order follows the content it acts
 * on), and an in-flow spacer of its measured height lets the content above
 * it scroll clear. Render it as the last element of the page, one per page
 * (it publishes its height as --bottom-bar-space).
 */
export function BottomActionBar({
  className,
  children,
  ...region
}: { className?: string; children: ReactNode; role?: string; "aria-label"?: string }) {
  const [ref, height] = useElementHeight<HTMLDivElement>();
  const reserve = height ? `calc(${height}px + 0.75rem)` : null;
  useEffect(() => {
    if (!reserve) return;
    // Feeds the dashboard's scroll-padding-bottom (focused elements stay clear of the bar).
    const root = document.documentElement;
    root.style.setProperty("--bottom-bar-space", reserve);
    return () => {
      root.style.removeProperty("--bottom-bar-space");
    };
  }, [reserve]);
  return (
    <>
      <div aria-hidden data-bottom-bar-spacer style={{ height: reserve ?? 0 }} />
      <div className={cn(BOTTOM_DOCK_FRAME, "bottom-above-bottom-dock")}>
        <div className={BOTTOM_DOCK_COLUMN}>
          <div ref={ref} {...region} className={cn("pointer-events-auto w-full", className)}>
            {children}
          </div>
        </div>
      </div>
    </>
  );
}

/** Renders children into the bottom dock (nothing until the dock is mounted). */
export function BottomDockPortal({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => setTarget(document.getElementById(BOTTOM_DOCK_ID)), []);
  return target ? createPortal(children, target) : null;
}
