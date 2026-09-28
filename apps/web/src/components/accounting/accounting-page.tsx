"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Plus, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { formatBDT } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { EntriesTable } from "./entries-table";
import { EntryDialog, dhakaToday } from "./entry-dialog";
import { MonthlyChart } from "./monthly-chart";
import { PeriodPicker, periodLabel, type PeriodValue } from "./period";

type Tab = "overview" | "income" | "expenses" | "reports";
const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ["overview", "Overview"],
  ["income", "Income"],
  ["expenses", "Expenses"],
  ["reports", "Reports"],
];

export function AccountingPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [period, setPeriod] = useState<PeriodValue>({ preset: "month" });
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Insights"
        title="Accounting"
        description="Revenue from delivered orders, your costs and what you really earn. All amounts in Taka (৳)."
        actions={
          tab === "overview" || tab === "reports" ? (
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> Add expense
            </Button>
          ) : null
        }
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex gap-1 rounded-lg border border-stroke/10 bg-surface p-1" role="tablist" aria-label="Accounting sections">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === key ? "bg-brand/12 text-fg" : "text-fg-subtle hover:text-fg",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {tab !== "reports" ? <PeriodPicker value={period} onChange={setPeriod} /> : null}
      </div>

      {tab === "overview" ? <Overview period={period} /> : null}
      {tab === "income" ? <EntriesTable type="income" period={period} /> : null}
      {tab === "expenses" ? <EntriesTable type="expense" period={period} /> : null}
      {tab === "reports" ? <Reports /> : null}

      <EntryDialog open={addOpen} onOpenChange={setAddOpen} type="expense" />
    </div>
  );
}

