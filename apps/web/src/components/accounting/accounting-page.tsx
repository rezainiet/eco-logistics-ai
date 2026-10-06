"use client";

import { type ReactNode, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Coins, Loader2, Plus, TrendingDown, TrendingUp, Wallet } from "lucide-react";
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
import { OrderProfitTable } from "./order-profit";
import { pnlLines, profitPresentation } from "@/lib/accounting/pnl";

type Tab = "overview" | "orders" | "income" | "expenses" | "reports";
const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ["overview", "Overview"],
  ["orders", "Order profit"],
  ["income", "Income"],
  ["expenses", "Expenses"],
  ["reports", "Reports"],
];

export function AccountingPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [period, setPeriod] = useState<PeriodValue>({ preset: "month" });
  const [addOpen, setAddOpen] = useState(false);
  // Opening Order profit from an incomplete profit figure starts on its "missing costs" filter.
  const [missingOnly, setMissingOnly] = useState(false);

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

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-1 self-start rounded-lg border border-stroke/10 bg-surface p-1" role="tablist" aria-label="Accounting sections">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => {
                setTab(key);
                setMissingOnly(false);
              }}
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

      {tab === "overview" ? (
        <Overview
          period={period}
          onReviewMissing={() => {
            setMissingOnly(true);
            setTab("orders");
          }}
        />
      ) : null}
      {tab === "orders" ? <OrderProfitTable period={period} initialMissingOnly={missingOnly} /> : null}
      {tab === "income" ? <EntriesTable type="income" period={period} /> : null}
      {tab === "expenses" ? <EntriesTable type="expense" period={period} /> : null}
      {tab === "reports" ? <Reports /> : null}

      <EntryDialog open={addOpen} onOpenChange={setAddOpen} type="expense" />
    </div>
  );
}

