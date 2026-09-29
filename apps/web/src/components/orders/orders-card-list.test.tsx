import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { byAriaLabel, findElements } from "@/test-utils/element-tree";
import { OrdersCardList, type OrderCardRow } from "./orders-card-list";

function row(over: Partial<OrderCardRow> = {}): OrderCardRow {
  return {
    id: "ord_1",
    orderNumber: "ORD-TEST-1",
    status: "pending",
    cod: 930,
    customer: { name: "Test Customer", phone: "+8801300000000", district: "Dhaka" },
    riskScore: 10,
    riskLevel: "low",
    reviewStatus: "not_required",
    createdAt: "2026-09-29T08:00:00.000Z",
    ...over,
  };
}

function props(over: Partial<Parameters<typeof OrdersCardList>[0]> = {}) {
  return {
    rows: [row(), row({ id: "ord_2", orderNumber: "ORD-TEST-2", status: "cancelled" })],
    isLoading: false,
    selected: new Set<string>(),
    onToggleRow: vi.fn(),
    onOpenOrder: vi.fn(),
    onResetFilters: vi.fn(),
    ...over,
  };
}

describe("OrdersCardList (mobile) — open order detail", () => {
  it("renders a visible, labelled View details button on every card", () => {
    const html = renderToStaticMarkup(<OrdersCardList {...props()} />);
    expect(html).toContain('aria-label="View order ORD-TEST-1"');
    expect(html).toContain('aria-label="View order ORD-TEST-2"');
    // Visible text, not an icon-only control.
    expect(html.match(/>View details</g)?.length).toBe(2);
    // A real <button type="button"> — keyboard focusable and never submits a form.
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-label="View order ORD-TEST-1"/);
  });

  it("opens the detail drawer for that order (terminal orders too)", () => {
    const p = props();
    const tree = OrdersCardList(p);
    const [view2] = findElements(tree, byAriaLabel("View order ORD-TEST-2"));
    expect(view2).toBeDefined();
    (view2!.props.onClick as () => void)();
    expect(p.onOpenOrder).toHaveBeenCalledTimes(1);
    expect(p.onOpenOrder).toHaveBeenCalledWith("ord_2");
    // Opening detail must not touch bulk selection.
    expect(p.onToggleRow).not.toHaveBeenCalled();
  });

  it("keeps the selection checkbox independent of the detail button", () => {
    const p = props();
    const tree = OrdersCardList(p);
    const [box] = findElements(tree, byAriaLabel("Select order ORD-TEST-1"));
    (box!.props.onChange as () => void)();
    expect(p.onToggleRow).toHaveBeenCalledWith("ord_1");
    expect(p.onOpenOrder).not.toHaveBeenCalled();
  });

  it("renders nothing openable while loading or when empty", () => {
    expect(renderToStaticMarkup(<OrdersCardList {...props({ isLoading: true })} />)).not.toContain("View order");
    expect(renderToStaticMarkup(<OrdersCardList {...props({ rows: [] })} />)).not.toContain("View order");
  });
});
