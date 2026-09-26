import type { Locale } from "./locales.js";
import { type PageContent, type TemplateSpec, effectiveSections } from "./spec.js";

/**
 * Landing-page analytics — the single definition of what a PUBLISHED
 * landing page may report to Meta, shared by the API (validation), the
 * public renderer (runtime) and the docs.
 *
 * Honesty rules:
 *   - Only actions that really happen are reported. A WhatsApp or phone
 *     click is a `Contact`, not a sale. Commerce events exist only on pages
 *     that sell catalog products through the built-in cart:
 *       AddToCart         a product really went into the cart
 *       InitiateCheckout  the customer moved from the cart to checkout
 *       Purchase          the SERVER accepted an order (never on opening a
 *                         form). Orders are cash on delivery: Purchase means
 *                         "order placed", not "paid" (payment_method: cod).
 *     `Lead` is reserved for a future form submission.
 *   - No personal data: never names, phone numbers, addresses, emails,
 *     message text, link URLs, or merchant/page database ids. Catalog
 *     products are identified by their product id (content_ids), page
 *     product cards by their position key ("products-0").
 *   - The editor preview and the dashboard never load a pixel.
 */

/** Meta Pixel (dataset) IDs are 15–16 digit numbers. Anything else is rejected. */
export const META_PIXEL_ID_RE = /^[1-9][0-9]{14,15}$/;

export function isMetaPixelId(value: unknown): value is string {
  return typeof value === "string" && META_PIXEL_ID_RE.test(value);
}

/** Normalises user input ("  1234 5678… ") to digits; null when not a valid ID. */
export function normalizeMetaPixelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[\s-]/g, "");
  return isMetaPixelId(digits) ? digits : null;
}

/** Tracking configuration as served with a published page (public data only). */
export interface LandingAnalyticsConfig {
  metaPixelId: string;
}

export function analyticsConfigOf(
  stored: { metaPixelId?: unknown; enabled?: unknown } | null | undefined,
): LandingAnalyticsConfig | null {
  if (!stored || stored.enabled !== true || !isMetaPixelId(stored.metaPixelId)) return null;
  return { metaPixelId: stored.metaPixelId };
}

export type ContactMethod = "whatsapp" | "phone" | "email" | "messenger";

/** Every event a landing page can send. `kind` = Meta standard vs custom event. */
export const LANDING_EVENTS = {
  PageView: { kind: "standard", when: "Page loaded (once per page load)" },
  AddToCart: { kind: "standard", when: "A catalog product was added to the cart (quantity actually increased)" },
  InitiateCheckout: { kind: "standard", when: "The customer continued from the cart to checkout" },
  Purchase: { kind: "standard", when: "The server created the order (cash on delivery — placed, not paid); once per order" },
  ViewContent: { kind: "standard", when: "Page loaded — the offer/products were shown (once per page load)" },
  Contact: { kind: "standard", when: "Click on a WhatsApp, phone, email or Messenger link" },
  whatsapp_click: { kind: "custom", when: "Click on a WhatsApp link (not inside a product card)" },
  phone_click: { kind: "custom", when: "Click on a phone (tel:) link (not inside a product card)" },
  email_click: { kind: "custom", when: "Click on an email (mailto:) link (not inside a product card)" },
  messenger_click: { kind: "custom", when: "Click on a Messenger (m.me) link (not inside a product card)" },
  product_click: { kind: "custom", when: "Click on a product card's button or link" },
  cta_click: { kind: "custom", when: "Click on any other button/link (section scroll, external link)" },
  language_switch: { kind: "custom", when: "Visitor switches the page language" },
} as const;

export type LandingEventName = keyof typeof LANDING_EVENTS;

/** Classifies a link destination without ever exposing it. */
export function linkKind(href: string): ContactMethod | "section" | "link" | null {
  const h = href.trim().toLowerCase();
  if (!h) return null;
  if (h.startsWith("#")) return "section";
  if (h.startsWith("tel:")) return "phone";
  if (h.startsWith("mailto:")) return "email";
  if (/^https:\/\/(wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\//.test(h)) return "whatsapp";
  if (/^https:\/\/(m\.me|www\.messenger\.com|messenger\.com)\//.test(h)) return "messenger";
  if (/^https?:\/\//.test(h) || h.startsWith("/")) return "link";
  return null;
}

/** Stable, non-personal product key: "<sectionId>-<index>". */
export function productKey(sectionId: string, index: number): string {
  return `${sectionId}-${index}`;
}

export interface TrackedProduct {
  name: string;
  /** BDT; null when the product shows no price. */
  price: number | null;
}

/**
 * Products shown on a page, by key — built on the server from validated
 * content, so click events carry the name/price the page actually shows
 * without reading them back out of the DOM.
 */
export function productCatalog(spec: TemplateSpec, content: PageContent, locale: Locale): Record<string, TrackedProduct> {
  const out: Record<string, TrackedProduct> = {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 100) : "");
  for (const section of effectiveSections(spec, locale)) {
    const values = content[section.id] ?? {};
    if (section.type === "productGrid" && Array.isArray(values.items)) {
      values.items.slice(0, 50).forEach((item, i) => {
        const p = (item ?? {}) as Record<string, unknown>;
        out[productKey(section.id, i)] = { name: str(p.name), price: num(p.price) };
      });
    }
    if (section.type === "offerBanner") {
      out[productKey(section.id, 0)] = { name: str(values.heading), price: num(values.price) };
    }
  }
  return out;
}
