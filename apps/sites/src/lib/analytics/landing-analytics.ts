import { type LandingAnalyticsConfig, type LandingEventName, type TrackedProduct, linkKind } from "@ecom/landing";
import { COMMERCE_EVENT, type CommerceEvent, type CommerceLine } from "./commerce-events";
import { type MetaPixel, type PixelParams, metaPixel } from "./meta-pixel";

/**
 * landingAnalytics — the one event layer for published landing pages.
 *
 * Components never call the pixel. A single delegated click listener
 * classifies real visitor actions from the link's destination and the
 * section it sits in; see docs/landing-analytics.md for the catalogue.
 *
 * Guarantees:
 *   - Production page only: mounted by the public page route, never by the
 *     preview frame, and refuses to run inside any frame.
 *   - PageView + ViewContent exactly once per page load, whatever React does
 *     (StrictMode double effects, remounts, hydration).
 *   - Per click: at most one standard event (Contact) and one custom event.
 *   - No personal data: link URLs, phone numbers, emails and message text
 *     are never read into an event — only the kind of link.
 *   - Commerce events come from the cart (see commerce-events.ts), never
 *     from DOM guesses. Purchase is sent only for an order the server
 *     created, once per order (deterministic eventID, remembered for the
 *     browser session), with payment_method "cod": placed, not paid.
 */

const STANDARD = new Set<LandingEventName>(["PageView", "ViewContent", "Contact", "AddToCart", "InitiateCheckout", "Purchase"]);
const purchasesSent = new Set<string>();

function purchaseSeen(ref: string): boolean {
  if (purchasesSent.has(ref)) return true;
  try {
    return window.sessionStorage.getItem(`confirmx:purchase:${ref}`) === "1";
  } catch {
    return false;
  }
}

function rememberPurchase(ref: string): void {
  purchasesSent.add(ref);
  try {
    window.sessionStorage.setItem(`confirmx:purchase:${ref}`, "1");
  } catch {
    // In-memory guard still applies.
  }
}

function contentsOf(lines: CommerceLine[]) {
  return {
    content_type: "product",
    content_ids: lines.map((l) => l.id),
    contents: lines.map((l) => ({ id: l.id, quantity: l.quantity, item_price: l.price })),
    num_items: lines.reduce((s, l) => s + l.quantity, 0),
  };
}

export interface LandingPageContext {
  slug: string;
  template: string;
  locale: string;
  title: string;
}


const pageViews = new Set<string>();

function sectionOf(el: Element): string | undefined {
  return el.closest("section[id]")?.id || (el.closest("header") ? "header" : undefined);
}

export function startLandingAnalytics(
  config: LandingAnalyticsConfig,
  page: LandingPageContext,
  products: Record<string, TrackedProduct>,
): () => void {
  if (typeof window === "undefined" || window.top !== window.self) return () => {};

  const pixel: MetaPixel = metaPixel(config.metaPixelId);
  const base: PixelParams = { lp_slug: page.slug, lp_template: page.template, lp_locale: page.locale };
  const send = (name: LandingEventName, params?: PixelParams, eventId?: string) => {
    const payload = { ...base, ...params };
    if (STANDARD.has(name)) pixel.track(name, payload, eventId);
    else pixel.trackCustom(name, payload);
  };

  const loadKey = `${config.metaPixelId}|${location.pathname}`;
  if (!pageViews.has(loadKey)) {
    pageViews.add(loadKey);
    send("PageView");
    const ids = Object.keys(products).slice(0, 20);
    send(
      "ViewContent",
      ids.length
        ? { content_name: page.title, content_type: "product", content_ids: ids, num_items: ids.length, currency: "BDT" }
        : { content_name: page.title },
    );
  }

  const onClick = (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    const a = target?.closest<HTMLAnchorElement>("a[href]");
    if (!a) return;

    // Language switch (outside the landing root).
    const lang = a.getAttribute("data-lp-lang");
    if (lang) {
      if (lang === page.locale) return;
      send("language_switch", { lp_from: page.locale, lp_to: lang });
      // Same-tab navigation would cancel the in-flight beacon: give it a
      // moment (plain left-clicks only; new-tab clicks are left alone).
      if (!e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const href = a.href;
        setTimeout(() => window.location.assign(href), 150);
      }
      return;
    }
    if (!a.closest("[data-landing-root]")) return;

    const kind = linkKind(a.getAttribute("href") ?? "");
    if (!kind) return;
    const location_ = sectionOf(a);
    const contact = kind === "whatsapp" || kind === "phone" || kind === "email" || kind === "messenger";

    const productEl = a.closest<HTMLElement>("[data-lp-product]");
    const key = productEl?.dataset.lpProduct;
    const product = key ? products[key] : undefined;
    if (key && product) {
      send("product_click", {
        content_ids: [key],
        content_name: product.name,
        content_type: "product",
        value: product.price ?? undefined,
        currency: product.price !== null ? "BDT" : undefined,
        lp_cta_type: kind,
        lp_location: location_,
      });
      if (contact) send("Contact", { lp_contact_method: kind, lp_location: location_, content_ids: [key] });
      return;
    }

    if (contact) {
      send("Contact", { lp_contact_method: kind, lp_location: location_ });
      send(`${kind}_click` as LandingEventName, { lp_location: location_ });
      return;
    }
    send("cta_click", { lp_cta_type: kind, lp_location: location_ });
  };

  const onCommerce = (e: Event) => {
    const ev = (e as CustomEvent<CommerceEvent>).detail;
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "add_to_cart") {
      send("AddToCart", {
        ...contentsOf([ev.line]),
        content_name: ev.name.slice(0, 100),
        value: Math.round(ev.line.price * ev.line.quantity * 100) / 100,
        currency: ev.currency,
      });
    } else if (ev.type === "initiate_checkout") {
      if (!ev.lines.length) return;
      send("InitiateCheckout", { ...contentsOf(ev.lines), value: ev.value, currency: ev.currency });
    } else if (ev.type === "purchase") {
      if (!ev.orderRef || !ev.lines.length || purchaseSeen(ev.orderRef)) return;
      rememberPurchase(ev.orderRef);
      send("Purchase", { ...contentsOf(ev.lines), value: ev.value, currency: ev.currency, payment_method: "cod" }, `Purchase.${ev.orderRef}`);
    }
  };

  document.addEventListener("click", onClick, true);
  window.addEventListener(COMMERCE_EVENT, onCommerce);
  return () => {
    document.removeEventListener("click", onClick, true);
    window.removeEventListener(COMMERCE_EVENT, onCommerce);
  };
}
