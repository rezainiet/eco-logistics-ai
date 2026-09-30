import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio, deriveBrandStates, hexToRgb, hslToHex, readableFg, relativeLuminance } from "@ecom/branding";
import { buttonVariants } from "./button";
import { badgeVariants } from "./badge";
import { brandStyleVars, readableFg as dashboardReadableFg } from "@/components/branding/branding";

/**
 * Solid brand surfaces (lime by default, or the merchant's accent) must use
 * the --brand-fg token for their label. White on the default lime measured
 * 1.24:1 in production (audit F-02) — these guards keep it from coming back.
 */
const SRC = fileURLToPath(new URL("../..", import.meta.url));
const AA = 4.5;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

/** Every quoted / template literal in a file (good enough for class strings). */
function literals(src: string): string[] {
  const out: string[] = [];
  const re = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[2]!);
  return out;
}

// A solid fill: `bg-brand` / `bg-primary` not followed by `-hover`, `/10` etc.
const SOLID_BRAND = /(^|[\s:"'`])bg-(brand|primary)(?=$|[\s"'`])/;
const WHITE_TEXT = /(^|[\s:"'`])text-white(?=$|[\s"'`])/;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sf = s / 100;
  const lf = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sf * Math.min(lf, 1 - lf);
  const f = (n: number) => lf - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function cssVar(css: string, name: string): [number, number, number] {
  const m = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(css);
  if (!m) throw new Error(`--${name} not found in globals.css`);
  return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
}

const lum = (rgb: [number, number, number]) => relativeLuminance(rgb[0], rgb[1], rgb[2]);
const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

describe("brand CTA contrast (audit F-02)", () => {
  it("no class string pairs a solid brand/primary fill with text-white", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, "/");
      for (const lit of literals(readFileSync(file, "utf8"))) {
        if (SOLID_BRAND.test(lit) && WHITE_TEXT.test(lit)) offenders.push(`${rel}: "${lit.trim().slice(0, 90)}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the shared brand Button variant and default Badge use the brand foreground token", () => {
    const button = buttonVariants({ variant: "brand" });
    expect(button).toContain("bg-brand");
    expect(button).toContain("text-brand-fg");
    expect(button).not.toContain("text-white");
    // Keeps the keyboard focus ring shared by every Button.
    expect(button).toContain("focus-visible:ring-2");
    const badge = badgeVariants({ variant: "default" });
    expect(badge).toContain("text-brand-fg");
    expect(badge).not.toContain("text-white");
  });

  it("default brand tokens meet WCAG AA for normal text in rest, hover and active states", () => {
    const css = readFileSync(join(SRC, "app/globals.css"), "utf8");
    const fg = lum(cssVar(css, "brand-fg"));
    for (const state of ["brand", "brand-hover", "brand-active"]) {
      expect(contrastRatio(lum(cssVar(css, state)), fg), state).toBeGreaterThanOrEqual(AA);
    }
    // The regression itself: white on the default lime.
    expect(contrastRatio(lum(cssVar(css, "brand")), 1)).toBeLessThan(AA);
  });

  it("merchant accents get whichever of black/white contrasts better — always ≥ AA", () => {
    let worst = Infinity;
    for (let r = 0; r <= 255; r += 17)
      for (let g = 0; g <= 255; g += 17)
        for (let b = 0; b <= 255; b += 17) {
          const bg = relativeLuminance(r, g, b);
          const fg = readableFg(hex(r, g, b)) === "#000000" ? 0 : 1;
          const other = fg === 0 ? 1 : 0;
          const chosen = contrastRatio(bg, fg);
          expect(chosen).toBeGreaterThanOrEqual(contrastRatio(bg, other));
          worst = Math.min(worst, chosen);
        }
    expect(worst).toBeGreaterThanOrEqual(AA);
  });

  it("merchant accents stay ≥ AA in rest, hover and active states (shared derivation)", () => {
    const rendered = (c: { h: number; s: number; l: number }) => {
      const [r, g, b] = hexToRgb(hslToHex(c.h, c.s, c.l))!;
      return relativeLuminance(r, g, b);
    };
    let worst = Infinity;
    let oldFailures = 0;
    for (let r = 0; r <= 255; r += 15)
      for (let g = 0; g <= 255; g += 15)
        for (let b = 0; b <= 255; b += 15) {
          const s = deriveBrandStates(hex(r, g, b))!;
          const fg = s.fg === "#000000" ? 0 : 1;
          for (const state of [s.brand, s.hover, s.active]) worst = Math.min(worst, contrastRatio(rendered(state), fg));
          // The previous rule always darkened hover by 6 / active by 12.
          const oldHover = { ...s.brand, l: Math.max(0, s.brand.l - 6) };
          if (contrastRatio(rendered(oldHover), fg) < AA) oldFailures++;
        }
    expect(worst).toBeGreaterThanOrEqual(AA);
    // The regression the new rule removes really existed.
    expect(oldFailures).toBeGreaterThan(0);
  });

  it("brandStyleVars emits all four variables from the shared derivation", () => {
    expect(brandStyleVars("#c6f84f")).toEqual({
      "--brand": "78 92% 64%",
      "--brand-hover": "78 92% 70%",
      "--brand-active": "78 92% 76%",
      "--brand-fg": "0 0% 0%",
    });
    const dark = brandStyleVars("#1e3a8a")!;
    expect(dark["--brand-fg"]).toBe("0 0% 100%");
    // White label → hover/active get darker, never lighter.
    expect(Number(dark["--brand-hover"]!.split(" ")[2]!.replace("%", ""))).toBeLessThan(
      Number(dark["--brand"]!.split(" ")[2]!.replace("%", "")),
    );
    expect(brandStyleVars("not-a-colour")).toBeUndefined();
    expect(brandStyleVars(null)).toBeUndefined();
  });

  it("mid-tone accents that the old 0.6 luminance cut-off put white on now get black", () => {
    // Luminance ≈ 0.3: white is ~3:1 (fails), black ~7:1.
    expect(readableFg("#3aa6a6")).toBe("#000000");
    expect(dashboardReadableFg("#3aa6a6")).toBe("black");
    // The default lime keeps its dark label; a dark accent keeps white.
    expect(dashboardReadableFg("#c6f84f")).toBe("black");
    expect(dashboardReadableFg("#1e3a8a")).toBe("white");
  });
});
