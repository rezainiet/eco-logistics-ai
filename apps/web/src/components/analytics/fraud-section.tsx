"use client";

import Link from "next/link";
import {
  BadgeDollarSign,
  CheckCircle2,
  PhoneOff,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { trpc } from "@/lib/trpc";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

function formatBDT(n: number): string {
  return `৳ ${n.toLocaleString()}`;
}

function Metric({
  label,
  value,
  icon: Icon,
  sub,
  accent,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  sub?: string;
  accent: string;
}) {
  return (
    <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-[0.4px] text-[#9CA3AF]">
          {label}
        </CardTitle>
        <div
          className="flex h-8 w-8 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${accent}22` }}
        >
          <Icon className="h-4 w-4" style={{ color: accent }} />
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="text-2xl font-semibold text-[#F3F4F6]">{value}</p>
        {sub ? <p className="text-xs text-[#9CA3AF]">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

export function FraudSection() {
  const stats = trpc.fraud.getReviewStats.useQuery({ days: 7 });
  const loading = stats.isLoading;
  const today = stats.data?.today ?? { risky: 0, verified: 0, rejected: 0, codSaved: 0 };
  const window = stats.data?.window ?? { risky: 0, verified: 0, rejected: 0, codSaved: 0 };
  const queue = stats.data?.queue ?? { pending: 0, noAnswer: 0 };

  const metrics = [
    {
      label: "Risky today",
      value: loading ? "…" : today.risky.toLocaleString(),
      icon: ShieldAlert,
      sub: `${window.risky} in last 7d`,
      accent: "#EF4444",
    },
    {
      label: "Verified today",
      value: loading ? "…" : today.verified.toLocaleString(),
      icon: ShieldCheck,
      sub: `${window.verified} in last 7d`,
      accent: "#10B981",
    },
    {
      label: "Rejected today",
      value: loading ? "…" : today.rejected.toLocaleString(),
      icon: PhoneOff,
      sub: `${window.rejected} in last 7d`,
      accent: "#F59E0B",
    },
    {
      label: "COD saved",
      value: loading ? "…" : formatBDT(window.codSaved),
      icon: BadgeDollarSign,
      sub: today.codSaved > 0 ? `${formatBDT(today.codSaved)} today` : "Last 7 days",
      accent: "#8B5CF6",
    },
  ];

  const queueTotal = queue.pending + queue.noAnswer;

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-[#F3F4F6]">
            Fraud protection
          </h2>
          <p className="mt-0.5 text-sm text-[#9CA3AF]">
            COD verification queue + rejected orders
          </p>
        </div>
        <Button
          asChild
          variant="outline"
          className="border-[rgba(0,132,212,0.3)] bg-[rgba(0,132,212,0.08)] text-[#60A5FA] hover:bg-[rgba(0,132,212,0.15)]"
        >
          <Link href="/dashboard/fraud-review">
            {queueTotal > 0 ? `${queueTotal} to review` : "Review queue"}
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((m) => (
          <Metric
            key={m.label}
            label={m.label}
            value={m.value}
            icon={m.icon}
            sub={m.sub}
            accent={m.accent}
          />
        ))}
      </div>

      {queueTotal > 0 && (
        <Card className="border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.06)] text-[#F3F4F6]">
          <CardHeader>
            <CardTitle className="text-base font-semibold text-[#FCA5A5]">
              Action required
            </CardTitle>
            <CardDescription className="text-[#D1D5DB]">
              {queue.pending.toLocaleString()} pending call · {queue.noAnswer.toLocaleString()}{" "}
              no answer — these orders cannot be booked until reviewed.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </section>
  );
}
