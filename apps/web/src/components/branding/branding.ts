/**
 * Pure helpers for the merchant-branding feature. Kept framework-free so
 * both the BrandingProvider and the Settings → Branding tab can reuse them.
 */

export interface HSL {
  /** 0..360 */
  h: number;
  /** 0..100 */
  s: number;
  /** 0..100 */
  l: number;
}

/** Parse a 6-digit "#rrggbb" hex into [r,g,b] (0..255). Returns null on bad input. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Convert [r,g,b] (0..255) to HSL. */
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

/** Convenience: hex → HSL, or null. */
export function hexToHsl(hex: string): HSL | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return rgbToHsl(rgb[0], rgb[1], rgb[2]);
}

/** Relative luminance per WCAG (0..1). */
export function relativeLuminance(r: number, g: number, b: number): number {
  const ch = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** Pick the readable foreground for a given hex background (white or black). */
export function readableFg(hex: string): "white" | "black" {
  const rgb = hexToRgb(hex);
  if (!rgb) return "white";
  // Threshold ~0.5 works well on a dark UI; keep brand-fg white most of the
  // time and only flip when the merchant picks a very pale accent.
  return relativeLuminance(rgb[0], rgb[1], rgb[2]) > 0.6 ? "black" : "white";
}

/**
 * Extract a representative accent color from an image. Bins pixels by H/S/L,
 * picks the bin with the most weight after rejecting near-greys and very
 * dark/very light pixels. Designed to run on a small (`maxSide` px) thumbnail
 * to stay fast — typical run is <50 ms on a 256-px logo.
 *
 * Returns hex like "#0084d4", or null when the image is mostly grey/transparent.
 */
export function dominantColorFromImageData(
  data: Uint8ClampedArray,
  opts: { greySaturationFloor?: number; lightnessRange?: [number, number] } = {},
): string | null {
  const greyFloor = opts.greySaturationFloor ?? 25;
  const [lMin, lMax] = opts.lightnessRange ?? [12, 88];
  // Buckets keyed by (H bin, S bin, L bin). H buckets: 18 (20-deg slices),
  // S buckets: 4, L buckets: 4. Tighter binning would over-fragment small logos.
  const bins = new Map<string, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a < 128) continue;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const { h, s, l } = rgbToHsl(r, g, b);
    if (s < greyFloor) continue;
    if (l < lMin || l > lMax) continue;
    const key = `${Math.floor(h / 20)}:${Math.floor(s / 25)}:${Math.floor(l / 25)}`;
    const cur = bins.get(key);
    if (cur) {
      cur.count++;
      cur.r += r;
      cur.g += g;
      cur.b += b;
    } else {
      bins.set(key, { count: 1, r, g, b });
    }
  }
  let best: { count: number; r: number; g: number; b: number } | null = null;
  for (const v of bins.values()) {
    if (!best || v.count > best.count) best = v;
  }
  if (!best || best.count === 0) return null;
  const r = Math.round(best.r / best.count);
  const g = Math.round(best.g / best.count);
  const b = Math.round(best.b / best.count);
  const toHex = (x: number) => x.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
