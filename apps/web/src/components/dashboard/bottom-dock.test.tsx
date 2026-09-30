import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BOTTOM_DOCK_FRAME,
  BOTTOM_DOCK_GAP_PX,
  BOTTOM_DOCK_ID,
  BottomActionBar,
  BottomDock,
  BottomDockPortal,
  DASHBOARD_SCROLL_PADDING_BOTTOM,
  bottomDockSpace,
} from "./bottom-dock";

describe("bottomDockSpace — what bars above the dock and the page padding must clear", () => {
  it("is 0 when the dock is empty, so nothing moves on pages without a notice", () => {
    expect(bottomDockSpace(0)).toBe(0);
  });
  it("is the dock height plus one gap when something is docked", () => {
    expect(bottomDockSpace(52)).toBe(52 + BOTTOM_DOCK_GAP_PX);
  });
  it("rounds fractional layout heights up, never under-reserving", () => {
    expect(bottomDockSpace(52.2)).toBe(53 + BOTTOM_DOCK_GAP_PX);
  });
  it("the gap matches the dock's gap-2 between items", () => {
    expect(BOTTOM_DOCK_GAP_PX).toBe(8);
  });
});

describe("BottomDock", () => {
  const html = renderToStaticMarkup(<BottomDock />);

  it("is viewport-fixed directly above the mobile nav — position never depends on a containing block", () => {
    expect(html).toMatch(/class="[^"]*\bfixed\b[^"]*\bbottom-above-mobile-nav\b/);
    expect(html).not.toContain("sticky");
    expect(html).toContain(`id="${BOTTOM_DOCK_ID}"`);
  });

  it("centres in the content column on md+ (sidebar is w-60) and stays below the nav's z-40", () => {
    expect(BOTTOM_DOCK_FRAME.split(" ")).toEqual(expect.arrayContaining(["inset-x-0", "md:left-60", "z-30"]));
    expect(html).not.toMatch(/\bz-(4\d|5\d|\[)/);
  });

  it("doesn't swallow taps on the page behind it — only docked items take pointer events", () => {
    expect(BOTTOM_DOCK_FRAME.split(" ")).toContain("pointer-events-none");
  });
});

describe("BottomDockPortal", () => {
  it("renders nothing on the server (the dock target only exists after mount)", () => {
    expect(renderToStaticMarkup(<BottomDockPortal>docked</BottomDockPortal>)).toBe("");
  });
});

describe("BottomActionBar", () => {
  const html = renderToStaticMarkup(
    <BottomActionBar role="region" aria-label="Page actions" className="max-w-3xl">
      <button type="button">Go</button>
    </BottomActionBar>,
  );

  it("is viewport-fixed above the nav AND the dock, so it never overlaps either", () => {
    expect(html).toMatch(/class="[^"]*\bfixed\b[^"]*\bbottom-above-bottom-dock\b/);
    expect(html).not.toMatch(/\bsticky\b|\bbottom-above-mobile-nav\b/);
  });

  it("reserves its own height in flow with an aria-hidden spacer (0 until measured)", () => {
    expect(html.startsWith('<div aria-hidden="true" data-bottom-bar-spacer="true" style="height:0"></div>')).toBe(true);
  });

  it("keeps the region's name and only the bar itself takes pointer events", () => {
    expect(html).toMatch(/<div role="region" aria-label="Page actions" class="pointer-events-auto w-full max-w-3xl">/);
    expect(html).toContain("<button");
  });
});

describe("focus is never scrolled behind the bottom surfaces (WCAG 2.4.11)", () => {
  it("dashboard scroll-padding-bottom covers nav + safe area, the dock and the action bar", () => {
    expect(DASHBOARD_SCROLL_PADDING_BOTTOM).toBe(
      "calc(var(--app-bottom-inset) + var(--bottom-dock-space) + var(--bottom-bar-space))",
    );
  });
  it("the dock applies it (and removes it on unmount) and the action bar publishes its space", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./bottom-dock.tsx", import.meta.url), "utf8");
    expect(src).toContain("root.style.scrollPaddingBottom = DASHBOARD_SCROLL_PADDING_BOTTOM;");
    expect(src).toContain('root.style.removeProperty("scroll-padding-bottom");');
    expect(src).toContain('root.style.setProperty("--bottom-bar-space", reserve);');
    expect(src).toContain('root.style.removeProperty("--bottom-bar-space")');
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/--bottom-bar-space:\s*0px/);
  });
});
