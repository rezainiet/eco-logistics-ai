/**
 * Pure color helpers. Mirrors `apps/web/src/components/branding/branding.ts`
 * but kept here so apps/api (which does not depend on apps/web) can use
 * them for email rendering.
 */

export interface HSL {
  /** 0..360 */ h: number;
  /** 0..100 */ s: number;
  /** 0..100 */ l: number;
}

/** Parse "#rrggbb" → [r,g,b] (0..255). Tolerates #RGB shorthand and missing #. */
export function hexToRgb(input: string): [number, number, number] | null {
  if (!input) return null;
  let hex = input.trim().replace(/^#/, "");
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  const n = parseInt(hex, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function rgbToHsl(r: number, g: number, b: number): HSL {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rf:
        h = (gf - bf) / d + (gf < bf ? 6 : 0);
        break;
      case gf:
        h = (bf - rf) / d + 2;
        break;
      default:
        h = (rf - gf) / d + 4;
    }
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hexToHsl(hex: string): HSL | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return rgbToHsl(rgb[0], rgb[1], rgb[2]);
}

/** "76 92% 64%" — the format Tailwind tokens consume via `hsl(var(--brand))`. */
export function hexToHslComponents(hex: string): string | null {
  const hsl = hexToHsl(hex);
  if (!hsl) return null;
  return `${hsl.h} ${hsl.s}% ${hsl.l}%`;
}

/** WCAG relative luminance, 0..1. */
export function relativeLuminance(r: number, g: number, b: number): number {
  const ch = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** "#000" or "#fff" depending on which contrasts better with the given hex. */
export function readableFg(hex: string): "#FFFFFF" | "#000000" {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#FFFFFF";
  return relativeLuminance(rgb[0], rgb[1], rgb[2]) > 0.6 ? "#000000" : "#FFFFFF";
}

/** Lighten/darken an HSL by adjusting lightness (clamped to [0,100]). */
export function adjustL(hsl: HSL, deltaL: number): HSL {
  return { h: hsl.h, s: hsl.s, l: Math.max(0, Math.min(100, hsl.l + deltaL)) };
}

export function hslToHex(h: number, s: number, l: number): string {
  const sf = s / 100;
  const lf = l / 100;
  const c = (1 - Math.abs(2 * lf - 1)) * sf;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = lf - c / 2;
  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/** Auto-derive a `brandActive` from `brand` if the admin didn't set one. */
export function deriveBrandActive(brandHex: string): string {
  const hsl = hexToHsl(brandHex);
  if (!hsl) return brandHex;
  const dim = adjustL(hsl, -12);
  return hslToHex(dim.h, dim.s, dim.l);
}
