import { type ReactElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { findElements } from "@/test-utils/element-tree";
import { type BulkActionBarViewProps, BulkActionBarView } from "./bulk-automation-bar";

const text = (n: unknown): string =>
  Array.isArray(n) ? n.map(text).join("") : typeof n === "string" || typeof n === "number" ? String(n) : isValidElement(n) ? text((n.props as { children?: unknown }).children) : "";

function props(over: Partial<BulkActionBarViewProps> = {}): BulkActionBarViewProps {
  return { count: 3, confirming: false, rejectBusy: false, onClear: vi.fn(), onReject: vi.fn(), onConfirm: vi.fn(), ...over };
}
const button = (tree: ReactElement, label: RegExp) =>
  findElements(tree, (el) => typeof el.props.onClick === "function" && label.test(text(el.props.children)))[0]!;

describe("BulkActionBarView — mobile placement (audit F-05)", () => {
  it("is a fixed bottom action bar above the nav and the bottom dock, not sticky and not a bigger z-index", () => {
    const html = renderToStaticMarkup(BulkActionBarView(props()) as ReactElement);
    // Fixed: independent of the orders page root, which starts low under the banners.
    expect(html).toMatch(/class="[^"]*\bfixed\b[^"]*\bbottom-above-bottom-dock\b/);
    expect(html).not.toMatch(/\bsticky\b/);
    expect(html).not.toMatch(/\bbottom-3\b|\bbottom-above-mobile-nav\b/);
    // In-flow spacer so the pagination above can scroll clear of it.
    expect(html).toMatch(/<div aria-hidden="true" data-bottom-bar-spacer="true"/);
    expect(html).not.toMatch(/\bz-(4\d|5\d|\[)/);
  });

  it("wraps instead of overflowing at 320px", () => {
    const html = renderToStaticMarkup(BulkActionBarView(props()) as ReactElement);
    expect(html.match(/flex-wrap/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('aria-label="Bulk actions for selected orders"');
  });
});

describe("BulkActionBarView — actions", () => {
  it("wires Clear / Reject / Confirm", () => {
    const p = props();
    const tree = BulkActionBarView(p) as ReactElement;
    (button(tree, /^Clear$/).props.onClick as () => void)();
    (button(tree, /^Reject 3$/).props.onClick as () => void)();
    (button(tree, /^Confirm 3$/).props.onClick as () => void)();
    expect(p.onClear).toHaveBeenCalledTimes(1);
    expect(p.onReject).toHaveBeenCalledTimes(1);
    expect(p.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables Reject (with a reason) while another reject is still in its window", () => {
    const tree = BulkActionBarView(props({ rejectBusy: true })) as ReactElement;
    const reject = button(tree, /^Reject 3$/);
    expect(reject.props.disabled).toBe(true);
    expect(String(reject.props.title)).toMatch(/still finishing/);
    expect(button(tree, /^Confirm 3$/).props.disabled).toBe(false);
  });

  it("disables both actions above the 200-order batch cap", () => {
    const tree = BulkActionBarView(props({ count: 201 })) as ReactElement;
    expect(button(tree, /^Reject 201$/).props.disabled).toBe(true);
    expect(button(tree, /^Confirm 201$/).props.disabled).toBe(true);
  });
});
