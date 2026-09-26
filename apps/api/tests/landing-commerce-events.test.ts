import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Commerce → Meta Pixel events of the public landing page
 * (apps/sites/src/lib/analytics). apps/sites has no test runner, so the
 * browser globals the layer touches are stubbed here with Node's own
 * EventTarget/CustomEvent, and `fbq` is a recorder: nothing is loaded
 * from or sent to Meta.
 *
 * The modules are imported by path at runtime (apps/sites is type-checked
 * by its own tsconfig, not the API's).
 */

const SITES_ANALYTICS = fileURLToPath(new URL("../../sites/src/lib/analytics/", import.meta.url));

type Call = unknown[];
let calls: Call[];

function installBrowser() {
  calls = [];
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  const store = new Map<string, string>();
  const fbq = (...args: Call) => {
    calls.push(args);
  };
  Object.assign(win, {
    fbq,
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
  return { win, store };
}

async function load() {
  vi.resetModules();
  const analytics = await import(/* @vite-ignore */ `${SITES_ANALYTICS}landing-analytics.ts`);
  const events = await import(/* @vite-ignore */ `${SITES_ANALYTICS}commerce-events.ts`);
  return { start: analytics.startLandingAnalytics, emit: events.emitCommerceEvent };
}

const PIXEL = "123456789012345";
const page = { slug: "bazar", template: "bd-modern-shop", locale: "bn", title: "বাজার" };
const tracked = (name: string) => calls.filter((c) => c[0] === "trackSingle" && c[2] === name);
const line = { id: "6ab73cca06587711398245c7", quantity: 2, price: 1290 };

describe("landing commerce → Meta events", () => {
  beforeEach(() => {
    installBrowser();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends AddToCart and InitiateCheckout to this page's pixel, without personal data", async () => {
    const { start, emit } = await load();
    const stop = start({ metaPixelId: PIXEL }, page, {});
    emit({ type: "add_to_cart", line: { ...line, quantity: 1 }, name: "Premium Cotton Shirt", currency: "BDT" });
    emit({ type: "initiate_checkout", lines: [line], value: 2580, currency: "BDT" });

    const [add] = tracked("AddToCart");
    expect(add![1]).toBe(PIXEL);
    expect(add![3]).toMatchObject({
      content_ids: [line.id],
      content_type: "product",
      contents: [{ id: line.id, quantity: 1, item_price: 1290 }],
      num_items: 1,
      value: 1290,
      currency: "BDT",
      lp_slug: "bazar",
    });
    const [checkout] = tracked("InitiateCheckout");
    expect(checkout![3]).toMatchObject({ content_ids: [line.id], num_items: 2, value: 2580, currency: "BDT" });
    for (const c of calls) {
      expect(JSON.stringify(c)).not.toMatch(/phone|address|email|\+880|01712345678/i);
    }
    stop();
  });

  it("Purchase: only for a server-accepted order, once per order, deterministic event id, COD", async () => {
    const { start, emit } = await load();
    start({ metaPixelId: PIXEL }, page, {});
    const purchase = { type: "purchase" as const, orderRef: "ORD-TEST-1", lines: [line], value: 2700, currency: "BDT" };
    emit(purchase);
    emit(purchase); // retried request returning the same order
    emit({ ...purchase, orderRef: "" }); // no order → nothing
    const sent = tracked("Purchase");
    expect(sent).toHaveLength(1);
    expect(sent[0]![3]).toMatchObject({ value: 2700, currency: "BDT", payment_method: "cod", num_items: 2, content_ids: [line.id] });
    expect(sent[0]![4]).toEqual({ eventID: "Purchase.ORD-TEST-1" });

    // A different order is its own Purchase.
    emit({ ...purchase, orderRef: "ORD-TEST-2" });
    expect(tracked("Purchase")).toHaveLength(2);
  });

  it("does not re-send a Purchase after a reload in the same browser session", async () => {
    const { win } = { win: (globalThis as unknown as { window: Record<string, unknown> }).window };
    const first = await load();
    first.start({ metaPixelId: PIXEL }, page, {});
    first.emit({ type: "purchase", orderRef: "ORD-RELOAD", lines: [line], value: 2700, currency: "BDT" });
    expect(tracked("Purchase")).toHaveLength(1);

    // Fresh module state (a page reload), same sessionStorage.
    expect(win.sessionStorage).toBeDefined();
    const again = await load();
    again.start({ metaPixelId: PIXEL }, { ...page, slug: "bazar" }, {});
    again.emit({ type: "purchase", orderRef: "ORD-RELOAD", lines: [line], value: 2700, currency: "BDT" });
    expect(tracked("Purchase")).toHaveLength(1);
  });

  it("sends nothing when the layer is not started (no pixel on the page) and nothing inside a frame", async () => {
    const { emit } = await load();
    emit({ type: "add_to_cart", line, name: "x", currency: "BDT" });
    expect(calls).toHaveLength(0);

    const { start } = await load();
    const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
    w.top = {}; // embedded (e.g. editor preview frame)
    start({ metaPixelId: PIXEL }, page, {});
    emit({ type: "purchase", orderRef: "ORD-FRAME", lines: [line], value: 1, currency: "BDT" });
    expect(calls).toHaveLength(0);
  });
});