function Overview({ period }: { period: PeriodValue }) {
  const summary = trpc.finance.summary.useQuery({ period });
  if (summary.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-fg-subtle">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (summary.isError) {
    return <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">Could not load accounting: {summary.error.message}</p>;
  }
  const s = summary.data!;
  const income = s.revenue.realized + s.otherIncome;

  const lines: Array<{ label: string; value: number; note?: string; sign: "+" | "−" }> = [
    {
      label: "Revenue (delivered orders)",
      value: s.revenue.realized,
      sign: "+",
      note:
        s.revenue.fallbackDated.orders > 0
          ? `${s.revenue.exact.orders} with delivery time · ${s.revenue.fallbackDated.orders} older, dated by last update (${formatBDT(s.revenue.fallbackDated.amount)})`
          : `${s.revenue.deliveredOrders} delivered order${s.revenue.deliveredOrders === 1 ? "" : "s"}`,
    },
    ...(s.otherIncome > 0 ? [{ label: "Other income", value: s.otherIncome, sign: "+" as const }] : []),
    {
      label: "Product cost",
      value: s.productCost.total,
      sign: "−",
      note: s.productCost.ordersMissingCost > 0 ? `Cost not recorded for ${s.productCost.ordersMissingCost} order(s)` : undefined,
    },
    {
      label: "Courier cost",
      value: s.courierCost.total,
      sign: "−",
      note: [
        s.courierCost.fromReturned > 0 ? `incl. ${formatBDT(s.courierCost.fromReturned)} on returned parcels` : null,
        s.courierCost.ordersMissingFee > 0 ? `Not recorded for ${s.courierCost.ordersMissingFee} order(s)` : null,
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
    },
    { label: "Advertising", value: s.advertising, sign: "−" },
    { label: "Office rent", value: s.office, sign: "−" },
    { label: "Salary", value: s.salary, sign: "−" },
    { label: "Other expenses", value: s.otherExpenses, sign: "−" },
  ];

  return (
    <div className="space-y-6">
      <div className="text-xs uppercase tracking-wide text-fg-faint">{periodLabel(period)}</div>
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Revenue" value={formatBDT(income)} icon={TrendingUp} tone="success" footer={<span>Delivered orders + other income</span>} />
        <StatCard label="Expenses" value={formatBDT(s.totalExpenses)} icon={TrendingDown} tone="warning" />
        <StatCard
          label="Net profit"
          value={<span className={cn(s.netProfit < 0 && "text-danger")}>{formatBDT(s.netProfit)}</span>}
          icon={Wallet}
          tone={s.netProfit < 0 ? "danger" : "brand"}
          footer={!s.costComplete ? <span className="text-warning">Some costs not recorded</span> : undefined}
        />
      </div>

      {s.warnings.length > 0 ? (
        <div className="space-y-1 rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning">
          {s.warnings.map((w) => (
            <p key={w.code} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {w.message}
            </p>
          ))}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="rounded-xl border border-stroke/10 bg-surface lg:col-span-3">
          <div className="border-b border-stroke/8 px-4 py-3 text-sm font-semibold">Profit &amp; loss</div>
          <dl className="divide-y divide-stroke/8 text-sm">
            {lines.map((l) => (
              <div key={l.label} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <dt>
                  {l.label}
                  {l.note ? <span className={cn("ml-2 text-xs", l.note.includes("not recorded") || l.note.includes("Not recorded") ? "text-warning" : "text-fg-subtle")}>{l.note}</span> : null}
                </dt>
                <dd className="tabular-nums">
                  {l.sign === "−" && l.value > 0 ? "− " : ""}
                  {formatBDT(l.value)}
                </dd>
              </div>
            ))}
            <div className="flex items-center justify-between px-4 py-3 font-semibold">
              <dt>Net profit</dt>
              <dd className={cn("tabular-nums", s.netProfit < 0 && "text-danger")}>{formatBDT(s.netProfit)}</dd>
            </div>
          </dl>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <div className="rounded-xl border border-stroke/10 bg-surface p-4 text-sm">
            <div className="font-semibold">Not delivered yet</div>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{formatBDT(s.revenue.pendingOrderValue)}</p>
            <p className="mt-1 text-xs text-fg-subtle">
              {s.revenue.pendingOrders} open order{s.revenue.pendingOrders === 1 ? "" : "s"} placed in this period. Cash on delivery counts as revenue only once delivered.
            </p>
            <p className="mt-3 text-xs text-fg-subtle">
              All orders placed in this period: <span className="tabular-nums text-fg">{formatBDT(s.revenue.grossOrderValue)}</span> ({s.revenue.grossOrders})
            </p>
          </div>
          <div className="rounded-xl border border-stroke/10 bg-surface">
            <div className="border-b border-stroke/8 px-4 py-3 text-sm font-semibold">By category</div>
            {s.byCategory.length === 0 ? (
              <p className="px-4 py-3 text-sm text-fg-subtle">No income or expense entries in this period.</p>
            ) : (
              <ul className="divide-y divide-stroke/8 text-sm">
                {s.byCategory.map((c) => (
                  <li key={`${c.type}:${c.category}`} className="flex justify-between px-4 py-2.5">
                    <span>
                      {c.label} <span className="text-xs text-fg-faint">× {c.count}</span>
                    </span>
                    <span className={cn("tabular-nums", c.type === "income" ? "text-success" : "")}>
                      {c.type === "income" ? "+ " : "− "}
                      {formatBDT(c.total)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Reports() {
  const currentYear = Number(dhakaToday().slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const monthly = trpc.finance.monthly.useQuery({ year });
  const months = monthly.data?.months ?? [];
  const total = months.reduce(
    (a, m) => ({ revenue: a.revenue + m.revenue + m.otherIncome, expenses: a.expenses + m.expenses, net: a.net + m.netProfit }),
    { revenue: 0, expenses: 0, net: 0 },
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        {[currentYear - 1, currentYear].map((y) => (
          <button
            key={y}
            onClick={() => setYear(y)}
            aria-pressed={year === y}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium",
              year === y ? "border-brand/40 bg-brand/10 text-fg" : "border-stroke/12 text-fg-subtle hover:text-fg",
            )}
          >
            {y}
          </button>
        ))}
      </div>
      {monthly.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-fg-subtle">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : monthly.isError ? (
        <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">Could not load report: {monthly.error.message}</p>
      ) : (
        <>
          <div className="rounded-xl border border-stroke/10 bg-surface p-4">
            <div className="mb-2 text-sm font-semibold">Monthly trend · {year}</div>
            <MonthlyChart data={months} />
          </div>
          <div className="overflow-x-auto rounded-xl border border-stroke/10 bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-stroke/8 text-left text-2xs uppercase tracking-wide text-fg-faint">
                <tr>
                  <th className="px-4 py-3 font-medium">Month</th>
                  <th className="px-4 py-3 text-right font-medium">Revenue</th>
                  <th className="px-4 py-3 text-right font-medium">Expenses</th>
                  <th className="px-4 py-3 text-right font-medium">Net profit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stroke/8">
                {months.map((m) => (
                  <tr key={m.month}>
                    <td className="px-4 py-2.5 tabular-nums">
                      {m.month}
                      {!m.costComplete ? (
                        <span className="ml-2 text-xs text-warning" title="Some delivered or returned orders have no recorded product or courier cost">
                          costs incomplete
                        </span>
                      ) : null}
                      {m.fallbackDatedOrders > 0 ? (
                        <span className="ml-2 text-xs text-fg-subtle" title="Older orders without a recorded delivery/return time, dated by their last update">
                          {m.fallbackDatedOrders} dated by last update
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatBDT(m.revenue + m.otherIncome)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatBDT(m.expenses)}</td>
                    <td className={cn("px-4 py-2.5 text-right font-medium tabular-nums", m.netProfit < 0 && "text-danger")}>{formatBDT(m.netProfit)}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="px-4 py-3">Year</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatBDT(total.revenue)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatBDT(total.expenses)}</td>
                  <td className={cn("px-4 py-3 text-right tabular-nums", total.net < 0 && "text-danger")}>{formatBDT(total.net)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
