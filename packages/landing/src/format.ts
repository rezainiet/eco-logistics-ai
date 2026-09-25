import type { Locale } from "./locales.js";

/**
 * Number and BDT formatting for landing pages.
 *
 * Deliberately NOT `Intl.NumberFormat`: server (Node ICU) and browsers can
 * disagree on grouping and digit data, which would make SSR output differ
 * from the editor preview. This is small, deterministic and matches
 * Bangladeshi convention:
 *
 *   - South-Asian grouping: 1,290 · 12,500 · 1,25,000 · 12,50,000
 *   - Digits follow the page's numeral setting:
 *       "auto"    → Bangla digits (০-৯) on bn pages, Latin digits on en pages
 *       "latin"   → always 0-9  (many BD shops prefer this even in Bangla)
 *       "bengali" → always ০-৯
 *   - BDT is shown as "৳ 1,290" / "৳ ১,২৯০" with a no-break space so the
 *     symbol never wraps away from the amount.
 */

export const NUMERAL_MODES = ["auto", "latin", "bengali"] as const;
export type NumeralMode = (typeof NUMERAL_MODES)[number];

const BENGALI_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"] as const;

export function usesBengaliDigits(locale: Locale, mode: NumeralMode = "auto"): boolean {
  if (mode === "bengali") return true;
  if (mode === "latin") return false;
  return locale === "bn";
}

/** Replace ASCII digits with Bangla digits. */
export function toBengaliDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => BENGALI_DIGITS[Number(d)]!);
}

/** South-Asian (lakh/crore) grouping of a non-negative integer string. */
function groupSouthAsian(intDigits: string): string {
  if (intDigits.length <= 3) return intDigits;
  const last3 = intDigits.slice(-3);
  const rest = intDigits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

export function formatNumber(
  value: number,
  opts: { locale: Locale; numerals?: NumeralMode; maxFractionDigits?: number },
): string {
  if (!Number.isFinite(value)) return "";
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(opts.maxFractionDigits ?? 2);
  let [int, frac = ""] = fixed.split(".");
  frac = frac.replace(/0+$/, "");
  let out = groupSouthAsian(int ?? "0") + (frac ? `.${frac}` : "");
  if (negative) out = `-${out}`;
  return usesBengaliDigits(opts.locale, opts.numerals) ? toBengaliDigits(out) : out;
}

export const TAKA = "৳";

export function formatBDT(value: number, opts: { locale: Locale; numerals?: NumeralMode }): string {
  return `${TAKA}\u00A0${formatNumber(value, { ...opts, maxFractionDigits: 2 })}`;
}

/** Whole-percent discount from old → new price, or null when not a discount. */
export function discountPercent(price: number, oldPrice: number | null | undefined): number | null {
  if (!oldPrice || !Number.isFinite(oldPrice) || !Number.isFinite(price)) return null;
  if (oldPrice <= price || oldPrice <= 0) return null;
  const pct = Math.round(((oldPrice - price) / oldPrice) * 100);
  return pct >= 1 ? pct : null;
}

/** "-22%" (en) / "-২২%" (bn with Bangla digits). */
export function formatPercent(value: number, opts: { locale: Locale; numerals?: NumeralMode }): string {
  return `${formatNumber(value, { ...opts, maxFractionDigits: 0 })}%`;
}
