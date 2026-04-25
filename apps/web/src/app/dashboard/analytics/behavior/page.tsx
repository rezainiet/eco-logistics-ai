"use client";

import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  Download,
  Eye,
  Flame,
  Lock,
  ShoppingCart,
  ShieldAlert,
  Sparkles,
  Users,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartCard } from "@/components/charts/chart-card";
import {
  CHART_AXIS_STROKE,
  CHART_COLORS,
  CHART_CURSOR_FILL,
  CHART_GRID_STROKE,
  CHART_TOOLTIP_STYLE,
} from "@/components/charts/chart-style";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatNumber, formatPercent, formatRelative } from "@/lib/formatters";

const STAGE_COLORS: Record<string, string> = {
  page_view: CHART_COLORS.brand,
  product_view: CHART_COLORS.info,
  add_to_cart: CHART_COLORS.success,
  checkout_start: CHART_COLORS.warning,
  checkout_submit: CHART_COLORS.danger,
};

function fmtDuration(ms: number): string {
  if (!ms || ms < 1000) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

const TIER_LABEL: Record<string, string> = {
  starter: "Starter",
  growth: "Growth",
  scale: "Scale",
  enterprise: "Enterprise",
};

export default function BehaviorAnalyticsPage() {
  const [days, setDays] = useState(30);
  const entitlements = trpc.tracking.getEntitlements.useQuery();
  const ent = entitlements.data;
  const canBehavior = !!ent?.behaviorAnalytics;
  const canAdvanced = !!ent?.advancedBehaviorTables;
  const canExport = !!ent?.behaviorExports;

  const overview = trpc.tracking.overview.useQuery(
    { days },
    { enabled: canBehavior, retry: false },
  );
  const funnel = trpc.tracking.funnel.useQuery(
    { days },
    { enabled: canBehavior, retry: false },
  );
  const top = trpc.tracking.topProducts.useQuery(
    { days, limit: 10 },
    { enabled: canBehavior, retry: false },
  );
  const intent = trpc.tracking.highIntentSessions.useQuery(
    { days: Math.min(days, 14), limit: 15 },
    { enabled: canAdvanced, retry: false },
  );
  const repeat = trpc.tracking.repeatVisitors.useQuery(
    { days },
    { enabled: canBehavior, retry: false },
  );
  const suspicious = trpc.tracking.suspiciousSessions.useQuery(
    { days: Math.min(days, 14), limit: 15 },
    { enabled: canAdvanced, retry: false },
  );
  const utils = trpc.useUtils();

  if (entitlements.isSuccess && ent && !canBehavior) {
    return <BehaviorUpsell tier={ent.tier} next={ent.recommendedUpgradeTier} />;
  }

  const o = overview.data;
  const funnelData = (funnel.data ?? []).map((s) => ({
    name: s.stage.replace(/_/g, " "),
    sessions: s.sessions,
    rate: Math.round(s.rate * 100),
    color: STAGE_COLORS[s.stage] ?? CHART_COLORS.brand,
  }));

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Insights"
        title="Behavior analytics"
        description={
          ent?.behaviorRetentionDays === null
            ? "Storefront intent, abandon funnel, repeat visitors, and suspicious session detection — custom retention enabled."
            : `Storefront intent, abandon funnel, repeat visitors, and suspicious session detection — ${ent?.behaviorRetentionDays ?? 30}-day retention on your plan.`
        }
        actions={
          <div className="flex items-center gap-2">
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="14">Last 14 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
                {ent?.behaviorRetentionDays === null || (ent?.behaviorRetentionDays ?? 0) >= 180 ? (
                  <SelectItem value="180">Last 180 days</SelectItem>
                ) : null}
                {ent?.behaviorRetentionDays === null ? (
                  <SelectItem value="365">Last 365 days</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            {canExport ? (
              <ExportButton days={days} onDone={() => utils.tracking.getEntitlements.invalidate()} />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Sessions"
          value={formatNumber(o?.sessions)}
          icon={Activity}
          tone="brand"
          loading={overview.isLoading}
          footer={`${formatNumber(o?.pageViews)} page views`}
        />
        <StatCard
          label="Conversion"
          value={formatPercent((o?.conversionRate ?? 0) * 100)}
          icon={Sparkles}
          tone="success"
          loading={overview.isLoading}
          footer={`${formatNumber(o?.converted)} checkouts`}
        />
        <StatCard
          label="Cart abandonment"
          value={formatPercent((o?.abandonRate ?? 0) * 100)}
          icon={ShoppingCart}
          tone="warning"
          invertDelta
          loading={overview.isLoading}
          footer={`${formatNumber(o?.abandoned)} sessions abandoned`}
        />
        <StatCard
          label="Repeat visitors"
          value={formatPercent((repeat.data?.share ?? 0) * 100)}
          icon={Users}
          tone="info"
          loading={repeat.isLoading}
          footer={`${formatNumber(repeat.data?.repeat)} of ${formatNumber(repeat.data?.total)} visitors`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title="Abandon funnel"
          description="Sessions reaching each step of the storefront flow."
        >
          <div className="h-72">
            {funnelData.length === 0 ? (
              <EmptyState
                icon={Eye}
                title="No data yet"
                description="Embed the SDK on your storefront to start collecting events."
              />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={funnelData} layout="vertical" margin={{ left: 24, right: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} horizontal={false} />
                  <XAxis type="number" stroke={CHART_AXIS_STROKE} />
                  <YAxis type="category" dataKey="name" stroke={CHART_AXIS_STROKE} width={120} />
                  <Tooltip
                    cursor={{ fill: CHART_CURSOR_FILL }}
                    contentStyle={CHART_TOOLTIP_STYLE}
                    formatter={(value: number, _n, p) =>
                      [`${value} sessions (${p.payload?.rate ?? 0}%)`, "Sessions"]
                    }
                  />
                  <Bar dataKey="sessions" radius={[0, 6, 6, 0]}>
                    {funnelData.map((row) => (
                      <Cell key={row.name} fill={row.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </ChartCard>

        <Card>
          <CardHeader>
            <CardTitle>Top viewed products</CardTitle>
            <p className="text-xs text-fg-subtle">Distinct sessions per product.</p>
          </CardHeader>
          <CardContent>
            {top.isLoading ? (
              <div className="text-fg-subtle">Loading…</div>
            ) : (top.data ?? []).length === 0 ? (
              <p className="text-xs text-fg-faint">No product views yet.</p>
            ) : (
              <ul className="space-y-2">
                {(top.data ?? []).map((p) => (
                  <li
                    key={p.productId}
                    className="flex items-center justify-between gap-3 rounded-md border border-stroke/8 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-fg">{p.name}</p>
                      <p className="text-2xs text-fg-faint">id: {p.productId}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-fg">{formatNumber(p.sessions)}</p>
                      <p className="text-2xs text-success">
                        {formatPercent(p.conversionRate * 100)} → cart
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            <span className="inline-flex items-center gap-2">
              <Flame className="h-4 w-4 text-warning" /> High-intent sessions
              {!canAdvanced ? <Lock className="h-3.5 w-3.5 text-fg-faint" /> : null}
            </span>
          </CardTitle>
          <p className="text-xs text-fg-subtle">
            Buyers who viewed multiple products, started checkout, or are repeat visitors. Reach out
            before they abandon.
          </p>
        </CardHeader>
        <CardContent>
          {!canAdvanced ? (
            <AdvancedTableLock tier={ent?.tier ?? "growth"} next={ent?.recommendedUpgradeTier ?? "scale"} />
          ) : intent.isLoading ? (
            <div className="text-fg-subtle">Loading…</div>
          ) : (intent.data ?? []).length === 0 ? (
            <EmptyState
              icon={Flame}
              title="No high-intent sessions yet"
              description="Sessions appear here once buyers start browsing."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Identity</TableHead>
                  <TableHead className="text-right">Views</TableHead>
                  <TableHead className="text-right">Cart</TableHead>
                  <TableHead className="text-right">Checkout</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead className="text-right">Intent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(intent.data ?? []).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-2xs">{s.sessionId.slice(0, 10)}…</TableCell>
                    <TableCell>
                      {s.phone ? (
                        <span className="text-xs text-fg">{s.phone}</span>
                      ) : s.email ? (
                        <span className="text-xs text-fg">{s.email}</span>
                      ) : (
                        <span className="text-2xs text-fg-faint">anon</span>
                      )}
                      {s.repeatVisitor ? (
                        <Badge variant="outline" className="ml-2 bg-info-subtle text-info">
                          repeat
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">{s.productViews}</TableCell>
                    <TableCell className="text-right">{s.addToCartCount}</TableCell>
                    <TableCell className="text-right">{s.checkoutStartCount}</TableCell>
                    <TableCell className="text-right">{fmtDuration(s.durationMs)}</TableCell>
                    <TableCell>{formatRelative(s.lastSeenAt)}</TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant="outline"
                        className={
                          s.intent >= 10
                            ? "bg-danger-subtle text-danger"
                            : s.intent >= 5
                              ? "bg-warning-subtle text-warning"
                              : "bg-info-subtle text-info"
                        }
                      >
                        {s.intent}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <span className="inline-flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-danger" /> Suspicious sessions
              {!canAdvanced ? <Lock className="h-3.5 w-3.5 text-fg-faint" /> : null}
            </span>
          </CardTitle>
          <p className="text-xs text-fg-subtle">
            Bot-like browsing patterns and cart hoarding. Flagged sessions feed the fraud engine.
          </p>
        </CardHeader>
        <CardContent>
          {!canAdvanced ? (
            <AdvancedTableLock tier={ent?.tier ?? "growth"} next={ent?.recommendedUpgradeTier ?? "scale"} />
          ) : suspicious.isLoading ? (
            <div className="text-fg-subtle">Loading…</div>
          ) : (suspicious.data ?? []).length === 0 ? (
            <EmptyState
              icon={ShieldAlert}
              title="No suspicious sessions"
              tone="success"
              description="Storefront traffic looks clean over this window."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead className="text-right">Views</TableHead>
                  <TableHead className="text-right">Cart</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(suspicious.data ?? []).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-2xs">{s.sessionId.slice(0, 10)}…</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {s.flags.map((f) => (
                          <Badge key={f} variant="outline" className="bg-warning-subtle text-warning">
                            {f}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{s.productViews}</TableCell>
                    <TableCell className="text-right">{s.addToCartCount}</TableCell>
                    <TableCell className="text-right">{fmtDuration(s.durationMs)}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant="outline" className="bg-danger-subtle text-danger">
                        {s.suspiciousScore}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BehaviorUpsell({
  tier,
  next,
}: {
  tier: string;
  next: string | null;
}) {
  const target = TIER_LABEL[next ?? "growth"] ?? "Growth";
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Insights"
        title="Behavior analytics"
        description="Storefront intent, abandon funnel, and identity-resolved buyer sessions."
      />
      <Card className="border-warning-border bg-warning-subtle/40">
        <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
          <Sparkles className="h-10 w-10 text-warning" />
          <div className="max-w-md space-y-1">
            <h3 className="text-base font-semibold text-fg">
              Behavior analytics is on {target} and above
            </h3>
            <p className="text-xs text-fg-subtle">
              You're on {TIER_LABEL[tier] ?? tier}. Upgrade to see your storefront
              funnel, top-viewed products, repeat-visitor rate, and identity-resolved
              buyer sessions stitched to delivered orders.
            </p>
          </div>
          <Button asChild>
            <a href="/dashboard/billing">
              <Sparkles className="mr-2 h-4 w-4" /> Upgrade to {target}
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function AdvancedTableLock({ tier, next }: { tier: string; next: string | null }) {
  const target = TIER_LABEL[next ?? "scale"] ?? "Scale";
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-warning-border bg-warning-subtle/30 px-6 py-8 text-center">
      <Lock className="h-6 w-6 text-warning" />
      <p className="text-sm font-semibold text-fg">Advanced behavior tables are on {target}</p>
      <p className="max-w-md text-xs text-fg-subtle">
        Surface high-intent buyers and bot-pattern sessions in real time. You're on{" "}
        {TIER_LABEL[tier] ?? tier} — upgrade to {target} to unlock.
      </p>
      <Button asChild size="sm">
        <a href="/dashboard/billing">
          <Sparkles className="mr-1 h-3.5 w-3.5" /> Upgrade
        </a>
      </Button>
    </div>
  );
}

function ExportButton({ days, onDone }: { days: number; onDone: () => void }) {
  const [pending, setPending] = useState(false);
  const utils = trpc.useUtils();
  const handle = async (kind: "sessions" | "events") => {
    setPending(true);
    try {
      const result = await utils.client.tracking.exportData.query({
        kind,
        days,
        limit: 5000,
      });
      const blob = new Blob([JSON.stringify(result, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `behavior-${kind}-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${result.count} ${kind}`);
      onDone();
    } catch (err) {
      toast.error((err as Error).message ?? "Export failed");
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => handle("sessions")}>
        <Download className="mr-1 h-3.5 w-3.5" /> Sessions
      </Button>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => handle("events")}>
        <Download className="mr-1 h-3.5 w-3.5" /> Events
      </Button>
    </div>
  );
}
