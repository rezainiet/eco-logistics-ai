import { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { findElements } from "@/test-utils/element-tree";
import { QueueLoadMore } from "./queue-load-more";

const base = { shown: 50, total: 120, hasMore: true, loading: false, failed: false, onLoadMore: () => {} };
const html = (p: Partial<typeof base>) => renderToStaticMarkup(<QueueLoadMore {...base} {...p} />);
const text = (h: string) =>
  h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("QueueLoadMore (audit OV-2)", () => {
  it("offers Load more with progress while more pages exist", () => {
    const t = text(html({}));
    expect(t).toContain("Showing 50 of 120");
    expect(t).toContain("Load more");
  });

  it("disables the button while the next page is loading", () => {
    const h = html({ loading: true });
    expect(text(h)).toContain("Loading…");
    expect(h).toMatch(/<button[^>]*disabled/);
  });

  it("a failed next page keeps the list and offers Retry", () => {
    const t = text(html({ failed: true }));
    expect(t).toContain("Couldn't load more orders");
    expect(t).toContain("Retry");
  });

  it("says when everything is shown, with no button", () => {
    const h = html({ hasMore: false, shown: 120 });
    expect(text(h)).toBe("All 120 shown");
    expect(h).not.toContain("<button");
  });

  it("renders nothing for an empty list (the empty state covers it)", () => {
    expect(html({ shown: 0, hasMore: false })).toBe("");
  });

  it("calls onLoadMore", () => {
    const onLoadMore = vi.fn();
    const tree = QueueLoadMore({ ...base, onLoadMore }) as ReactElement;
    const btn = findElements(tree, (el) => typeof el.props.onClick === "function")[0]!;
    (btn.props.onClick as () => void)();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
