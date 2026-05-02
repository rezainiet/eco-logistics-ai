"use client";

import { useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { MailCheck, Clock } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { deriveOnboardingProgress } from "@/lib/onboarding/progress";

/**
 * Welcome hero rendered above the onboarding checklist on /dashboard/getting-started.
 *
 * Replaces the old utilitarian header (an h1 + p) with a personalised greeting,
 * a real progress ring, and inline pills for trial-days-left and email-verify.
 * The pills replace the stacked banners that the dashboard layout normally
 * shows — `<DashboardBanners>` suppresses those on this route so we don't
 * duplicate the call-to-action.
 *
 * Built defensively: every query has its own loading state and falls back to
 * sensible defaults rather than blocking the hero render. Brand new merchants
 * see the greeting and the ring even if some queries are still in-flight.
 */
const VERIFY_DISMISS_KEY = "logistics:verify-email-dismissed";

export function DashboardHero({ initialName }: { initialName?: string }) {
  const session = useSession();
  const profile = trpc.merchants.getProfile.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const plan = trpc.billing.getPlan.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const couriers = trpc.merchants.getCouriers.useQuery(undefined, { staleTime: 60_000 });
  const orders = trpc.orders.listOrders.useQuery(
    { limit: 5 } as never,
    { staleTime: 60_000 },
  );
  const automation = trpc.merchants.getAutomationConfig.useQuery(undefined, { staleTime: 60_000 });
  const integrations = trpc.integrations.list.useQuery(undefined, { staleTime: 60_000 });

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 5) return "Working late";
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    if (hour < 21) return "Good evening";
    return "Good evening";
  }, []);

  const firstName = useMemo(() => {
    // Prefer the live session value once it lands; fall back to the
    // server-rendered initialName so the greeting doesn't flicker
    // "Good evening" → "Good evening, Reza" on first paint.
    const raw =
      session.data?.user?.name ??
      session.data?.user?.email ??
      initialName ??
      "";
    if (!raw) return "";
    if (raw.includes("@")) return raw.split("@")[0]!.split(/[._-]/)[0] ?? "";
    return raw.split(/\s+/)[0] ?? "";
  }, [session.data?.user?.name, session.data?.user?.email, initialName]);

  const progress = useMemo(() => {
    const ordersData = orders.data as
      | { items?: Array<{ automationState?: string; bookedByAutomation?: boolean }> }
      | Array<{ automationState?: string; bookedByAutomation?: boolean }>
      | undefined
      | null;
    const ordersList = Array.isArray(ordersData)
      ? ordersData
      : Array.isArray(ordersData?.items)
        ? ordersData.items
        : [];
    return deriveOnboardingProgress({
      hasStoreConnected: (integrations.data ?? []).some(
        (i) => i.provider !== "csv" && i.status === "connected",
      ),
      hasCourier: (couriers.data ?? []).length > 0,
      hasFirstOrder: ordersList.length > 0,
      automationOn: automation.data?.enabled === true,
      smsTested: ordersList.some(
        (o) =>
          Boolean(o.bookedByAutomation) ||
          (typeof o.automationState === "string" &&
            ["auto_confirmed", "confirmed", "needs_call", "auto_cancelled"].includes(
              o.automationState,
            )),
      ),
    });
  }, [
    integrations.data,
    couriers.data,
    orders.data,
    automation.data?.enabled,
  ]);

  const trialDaysLeft = plan.data?.subscription?.trialDaysLeft;
  const isTrial = plan.data?.subscription?.status === "trial";
  const emailVerified = profile.data?.emailVerified ?? true;

  const subtitle = useMemo(() => {
    if (progress.complete) {
      return "You're fully set up. Automation is running on every new order.";
    }
    if (progress.doneCount === 0) {
      return "Let's ship your first order in the next 8 minutes. One step at a time, no copy-paste.";
    }
    if (progress.doneCount >= progress.totalCount - 1) {
      return "Almost there — one last step and your fulfilment runs itself.";
    }
    return `Nice — ${progress.doneCount} of ${progress.totalCount} done. Keep going, you're rolling.`;
  }, [progress.complete, progress.doneCount, progress.totalCount]);

  return (
    <section className="relative overflow-hidden rounded-lg border border-border bg-surface px-5 py-5 sm:px-6 sm:py-6 animate-slide-up">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-[radial-gradient(600px_180px_at_50%_-40px,hsl(var(--brand)/0.10),transparent_70%)]"
      />
      <div className="relative flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wider text-fg-faint">
            {new Intl.DateTimeFormat(undefined, {
              weekday: "long",
              month: "short",
              day: "numeric",
            }).format(new Date())}
          </p>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-fg">
            {greeting}
            {firstName ? `, ${firstName}` : ""}
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm text-fg-muted">{subtitle}</p>
          <HeroPills
            isTrial={isTrial}
            trialDaysLeft={trialDaysLeft}
            emailVerified={emailVerified}
            email={profile.data?.email}
          />
        </div>
        <ProgressRing
          percent={progress.percent}
          done={progress.doneCount}
          total={progress.totalCount}
        />
      </div>
    </section>
  );
}

