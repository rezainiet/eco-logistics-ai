"use client";

import * as React from "react";
import { trpc } from "@/lib/trpc";
import { ChartCard } from "@/components/charts/chart-card";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * RTO Intelligence v1 — observation surface.
 *
 * Renders four cards driven by `analytics.intentDistribution`,
 * `addressQualityDistribution`, `topThanas`, and `campaignSourceOutcomes`.
 *
 * Design rules (per execution roadmap §STEP 4):
 *  - Operator-readable labels ("Verified", "Implicit", "Incomplete address")
 *    not ML/AI marketing language.
 *  - Null-safe — every percentage rendering branches on `null` (no resolved
 *    orders → "—" instead of "NaN%").
 *  - No spinning AI badges, no "predictions" copy. The data is honest.
 *  - One-roundtrip per card via tRPC's natural batching.
 *  - Bounded to 30-day window; `days` prop is overridable for future filters.
 */

type Props = { days?: number };

const PERCENT_FMT = new Intl.NumberFormat("en-BD", {
  style: "percent",
  maximumFractionDigits: 0,
});

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return PERCENT_FMT.format(v);
}

const INTENT_LABELS: Record<string, { label: string; tone: string }> = {
  verified: { label: "Verified", tone: "text-success" },
  implicit: { label: "Implicit", tone: "text-fg" },
  unverified: { label: "Unverified", tone: "text-warning" },
  no_data: { label: "No session data", tone: "text-fg-subtle" },
};

const COMPLETENESS_LABELS: Record<string, { label: string; tone: string }> = {
  complete: { label: "Complete", tone: "text-success" },
  partial: { label: "Partial", tone: "text-warning" },
  incomplete: { label: "Incomplete", tone: "text-danger" },
};

const CAMPAIGN_LABELS: Record<string, string> = {
  organic: "Organic",
  paid_social: "Paid social",
  direct: "Direct",
  unknown: "Unknown",
  no_session: "No session",
};

export function RtoIntelligenceSection({ days = 30 }: Props) {
  const intent = trpc.analytics.intentDistribution.useQuery({ days });
  const address = trpc.analytics.addressQualityDistribution.useQuery({ days });
  const thanas = trpc.analytics.topThanas.useQuery({ days, limit: 10 });
  const campaigns = trpc.analytics.campaignSourceOutcomes.useQuery({ days });

  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold text-fg">RTO Intelligence</h2>
        <p className="text-xs text-fg-subtle">
          Observation-only signals from the past {days} days. Rates are
          computed over RESOLVED orders (delivered + RTO + cancelled);
          in-flight orders are counted separately.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Intent tier distribution"
          description="How committed your buyers were when they ordered"
        >
          {intent.isError ? (
            <div className="px-2 py-6 text-center text-sm text-fg-muted">
              Could not load intent distribution.
            </div>
          ) : intent.isLoading ? (
            <div className="h-48 animate-shimmer rounded-md" />
          ) : (intent.data?.totalOrders ?? 0) === 0 ? (
            <EmptyState
              title="No data yet"
              description="Once orders flow, intent tiers appear here."
              className="my-4"
            />
          ) : (
            <BucketTable
              rows={(intent.data?.buckets ?? []).map((b) => ({
                key: b.tier,
                label: INTENT_LABELS[b.tier]?.label ?? b.tier,
                tone: INTENT_LABELS[b.tier]?.tone ?? "text-fg",
                total: b.total,
                deliveredRate: b.deliveredRate,
                rtoRate: b.rtoRate,
              }))}
              totalLabel="Total"
              total={intent.data?.totalOrders ?? 0}
            />
          )}
        </ChartCard>

        <ChartCard
          title="Address quality distribution"
          description="How deliverable the addresses you've taken were"
        >
          {address.isError ? (
            <div className="px-2 py-6 text-center text-sm text-fg-muted">
              Could not load address quality distribution.
            </div>
          ) : address.isLoading ? (
            <div className="h-48 animate-shimmer rounded-md" />
          ) : (address.data?.totalOrders ?? 0) === 0 ? (
            <EmptyState
              title="No data yet"
              description="Address quality stamps appear once orders ingest."
              className="my-4"
            />
          ) : (
            <BucketTable
              rows={(address.data?.buckets ?? []).map((b) => ({
                key: b.completeness,
                label: COMPLETENESS_LABELS[b.completeness]?.label ?? b.completeness,
                tone: COMPLETENESS_LABELS[b.completeness]?.tone ?? "text-fg",
                total: b.total,
                deliveredRate: b.deliveredRate,
                rtoRate: b.rtoRate,
              }))}
              totalLabel="Total"
              total={address.data?.totalOrders ?? 0}
            />
          )}
        </ChartCard>

        <ChartCard
          title="Top thanas by volume"
          description="Delivery rates per thana over the past 30 days"
        >
          {thanas.isError ? (
            <div className="px-2 py-6 text-center text-sm text-fg-muted">
              Could not load thana breakdown.
            </div>
          ) : thanas.isLoading ? (
            <div className="h-48 animate-shimmer rounded-md" />
          ) : (thanas.data?.thanas ?? []).length === 0 ? (
            <EmptyState
              title="No thanas detected yet"
              description="Thanas extracted from delivery addresses appear here."
              className="my-4"
            />
          ) : (
            <ThanaTable rows={thanas.data?.thanas ?? []} />
          )}
        </ChartCard>

        <ChartCard
          title="Campaign source outcomes"
          description="Where your orders came from, and how each cohort delivered"
        >
          {campaigns.isError ? (
            <div className="px-2 py-6 text-center text-sm text-fg-muted">
              Could not load campaign breakdown.
            </div>
          ) : campaigns.isLoading ? (
            <div className="h-48 animate-shimmer rounded-md" />
          ) : (campaigns.data?.totalOrders ?? 0) === 0 ? (
            <EmptyState
              title="No data yet"
              description="Campaign attribution appears once your storefront SDK captures sessions."
              className="my-4"
            />
          ) : (
            <BucketTable
              rows={(campaigns.data?.buckets ?? []).map((b) => ({
                key: b.source,
                label: CAMPAIGN_LABELS[b.source] ?? b.source,
                tone: "text-fg",
                total: b.total,
                deliveredRate: b.deliveredRate,
                rtoRate: b.rtoRate,
              }))}
              totalLabel="Total"
              total={campaigns.data?.totalOrders ?? 0}
            />
          )}
        </ChartCard>
      </div>
    </section>
  );
}

