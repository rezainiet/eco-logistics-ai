import { type NumeralMode, formatBDT, formatNumber } from "./format.js";
import type { Locale } from "./locales.js";
import { type PageContent, type TemplateSpec, effectiveSections } from "./spec.js";

/**
 * Landing-page commerce — shared by the API (public payload + order
 * validation), the renderer (product cards), the public cart/checkout and
 * the editor preview.
 *
 * A landing page stores product REFERENCES only (id + safe display
 * overrides). Name, price, currency and stock always come from the
 * merchant's live product at request time; the page can never override
 * them, and the server re-checks everything when an order is placed.
 */

/** Most units of one product in one order, and most lines in a cart. */
export const MAX_LINE_QUANTITY = 10;
export const MAX_CART_LINES = 20;
/** Most products one landing page can link. */
export const MAX_PAGE_PRODUCTS = 24;

export type CatalogStockStatus = "in_stock" | "low_stock" | "out_of_stock";

/** A product as a published page (and its preview) shows it. Public data only. */
export interface CatalogProduct {
  id: string;
  name: string;
  description: string;
  imageAssetId: string | null;
  price: number;
  compareAtPrice: number | null;
  currency: string;
  /** False when inactive or out of stock — shown, but cannot be ordered. */
  available: boolean;
  stockStatus: CatalogStockStatus;
  /** Most units a customer may put in the cart (0 when unavailable). */
  maxQuantity: number;
  badge: string | null;
  ctaText: string | null;
  featured: boolean;
}

/** A page's product link: the reference plus display-only overrides. */
export interface PageProductRef {
  productId: string;
  ctaText?: string | null;
  badge?: string | null;
  featured?: boolean;
}

export interface DeliveryOption {
  /** "<sectionId>-<index>" of the delivery zone on the published page. */
  id: string;
  label: string;
  time: string | null;
  charge: number;
}

/** Commerce block of the public payload; null when the page links no products. */
export interface LandingCommerce {
  products: CatalogProduct[];
  delivery: DeliveryOption[];
  currency: string;
}

const OBJECT_ID_RE = /^[a-f0-9]{24}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Re-validates a catalog from an untrusted source (preview postMessage):
 * wrong shapes are dropped, strings are truncated, images are asset ids
 * (turned into URLs by the renderer's own configuration), never URLs.
 */
export function parseCatalog(data: unknown): CatalogProduct[] {
  if (!Array.isArray(data)) return [];
  const out: CatalogProduct[] = [];
  for (const raw of data.slice(0, MAX_PAGE_PRODUCTS)) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const id = str(p.id, 24);
    const price = numOrNull(p.price);
    if (!OBJECT_ID_RE.test(id) || price === null) continue;
    const stock = p.stockStatus === "low_stock" || p.stockStatus === "out_of_stock" ? p.stockStatus : "in_stock";
    const available = p.available === true && stock !== "out_of_stock";
    const max = typeof p.maxQuantity === "number" && Number.isInteger(p.maxQuantity) ? p.maxQuantity : 0;
    const image = str(p.imageAssetId, 24);
    out.push({
      id,
      name: str(p.name, 120),
      description: str(p.description, 2000),
      imageAssetId: OBJECT_ID_RE.test(image) ? image : null,
      price,
      compareAtPrice: numOrNull(p.compareAtPrice),
      currency: /^[A-Z]{3}$/.test(str(p.currency, 3)) ? str(p.currency, 3) : "BDT",
      available,
      stockStatus: stock,
      maxQuantity: available ? Math.max(0, Math.min(MAX_LINE_QUANTITY, max)) : 0,
      badge: str(p.badge, 24) || null,
      ctaText: str(p.ctaText, 40) || null,
      featured: p.featured === true,
    });
  }
  return out;
}

