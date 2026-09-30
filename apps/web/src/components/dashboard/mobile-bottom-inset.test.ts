import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import tailwindConfig from "../../../tailwind.config";
import { BOTTOM_DOCK_COLUMN } from "./bottom-dock";

/**
 * Audit F-05: bottom-anchored bars sat under the fixed mobile bottom nav.
 *
 * Layer 1 — one inset token (nav row + 1px border + safe area, 0 on md+).
 * Layer 2 — containment. A bottom-sticky element can never rise above the
 * top of its containing block, so inside a container that starts low on the
 * page (the review card below the queue; the gallery and orders page roots
 * under the incident/billing banners on a 320×568 phone) it was pinned to
 * that container's top while it scrolled in — under the nav or the dock,
 * regardless of its `bottom` offset. So bottom-sticky is gone and each
 * surface has an explicit model:
 *   - app-level notices (reject undo)   → BottomDock, viewport-fixed on the nav inset
 *   - page actions (bulk bar, gallery)  → BottomActionBar, fixed above the dock + in-flow spacer
 *   - review-queue decision actions     → normal flow, cleared by the page-end padding
 * (Top-sticky — topbar, selection banner, section headers — is unaffected.)
 */
const SRC = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx$/.test(p) && !/\.test\.tsx$/.test(p) ? [p] : [];
  });
}
// Comments are prose (apostrophes would pair up as bogus string literals).
// `(?<!:)` keeps "https://…" inside strings intact.
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
function literals(src: string): string[] {
  src = stripComments(src);
  const out: string[] = [];
  const re = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[2]!);
  return out;
}
const dashboardFiles = () =>
  files(SRC)
    .map((f) => ({ rel: relative(SRC, f).replace(/\\/g, "/"), src: readFileSync(f, "utf8") }))
    .filter((f) => !f.rel.startsWith("app/(marketing)/")); // marketing has no bottom nav

