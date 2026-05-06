"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  MailCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Resend-cooldown window in seconds. Mirrors the rate-limit window the API
 * enforces — keep the two in lockstep so the user never gets a 429 they
 * could have avoided by reading the disabled-button countdown.
 */
const RESEND_COOLDOWN_SECONDS = 60;

function VerifyEmailSentInner() {
  const params = useSearchParams();
  const { data: session } = useSession();
  // Email comes from either the ?email= param (set by signup on redirect)
  // or the active session if available. Falls back to a generic line if
  // neither is present so we don't render an empty <strong></strong>.
  const email =
    params.get("email") ??
    session?.user?.email ??
    "";

  const [cooldown, setCooldown] = useState(0);
  const [resendState, setResendState] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [resendError, setResendError] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  async function handleResend() {
    if (cooldown > 0 || resendState === "sending") return;
    setResendState("sending");
    setResendError(null);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
      const res = await fetch(`${apiUrl}/auth/resend-verification`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Empty body is fine — the API resolves the merchant from the
        // session cookie. We pass `email` only as a fallback for the
        // anonymous resend path (e.g. signed-out user who hit /resend
        // from an old email).
        body: JSON.stringify(email ? { email } : {}),
        credentials: "include",
      });
      if (!res.ok) {
        if (res.status === 429) {
          setResendError(
            "Too many resends. Wait a minute before trying again.",
          );
        } else {
          setResendError("We couldn't send the email. Try again in a moment.");
        }
        setResendState("error");
        return;
      }
      setResendState("sent");
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch {
      setResendError("Network hiccup. Try again in a moment.");
      setResendState("error");
    }
  }

  return (
    <div className="cordon-card animate-slide-up border border-stroke/30 bg-surface p-7 shadow-elevated">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand/15 text-brand">
          <MailCheck className="h-5 w-5" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          You&apos;re in. Check your inbox to{" "}
          <span className="cordon-serif">activate protection.</span>
        </h1>
        <p className="max-w-sm text-sm text-fg-subtle">
          {email ? (
            <>
              We sent a verification link to{" "}
              <strong className="text-fg">{email}</strong>. Click it and
              Cordon starts scoring orders for you.
            </>
          ) : (
            <>
              We just emailed you a verification link. Click it and Cordon
              starts scoring orders for you.
            </>
          )}
        </p>
        <p className="text-xs text-fg-faint">
          The link expires in 24 hours. Didn&apos;t arrive? Check spam, or
          resend below.
        </p>
      </div>

      <div className="mt-6 space-y-3">
        <Button
          type="button"
          onClick={handleResend}
          disabled={cooldown > 0 || resendState === "sending"}
          className="h-11 w-full bg-brand font-semibold text-brand-fg hover:bg-brand-hover disabled:opacity-60"
        >
          {resendState === "sending" ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Sending…
            </>
          ) : cooldown > 0 ? (
            <>Resend available in {cooldown}s</>
          ) : (
            <>Resend verification email</>
          )}
        </Button>

        {resendState === "sent" ? (
          <div className="flex items-start gap-2 rounded-md border border-success-border bg-success-subtle px-3 py-2 text-sm text-success">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Email resent. Check your inbox in a moment.</span>
          </div>
        ) : null}

        {resendState === "error" && resendError ? (
          <div className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{resendError}</span>
          </div>
        ) : null}
      </div>

      <div className="mt-6 flex flex-col items-center gap-2 text-xs text-fg-faint">
        <p>
          Wrong email?{" "}
          <Link
            href="/signup"
            className="font-medium text-brand underline-offset-4 hover:underline"
          >
            Start over
          </Link>
        </p>
        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 text-fg-muted hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
        </Link>
      </div>
    </div>
  );
}

export default function VerifyEmailSentPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailSentInner />
    </Suspense>
  );
}
