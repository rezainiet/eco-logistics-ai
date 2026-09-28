import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Published landing page → Meta / Google (GA4 + Ads) / TikTok browser
 * events (apps/sites/src/lib/analytics). Same harness as
 * landing-commerce-events.test.ts: browser globals are stubbed, `fbq` is a
 * recorder, and the Google / TikTok loaders install their own queueing stubs
 * (dataLayer, ttq) which are inspected — nothing is loaded from or sent to
 * any provider.
 */

const SITES_ANALYTICS = fileURLToPath(new URL("../../sites/src/lib/analytics/", import.meta.url));

type Call = unknown[];
let fbqCalls: Call[];
let win: EventTarget & Record<string, unknown>;

function installBrowser() {
  fbqCalls = [];
  win = new EventTarget() as EventTarget & Record<string, unknown>;
  const store = new Map<string, string>();
  Object.assign(win, {
    fbq: (...args: Call) => void fbqCalls.push(args),
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
    },
  });
  win.self = win;
  win.top = win;
  const doc = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(doc, { createElement: () => ({}), head: { appendChild: () => undefined } });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", { pathname: "/" });
}

async function load() {
  vi.resetModules();
  const analytics = await import(/* @vite-ignore */ `${SITES_ANALYTICS}landing-analytics.ts`);
  const events = await import(/* @vite-ignore */ `${SITES_ANALYTICS}commerce-events.ts`);
  return { start: analytics.startLandingAnalytics, emit: events.emitCommerceEvent };
}

const PIXEL = "123456789012345";
const GA4 = "G-ABC123XYZ9";
const ADS = { id: "AW-123456789", purchaseLabel: "AbC-D_efG-h12" };
const TT = "C4ABCDEF1234567890GH";
const page = { slug: "bazar", template: "bd-modern-shop", locale: "bn", title: "বাজার" };
const products = { "6ab73cca06587711398245c7": { name: "Premium Cotton Shirt", price: 1290 } };
const line = { id: "6ab73cca06587711398245c7", quantity: 2, price: 1290 };
const purchase = { type: "purchase", orderRef: "ORD-MKT-1", lines: [line], value: 2660, currency: "BDT" } as const;

/** gtag("event", name, params) calls recorded in dataLayer. */
function gtagEvents(): Array<{ name: string; params: Record<string, unknown> }> {
  const dl = (win.dataLayer as ArrayLike<unknown>[] | undefined) ?? [];
  return dl.map((a) => Array.from(a)).filter((a) => a[0] === "event").map((a) => ({ name: String(a[1]), params: a[2] as Record<string, unknown> }));
}
function gtagConfigs(): Call[] {
  const dl = (win.dataLayer as ArrayLike<unknown>[] | undefined) ?? [];
  return dl.map((a) => Array.from(a)).filter((a) => a[0] === "config");
}
/** ttq.instance(TT) queue: [method, ...args]. */
function ttqCalls(): Call[] {
  const ttq = win.ttq as { _i?: Record<string, Call[]> } | undefined;
  return (ttq?._i?.[TT] ?? []).map((c) => c as Call);
}

