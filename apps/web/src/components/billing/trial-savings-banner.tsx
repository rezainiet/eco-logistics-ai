"use client";

import Link from "next/link";
import { Sparkles, ArrowRight } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatBDT } from "@/lib/formatters";

/**
 * Trial-countdown banner with a live "Cordon has saved you ৳…" figure.
 *
 * Replaces the bare "Trial ends in N days" line with a persuasion-grade
 * banner: shows the merchant the concrete BDT amount Cordon has already
 * blocked from going to fraudulent COD orders during their trial. Only
 * renders for trial accounts; signed-in paid merchants see nothing.
 *
 * Data sources (all already-existing tRPC procedures, zero new backend):
 *   - `billing.getPlan`        → trialDaysLeft, status === "trial"
 *   - `fraud.getReviewStats`   → window.codSaved (rejected reviews × cod)
 *
 * Failure isolation: any query erroring renders nothing. The banner is
 * decorative; never blocks the dashboard.
 */
export function TrialSavingsBanner() {
  const plan = trpc.billing.getPlan.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  // 30-day window matches the trial length so the figure is "what Cordon
  // saved you during your trial," not lifetime.
  const fraud = trpc.fraud.getReviewStats.useQuery(
    { days: 30 },
    { staleTime: 60_000, refetchOnWindowFocus: false },
  );

  if (plan.isError || fraud.isError) return null;
  if (!plan.data) return null;
  // billing.getPlan returns { subscription: { status, trialDaysLeft, … }, plan, stripe }.
  // Read the nested fields rather than the legacy flat shape.
  const sub = plan.data.subscription;
  if (!sub || sub.status !== "trial") return null;

  const daysLeft = typeof sub.trialDaysLeft === "number" ? sub.trialDaysLeft : null;
  if (daysLeft === null) return null;

  const codSaved = fraud.data?.window?.codSaved ?? 0;

  // Two visual modes:
  //   - "early trial" (>3 days left, savings >0)  → soft brand banner,
  //     emphasises the save amount as proof Cordon is already paying off.
  //   - "expiring soon" (≤3 days)                  → warning tone,
  //     emphasises urgency. Falls back to "trial ends" copy when codSaved
  //     is still 0 (merchant just signed up, no fraud caught yet).
  const expiringSoon = daysLeft <= 3;
  const hasSavings = codSaved > 0;

  return (
    <div
      className={
        "flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm " +
        (expiringSoon
          ? "border-warning-border bg-warning-subtle text-warning"
          : "border-brand/25 bg-brand/5 text-fg-muted")
      }
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={
            "inline-block h-2 w-2 rounded-full " +
            (expiringSoon
              ? "bg-warning shadow-[0_0_8px_hsl(var(--warning))]"
              : "bg-brand shadow-[0_0_10px_hsl(var(--brand))]")
          }
        />
        <span>
          <strong className={expiringSoon ? "text-warning" : "text-fg"}>
            {daysLeft} day{daysLeft === 1 ? "" : "s"} left
          </strong>{" "}
          on your trial
          {hasSavings ? (
            <>
              {" · "}
              Cordon has saved you{" "}
              <strong className={expiringSoon ? "text-warning" : "text-fg"}>
                {formatBDT(codSaved)}
              </strong>{" "}
              so far
            </>
          ) : null}
        </span>
      </div>
      <Link
        href="/pricing"
        className={
          "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors " +
          (expiringSoon
            ? "bg-warning text-bg hover:bg-warning/90"
            : "bg-brand text-brand-fg hover:bg-brand-hover")
        }
      >
        {hasSavings ? "Lock in your plan" : "Choose a plan"}
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
      {/* Subtle footer hint — only when we have a savings figure to anchor on. */}
      {hasSavings ? (
        <span className="hidden w-full items-center gap-1.5 text-2xs text-fg-faint md:flex">
          <Sparkles className="h-3 w-3 text-brand" aria-hidden />
          Based on flagged orders we&apos;ve already blocked from being booked.
          Real number; updates as more orders run through Cordon.
        </span>
      ) : null}
    </div>
  );
}
