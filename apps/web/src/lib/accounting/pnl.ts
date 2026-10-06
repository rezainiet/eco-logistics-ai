/**
 * Accounting presentation helpers. Every number comes from the API
 * (apps/api/src/lib/finance/report.ts); these only arrange and word them.
 */

export interface PnlSummaryLike {
  revenue: { realized: number };
  refunds: number;
  netRevenue: number;
  productCost: { total: number; ordersMissingCost: number };
  courierCost: { total: number; ordersMissingFee: number; fromReturned: number };
  grossProfit: number;
  advertising: number;
  marketing: number;
  office: number;
  software: number;
  salary: number;
  otherExpenses: number;
  otherIncome: number;
  netProfit: number;
  costComplete: boolean;
}

export type PnlLine =
  | { kind: "line"; key: string; label: string; value: number; sign: "+" | "−"; note?: string; warn?: boolean }
  | { kind: "subtotal"; key: string; label: string; value: number; incomplete: boolean };

/**
 * The P&L statement, top to bottom. Zero optional lines (refunds, other
 * marketing, software, other income) are left out to keep it short; a
 * subtotal is marked incomplete when a delivered/returned order has no
 * recorded product cost or courier fee (profit is then overstated).
 */
export function pnlLines(s: PnlSummaryLike): PnlLine[] {
  const out: PnlLine[] = [{ kind: "line", key: "revenue", label: "Revenue (delivered orders)", value: s.revenue.realized, sign: "+" }];
  if (s.refunds > 0) {
    out.push({ kind: "line", key: "refunds", label: "Customer refunds", value: s.refunds, sign: "−" });
    out.push({ kind: "subtotal", key: "netRevenue", label: "Net revenue", value: s.netRevenue, incomplete: false });
  }
  out.push({
    kind: "line",
    key: "productCost",
    label: "Product cost",
    value: s.productCost.total,
    sign: "−",
    ...(s.productCost.ordersMissingCost > 0 ? { note: `not recorded for ${s.productCost.ordersMissingCost} order(s)`, warn: true } : {}),
  });
  const courierNotes = [
    s.courierCost.fromReturned > 0 ? `incl. returned parcels` : null,
    s.courierCost.ordersMissingFee > 0 ? `not recorded for ${s.courierCost.ordersMissingFee} order(s)` : null,
  ].filter(Boolean);
  out.push({
    kind: "line",
    key: "courierCost",
    label: "Courier cost",
    value: s.courierCost.total,
    sign: "−",
    ...(courierNotes.length ? { note: courierNotes.join(" · "), warn: s.courierCost.ordersMissingFee > 0 } : {}),
  });
  out.push({ kind: "subtotal", key: "grossProfit", label: "Gross profit", value: s.grossProfit, incomplete: !s.costComplete });
  out.push({ kind: "line", key: "advertising", label: "Advertising (Meta, Google, TikTok)", value: s.advertising, sign: "−" });
  if (s.marketing > 0) out.push({ kind: "line", key: "marketing", label: "Other marketing", value: s.marketing, sign: "−" });
  out.push({ kind: "line", key: "salary", label: "Salary", value: s.salary, sign: "−" });
  out.push({ kind: "line", key: "office", label: "Office rent", value: s.office, sign: "−" });
  if (s.software > 0) out.push({ kind: "line", key: "software", label: "Software & subscriptions", value: s.software, sign: "−" });
  out.push({ kind: "line", key: "otherExpenses", label: "Other expenses", value: s.otherExpenses, sign: "−" });
  if (s.otherIncome > 0) out.push({ kind: "line", key: "otherIncome", label: "Other income", value: s.otherIncome, sign: "+" });
  out.push({ kind: "subtotal", key: "netProfit", label: "Net profit", value: s.netProfit, incomplete: !s.costComplete });
  return out;
}

/** `costCoverage` from the finance API (apps/api/src/lib/finance/report.ts, CostCoverage). */
export interface CostCoverageLike {
  eligibleOrders: number;
  coveredOrders: number;
  incompleteOrders: number;
  percentage: number | null;
  complete: boolean;
}

export type ProfitState = "complete" | "incomplete" | "no_orders";

/**
 * How a P&L profit figure may be presented. While a delivered or returned
 * order lacks a cost, the P&L leaves that cost out, so the figure is an upper
 * bound on the real profit: it is shown as "up to ৳X" with the cost coverage,
 * never as the profit itself. A period with no delivered or returned orders
 * has no coverage to speak of.
 */
export function profitPresentation(c: CostCoverageLike): {
  state: ProfitState;
  /** Put in front of the amount ("Up to ৳12,000"). */
  prefix: string;
  /** "Cost coverage 72%" — only when incomplete. */
  coverage: string | null;
  /** "18 of 25 orders fully costed" / "No delivered or returned orders in this period". */
  detail: string | null;
} {
  if (c.eligibleOrders === 0) {
    return { state: "no_orders", prefix: "", coverage: null, detail: "No delivered or returned orders in this period" };
  }
  if (c.complete) return { state: "complete", prefix: "", coverage: null, detail: null };
  return {
    state: "incomplete",
    prefix: "Up to ",
    coverage: `Cost coverage ${c.percentage ?? 0}%`,
    detail: `${c.coveredOrders} of ${c.eligibleOrders} order${c.eligibleOrders === 1 ? "" : "s"} fully costed`,
  };
}

/** First and last day of a "YYYY-MM" month (calendar days, Bangladesh). */
export function monthRange(month: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

const FIELD_LABEL: Record<string, string> = {
  category: "category",
  amount: "amount",
  occurredOn: "date",
  description: "description",
  reference: "reference",
};

/** "amount 500 → 650, date 2026-10-01 → 2026-10-02" */
export function changeText(changes: Array<{ field: string; from: unknown; to: unknown }>): string {
  return changes
    .filter((c) => FIELD_LABEL[c.field])
    .map((c) => `${FIELD_LABEL[c.field]} ${c.from === "" || c.from === null ? "—" : String(c.from)} → ${c.to === "" || c.to === null ? "—" : String(c.to)}`)
    .join(", ");
}
