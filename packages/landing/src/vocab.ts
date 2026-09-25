import type { FieldDef } from "./fields.js";
import type { Locale } from "./locales.js";

/**
 * Closed vocabularies shared by section definitions and components:
 * icons, fonts, social networks and payment methods. A merchant only ever
 * picks a key from these lists; the components map keys to trusted output.
 */

export const ICON_NAMES = [
  "check",
  "star",
  "shield",
  "truck",
  "clock",
  "heart",
  "bolt",
  "phone",
  "chat",
  "gift",
  "leaf",
  "award",
  "tag",
  "map-pin",
  "sparkles",
  "wrench",
  "cart",
  "bag",
  "return",
  "lock",
  "cash",
  "support",
  "percent",
  "fire",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

export const ICON_OPTIONS = ICON_NAMES.map((n) => ({ value: n, label: n.replace("-", " ") }));

/**
 * Font choices. The Bengali faces are self-hosted web fonts loaded by the
 * public renderer (apps/sites, next/font) and exposed as CSS variables:
 *   --lp-font-bn-sans  → Hind Siliguri
 *   --lp-font-bn-serif → Noto Serif Bengali
 * Every stack carries a Bengali face, so Bangla words inside an English
 * page never fall back to a random system font, and every Bangla stack
 * carries Latin faces for mixed Bangla + English copy.
 */
export const FONT_KEYS = ["system", "humanist", "serif", "bengali"] as const;
export type FontKey = (typeof FONT_KEYS)[number];

const LATIN = {
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial',
  humanist: '"Trebuchet MS", "Gill Sans", "Segoe UI", ui-sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", Times',
} as const;
const BN_SANS = 'var(--lp-font-bn-sans, "Hind Siliguri"), "Noto Sans Bengali"';
const BN_SERIF = 'var(--lp-font-bn-serif, "Noto Serif Bengali"), "Noto Sans Bengali"';

export function fontStack(font: FontKey | string, locale: Locale): string {
  const key = (FONT_KEYS as readonly string[]).includes(font) ? (font as FontKey) : "system";
  const serif = key === "serif";
  if (locale === "bn" || key === "bengali") {
    // Bengali face first so conjuncts and vowel signs come from one font;
    // Latin letters in mixed copy fall through to the Latin stack.
    return `${serif ? BN_SERIF : BN_SANS}, ${serif ? LATIN.serif : LATIN.system}, ${serif ? "serif" : "sans-serif"}`;
  }
  const latin = LATIN[key as Exclude<FontKey, "bengali">];
  return `${latin}, ${serif ? BN_SERIF : BN_SANS}, ${serif ? "serif" : "sans-serif"}`;
}

/** Back-compat export: English stacks by key. */
export const FONT_STACKS: Record<FontKey, string> = {
  system: fontStack("system", "en"),
  humanist: fontStack("humanist", "en"),
  serif: fontStack("serif", "en"),
  bengali: fontStack("bengali", "bn"),
};

export const FONT_OPTIONS = [
  { value: "system", label: "Modern sans" },
  { value: "humanist", label: "Friendly sans" },
  { value: "serif", label: "Classic serif" },
  { value: "bengali", label: "Bengali-friendly sans" },
];

export const SOCIAL_NETWORKS = [
  { value: "facebook", label: "Facebook" },
  { value: "messenger", label: "Messenger" },
  { value: "instagram", label: "Instagram" },
  { value: "youtube", label: "YouTube" },
  { value: "tiktok", label: "TikTok" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "x", label: "X" },
] as const;

/**
 * Payment methods a merchant can DISPLAY as accepted. Display only —
 * ConfirmX does not process any of these payments.
 */
export const PAYMENT_METHODS = ["cod", "bkash", "nagad", "rocket", "upay", "card", "bank"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_OPTIONS = [
  { value: "cod", label: "Cash on Delivery" },
  { value: "bkash", label: "bKash" },
  { value: "nagad", label: "Nagad" },
  { value: "rocket", label: "Rocket" },
  { value: "upay", label: "Upay" },
  { value: "card", label: "Card" },
  { value: "bank", label: "Bank transfer" },
];

export const RATING_OPTIONS = [
  { value: "5", label: "5 stars" },
  { value: "4", label: "4 stars" },
  { value: "3", label: "3 stars" },
  { value: "0", label: "No rating" },
];

export const heading = (def = "", required = true): FieldDef => ({
  key: "heading",
  type: "text",
  label: "Heading",
  maxLength: 120,
  required,
  default: def,
});

export const cta = (key: string, label: string): FieldDef => ({ key, type: "cta", label });

/** The product fields shared by every product card (grid, flash sale, best sellers). */
export const PRODUCT_FIELDS: ReadonlyArray<FieldDef> = [
  { key: "image", type: "image", label: "Product image" },
  { key: "name", type: "text", label: "Product name", maxLength: 100, required: true },
  { key: "price", type: "price", label: "Price (BDT)", required: true },
  { key: "oldPrice", type: "price", label: "Previous price (BDT)", help: "Shown struck through; the discount % is calculated automatically." },
  { key: "badge", type: "text", label: "Badge (e.g. New, Hot)", maxLength: 24 },
  { key: "rating", type: "select", label: "Rating", options: RATING_OPTIONS, default: "0" },
  cta("cta", "Button"),
];
