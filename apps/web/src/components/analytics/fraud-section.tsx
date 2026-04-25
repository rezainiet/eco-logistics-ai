"use client";

import Link from "next/link";
import {
  BadgeDollarSign,
  PhoneOff,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { Heading } from "@/components/ui/heading";
import { formatBDT } from "@/lib/formatters";

export function FraudSection() {
  const stats = trpc.fraud.getReviewStats.useQuery({ days: 7 });
  const loading = stats.isLoading;
  const today = stats.data?.today ?? { risky: 0, verified: 0, rejected: 0, codSaved: 0 };
  const window = stats.data?.window ?? { risky: 0, verified: 0, rejected: 0, codSaved: 0 };
  const queue = stats.data?.queue ?? { pending: 0, noAnswer: 0 };

  const queueTotal = queue.pending + queue.noAnswer;

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-0.5">
          <Heading level="section">Fraud protection</Heading>
          <p className="text-xs text-fg-subtle">
            COD verification queue &amp; rejected orders
          </p>
        </div>
        <Button
          asChild
          variant="outline"
          className="border-brand/30 bg-brand-subtle text-brand hover:bg-brand/20 hover:text-brand"
        >
          <Link href="/dashboard/fraud-review">
            {queueTotal > 0 ? `${queueTotal} to review` : "Review queue"}
          </Link>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Risky today"
          value={loading ? "—" : today.risky.toLocaleString()}
          icon={ShieldAlert}
          tone="danger"
          footer={`${window.risky} in last 7d`}
          loading={loading}
        />
        <StatCard
          label="Verified today"
          value={loading ? "—" : today.verified.toLocaleString()}
          icon={ShieldCheck}
          tone="success"
          footer={`${window.verified} in last 7d`}
          loading={loading}
        />
        <StatCard
          label="Rejected today"
          value={loading ? "—" : today.rejected.toLocaleString()}
          icon={PhoneOff}
          tone="warning"
          footer={`${window.rejected} in last 7d`}
          loading={loading}
        />
        <StatCard
          label="COD saved"
          value={loading ? "—" : formatBDT(window.codSaved)}
          icon={BadgeDollarSign}
          tone="violet"
          footer={
            today.codSaved > 0 ? `${formatBDT(today.codSaved)} today` : "Last 7 days"
          }
          loading={loading}
        />
      </div>

      {queueTotal > 0 && (
        <div className="rounded-xl border border-danger-border bg-danger-subtle p-4">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-danger/20 text-danger">
              <ShieldAlert className="h-4 w-4" />
            </span>
            <div className="space-y-0.5">
              <p className="text-sm font-semibold text-danger">Action required</p>
              <p className="text-xs text-fg-muted">
                {queue.pending.toLocaleString()} pending call ·{" "}
                {queue.noAnswer.toLocaleString()} no answer — these orders cannot
                be booked until reviewed.
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