function HeroPills({
  isTrial,
  trialDaysLeft,
  emailVerified,
  email,
}: {
  isTrial?: boolean;
  trialDaysLeft?: number | null;
  emailVerified: boolean;
  email?: string;
}) {
  const [verifyDismissed, setVerifyDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(VERIFY_DISMISS_KEY) === "1";
  });
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  async function resendVerification() {
    if (!email) return;
    setResending(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
      await fetch(`${apiUrl}/auth/resend-verification`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setResent(true);
    } finally {
      setResending(false);
    }
  }

  function dismissVerify() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(VERIFY_DISMISS_KEY, "1");
    }
    setVerifyDismissed(true);
  }

  const showTrial = isTrial && typeof trialDaysLeft === "number" && trialDaysLeft > 0;
  const showVerify = !emailVerified && !verifyDismissed && Boolean(email);

  if (!showTrial && !showVerify) return null;

  return (
    <div className="mt-3.5 flex flex-wrap items-center gap-2">
      {showTrial ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-info/25 bg-info/10 px-2.5 py-1 text-xs font-medium text-info">
          <Clock className="h-3 w-3" aria-hidden />
          {trialDaysLeft} day{trialDaysLeft === 1 ? "" : "s"} left in trial
        </span>
      ) : null}
      {showVerify ? (
        <span className="inline-flex items-center gap-2 rounded-full border border-warning/25 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning">
          <MailCheck className="h-3 w-3" aria-hidden />
          {resent ? (
            <span>Verification sent — check your inbox</span>
          ) : (
            <>
              <span>Verify your email</span>
              <button
                type="button"
                onClick={resendVerification}
                disabled={resending}
                className="text-warning underline-offset-2 hover:underline disabled:opacity-60"
              >
                {resending ? "sending…" : "resend"}
              </button>
              <span aria-hidden className="text-warning/40">
                ·
              </span>
              <button
                type="button"
                onClick={dismissVerify}
                className="text-warning/80 hover:text-warning"
                aria-label="Dismiss email verification reminder"
              >
                dismiss
              </button>
            </>
          )}
        </span>
      ) : null}
    </div>
  );
}

function ProgressRing({
  percent,
  done,
  total,
}: {
  percent: number;
  done: number;
  total: number;
}) {
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(100, percent)) / 100);
  return (
    <div
      className="flex shrink-0 flex-col items-center gap-1.5"
      role="img"
      aria-label={`${done} of ${total} onboarding steps complete`}
    >
      <div className="relative">
        <svg
          width="92"
          height="92"
          viewBox="0 0 92 92"
          className="-rotate-90"
          aria-hidden
        >
          <circle
            cx="46"
            cy="46"
            r={radius}
            stroke="hsl(var(--stroke-default) / 0.12)"
            strokeWidth="6"
            fill="none"
          />
          <circle
            cx="46"
            cy="46"
            r={radius}
            stroke="hsl(var(--brand))"
            strokeWidth="6"
            fill="none"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-[stroke-dashoffset] duration-700 ease-out"
          />
        </svg>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-center leading-tight">
            <div className="text-lg font-semibold tabular-nums text-fg">{percent}%</div>
          </div>
        </div>
      </div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">
        {done} of {total} done
      </div>
    </div>
  );
}
