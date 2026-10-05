"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, ExternalLink, Info, Loader2, Megaphone, RotateCcw } from "lucide-react";
import type { RouterOutputs } from "@ecom/types";
import { trpc } from "@/lib/trpc";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PeriodPicker, periodLabel, type PeriodValue } from "@/components/accounting/period";
import { formatBDT } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL, TRAFFIC_LABEL, formatRate, warningText, type MarketingWarning } from "@/lib/marketing/labels";

type Tab = "overview" | "funnel" | "tracking" | "attribution" | "campaigns";
type Touch = "first" | "last";

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ["overview", "Overview"],
  ["funnel", "Funnel"],
  ["tracking", "Tracking"],
  ["attribution", "Attribution"],
  ["campaigns", "Campaigns"],
];

const pill = (active: boolean) =>
  cn(
    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
    active ? "border-brand/40 bg-brand/10 text-fg" : "border-stroke/12 text-fg-subtle hover:text-fg",
  );

function Loading() {
  return (
    <div className="flex items-center gap-2 text-sm text-fg-subtle">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </div>
  );
}

function Failed({ message }: { message: string }) {
  return <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">Could not load: {message}</p>;
}

function TouchToggle({ value, onChange }: { value: Touch; onChange: (t: Touch) => void }) {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="Attribution model">
      <button className={pill(value === "last")} aria-pressed={value === "last"} onClick={() => onChange("last")}>
        Last click
      </button>
      <button className={pill(value === "first")} aria-pressed={value === "first"} onClick={() => onChange("first")}>
        First click
      </button>
    </div>
  );
}

export function MarketingPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [period, setPeriod] = useState<PeriodValue>({ preset: "month" });
  const [touch, setTouch] = useState<Touch>("last");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Insights"
        title="Marketing"
        description="Where your orders come from, and what they earn once delivered. Amounts in Taka (৳)."
      />
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-1 self-start rounded-lg border border-stroke/10 bg-surface p-1" role="tablist" aria-label="Marketing sections">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn("rounded-md px-3 py-1.5 text-sm font-medium transition-colors", tab === key ? "bg-brand/12 text-fg" : "text-fg-subtle hover:text-fg")}
            >
              {label}
            </button>
          ))}
        </div>
        {tab !== "tracking" ? (
          <div className="flex flex-wrap items-center gap-3">
            {tab !== "funnel" ? <TouchToggle value={touch} onChange={setTouch} /> : null}
            <PeriodPicker value={period} onChange={setPeriod} />
          </div>
        ) : null}
      </div>

      {tab === "overview" ? <Overview period={period} touch={touch} /> : null}
      {tab === "funnel" ? <Funnel period={period} /> : null}
      {tab === "tracking" ? <Tracking /> : null}
      {tab === "attribution" ? <Breakdown period={period} touch={touch} dimensions={["source", "medium"]} /> : null}
      {tab === "campaigns" ? <Breakdown period={period} touch={touch} dimensions={["campaign", "content", "term"]} /> : null}
    </div>
  );
}

