import { describe, expect, it } from "vitest";
import { changeText, monthRange, pnlLines, profitPresentation, type PnlSummaryLike } from "./pnl";

const base: PnlSummaryLike = {
  revenue: { realized: 10_000 },
  refunds: 0,
  netRevenue: 10_000,
  productCost: { total: 4_000, ordersMissingCost: 0 },
  courierCost: { total: 600, ordersMissingFee: 0, fromReturned: 0 },
  grossProfit: 5_400,
  advertising: 1_000,
  marketing: 0,
  office: 500,
  software: 0,
  salary: 2_000,
  otherExpenses: 0,
  otherIncome: 0,
  netProfit: 1_900,
  costComplete: true,
};

describe("P&L statement", () => {
  it("orders the statement and leaves out zero optional lines", () => {
    expect(pnlLines(base).map((l) => l.key)).toEqual([
      "revenue",
      "productCost",
      "courierCost",
      "grossProfit",
      "advertising",
      "salary",
      "office",
      "otherExpenses",
      "netProfit",
    ]);
  });

  it("shows refunds as contra-revenue with a net revenue subtotal, and optional lines when used", () => {
    const keys = pnlLines({ ...base, refunds: 300, netRevenue: 9_700, marketing: 200, software: 150, otherIncome: 50 }).map((l) => l.key);
    expect(keys.slice(0, 3)).toEqual(["revenue", "refunds", "netRevenue"]);
    expect(keys).toContain("marketing");
    expect(keys).toContain("software");
    expect(keys).toContain("otherIncome");
  });

  it("marks profit incomplete and says which cost is missing", () => {
    const lines = pnlLines({ ...base, costComplete: false, productCost: { total: 3_000, ordersMissingCost: 2 } });
    const gross = lines.find((l) => l.key === "grossProfit");
    expect(gross).toMatchObject({ kind: "subtotal", incomplete: true });
    expect(lines.find((l) => l.key === "productCost")).toMatchObject({ note: "not recorded for 2 order(s)", warn: true });
  });
});

describe("profit presentation by cost coverage", () => {
  it("shows a fully costed profit as it is", () => {
    expect(profitPresentation({ eligibleOrders: 4, coveredOrders: 4, incompleteOrders: 0, percentage: 100, complete: true })).toEqual({
      state: "complete",
      prefix: "",
      coverage: null,
      detail: null,
    });
  });

  it("shows a partly costed profit as an upper bound with its coverage", () => {
    expect(profitPresentation({ eligibleOrders: 4, coveredOrders: 3, incompleteOrders: 1, percentage: 75, complete: false })).toEqual({
      state: "incomplete",
      prefix: "Up to ",
      coverage: "Cost coverage 75%",
      detail: "3 of 4 orders fully costed",
    });
    expect(profitPresentation({ eligibleOrders: 1, coveredOrders: 0, incompleteOrders: 1, percentage: 0, complete: false }).detail).toBe(
      "0 of 1 order fully costed",
    );
  });

  it("has no coverage without delivered or returned orders", () => {
    const p = profitPresentation({ eligibleOrders: 0, coveredOrders: 0, incompleteOrders: 0, percentage: null, complete: true });
    expect(p.state).toBe("no_orders");
    expect(p.prefix).toBe("");
    expect(p.coverage).toBeNull();
    expect(p.detail).toBe("No delivered or returned orders in this period");
  });
});

describe("month range", () => {
  it("returns the first and last day of the month", () => {
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(monthRange("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(monthRange("2026-13")).toBeNull();
    expect(monthRange("junk")).toBeNull();
  });
});

describe("entry history", () => {
  it("words edits plainly", () => {
    expect(changeText([{ field: "amount", from: 500, to: 650 }, { field: "description", from: "", to: "June rent" }, { field: "status", from: "active", to: "void" }])).toBe(
      "amount 500 → 650, description — → June rent",
    );
  });
});