describe("mobile bottom inset token", () => {
  it("globals.css: nav height + safe area on phones, 0 from md; dock space defaults to 0", () => {
    const css = read("app/globals.css");
    // The inset must equal the nav's full box: 3.5rem tap row + its 1px top border.
    expect(css).toMatch(/--mobile-nav-row:\s*3\.5rem/);
    expect(css).toMatch(/--mobile-nav-height:\s*calc\(var\(--mobile-nav-row\)\s*\+\s*1px\)/);
    expect(css).toMatch(/--app-bottom-inset:\s*calc\(var\(--mobile-nav-height\)\s*\+\s*env\(safe-area-inset-bottom,\s*0px\)\)/);
    expect(css).toMatch(/@media \(min-width: 768px\)\s*\{\s*:root\s*\{\s*--app-bottom-inset:\s*0px;/);
    expect(css).toMatch(/--bottom-dock-space:\s*0px/);
  });

  it("tailwind exposes the tokens as spacing (no hard-coded nav heights)", () => {
    const spacing = (tailwindConfig.theme?.extend as { spacing?: Record<string, string> }).spacing ?? {};
    expect(spacing["mobile-nav-row"]).toBe("var(--mobile-nav-row)");
    expect(spacing["mobile-nav"]).toBe("var(--mobile-nav-height)");
    expect(spacing["above-mobile-nav"]).toBe("calc(var(--app-bottom-inset) + 0.75rem)");
    expect(spacing["above-bottom-dock"]).toBe("calc(var(--app-bottom-inset) + var(--bottom-dock-space) + 0.75rem)");
    expect(spacing["page-end"]).toBe("calc(var(--app-bottom-inset) + var(--bottom-dock-space) + 2rem)");
  });

  it("the bottom nav itself is sized by the token and hidden from md — the same breakpoint the token resets at", () => {
    const nav = read("components/dashboard/mobile-bottom-nav.tsx");
    // Items fill the tap row; the nav adds exactly one 1px top border — the
    // "+ 1px" in --mobile-nav-height.
    expect(nav).toContain("min-h-mobile-nav-row");
    expect(nav).toMatch(/fixed inset-x-0 bottom-0 z-40 border-t [^"]*md:hidden/);
    expect(nav.match(/\bborder-(t|y|b)\b/g)).toEqual(["border-t"]);
    expect(nav).toMatch(/pb-\[env\(safe-area-inset-bottom\)\]/);
  });
});

describe("dashboard layout reserves nav + dock space and mounts the dock", () => {
  const layout = read("app/dashboard/layout.tsx");

  it("content wrapper pads by the page-end token instead of a hard-coded pb-24", () => {
    expect(layout).toMatch(/className="mx-auto w-full max-w-\[1400px\] flex-1 px-4 pb-page-end pt-6 md:px-8 md:pt-8"/);
    expect(layout).not.toMatch(/\bpb-24\b|\bmd:pb-8\b/);
  });

  it("the dock column lines up with the content column (same max width and gutters)", () => {
    for (const cls of ["mx-auto", "w-full", "max-w-[1400px]", "px-4", "md:px-8"]) {
      expect(BOTTOM_DOCK_COLUMN.split(" ")).toContain(cls);
    }
  });

  it("mounts BottomDock once, after the nav, with the reject banner rendering into it", () => {
    expect(layout.match(/<BottomDock \/>/g)).toHaveLength(1);
    expect(layout.indexOf("<MobileBottomNav />")).toBeLessThan(layout.indexOf("<BottomDock />"));
    expect(layout).toContain("<PendingRejectBanner />");
  });
});

describe("containment: every bottom-anchored surface uses an explicit, overlap-free model", () => {
  it("no bar anchors to the bottom with anything but the tokens", () => {
    const allowed = new Set([
      "components/dashboard/mobile-bottom-nav.tsx", // the nav itself (bottom-0)
      "components/ui/sheet.tsx", // full-screen overlay primitives (z-50, above the nav)
      "components/ui/dialog.tsx",
    ]);
    const offenders: string[] = [];
    for (const { rel, src } of dashboardFiles()) {
      if (allowed.has(rel)) continue;
      for (const lit of literals(src)) {
        const tokens = lit.split(/\s+/);
        if (!tokens.includes("sticky") && !tokens.includes("fixed")) continue;
        // Includes responsive variants: a `md:bottom-4` would bypass the dock on desktop.
        const bottoms = tokens.filter((t) => /(^|:)bottom-/.test(t));
        const bad = bottoms.filter((t) => t !== "bottom-above-bottom-dock");
        if (bad.length) offenders.push(`${rel}: ${bad.join(" ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only the dock sits directly on the nav inset", () => {
    const users = dashboardFiles()
      .filter(({ src }) => /\bbottom-above-mobile-nav\b/.test(stripComments(src)))
      .map(({ rel }) => rel);
    expect(users).toEqual(["components/dashboard/bottom-dock.tsx"]);
  });

  it("nothing in the dashboard is bottom-sticky", () => {
    const sticky = dashboardFiles()
      .filter(({ src }) => literals(src).some((l) => /(^|\s)sticky(\s|$)/.test(l) && /(^|\s|:)bottom-/.test(l)))
      .map(({ rel }) => rel);
    expect(sticky).toEqual([]);
  });

  it("orders bulk bar is a BottomActionBar rendered last in the orders page root (so its spacer ends the page)", () => {
    expect(read("components/automation/bulk-automation-bar.tsx")).toMatch(/<BottomActionBar\s+role="region"\s+aria-label="Bulk actions for selected orders"/);
    const orders = read("app/dashboard/orders/page.tsx");
    // `return (` → 4-space root div → 6-space children; only portalled dialogs follow it.
    expect(orders).toMatch(/\n {2}return \(\n {4}<div className="space-y-6">\n/);
    const tail = orders.slice(orders.search(/\n {6}<BulkAutomationBar\n/));
    expect(tail.length).toBeLessThan(orders.length);
    const followers = [...tail.matchAll(/\n {6}<([A-Z]\w*)/g)].map((m) => m[1]);
    expect(followers[0]).toBe("BulkAutomationBar");
    expect(followers.slice(1).every((c) => /(Dialog|Drawer)$/.test(c!))).toBe(true);
  });

  it("review-queue actions are in normal flow (not sticky/fixed) on every viewport", () => {
    const page = read("app/dashboard/fraud-review/page.tsx");
    const row = literals(page).find((l) => l.includes("grid grid-cols-2 gap-2 border-t"));
    expect(row).toBeDefined();
    expect(row!.split(/\s+/).some((t) => /^(sticky|fixed|md:static|-mx-6)$/.test(t) || /(^|:)bottom-/.test(t))).toBe(false);
    // The md+ row wraps: at 768/1024 the detail column is narrower than the four buttons.
    expect(row!.split(/\s+/)).toEqual(expect.arrayContaining(["md:flex", "md:flex-wrap"]));
  });

  it("template gallery create bar is a BottomActionBar (fixed above the dock, height reserved), last in the gallery", () => {
    const gallery = read("components/landing/template-gallery.tsx");
    expect(gallery).toMatch(/<BottomActionBar\s+role="region"\s+aria-label="Create page"/);
    expect(gallery).toMatch(/<\/BottomActionBar>\n\s+\) : null\}\n\s+<\/div>\n\s+\);\n\}/);
    expect(literals(gallery).some((l) => /(^|\s)sticky(\s|$)/.test(l))).toBe(false);
    expect(gallery).not.toMatch(/\bpb-40\b/);
  });
});
