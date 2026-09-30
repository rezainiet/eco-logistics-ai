import { describe, expect, it, vi } from "vitest";
import { type RevealElement, VALUE_CONTROL_SELECTOR, revealField } from "./reveal-field";

/**
 * A tiny fake DOM — just enough selector support for the stable attributes
 * the editor renders (data-section-id, data-field-path, aria-invalid) and the
 * value-control selector. No layout, no class names.
 */
class El implements RevealElement {
  open?: boolean;
  focused = false;
  scrolled: ScrollIntoViewOptions | undefined;
  classes = new Set<string>();
  classList = { add: (...t: string[]) => t.forEach((c) => this.classes.add(c)), remove: (...t: string[]) => t.forEach((c) => this.classes.delete(c)) };
  constructor(public tag: string, public attrs: Record<string, string> = {}, public children: El[] = []) {
    if (tag === "details") this.open = false;
  }
  focus = vi.fn(() => {
    this.focused = true;
  });
  scrollIntoView(arg?: ScrollIntoViewOptions) {
    this.scrolled = arg;
  }
  *all(): Generator<El> {
    for (const c of this.children) {
      yield c;
      yield* c.all();
    }
  }
  querySelector(selectors: string): El | null {
    for (const sel of selectors.split(",").map((s) => s.trim())) {
      for (const el of this.all()) if (el.matches(sel)) return el;
    }
    return null;
  }
  matches(sel: string): boolean {
    const tag = /^[a-z]+/.exec(sel)?.[0];
    if (tag && this.tag !== tag) return false;
    for (const [, k, v] of sel.matchAll(/(?<!:not\()\[([a-z-]+)="([^"]*)"\]/g)) if (this.attrs[k!] !== v) return false;
    for (const [, k, v] of sel.matchAll(/:not\(\[([a-z-]+)=([a-z]+)\]\)/g)) if (this.attrs[k!] === v) return false;
    return true;
  }
}

function editor() {
  const heroInput = new El("input", { type: "text" });
  const ctaText = new El("input", { type: "text", "aria-label": "Button — button text" });
  const ctaAction = new El("select", { "aria-invalid": "true" });
  const itemName = new El("input", { type: "text", "aria-invalid": "true" });
  const hero = new El("details", { "data-section-id": "hero" }, [new El("div", { "data-field-path": "hero.headline" }, [heroInput])]);
  const order = new El("details", { "data-section-id": "order" }, [new El("div", { "data-field-path": "order.cta" }, [ctaText, ctaAction])]);
  const cats = new El("details", { "data-section-id": "categories" }, [
    new El("div", { "data-field-path": "categories.items" }, [
      new El("div", { "data-field-path": "categories.items.1" }, [new El("div", { "data-field-path": "categories.items.1.name" }, [itemName])]),
    ]),
  ]);
  const root = new El("div", {}, [hero, order, cats]);
  return { root, hero, order, cats, heroInput, ctaText, ctaAction, itemName };
}

describe("revealField — 'Fix missing fields' lands on the right control", () => {
  it("opens the collapsed section, centres the field and focuses its invalid control", () => {
    const d = editor();
    expect(d.order.open).toBe(false);
    const r = revealField(d.root, "order.cta", { focus: true });
    expect(d.order.open).toBe(true);
    expect(d.hero.open).toBe(false); // only the target section
    expect((r.anchor as El | null)?.scrolled).toEqual({ block: "center", behavior: "smooth" });
    expect(r.focused).toBe(d.ctaAction); // the empty action, not the filled button text
    expect(d.ctaAction.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(d.ctaText.focused).toBe(false);
  });

  it("falls back to the first value control when nothing is marked invalid", () => {
    const d = editor();
    const r = revealField(d.root, "hero.headline", { focus: true });
    expect(r.focused).toBe(d.heroInput);
  });

  it("reaches a field inside a repeater item", () => {
    const d = editor();
    const r = revealField(d.root, "categories.items.1.name", { focus: true });
    expect(d.cats.open).toBe(true);
    expect(r.focused).toBe(d.itemName);
  });

  it("does not steal focus when focus is not requested (touch, preview click)", () => {
    const d = editor();
    const r = revealField(d.root, "order.cta", { focus: false });
    expect(d.order.open).toBe(true);
    expect(r.focused).toBeNull();
    expect(d.ctaAction.focused).toBe(false);
  });

  it("flash highlight is added and removed", () => {
    const d = editor();
    const timers: Array<() => void> = [];
    const r = revealField(d.root, "hero.headline", { focus: false, flash: ["ring-2"], schedule: (fn) => timers.push(fn) });
    expect((r.anchor as El).classes.has("ring-2")).toBe(true);
    timers.forEach((t) => t());
    expect((r.anchor as El).classes.has("ring-2")).toBe(false);
  });

  it("uses the shared value-control selector (no file/hidden/checkbox inputs)", () => {
    expect(VALUE_CONTROL_SELECTOR).toBe("input:not([type=file]):not([type=hidden]):not([type=checkbox]), textarea, select");
  });
});
