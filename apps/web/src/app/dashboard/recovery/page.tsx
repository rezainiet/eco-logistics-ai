"use client";

import { useState } from "react";
import {
  CheckCircle2,
  LifeBuoy,
  Mail,
  MessageSquare,
  Phone,
  ShoppingCart,
  Sparkles,
  XCircle,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useVisibilityInterval } from "@/lib/use-visibility-interval";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { KpiGrid } from "@/components/dashboard/kpi-grid";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { formatBDT, formatNumber, formatRelative } from "@/lib/formatters";
import { formatRecoveryRate, recoveryStage } from "@/lib/recovery/lifecycle";
import { PLAN_NAME } from "@/lib/plan-pricing";

// Plan names come from the catalogue (tier `scale` is shown as "Pro").
const TIER_LABEL: Record<string, string> = PLAN_NAME;

export default function RecoveryPage() {
  const ent = trpc.recovery.getEntitlements.useQuery();
  const enabled = !!ent.data?.enabled;
  const interval = useVisibilityInterval(30_000);

  const list = trpc.recovery.list.useQuery(
    { limit: 100 },
    { enabled, retry: false, refetchInterval: interval },
  );
  const summary = trpc.recovery.summary.useQuery(
    { days: 30 },
    { enabled, retry: false, refetchInterval: interval },
  );
  const utils = trpc.useUtils();

  const update = trpc.recovery.update.useMutation({
    onSuccess: () => {
      void utils.recovery.list.invalidate();
      void utils.recovery.summary.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  if (ent.isSuccess && !enabled) {
    return <RecoveryUpsell tier={ent.data.tier} next={ent.data.recommendedUpgradeTier} />;
  }

  const s = summary.data;
  const awaitingDelivery = Math.max(0, (s?.recoveredOrderValue ?? 0) - (s?.recoveredRevenue ?? 0));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Outreach"
        title="Cart recovery"
        description="Buyers who left items in their cart. Landing-page carts get one automatic reminder email with a link back to their saved cart; you can also reach out yourself."
      />

      <KpiGrid ariaLabel="Recovery results, last 30 days">
        <StatCard
          label="Abandoned carts"
          value={formatNumber(s?.abandonedCarts)}
          icon={ShoppingCart}
          tone="warning"
          loading={summary.isLoading}
          footer={`${formatNumber(s?.tasks)} reachable · last 30 days`}
        />
        <StatCard
          label="Recovered orders"
          value={formatNumber(s?.recovered)}
          icon={CheckCircle2}
          tone="success"
          loading={summary.isLoading}
          footer={`Recovery rate ${formatRecoveryRate(s?.recoveryRate)}`}
        />
        <StatCard
          label="Recovered revenue"
          value={formatBDT(s?.recoveredRevenue)}
          icon={Sparkles}
          tone="brand"
          loading={summary.isLoading}
          footer={awaitingDelivery > 0 ? `+ ${formatBDT(awaitingDelivery)} awaiting delivery` : "Delivered orders only"}
        />
        <StatCard
          label="Reminder emails"
          value={formatNumber(s?.emailsSent)}
          icon={Mail}
          tone="info"
          loading={summary.isLoading}
          footer={`${formatNumber(s?.clicked)} clicked · ${formatNumber(s?.checkoutsStarted)} checked out`}
        />
      </KpiGrid>

      <Card>
        <CardHeader>
          <CardTitle>Recovery queue</CardTitle>
          <CardDescription>
            Newest first. Revenue counts once a recovered order is delivered.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {list.isLoading ? (
            <div className="text-fg-subtle">Loading…</div>
          ) : list.isError ? (
            <div className="text-sm text-danger">Couldn&apos;t load the recovery queue. It will retry automatically.</div>
          ) : (list.data ?? []).length === 0 ? (
            <EmptyState
              icon={LifeBuoy}
              tone="success"
              title="No carts to recover right now"
              description="When a buyer adds items, leaves their phone or email, and doesn't check out, they'll show up here. Landing-page carts with an email get one automatic reminder."
              variant="inset"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Cart</TableHead>
                  <TableHead>Abandoned</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(list.data ?? []).map((task) => {
                  const stage = recoveryStage(task);
                  const open = task.status === "pending" || task.status === "contacted";
                  return (
                    <TableRow key={task.id}>
                      <TableCell>
                        <div className="text-sm font-medium text-fg">{task.email ?? task.phone}</div>
                        {task.email && task.phone ? <div className="text-2xs text-fg-faint">{task.phone}</div> : null}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm font-semibold text-fg">{formatBDT(task.cartValue)}</div>
                        <div className="max-w-[16rem] truncate text-2xs text-fg-faint" title={(task.topProducts ?? []).join(", ")}>
                          {(task.topProducts ?? []).slice(0, 3).join(", ") || "—"}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-fg-subtle">
                        {formatRelative(task.abandonedAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={stage.tone} title={task.emailError ?? undefined}>
                          {stage.label}
                        </Badge>
                        {task.emailSentAt && task.status !== "recovered" ? (
                          <div className="mt-1 text-2xs text-fg-faint">Emailed {formatRelative(task.emailSentAt)}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {task.recoveredOrder ? (
                          <div>
                            <div className="font-medium text-fg">#{task.recoveredOrder.number}</div>
                            <div className="text-2xs text-fg-faint">
                              {formatBDT(task.recoveredOrder.total)} · {task.recoveredOrder.status ?? "—"}
                            </div>
                          </div>
                        ) : (
                          <span className="text-fg-faint">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {open ? (
                          <RecoveryActions
                            id={task.id}
                            hasPhone={!!task.phone}
                            hasEmail={!!task.email}
                            pending={update.isPending}
                            onAction={(payload) => update.mutate(payload)}
                          />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RecoveryActions({
  id,
  hasPhone,
  hasEmail,
  pending,
  onAction,
}: {
  id: string;
  hasPhone: boolean;
  hasEmail: boolean;
  pending: boolean;
  onAction: (payload: {
    id: string;
    status: "contacted" | "recovered" | "dismissed";
    channel?: "call" | "sms" | "email";
  }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const wrap = (fn: () => void) => {
    setBusy(true);
    try {
      fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center justify-end gap-1.5">
      {hasPhone ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending || busy}
          onClick={() => wrap(() => onAction({ id, status: "contacted", channel: "call" }))}
        >
          <Phone className="mr-1 h-3.5 w-3.5" /> Call
        </Button>
      ) : null}
      {hasPhone ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending || busy}
          onClick={() => wrap(() => onAction({ id, status: "contacted", channel: "sms" }))}
        >
          <MessageSquare className="mr-1 h-3.5 w-3.5" /> SMS
        </Button>
      ) : null}
      {hasEmail ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending || busy}
          onClick={() => wrap(() => onAction({ id, status: "contacted", channel: "email" }))}
        >
          <Mail className="mr-1 h-3.5 w-3.5" /> Email
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        disabled={pending || busy}
        onClick={() => wrap(() => onAction({ id, status: "recovered" }))}
        title="Mark recovered"
      >
        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending || busy}
        onClick={() => wrap(() => onAction({ id, status: "dismissed" }))}
        title="Dismiss"
      >
        <XCircle className="h-3.5 w-3.5 text-fg-faint" />
      </Button>
    </div>
  );
}

function RecoveryUpsell({ tier, next }: { tier: string; next: string | null }) {
  const target = TIER_LABEL[next ?? "growth"] ?? "Growth";
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Outreach" title="Cart recovery" />
      <Card className="border-warning-border bg-warning-subtle/40">
        <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
          <Sparkles className="h-10 w-10 text-warning" />
          <div className="max-w-md space-y-1">
            <h3 className="text-base font-semibold text-fg">
              Cart recovery is on {target} and above
            </h3>
            <p className="text-xs text-fg-subtle">
              You're on {TIER_LABEL[tier] ?? tier}. Upgrade to surface buyers
              who abandoned carts with items inside, and act on them via call,
              SMS, or email — directly recovering revenue.
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