describe("landing page → Google / TikTok, alongside the existing Meta Pixel", () => {
  beforeEach(installBrowser);
  afterEach(() => vi.unstubAllGlobals());

  it("Meta-only page: exactly the existing Meta calls, and no Google/TikTok code or globals", async () => {
    const { start, emit } = await load();
    const stop = start({ metaPixelId: PIXEL }, page, products);
    emit({ type: "add_to_cart", line, name: "Premium Cotton Shirt", currency: "BDT" });
    emit(purchase);
    stop();
    const names = fbqCalls.filter((c) => c[0] === "trackSingle").map((c) => c[2]);
    expect(names).toEqual(["PageView", "ViewContent", "AddToCart", "Purchase"]);
    expect(fbqCalls.find((c) => c[2] === "Purchase")![4]).toEqual({ eventID: "Purchase.ORD-MKT-1" });
    expect(win.dataLayer).toBeUndefined();
    expect(win.gtag).toBeUndefined();
    expect(win.ttq).toBeUndefined();
  });

  it("Google and TikTok disabled (no IDs configured): nothing is loaded or sent", async () => {
    const { start, emit } = await load();
    const stop = start({}, page, products);
    emit(purchase);
    stop();
    expect(fbqCalls).toHaveLength(0);
    expect(win.dataLayer).toBeUndefined();
    expect(win.ttq).toBeUndefined();
  });

  it("GA4: one page_view (automatic page views off), ecommerce events mapped, purchase once with the order ref", async () => {
    const { start, emit } = await load();
    const stop = start({ ga4MeasurementId: GA4 }, page, products);
    start({ ga4MeasurementId: GA4 }, page, products)(); // remount: no second page_view
    emit({ type: "add_to_cart", line, name: "Premium Cotton Shirt", currency: "BDT" });
    emit({ type: "initiate_checkout", lines: [line], value: 2580, currency: "BDT" });
    emit(purchase);
    emit(purchase); // retried request, same order
    stop();
    expect(gtagConfigs()).toEqual([["config", GA4, { send_page_view: false }]]);
    const ev = gtagEvents();
    expect(ev.map((e) => e.name)).toEqual(["page_view", "view_item_list", "add_to_cart", "begin_checkout", "purchase"]);
    expect(ev.every((e) => e.params.send_to === GA4)).toBe(true);
    expect(ev.find((e) => e.name === "add_to_cart")!.params).toMatchObject({
      currency: "BDT",
      value: 2580,
      items: [{ item_id: line.id, quantity: 2, price: 1290, item_name: "Premium Cotton Shirt" }],
    });
    expect(ev.find((e) => e.name === "purchase")!.params).toMatchObject({ transaction_id: "ORD-MKT-1", value: 2660, currency: "BDT" });
    expect(fbqCalls).toHaveLength(0);
  });

  it("Google Ads: purchase conversion only with a conversion label, with the order ref as transaction id", async () => {
    let { start, emit } = await load();
    let stop = start({ googleAds: ADS }, page, products);
    emit(purchase);
    stop();
    const conv = gtagEvents().filter((e) => e.name === "conversion");
    expect(conv).toHaveLength(1);
    expect(conv[0]!.params).toEqual({ value: 2660, currency: "BDT", transaction_id: "ORD-MKT-1", send_to: `${ADS.id}/${ADS.purchaseLabel}` });
    // Ads-only: GA4 ecommerce events are not sent anywhere.
    expect(gtagEvents().find((e) => e.name === "purchase")).toBeUndefined();

    installBrowser();
    ({ start, emit } = await load());
    stop = start({ googleAds: { id: ADS.id } }, page, products);
    emit({ ...purchase, orderRef: "ORD-MKT-2" });
    stop();
    expect(gtagEvents().filter((e) => e.name === "conversion")).toHaveLength(0);
  });

  it("TikTok: page() once, events to this pixel only, PlaceAnOrder once per order with a deterministic event_id", async () => {
    const { start, emit } = await load();
    const stop = start({ tiktokPixelId: TT }, page, products);
    start({ tiktokPixelId: TT }, page, products)();
    emit({ type: "add_to_cart", line, name: "Premium Cotton Shirt", currency: "BDT" });
    emit(purchase);
    emit(purchase);
    emit({ ...purchase, orderRef: "" }); // no server order → nothing
    stop();
    const calls = ttqCalls();
    expect(calls.filter((c) => c[0] === "page")).toHaveLength(1);
    const tracks = calls.filter((c) => c[0] === "track");
    expect(tracks.map((c) => c[1])).toEqual(["ViewContent", "AddToCart", "PlaceAnOrder"]);
    const place = tracks.find((c) => c[1] === "PlaceAnOrder")!;
    expect(place[2]).toMatchObject({ value: 2660, currency: "BDT", contents: [{ content_id: line.id, quantity: 2, price: 1290, content_type: "product" }] });
    expect(place[3]).toEqual({ event_id: "Purchase.ORD-MKT-1" });
  });

  it("all three together: each provider gets one Purchase; none re-sends it after a reload in the same session", async () => {
    let { start, emit } = await load();
    let stop = start({ metaPixelId: PIXEL, ga4MeasurementId: GA4, googleAds: ADS, tiktokPixelId: TT }, page, products);
    emit(purchase);
    stop();
    const store = win.sessionStorage;
    // Reload: new module instance, same browser session storage.
    ({ start, emit } = await load());
    Object.assign(win, { sessionStorage: store });
    stop = start({ metaPixelId: PIXEL, ga4MeasurementId: GA4, googleAds: ADS, tiktokPixelId: TT }, page, products);
    emit(purchase);
    stop();
    expect(fbqCalls.filter((c) => c[2] === "Purchase")).toHaveLength(1);
    expect(gtagEvents().filter((e) => e.name === "purchase")).toHaveLength(1);
    expect(gtagEvents().filter((e) => e.name === "conversion")).toHaveLength(1);
    expect(ttqCalls().filter((c) => c[1] === "PlaceAnOrder")).toHaveLength(1);
  });

  it("no personal data in any provider payload; nothing runs inside a frame", async () => {
    const { start, emit } = await load();
    const stop = start({ metaPixelId: PIXEL, ga4MeasurementId: GA4, googleAds: ADS, tiktokPixelId: TT }, page, products);
    emit({ type: "add_to_cart", line, name: "Premium Cotton Shirt", currency: "BDT" });
    emit({ type: "initiate_checkout", lines: [line], value: 2580, currency: "BDT" });
    emit(purchase);
    stop();
    const all = JSON.stringify([fbqCalls, gtagEvents(), ttqCalls()]);
    for (const pii of ["রহিম", "01712345678", "ধানমন্ডি", "@", "phone", "address", "email", "customer"]) expect(all).not.toContain(pii);

    installBrowser();
    win.top = {};
    const again = await load();
    again.start({ ga4MeasurementId: GA4, tiktokPixelId: TT }, page, products)();
    expect(win.dataLayer).toBeUndefined();
    expect(win.ttq).toBeUndefined();
  });
});