interface BucketRow {
  key: string;
  label: string;
  tone: string;
  total: number;
  deliveredRate: number | null;
  rtoRate: number | null;
}

function BucketTable({
  rows,
  totalLabel,
  total,
}: {
  rows: BucketRow[];
  totalLabel: string;
  total: number;
}) {
  return (
    <div className="px-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
            <th className="px-2 py-2 text-left">Tier</th>
            <th className="px-2 py-2 text-right">Orders</th>
            <th className="px-2 py-2 text-right">Delivered %</th>
            <th className="px-2 py-2 text-right">RTO %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const share = total > 0 ? r.total / total : 0;
            return (
              <tr key={r.key} className="border-t border-stroke/8">
                <td className={`px-2 py-2 ${r.tone}`}>
                  <span className="font-medium">{r.label}</span>
                  {total > 0 ? (
                    <span className="ml-2 text-2xs text-fg-subtle">
                      {pct(share)}
                    </span>
                  ) : null}
                </td>
                <td className="px-2 py-2 text-right text-fg">{r.total.toLocaleString()}</td>
                <td className="px-2 py-2 text-right text-fg">{pct(r.deliveredRate)}</td>
                <td className="px-2 py-2 text-right text-fg">{pct(r.rtoRate)}</td>
              </tr>
            );
          })}
          <tr className="border-t border-stroke/14">
            <td className="px-2 py-2 text-2xs font-semibold uppercase text-fg-subtle">
              {totalLabel}
            </td>
            <td className="px-2 py-2 text-right text-2xs font-semibold text-fg-subtle">
              {total.toLocaleString()}
            </td>
            <td colSpan={2} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

interface ThanaRow {
  thana: string;
  total: number;
  delivered: number;
  rto: number;
  inFlight: number;
  deliveredRate: number | null;
  rtoRate: number | null;
  pendingRate: number;
}

function ThanaTable({ rows }: { rows: ThanaRow[] }) {
  return (
    <div className="px-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
            <th className="px-2 py-2 text-left">Thana</th>
            <th className="px-2 py-2 text-right">Orders</th>
            <th className="px-2 py-2 text-right">Delivered %</th>
            <th className="px-2 py-2 text-right">RTO %</th>
            <th className="px-2 py-2 text-right">In flight %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.thana} className="border-t border-stroke/8">
              <td className="px-2 py-2 font-medium text-fg capitalize">{r.thana}</td>
              <td className="px-2 py-2 text-right text-fg">{r.total.toLocaleString()}</td>
              <td className="px-2 py-2 text-right text-fg">{pct(r.deliveredRate)}</td>
              <td className="px-2 py-2 text-right text-fg">{pct(r.rtoRate)}</td>
              <td className="px-2 py-2 text-right text-fg-subtle">{pct(r.pendingRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