function Overview({ period, onReviewMissing }: { period: PeriodValue; onReviewMissing: () => void }) {
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
  const lines = pnlLines(s);
  // Missing costs only lower profit: while any are missing the figures are an upper bound.
  const shown = profitPresentation(s.costCoverage);
  const incomplete = shown.state === "incomplete";
  const profitValue = (value: number) => (
    <span className={cn(value < 0 && "text-danger")}>
      {shown.prefix ? <span className="text-base font-medium text-fg-subtle">{shown.prefix}</span> : null}
      {formatBDT(value)}
    </span>
  );
  const profitFooter = (complete: ReactNode) =>
    incomplete ? (
      <span className="flex flex-wrap items-center gap-x-2 text-warning">
        <span title={shown.detail ?? undefined}>{shown.coverage}</span>
        <button type="button" onClick={onReviewMissing} className="underline underline-offset-2 hover:text-fg">
          Review {s.costCoverage.incompleteOrders} order{s.costCoverage.incompleteOrders === 1 ? "" : "s"}
        </button>
      </span>
    ) : shown.state === "no_orders" ? (
      <span>{shown.detail}</span>
    ) : (
      complete
    );
  const notes: Record<string, string | undefined> = {
    revenue: [
      s.revenue.fallbackDated.orders > 0
        ? `${s.revenue.exact.orders} with delivery time · ${s.revenue.fallbackDated.orders} older, dated by last update (${formatBDT(s.revenue.fallbackDated.amount)})`
        : `${s.revenue.deliveredOrders} delivered order${s.revenue.deliveredOrders === 1 ? "" : "s"}`,
      // Delivery charges are inside the order totals — shown as a split, not extra income.
      s.revenue.deliveryCharges > 0 ? `${formatBDT(s.revenue.productSales)} products + ${formatBDT(s.revenue.deliveryCharges)} delivery charges` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  };

  return (
    <div className="space-y-6">
      <div className="text-xs uppercase tracking-wide text-fg-faint">{periodLabel(period)}</div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Revenue" value={formatBDT(income)} icon={TrendingUp} tone="success" footer={<span>Delivered orders + other income</span>} />
        <StatCard
          label="Gross profit"
          value={profitValue(s.grossProfit)}
          icon={Coins}
          tone={s.grossProfit < 0 ? "danger" : incomplete ? "warning" : "success"}
          footer={profitFooter(<span>After product &amp; courier cost</span>)}
        />
        <StatCard label="Expenses" value={formatBDT(s.totalExpenses)} icon={TrendingDown} tone="warning" />
        <StatCard
          label="Net profit"
          value={profitValue(s.netProfit)}
          icon={Wallet}
          tone={s.netProfit < 0 ? "danger" : incomplete ? "warning" : "brand"}
          footer={profitFooter(undefined)}
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
            {lines.map((l) =>
              l.kind === "subtotal" ? (
                <div key={l.key} className="flex items-center justify-between gap-3 bg-surface-raised/40 px-4 py-3 font-semibold">
                  <dt>
                    {l.label}
                    {l.incomplete ? (
                      <span className="ml-2 text-xs font-normal text-warning" title="A delivered or returned order has no recorded product or courier cost — the real figure is lower">
                        costs incomplete{shown.coverage ? ` · ${shown.coverage.toLowerCase()}` : ""}
                      </span>
                    ) : null}
                  </dt>
                  <dd className={cn("whitespace-nowrap tabular-nums", l.value < 0 && "text-danger")}>
                    <UpTo show={l.incomplete} />
                    {formatBDT(l.value)}
                  </dd>
                </div>
              ) : (
                <div key={l.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <dt>
                    {l.label}
                    {l.note || notes[l.key] ? (
                      <span className={cn("ml-2 text-xs", l.warn ? "text-warning" : "text-fg-subtle")}>{l.note ?? notes[l.key]}</span>
                    ) : null}
                  </dt>
                  <dd className="whitespace-nowrap tabular-nums">
                    {l.sign === "−" && l.value > 0 ? "− " : ""}
                    {formatBDT(l.value)}
                  </dd>
                </div>
              ),
            )}
          </dl>
          <p className="border-t border-stroke/8 px-4 py-2.5 text-2xs text-fg-faint">
            Profit by marketing channel is in{" "}
            <Link href="/dashboard/marketing" className="text-brand hover:underline">
              Marketing
            </Link>
            ; each order&apos;s profit is under Order profit.
          </p>
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
                    <span className={cn("whitespace-nowrap tabular-nums", c.type === "income" ? "text-success" : "")}>
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
  const t = monthly.data?.totals;

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
            {months.some((m) => !m.costComplete) ? (
              <p className="mt-2 text-2xs text-fg-faint">
                Months marked “costs incomplete” show profit before their unrecorded costs — the real profit is lower.
              </p>
            ) : null}
          </div>
          <div className="overflow-x-auto rounded-xl border border-stroke/10 bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-stroke/8 text-left text-2xs uppercase tracking-wide text-fg-faint">
                <tr>
                  <th className="px-4 py-3 font-medium">Month</th>
                  <th className="px-4 py-3 text-right font-medium">Revenue</th>
                  <th className="px-4 py-3 text-right font-medium">Gross profit</th>
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
                        <span className="ml-2 text-xs text-warning" title="Some delivered or returned orders have no recorded product or courier cost — the real profit is lower">
                          costs incomplete · {m.costCoverage.percentage ?? 0}% costed
                        </span>
                      ) : null}
                      {m.fallbackDatedOrders > 0 ? (
                        <span className="ml-2 text-xs text-fg-subtle" title="Older orders without a recorded delivery/return time, dated by their last update">
                          {m.fallbackDatedOrders} dated by last update
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatBDT(m.revenue + m.otherIncome)}</td>
                    <td className={cn("whitespace-nowrap px-4 py-2.5 text-right tabular-nums", m.grossProfit < 0 && "text-danger")}>
                      <UpTo show={!m.costComplete} />
                      {formatBDT(m.grossProfit)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatBDT(m.expenses)}</td>
                    <td className={cn("whitespace-nowrap px-4 py-2.5 text-right font-medium tabular-nums", m.netProfit < 0 && "text-danger")}>
                      <UpTo show={!m.costComplete} />
                      {formatBDT(m.netProfit)}
                    </td>
                  </tr>
                ))}
                {t ? (
                  <tr className="font-semibold">
                    <td className="px-4 py-3">
                      Year {year}
                      {!t.costComplete ? (
                        <span className="ml-2 text-xs font-normal text-warning">costs incomplete · {t.costCoverage.percentage ?? 0}% costed</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatBDT(t.revenue + t.otherIncome)}</td>
                    <td className={cn("whitespace-nowrap px-4 py-3 text-right tabular-nums", t.grossProfit < 0 && "text-danger")}>
                      <UpTo show={!t.costComplete} />
                      {formatBDT(t.grossProfit)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatBDT(t.expenses)}</td>
                    <td className={cn("whitespace-nowrap px-4 py-3 text-right tabular-nums", t.netProfit < 0 && "text-danger")}>
                      <UpTo show={!t.costComplete} />
                      {formatBDT(t.netProfit)}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** "up to" in front of a profit that leaves out unrecorded costs, so is an upper bound. */
function UpTo({ show }: { show: boolean }) {
  return show ? <span className="text-xs font-normal text-fg-subtle">up to </span> : null;
}
