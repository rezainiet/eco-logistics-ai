"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Receipt } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { formatBDT } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL } from "@/lib/marketing/labels";
import type { PeriodValue } from "./period";

/**
 * Each delivered order's profit (and each returned parcel's courier cost)
 * in the period — the rows the P&L is made of. Unknown costs stay unknown.
 */
export function OrderProfitTable({ period }: { period: PeriodValue }) {
  const [missingOnly, setMissingOnly] = useState(false);
  const q = trpc.finance.orderProfit.useInfiniteQuery(
    { period, missingOnly, limit: 50 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, initialCursor: null },
  );
  const rows = (q.data?.pages ?? []).flatMap((p) => p.items);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-fg-subtle">Delivered orders (revenue − product cost − courier fee) and returned parcels (courier fee).</p>
        <label className="flex items-center gap-2 text-xs text-fg-subtle">
          <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} /> Only orders with missing costs
        </label>
      </div>
      {q.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-fg-subtle">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : q.isError && rows.length === 0 ? (
        <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">Could not load: {q.error.message}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title={missingOnly ? "No missing costs" : "No delivered or returned orders in this period"}
          description={missingOnly ? "Every delivered and returned order in this period has its costs recorded." : "Orders appear here once they are delivered or returned."}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-stroke/10 bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-stroke/8 text-left text-2xs uppercase tracking-wide text-fg-faint">
              <tr>
                <th className="px-4 py-3 font-medium">Order</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Channel</th>
                <th className="px-4 py-3 text-right font-medium">Revenue</th>
                <th className="px-4 py-3 text-right font-medium">Product cost</th>
                <th className="px-4 py-3 text-right font-medium">Courier</th>
                <th className="px-4 py-3 text-right font-medium">Profit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stroke/8">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5">
                    <Link href={`/dashboard/orders?focus=${r.id}`} className="font-medium hover:underline">
                      {r.orderNumber}
                    </Link>
                    <div className="text-2xs text-fg-faint">
                      {r.status === "rto" ? "Returned" : "Delivered"} · {new Date(r.at).toLocaleDateString()}
                    </div>
                  </td>
                  <td className="hidden px-4 py-2.5 text-fg-subtle md:table-cell">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatBDT(r.revenue)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {r.productCost === null ? <span className="text-warning">not recorded</span> : formatBDT(r.productCost)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {r.courierFee === null ? <span className="text-warning">not recorded</span> : formatBDT(r.courierFee)}
                  </td>
                  <td className={cn("px-4 py-2.5 text-right font-medium tabular-nums", r.profit !== null && r.profit < 0 && "text-danger")}>
                    {r.profit === null ? <span className="font-normal text-fg-faint">—</span> : formatBDT(r.profit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage ? (
        <Button variant="outline" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
