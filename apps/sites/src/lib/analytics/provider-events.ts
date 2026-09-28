import type { LandingEventName } from "@ecom/landing";
import type { PixelParams } from "./meta-pixel";

/**
 * Maps a landing event (in the Meta parameter shape landing-analytics
 * builds) to Google (GA4) and TikTok. Pure, so it is unit-tested directly.
 *
 * Only standard events are mirrored — PageView, ViewContent, AddToCart,
 * InitiateCheckout, Purchase, Contact. The Meta-only custom click events
 * (cta_click, product_click, *_click, language_switch) are not sent to
 * Google or TikTok. Parameters are rebuilt field by field from product ids,
 * quantities, prices, totals and the currency — never names of people,
 * phones, addresses or URLs.
 *
 *   landing          GA4 (gtag)        TikTok (ttq)
 *   PageView         page_view         page()
 *   ViewContent      view_item_list    ViewContent
 *   AddToCart        add_to_cart       AddToCart
 *   InitiateCheckout begin_checkout    InitiateCheckout
 *   Purchase         purchase (+ Ads   PlaceAnOrder — cash on delivery:
 *                    conversion)       placed, not paid
 *   Contact          contact           Contact
 */

type Line = { id: string; quantity: number; item_price: number };

function lines(p: PixelParams): Line[] {
  const c = p.contents;
  if (!Array.isArray(c)) return [];
  return c
    .map((x) => x as Record<string, unknown>)
    .filter((x) => typeof x.id === "string")
    .map((x) => ({ id: String(x.id), quantity: Number(x.quantity) || 1, item_price: Number(x.item_price) || 0 }));
}

const ids = (p: PixelParams): string[] => (Array.isArray(p.content_ids) ? (p.content_ids as unknown[]).map(String).slice(0, 20) : []);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v.slice(0, 100) : undefined);

const pageParams = (p: PixelParams) => ({ lp_slug: str(p.lp_slug), lp_template: str(p.lp_template), lp_locale: str(p.lp_locale) });

export type GoogleCall =
  | { kind: "page_view"; params: Record<string, unknown> }
  | { kind: "analytics"; name: string; params: Record<string, unknown> }
  | { kind: "purchase"; params: Record<string, unknown>; transactionId: string; value: number; currency: string };

export function toGoogle(name: LandingEventName, p: PixelParams, eventId?: string): GoogleCall | null {
  const currency = str(p.currency);
  const value = num(p.value);
  const single = str(p.content_name);
  const items = () => lines(p).map((l) => ({ item_id: l.id, quantity: l.quantity, price: l.item_price, ...(lines(p).length === 1 && single ? { item_name: single } : {}) }));
  switch (name) {
    case "PageView":
      return { kind: "page_view", params: pageParams(p) };
    case "ViewContent": {
      const list = ids(p);
      if (!list.length) return null;
      return { kind: "analytics", name: "view_item_list", params: { ...pageParams(p), items: list.map((id) => ({ item_id: id })) } };
    }
    case "AddToCart":
      return { kind: "analytics", name: "add_to_cart", params: { ...pageParams(p), currency, value, items: items() } };
    case "InitiateCheckout":
      return { kind: "analytics", name: "begin_checkout", params: { ...pageParams(p), currency, value, items: items() } };
    case "Purchase": {
      const ref = eventId?.startsWith("Purchase.") ? eventId.slice("Purchase.".length) : undefined;
      if (!ref || value === undefined || !currency) return null;
      return {
        kind: "purchase",
        transactionId: ref,
        value,
        currency,
        params: { ...pageParams(p), transaction_id: ref, currency, value, items: items() },
      };
    }
    case "Contact":
      return { kind: "analytics", name: "contact", params: { ...pageParams(p), method: str(p.lp_contact_method), lp_location: str(p.lp_location) } };
    default:
      return null;
  }
}

export type TiktokCall = { kind: "page" } | { kind: "track"; event: string; params: Record<string, unknown>; eventId?: string };

export function toTiktok(name: LandingEventName, p: PixelParams, eventId?: string): TiktokCall | null {
  const currency = str(p.currency);
  const value = num(p.value);
  const contents = () => lines(p).map((l) => ({ content_id: l.id, content_type: "product", quantity: l.quantity, price: l.item_price }));
  switch (name) {
    case "PageView":
      return { kind: "page" };
    case "ViewContent": {
      const list = ids(p);
      if (!list.length) return null;
      return { kind: "track", event: "ViewContent", params: { contents: list.map((id) => ({ content_id: id, content_type: "product" })) } };
    }
    case "AddToCart":
      return { kind: "track", event: "AddToCart", params: { contents: contents(), value, currency } };
    case "InitiateCheckout":
      return { kind: "track", event: "InitiateCheckout", params: { contents: contents(), value, currency } };
    case "Purchase":
      if (!eventId?.startsWith("Purchase.") || value === undefined || !currency) return null;
      return { kind: "track", event: "PlaceAnOrder", params: { contents: contents(), value, currency }, eventId };
    case "Contact":
      return { kind: "track", event: "Contact", params: {} };
    default:
      return null;
  }
}

/** Drops undefined values (keeps payloads minimal and deterministic). */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") out[k] = v;
  return out as Partial<T>;
}