/** Delivery zones with a charge, from the page's delivery section(s). */
export function deliveryOptions(spec: TemplateSpec, content: PageContent, locale: Locale): DeliveryOption[] {
  const out: DeliveryOption[] = [];
  for (const section of effectiveSections(spec, locale)) {
    if (section.type !== "deliveryInfo") continue;
    const zones = (content[section.id] ?? {}).zones;
    if (!Array.isArray(zones)) continue;
    zones.slice(0, 6).forEach((z, i) => {
      const zone = (z ?? {}) as Record<string, unknown>;
      const label = str(zone.area, 50).trim();
      if (!label) return;
      out.push({ id: `${section.id}-${i}`, label, time: str(zone.time, 40).trim() || null, charge: numOrNull(zone.charge) ?? 0 });
    });
  }
  return out;
}

/** Money in a product's currency: "৳ ১,২৯০" on Bangla pages, "USD 12.50" otherwise. */
export function formatMoney(value: number, currency: string, opts: { locale: Locale; numerals?: NumeralMode }): string {
  if (!currency || currency.toUpperCase() === "BDT") return formatBDT(value, opts);
  return `${currency.toUpperCase()} ${formatNumber(value, { ...opts, maxFractionDigits: 2 })}`;
}

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";

/**
 * Bangladeshi mobile number → "+8801XXXXXXXXX", or null. Accepts 01…,
 * 8801…, +8801…, spaces/dashes, and Bangla digits.
 */
export function normalizeBdMobile(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const ascii = raw.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
  const digits = ascii.replace(/[\s\-().]/g, "");
  const m = /^(?:\+?88)?(01[3-9]\d{8})$/.exec(digits);
  return m ? `+88${m[1]}` : null;
}

/** Customer-facing commerce words (cart, checkout, stock). */
export interface CommerceStrings {
  addToCart: string;
  orderNow: string;
  inStock: string;
  lowStock: string;
  outOfStock: string;
  unavailable: string;
  cart: string;
  openCart: (count: string) => string;
  emptyCart: string;
  continueShopping: string;
  remove: string;
  quantity: string;
  decrease: string;
  increase: string;
  maxReached: string;
  subtotal: string;
  delivery: string;
  deliveryArea: string;
  deliveryTbd: string;
  total: string;
  checkout: string;
  yourDetails: string;
  name: string;
  phone: string;
  phoneHint: string;
  address: string;
  district: string;
  email: string;
  optional: string;
  notes: string;
  review: string;
  back: string;
  placeOrder: string;
  placing: string;
  cod: string;
  codNote: string;
  success: string;
  orderNumber: string;
  successNote: string;
  close: string;
  loading: string;
  error: string;
  retry: string;
  errors: {
    name: string;
    phone: string;
    address: string;
    district: string;
    email: string;
    delivery: string;
    stock: string;
    unavailable: string;
    priceChanged: string;
    generic: string;
    rateLimited: string;
  };
}

const en: CommerceStrings = {
  addToCart: "Add to cart",
  orderNow: "Order now",
  inStock: "In stock",
  lowStock: "Low stock",
  outOfStock: "Out of stock",
  unavailable: "This product is currently out of stock",
  cart: "Your cart",
  openCart: (n) => `Open cart, ${n} items`,
  emptyCart: "Your cart is empty",
  continueShopping: "Continue shopping",
  remove: "Remove",
  quantity: "Quantity",
  decrease: "Decrease quantity",
  increase: "Increase quantity",
  maxReached: "Maximum available quantity",
  subtotal: "Subtotal",
  delivery: "Delivery charge",
  deliveryArea: "Delivery area",
  deliveryTbd: "Confirmed by the seller",
  total: "Total",
  checkout: "Checkout",
  yourDetails: "Your details",
  name: "Full name",
  phone: "Mobile number",
  phoneHint: "e.g. 01712345678",
  address: "Full address",
  district: "City / district",
  email: "Email",
  optional: "optional",
  notes: "Note for the seller",
  review: "Review order",
  back: "Back",
  placeOrder: "Complete order",
  placing: "Placing your order…",
  cod: "Cash on delivery",
  codNote: "Pay in cash when you receive the product.",
  success: "Your order has been received",
  orderNumber: "Order number",
  successNote: "The seller will call you to confirm. Payment is cash on delivery.",
  close: "Close",
  loading: "Loading…",
  error: "Something went wrong",
  retry: "Try again",
  errors: {
    name: "Enter your name",
    phone: "Enter a valid Bangladeshi mobile number (01XXXXXXXXX)",
    address: "Enter your full address",
    district: "Enter your city or district",
    email: "Enter a valid email or leave it empty",
    delivery: "Choose a delivery area",
    stock: "Not enough stock for some items — quantities were updated",
    unavailable: "Some items are no longer available and were removed",
    priceChanged: "Prices changed — please review your order",
    generic: "Your order could not be placed. Please try again.",
    rateLimited: "Too many attempts. Please wait a minute and try again.",
  },
};

