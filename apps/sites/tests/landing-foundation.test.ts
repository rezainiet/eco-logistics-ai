import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { belowTheFold, motionAllowed, startReveal } from "../src/lib/motion";
import { CART_BUTTON_CLASS, CART_BUTTON_CLASS_WITH_ACTION_BAR, cartButtonClass } from "../src/lib/commerce/cart-button";

/**
 * Sites side of the template foundation: the scroll-reveal script, the
 * floating cart's offset above the mobile order bar, and the CSP.
 */

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// ── Minimal DOM fakes (the suite runs in Node) ──────────────────────────────

type Handler = (e: unknown) => void;

class FakeEl {
  attrs = new Map<string, string>();
  handlers = new Map<string, Handler>();
  constructor(
    public top: number,
    attrs: Record<string, string> = {},
    public parent: FakeEl | null = null,
  ) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }
  getAttribute(n: string) {
    return this.attrs.has(n) ? this.attrs.get(n)! : null;
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, v);
  }
  getBoundingClientRect() {
    return { top: this.top };
  }
  closest(sel: string): FakeEl | null {
    // Only the selector the script uses: [data-lp-reveal="pending"].
    for (let el: FakeEl | null = this; el; el = el.parent) if (el.getAttribute("data-lp-reveal") === "pending") return el;
    return sel ? null : null;
  }
  addEventListener(type: string, h: Handler) {
    this.handlers.set(type, h);
  }
  removeEventListener(type: string) {
    this.handlers.delete(type);
  }
}

function setup(opts: { motion?: string | null; reduced?: boolean; io?: boolean; tops?: number[]; viewport?: number }) {
  const root = new FakeEl(0, { "data-landing-root": "", ...(opts.motion ? { "data-lp-motion": opts.motion } : {}) });
  const sections = (opts.tops ?? [0, 500, 900, 1600, 2400]).map((top) => new FakeEl(top, { "data-lp-reveal": "" }, root));
  (root as unknown as { querySelectorAll: () => FakeEl[] }).querySelectorAll = () => sections;
  const observed = new Set<FakeEl>();
  let callback: ((entries: Array<{ isIntersecting: boolean; target: FakeEl }>) => void) | null = null;
  let disconnected = false;
  class IO {
    constructor(cb: typeof callback) {
      callback = cb;
    }
    observe(el: FakeEl) {
      observed.add(el);
    }
    unobserve(el: FakeEl) {
      observed.delete(el);
    }
    disconnect() {
      disconnected = true;
      observed.clear();
    }
  }
  const mq = { matches: !!opts.reduced, handler: null as Handler | null, addEventListener: (_: string, h: Handler) => (mq.handler = h), removeEventListener: () => (mq.handler = null) };
  const winHandlers = new Map<string, Handler>();
  const win = {
    innerHeight: opts.viewport ?? 800,
    matchMedia: () => mq,
    ...(opts.io === false ? {} : { IntersectionObserver: IO }),
    addEventListener: (t: string, h: Handler) => winHandlers.set(t, h),
    removeEventListener: (t: string) => winHandlers.delete(t),
  };
  const doc = { querySelector: () => (root.getAttribute("data-lp-motion") ? root : null) };
  const stop = startReveal(doc as unknown as Document, win as unknown as Window & typeof globalThis);
  const states = () => sections.map((s) => s.getAttribute("data-lp-reveal"));
  const intersect = (i: number) => callback?.([{ isIntersecting: true, target: sections[i]! }]);
  return { root, sections, observed, states, intersect, stop, mq, winHandlers, isDisconnected: () => disconnected };
}

