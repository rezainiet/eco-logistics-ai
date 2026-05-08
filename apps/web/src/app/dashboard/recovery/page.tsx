"use client";

import { useState } from "react";
import {
  CheckCircle2,
  LifeBuoy,
  Mail,
  MessageSquare,
  Phone,
  Sparkles,
  XCircle,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useVisibilityInterval } from "@/lib/use-visibility-interval";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { formatNumber, formatRelative } from "@/lib/formatters";

const TIER_LABEL: Record<string, string> = {
  starter: "Starter",
  growth: "Growth",
  scale: "Scale",
  enterprise: "Enterprise",
};

export default function RecoveryPage() {
  const ent = trpc.recovery.getEntitlements.useQuery();
  const enabled = !!ent.data?.enabled;
  const interval = useVisibilityInterval(30_000);

  const list = trpc.recovery.list.useQuery(
    { status: "pending", limit: 100 },
    { enabled, retry: false, refetchInterval: interval },
  );
  const counts = trpc.recovery.counts.useQuery(undefined, {
    enabled,
    retry: false,
    refetchInterval: interval,
  });
  const utils = trpc.useUtils();

  const update = trpc.recovery.update.useMutation({
    onSuccess: () => {
      void utils.recovery.list.invalidate();
      void utils.recovery.counts.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  if (ent.isSuccess && !enabled) {
    return <RecoveryUpsell tier={ent.data.tier} next={ent.data.recommendedUpgradeTier} />;
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Outreach"
        title="Cart recovery"
        description="Identified buyers who added items to cart but didn't check out. Reach them while their intent is hot."
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Pending"
          value={formatNumber(counts.data?.pending.count)}
          icon={LifeBuoy}
          tone="warning"
          loading={counts.isLoading}
          footer={`BDT ${formatNumber(counts.data?.pending.cartValue)} in cart`}
        />
        <StatCard
          label="Contacted"
          value={formatNumber(counts.data?.contacted.count)}
          icon={Phone}
          tone="info"
          loading={counts.isLoading}
        />
        <StatCard
          label="Recovered"
          value={formatNumber(counts.data?.recovered.count)}
          icon={CheckCircle2}
          tone="success"
          loading={counts.isLoading}
          footer={`BDT ${formatNumber(counts.data?.recoveredValue)} recovered`}
        />
        <StatCard
          label="Pipeline value"
          value={`BDT ${formatNumber(counts.data?.pipelineValue)}`}
          icon={Sparkles}
          tone="brand"
          loading={counts.isLoading}
          footer="Pending + contacted carts"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pending outreach</CardTitle>
          <p className="text-xs text-fg-subtle">
            Stitched-identity sessions abandoned with items in cart. Mark
            contacted as you reach out — recovered orders auto-link by phone.
          </p>
        </CardHeader>
        <CardContent>
          {list.isLoading ? (
            <div className="text-fg-subtle">Loading…</div>
          ) : (list.data ?? []).length === 0 ? (
            <EmptyState
              icon={LifeBuoy}
              tone="success"
              title="Inbox is clear"
              description="No identified buyers have abandoned a cart in the recovery window."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Identity</TableHead>
                  <TableHead>Cart</TableHead>
                  <TableHead>Top products</TableHead>
                  <TableHead>Abandoned</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(list.data ?? []).map((task) => (
                  <TableRow key={task.id}>
                    <TableCell>
                      <div className="text-sm font-medium text-fg">{task.phone ?? task.email}</div>
                      <div className="text-2xs text-fg-faint font-mono">{task.sessionId.slice(0, 12)}…</div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm font-semibold text-fg">
                        BDT {formatNumber(task.cartValue)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(task.topProducts ?? []).slice(0, 3).map((p) => (
                          <Badge key={p} variant="outline" className="bg-info-subtle text-info">
                            {p}
                          </Badge>
                        ))}
                        {(task.topProducts ?? []).length === 0 ? (
                          <span className="text-2xs text-fg-faint">—</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-fg-subtle">
                      {formatRelative(task.abandonedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <RecoveryActions
                        id={task.id}
                        hasPhone={!!task.phone}
                        hasEmail={!!task.email}
                        pending={update.isPending}
                        onAction={(payload) => update.mutate(payload)}
                      />
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
