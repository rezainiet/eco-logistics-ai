"use client";

import { Bot, Coins, ShieldCheck, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface RoiSnapshot {
  ordersAutomated: number;
  rtoLikelyPrevented: number;
  smsConfirmationsSent: number;
  estimatedSavedBdt: number;
  periodLabel: string;
}

const fmt = new Intl.NumberFormat("en-BD", { style: "currency", currency: "BDT", maximumFractionDigits: 0 });

export function RoiCard({ snapshot }: { snapshot: RoiSnapshot }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-4 w-4 text-success" aria-hidden />
          Automation impact ({snapshot.periodLabel})
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="flex items-center gap-1 text-xs uppercase tracking-wider text-fg-muted">
            <Bot className="h-3 w-3" aria-hidden /> Orders automated
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-fg">
            {snapshot.ordersAutomated.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="flex items-center gap-1 text-xs uppercase tracking-wider text-fg-muted">
            <ShieldCheck className="h-3 w-3" aria-hidden /> RTOs likely prevented
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-fg">
            {snapshot.rtoLikelyPrevented.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="flex items-center gap-1 text-xs uppercase tracking-wider text-fg-muted">
            <Coins className="h-3 w-3" aria-hidden /> Estimated saved
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-fg">
            {fmt.format(snapshot.estimatedSavedBdt)}
          </div>
          <div className="text-[11px] italic text-fg-faint">est. — see how we calculate</div>
        </div>
        <div>
          <div className="flex items-center gap-1 text-xs uppercase tracking-wider text-fg-muted">
            SMS confirmations
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-fg">
            {snapshot.smsConfirmationsSent.toLocaleString()}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function buildRoiSnapshot(input: {
  ordersAutomated: number;
  rtoLikelyPrevented: number;
  smsConfirmationsSent: number;
  periodLabel: string;
  costPerRtoBdt?: number;
}): RoiSnapshot {
  const cost = input.costPerRtoBdt ?? 200;
  return {
    ordersAutomated: Math.max(0, input.ordersAutomated),
    rtoLikelyPrevented: Math.max(0, input.rtoLikelyPrevented),
    smsConfirmationsSent: Math.max(0, input.smsConfirmationsSent),
    estimatedSavedBdt: Math.max(0, input.rtoLikelyPrevented) * cost,
    periodLabel: input.periodLabel,
  };
}