const bn: CommerceStrings = {
  addToCart: "কার্টে যোগ করুন",
  orderNow: "অর্ডার করুন",
  inStock: "স্টকে আছে",
  lowStock: "স্টক কম",
  outOfStock: "স্টকে নেই",
  unavailable: "এই পণ্যটি বর্তমানে স্টকে নেই",
  cart: "আপনার কার্ট",
  openCart: (n) => `কার্ট খুলুন, ${n}টি পণ্য`,
  emptyCart: "আপনার কার্ট খালি",
  continueShopping: "কেনাকাটা চালিয়ে যান",
  remove: "সরান",
  quantity: "পরিমাণ",
  decrease: "পরিমাণ কমান",
  increase: "পরিমাণ বাড়ান",
  maxReached: "সর্বোচ্চ পরিমাণ",
  subtotal: "সাবটোটাল",
  delivery: "ডেলিভারি চার্জ",
  deliveryArea: "ডেলিভারি এলাকা",
  deliveryTbd: "বিক্রেতা নিশ্চিত করবেন",
  total: "সর্বমোট",
  checkout: "চেকআউট",
  yourDetails: "আপনার তথ্য",
  name: "আপনার নাম",
  phone: "মোবাইল নম্বর",
  phoneHint: "যেমন 01712345678",
  address: "সম্পূর্ণ ঠিকানা",
  district: "শহর / জেলা",
  email: "ইমেইল",
  optional: "ঐচ্ছিক",
  notes: "বিক্রেতার জন্য নোট",
  review: "অর্ডার দেখুন",
  back: "পেছনে",
  placeOrder: "অর্ডার সম্পন্ন করুন",
  placing: "অর্ডার করা হচ্ছে…",
  cod: "ক্যাশ অন ডেলিভারি",
  codNote: "পণ্য হাতে পেয়ে টাকা পরিশোধ করুন।",
  success: "আপনার অর্ডার সফলভাবে গ্রহণ করা হয়েছে",
  orderNumber: "অর্ডার নম্বর",
  successNote: "নিশ্চিত করতে বিক্রেতা আপনাকে কল করবেন। পেমেন্ট ক্যাশ অন ডেলিভারি।",
  close: "বন্ধ করুন",
  loading: "লোড হচ্ছে…",
  error: "কিছু একটা সমস্যা হয়েছে",
  retry: "আবার চেষ্টা করুন",
  errors: {
    name: "আপনার নাম লিখুন",
    phone: "সঠিক মোবাইল নম্বর লিখুন (01XXXXXXXXX)",
    address: "সম্পূর্ণ ঠিকানা লিখুন",
    district: "শহর বা জেলার নাম লিখুন",
    email: "সঠিক ইমেইল লিখুন অথবা খালি রাখুন",
    delivery: "ডেলিভারি এলাকা বেছে নিন",
    stock: "কিছু পণ্যের পর্যাপ্ত স্টক নেই — পরিমাণ আপডেট করা হয়েছে",
    unavailable: "কিছু পণ্য আর পাওয়া যাচ্ছে না, তাই সরিয়ে দেওয়া হয়েছে",
    priceChanged: "দাম পরিবর্তন হয়েছে — অনুগ্রহ করে অর্ডারটি আবার দেখুন",
    generic: "অর্ডার করা যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।",
    rateLimited: "অনেকবার চেষ্টা করা হয়েছে। এক মিনিট পর আবার চেষ্টা করুন।",
  },
};

export function commerceStrings(locale: Locale): CommerceStrings {
  return locale === "bn" ? bn : en;
}