describe("scroll reveal", () => {
  it("runs only for subtle / lively, without reduced motion, where IntersectionObserver exists", () => {
    expect(motionAllowed({ mode: "subtle", reducedMotion: false, hasObserver: true })).toBe(true);
    expect(motionAllowed({ mode: "lively", reducedMotion: false, hasObserver: true })).toBe(true);
    expect(motionAllowed({ mode: "none", reducedMotion: false, hasObserver: true })).toBe(false);
    expect(motionAllowed({ mode: null, reducedMotion: false, hasObserver: true })).toBe(false);
    expect(motionAllowed({ mode: "subtle", reducedMotion: true, hasObserver: true })).toBe(false);
    expect(motionAllowed({ mode: "subtle", reducedMotion: false, hasObserver: false })).toBe(false);
  });

  it("holds back only sections that start below the fold — nothing on screen ever blinks", () => {
    const at = (top: number) => ({ getBoundingClientRect: () => ({ top }) });
    const list = [at(-300), at(0), at(799), at(800), at(2000)];
    expect(belowTheFold(list, 800)).toEqual([list[3], list[4]]);
  });

  it("subtle: below-fold sections wait, then show as they scroll in", () => {
    const t = setup({ motion: "subtle" });
    expect(t.states()).toEqual(["", "", "pending", "pending", "pending"]);
    t.intersect(2);
    expect(t.states()).toEqual(["", "", "shown", "pending", "pending"]);
    expect(t.observed.has(t.sections[2]!)).toBe(false);
  });

  it("lively uses the same mechanism (only the CSS distance and duration differ)", () => {
    expect(setup({ motion: "lively" }).states()).toEqual(["", "", "pending", "pending", "pending"]);
  });

  it("does nothing at all with no motion setting, reduced motion, or no IntersectionObserver", () => {
    for (const t of [setup({ motion: null }), setup({ motion: "subtle", reduced: true }), setup({ motion: "subtle", io: false })]) {
      expect(t.states()).toEqual(["", "", "", "", ""]);
      expect(t.observed.size).toBe(0);
    }
  });

  it("can never leave content hidden: focus, print, reduced motion and unmount reveal it", () => {
    const focus = setup({ motion: "subtle" });
    const child = new FakeEl(0, {}, focus.sections[3]!);
    focus.root.handlers.get("focusin")!({ target: child });
    expect(focus.states()[3]).toBe("shown");

    const print = setup({ motion: "subtle" });
    print.winHandlers.get("beforeprint")!({});
    expect(print.states()).toEqual(["", "", "shown", "shown", "shown"]);
    expect(print.isDisconnected()).toBe(true);

    const reduce = setup({ motion: "lively" });
    reduce.mq.handler!({ matches: true });
    expect(reduce.states()).toEqual(["", "", "shown", "shown", "shown"]);

    const unmount = setup({ motion: "subtle" });
    unmount.stop();
    expect(unmount.states()).toEqual(["", "", "shown", "shown", "shown"]);
    expect(unmount.root.handlers.size).toBe(0);
    expect(unmount.winHandlers.size).toBe(0);
  });

  it("the CSS hides only script-marked pending sections, with opacity and transform, and never under reduced motion", () => {
    const css = src("../src/app/globals.css");
    // The rules after the explanatory comment.
    const motion = css.slice(css.indexOf("*/", css.indexOf("Landing-page scroll reveal")) + 2);
    const media = motion.slice(motion.indexOf("@media (prefers-reduced-motion: no-preference)"));
    expect(media).toContain('[data-lp-motion] [data-lp-reveal="pending"] {\n    opacity: 0;\n    transform: translate3d(0, var(--lp-reveal-distance), 0);\n  }');
    // Outside the no-preference media query nothing hides or moves anything.
    const outside = motion.slice(0, motion.indexOf("@media"));
    expect(outside).not.toMatch(/opacity|transform|display|visibility/);
    expect(motion).not.toMatch(/data-lp-reveal=""\]|\[data-lp-reveal\]\s*\{|animation:|@keyframes|infinite/);
  });
});

describe("floating cart button", () => {
  it("is exactly the original button when the page has no mobile order bar", () => {
    expect(cartButtonClass(false)).toBe(CART_BUTTON_CLASS);
    expect(CART_BUTTON_CLASS).toBe(
      "fixed bottom-4 right-4 z-40 inline-flex min-h-14 items-center gap-2 rounded-full bg-[var(--lp-primary)] px-5 py-3 font-semibold text-[color:var(--lp-on-primary)] shadow-lg ring-1 ring-black/10 sm:bottom-6 sm:right-6",
    );
  });

  it("sits above the order bar on phones and returns to its corner from 768px, where the bar is hidden", () => {
    const cls = cartButtonClass(true).split(" ");
    expect(cls).toContain("bottom-[calc(5rem+env(safe-area-inset-bottom,0px))]");
    expect(cls).toContain("md:bottom-6");
    expect(cls).not.toContain("sm:bottom-6"); // 640–767px still shows the bar
    expect(cls).not.toContain("bottom-4");
    // Same look otherwise.
    const rest = (c: string) => c.split(" ").filter((x) => !/bottom/.test(x)).sort();
    expect(rest(CART_BUTTON_CLASS_WITH_ACTION_BAR)).toEqual(rest(CART_BUTTON_CLASS));
  });

  it("is wired from the page's spec", () => {
    const page = src("../src/app/lp/[label]/[[...locale]]/page.tsx");
    const commerce = src("../src/app/lp/[label]/[[...locale]]/landing-commerce.tsx");
    expect(page).toContain("actionBar={hasMobileActionBar(r.spec)}");
    expect(commerce).toContain("className={cartButtonClass(actionBar)}");
    expect(commerce).toContain("actionBar = false");
  });
});

describe("content security policy", () => {
  it("is unchanged: no new script or style allowances", () => {
    const cfg = src("../next.config.mjs");
    expect(cfg).toContain("`script-src 'self' 'unsafe-inline'${isProd ? \"\" : \" 'unsafe-eval'\"}${scripts}`");
    expect(cfg).toContain("\"style-src 'self' 'unsafe-inline'\"");
  });

  it("the motion code needs nothing beyond bundled 'self' scripts", () => {
    for (const file of ["../src/lib/motion.ts", "../src/lib/landing-motion.tsx"]) {
      const code = src(file);
      expect(code, file).not.toMatch(/\beval\(|new Function|innerHTML|dangerouslySetInnerHTML|<script|document\.write|import\(["']http/);
    }
  });

  it("mounts the script only where motion can run: published pages with motion on, plain previews", () => {
    const page = src("../src/app/lp/[label]/[[...locale]]/page.tsx");
    const frame = src("../src/app/preview-frame/preview-frame.tsx");
    expect(page).toContain('{themeMotion(theme) !== "none" ? <LandingMotion /> : null}');
    expect(frame).toContain("{editing ? null : <LandingMotion watch={msg} />}");
  });
});
