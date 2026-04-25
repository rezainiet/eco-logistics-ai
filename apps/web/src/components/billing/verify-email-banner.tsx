"use client";

import { useState } from "react";
import { MailCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";

/**
 * Shows once at the top of the dashboard for merchants whose email is still
 * unverified. Dismissed copy persists in localStorage so the prompt isn't a
 * nag — the verified status comes from `merchants.getProfile` so it
 * disappears the moment they click the link in their inbox.
 */
const DISMISS_KEY = "logistics:verify-email-dismissed";

export function VerifyEmailBanner() {
  const profile = trpc.merchants.getProfile.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  });
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  if (!profile.data || profile.data.emailVerified || dismissed) return null;

  async function resend() {
    if (!profile.data) return;
    setResending(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
      await fetch(`${apiUrl}/auth/resend-verification`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: profile.data.email }),
      });
      setResent(true);
    } finally {
      setResending(false);
    }
  }

  function dismiss() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(DISMISS_KEY, "1");
    }
    setDismissed(true);
  }

  return (
    <div className="mb-5 flex flex-col gap-2 rounded-lg border border-info-border bg-info-subtle px-3.5 py-2.5 text-sm text-info animate-fade-in sm:flex-row sm:items-center sm:justify-between">
      <span className="flex items-start gap-2">
        <MailCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Verify your email <strong className="font-semibold">{profile.data.email}</strong>{" "}
          to unlock receipt emails and trial reminders.
        </span>
      </span>
      <span className="flex items-center gap-2">
        {resent ? (
          <span className="text-xs font-medium">Sent — check your inbox.</span>
        ) : (
          <button
            type="button"
            onClick={resend}
            disabled={resending}
            className="rounded-md border border-info/30 bg-surface px-2.5 py-1 text-xs font-medium text-info hover:bg-info/10 disabled:opacity-60"
          >
            {resending ? "Sending…" : "Resend email"}
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          className="text-xs text-info/80 underline-offset-4 hover:underline"
        >
          Dismiss
        </button>
      </span>
    </div>
  );
}
