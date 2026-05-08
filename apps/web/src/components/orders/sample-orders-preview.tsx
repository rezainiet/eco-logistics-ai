"use client";

import { Sparkles } from "lucide-react";

/**
 * "Skeleton-of-real-data" preview rendered in the orders empty state.
 *
 * Replaces a blank table below the EmptyState CTA with a faded sample
 * of what an order looks like once Cordon is wired up — risk-scored,
 * phone-verified, courier-ready. The preview annotates the columns
 * inline so a brand-new merchant understands what the dashboard will
 * actually do for them WITHOUT needing real traffic to learn the UI.
 *
 * Pure visual; no tRPC, no state, no interactivity. Hidden behind the
 * caller's "no real data + no active filters" guard so it never shows
 * over actual orders.
 */
export function SampleOrdersPreview() {
  return (
    <div className="px-4 pb-6">
      <div className="mb-3 flex items-center gap-2 text-2xs uppercase tracking-[0.12em] text-fg-faint">
        <Sparkles className="h-3 w-3 text-brand" aria-hidden />
        Preview · what your orders will look like once they start flowing
      </div>
      <div className="overflow-hidden rounded-xl border border-dashed border-stroke/30 bg-surface-raised/30">
        <table className="w-full text-sm">
          <thead className="text-2xs uppercase tracking-[0.1em] text-fg-faint">
            <tr className="border-b border-stroke/15">
              <th className="px-4 py-2.5 text-left font-medium">Order</th>
              <th className="px-4 py-2.5 text-left font-medium">Customer</th>
              <th className="px-4 py-2.5 text-left font-medium">Risk</th>
              <th className="px-4 py-2.5 text-left font-medium">Status</th>
              <th className="px-4 py-2.5 text-right font-medium">COD</th>
            </tr>
          </thead>
          <tbody className="text-fg-muted/80">
            <SampleRow
              order="#1042"
              customer="Rashid · 01711-…"
              risk={{ tone: "high", label: "High · phone-on-blocklist" }}
              status="In review"
              cod="৳ 2,450"
            />
            <SampleRow
              order="#1041"
              customer="Mahin · 01882-…"
              risk={{ tone: "medium", label: "Medium · new address" }}
              status="Confirmation call"
              cod="৳ 1,200"
            />
            <SampleRow
              order="#1040"
              customer="Sara · 01515-…"
              risk={{ tone: "low", label: "Low" }}
              status="Booked · Pathao"
              cod="৳ 980"
            />
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-2xs text-fg-faint">
        Cordon scores every incoming order, holds high-risk ones for review,
        and books low-risk ones automatically. The numbers above are
        illustrative — yours show up here the moment your store sends its
        first webhook.
      </p>
    </div>
  );
}

function SampleRow({
  order,
  customer,
  risk,
  status,
  cod,
}: {
  order: string;
  customer: string;
  risk: { tone: "high" | "medium" | "low"; label: string };
  status: string;
  cod: string;
}) {
  const riskCls =
    risk.tone === "high"
      ? "border-danger-border bg-danger-subtle text-danger"
      : risk.tone === "medium"
        ? "border-warning-border bg-warning-subtle text-warning"
        : "border-stroke/30 bg-surface-overlay/40 text-fg-muted";
  return (
    <tr className="border-b border-stroke/8 last:border-0 opacity-70 hover:opacity-90">
      <td className="px-4 py-2.5 font-mono text-xs text-fg-muted">{order}</td>
      <td className="px-4 py-2.5">{customer}</td>
      <td className="px-4 py-2.5">
        <span
          className={
            "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium " +
            riskCls
          }
        >
          {risk.label}
        </span>
      </td>
      <td className="px-4 py-2.5 text-2xs">{status}</td>
      <td className="px-4 py-2.5 text-right font-mono text-xs text-fg-muted">
        {cod}
      </td>
    </tr>
  );
}