function Overview({ period, touch }: { period: PeriodValue; touch: Touch }) {
  const q = trpc.marketing.overview.useQuery({ period, touch });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <Failed message={q.error.message} />;
  const r = q.data!;
  return (
    <div className="space-y-4">
      <div className="text-xs uppercase tracking-wide text-fg-faint">
        {periodLabel(period)} · {touch === "last" ? "last click" : "first click"}
      </div>
      {r.warnings.length > 0 ? (
        <ul className="space-y-1.5 rounded-lg border border-warning-border bg-warning-subtle/40 px-4 py-3 text-xs text-fg-muted" aria-label="Missing data">
          {(r.warnings as MarketingWarning[]).map((w, i) => (
            <li key={`${w.code}-${w.channel ?? i}`} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
              {warningText(w)}
            </li>
          ))}
        </ul>
      ) : null}
      {r.trafficTypes.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Orders by traffic type">
          {r.trafficTypes.map((t) => (
            <div key={t.type} className="rounded-xl border border-stroke/10 bg-surface p-3" title={TRAFFIC_LABEL[t.type]?.hint}>
              <div className="text-2xs uppercase tracking-wide text-fg-faint">{TRAFFIC_LABEL[t.type]?.label ?? t.type}</div>
              <div className="text-lg font-semibold tabular-nums">{t.ordersPlaced}</div>
              <div className="text-2xs text-fg-subtle">
                {t.deliveredOrders} delivered · {formatBDT(t.deliveredRevenue)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {r.channels.length === 0 ? (
        <EmptyState icon={Megaphone} title="No orders in this period" description="Orders from your landing pages show up here with the channel that brought them." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-stroke/10 bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-stroke/8 text-left text-2xs uppercase tracking-wide text-fg-faint">
              <tr>
                <th className="px-4 py-3 font-medium">Channel</th>
                <th className="px-4 py-3 text-right font-medium">Orders</th>
                <th className="px-4 py-3 text-right font-medium">Delivered</th>
                <th className="px-4 py-3 text-right font-medium">Revenue</th>
                <th className="px-4 py-3 text-right font-medium">Ad spend</th>
                <th className="px-4 py-3 text-right font-medium">Cost / order</th>
                <th className="px-4 py-3 text-right font-medium">ROAS</th>
                <th className="px-4 py-3 text-right font-medium" title="Delivered revenue − product cost − courier fees − ad spend">
                  Profit
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stroke/8">
              {r.channels.map((c) => (
                <tr key={c.channel}>
                  <td className="px-4 py-2.5">{CHANNEL_LABEL[c.channel] ?? c.channel}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.ordersPlaced}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.deliveredOrders}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatBDT(c.deliveredRevenue)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.spend === null ? "—" : formatBDT(c.spend)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.costPerOrder === null ? "—" : formatBDT(c.costPerOrder)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.roas === null ? "—" : `${c.roas}×`}</td>
                  <td
                    className="px-4 py-2.5 text-right tabular-nums"
                    title={c.profit === null ? "Not shown: a product cost or courier fee is not recorded for this channel" : undefined}
                  >
                    {c.profit === null ? "—" : formatBDT(c.profit)}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="px-4 py-3">Total</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.totals.ordersPlaced}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.totals.deliveredOrders}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatBDT(r.totals.deliveredRevenue)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.totals.spend > 0 ? formatBDT(r.totals.spend) : "—"}</td>
                <td className="px-4 py-3" />
                <td className="px-4 py-3 text-right tabular-nums">{r.totals.roas === null ? "—" : `${r.totals.roas}×`}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.totals.profit === null ? "—" : formatBDT(r.totals.profit)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <div className="space-y-1 rounded-lg border border-stroke/10 bg-surface px-4 py-3 text-xs text-fg-subtle">
        <p className="flex gap-2">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Orders = placed in this period. Revenue = delivered orders only, the same as Accounting.
        </p>
        <p className="flex gap-2">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Ad spend comes from the Meta, Google and TikTok ads expenses you enter in{" "}
          <Link href="/dashboard/accounting" className="text-brand hover:underline">
            Accounting
          </Link>
          . Without them, cost per order and ROAS are not shown.
        </p>
        <p className="flex gap-2">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          &ldquo;Not tracked&rdquo; = orders created outside your landing pages (dashboard, CSV, store integrations) or before tracking started.
        </p>
      </div>
      {r.recovery.recoveredOrders > 0 || r.recovery.deliveredOrders > 0 ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-stroke/10 bg-surface p-4 text-sm">
          <div className="flex items-center gap-2 font-semibold">
            <RotateCcw className="h-4 w-4 text-brand" aria-hidden /> Won back by Cart Recovery
          </div>
          <div>
            <span className="tabular-nums font-semibold">{r.recovery.recoveredOrders}</span> <span className="text-fg-subtle">orders placed</span>
          </div>
          <div>
            <span className="tabular-nums font-semibold">{formatBDT(r.recovery.deliveredRevenue)}</span>{" "}
            <span className="text-fg-subtle">delivered revenue ({r.recovery.deliveredOrders} orders)</span>
          </div>
          <p className="w-full text-2xs text-fg-faint">
            Already included above: first click keeps the ad that brought the buyer; last click shows the recovery email (Other, campaign cart_recovery).
          </p>
        </div>
      ) : null}
      {r.funnel ? (
        <div className="rounded-xl border border-stroke/10 bg-surface p-4">
          <div className="mb-3 text-sm font-semibold">Store visitor funnel</div>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            {(
              [
                ["Visits", r.funnel.sessions],
                ["Viewed a product", r.funnel.productViews],
                ["Added to cart", r.funnel.addToCart],
                ["Started checkout", r.funnel.checkoutStarted],
                ["Ordered", r.funnel.converted],
              ] as const
            ).map(([label, n]) => (
              <div key={label}>
                <div className="text-2xs uppercase tracking-wide text-fg-faint">{label}</div>
                <div className="text-lg font-semibold tabular-nums">{n}</div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-2xs text-fg-faint">From your connected store&apos;s tracking script.</p>
        </div>
      ) : null}
    </div>
  );
}

type Dim = "source" | "medium" | "campaign" | "content" | "term";
const DIM_LABEL: Record<Dim, string> = { source: "source", medium: "medium", campaign: "campaign", content: "ad / content", term: "keyword / term" };

function Breakdown({ period, touch, dimensions }: { period: PeriodValue; touch: Touch; dimensions: Dim[] }) {
  const [dimension, setDimension] = useState(dimensions[0]!);
  const q = trpc.marketing.breakdown.useQuery({ period, touch, dimension });
  return (
    <div className="space-y-4">
      {dimensions.length > 1 ? (
        <div className="flex gap-1.5">
          {dimensions.map((d) => (
            <button key={d} className={pill(dimension === d)} aria-pressed={dimension === d} onClick={() => setDimension(d)}>
              By {DIM_LABEL[d]}
            </button>
          ))}
        </div>
      ) : null}
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <Failed message={q.error.message} />
      ) : q.data!.rows.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No tracked orders yet"
          description="Add UTM tags (utm_source, utm_medium, utm_campaign, utm_content, utm_term) to your ad links to see which ones bring orders."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-stroke/10 bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-stroke/8 text-left text-2xs uppercase tracking-wide text-fg-faint">
              <tr>
                <th className="px-4 py-3 font-medium capitalize">{DIM_LABEL[dimension]}</th>
                <th className="px-4 py-3 font-medium">Channel</th>
                <th className="px-4 py-3 text-right font-medium">Orders</th>
                <th className="px-4 py-3 text-right font-medium">Delivered</th>
                <th className="px-4 py-3 text-right font-medium">Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stroke/8">
              {q.data!.rows.map((r) => (
                <tr key={`${r.channel}-${r.value ?? ""}`}>
                  <td className="px-4 py-2.5">{r.value ?? <span className="text-fg-faint">(not set)</span>}</td>
                  <td className="px-4 py-2.5 text-fg-subtle">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{r.ordersPlaced}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{r.deliveredOrders}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatBDT(r.deliveredRevenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const STEP_LABEL: ReadonlyArray<readonly [string, string]> = [
  ["visits", "Visits"],
  ["addedToCart", "Added to cart"],
  ["checkoutStarted", "Started checkout"],
  ["ordersPlaced", "Ordered"],
  ["deliveredOrders", "Delivered"],
];

function Funnel({ period }: { period: PeriodValue }) {
  const [pageId, setPageId] = useState<string>("");
  const pages = trpc.marketing.trackingStatus.useQuery();
  const q = trpc.marketing.funnel.useQuery({ period, landingPageId: pageId || null });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="funnel-page" className="text-xs text-fg-subtle">
          Landing page
        </label>
        <select
          id="funnel-page"
          value={pageId}
          onChange={(e) => setPageId(e.target.value)}
          className="max-w-full rounded-md border border-stroke/14 bg-surface-raised px-3 py-1.5 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-brand/30"
        >
          <option value="">All landing pages</option>
          {(pages.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <Failed message={q.error.message} />
      ) : (
        <FunnelBody data={q.data!} />
      )}
    </div>
  );
}

type FunnelData = RouterOutputs["marketing"]["funnel"];

function FunnelBody({ data }: { data: FunnelData }) {
  const t = data.totals;
  return (
    <div className="space-y-4">
      {!data.collecting ? (
        <p className="flex gap-2 rounded-lg border border-stroke/10 bg-surface px-4 py-3 text-xs text-fg-subtle">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Visit and cart tracking on landing pages is part of Growth and above, so only orders and deliveries are shown.
        </p>
      ) : t.visits === 0 ? (
        <p className="flex gap-2 rounded-lg border border-stroke/10 bg-surface px-4 py-3 text-xs text-fg-subtle">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          No landing-page visits recorded in this period yet. Visits are counted once per visitor session.
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" aria-label="Landing page funnel">
        {STEP_LABEL.map(([key, label]) => (
          <div key={key} className="rounded-xl border border-stroke/10 bg-surface p-3">
            <div className="text-2xs uppercase tracking-wide text-fg-faint">{label}</div>
            <div className="text-lg font-semibold tabular-nums">{t[key as keyof typeof t]}</div>
          </div>
        ))}
        <div className="rounded-xl border border-stroke/10 bg-surface p-3">
          <div className="text-2xs uppercase tracking-wide text-fg-faint">Revenue</div>
          <div className="text-lg font-semibold tabular-nums">{formatBDT(t.deliveredRevenue)}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-fg-subtle">
        <span>Visit → cart {formatRate(data.rates.visitToCart)}</span>
        <span>Cart → checkout {formatRate(data.rates.cartToCheckout)}</span>
        <span>Visit → order {formatRate(data.rates.visitToOrder)}</span>
      </div>
      {data.pages.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-stroke/10 bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-stroke/8 text-left text-2xs uppercase tracking-wide text-fg-faint">
              <tr>
                <th className="px-4 py-3 font-medium">Landing page</th>
                <th className="px-4 py-3 text-right font-medium">Visits</th>
                <th className="px-4 py-3 text-right font-medium">Cart</th>
                <th className="px-4 py-3 text-right font-medium">Checkout</th>
                <th className="px-4 py-3 text-right font-medium">Orders</th>
                <th className="px-4 py-3 text-right font-medium">Delivered</th>
                <th className="px-4 py-3 text-right font-medium">Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stroke/8">
              {data.pages.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-2.5">{p.name}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{p.visits}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{p.addedToCart}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{p.checkoutStarted}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{p.ordersPlaced}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{p.deliveredOrders}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatBDT(p.deliveredRevenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data.channels.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-stroke/10 bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-stroke/8 text-left text-2xs uppercase tracking-wide text-fg-faint">
              <tr>
                <th className="px-4 py-3 font-medium">Visits from</th>
                <th className="px-4 py-3 text-right font-medium">Visits</th>
                <th className="px-4 py-3 text-right font-medium">Cart</th>
                <th className="px-4 py-3 text-right font-medium">Checkout</th>
                <th className="px-4 py-3 text-right font-medium">Ordered</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stroke/8">
              {data.channels.map((c) => (
                <tr key={c.channel}>
                  <td className="px-4 py-2.5">{CHANNEL_LABEL[c.channel] ?? c.channel}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.visits}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.addedToCart}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.checkoutStarted}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.checkoutSubmitted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="flex gap-2 text-2xs text-fg-faint">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        Visits, cart and checkout come from your landing pages (one count per visitor session, no personal data).
        Orders and revenue come from your orders — revenue only once delivered, the same as Accounting.
      </p>
    </div>
  );
}

function Tracking() {
  const q = trpc.marketing.trackingStatus.useQuery();
  if (q.isLoading) return <Loading />;
  if (q.isError) return <Failed message={q.error.message} />;
  const pages = q.data!;
  if (pages.length === 0) {
    return <EmptyState icon={Megaphone} title="No landing pages yet" description="Create a landing page, then add its Meta, Google or TikTok IDs here." />;
  }
  const badge = (on: boolean, label: string) => (
    <span className={cn("rounded-full px-2 py-0.5 text-2xs font-medium", on ? "bg-success/15 text-success" : "bg-surface-raised text-fg-faint")}>
      {label} {on ? "on" : "off"}
    </span>
  );
  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-subtle">Each landing page has its own tracking IDs. Open a page to change them.</p>
      <ul className="divide-y divide-stroke/8 overflow-hidden rounded-xl border border-stroke/10 bg-surface">
        {pages.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{p.name}</div>
              <div className="text-2xs text-fg-faint">
                {p.slug ?? "no address yet"} · {p.status}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {badge(p.meta.enabled, "Meta")}
              {badge(p.google.enabled, "Google")}
              {badge(p.tiktok.enabled, "TikTok")}
              <Link href={`/dashboard/landing-pages/${p.id}#tracking`} className="ml-2 inline-flex items-center gap-1 text-xs text-brand hover:underline">
                Edit <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
