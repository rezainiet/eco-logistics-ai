"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

type Status = "loading" | "success" | "error";

function VerifyEmailContent() {
  const params = useSearchParams();
  const token = params.get("token");
  const [status, setStatus] = useState<Status>(token ? "loading" : "error");
  const [message, setMessage] = useState<string | null>(
    token ? null : "This link is missing its verification token.",
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
      try {
        const res = await fetch(`${apiUrl}/auth/verify-email`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        if (res.ok) {
          setStatus("success");
        } else {
          setStatus("error");
          setMessage("This verification link is invalid or has expired.");
        }
      } catch {
        if (!cancelled) {
          setStatus("error");
          setMessage("Couldn't reach the server. Please try again.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status === "loading") {
    return (
      <div className="cordon-card border border-stroke/30 bg-surface p-7 shadow-elevated">
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-brand" />
          <h1 className="text-lg font-semibold text-fg">Verifying your email…</h1>
          <p className="text-sm text-fg-subtle">This won't take long.</p>
        </div>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="cordon-card border border-stroke/30 bg-surface p-7 shadow-elevated animate-slide-up">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-success-subtle text-success">
            <CheckCircle2 className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">
            You&apos;re <span className="cordon-serif">verified.</span>
          </h1>
          <p className="max-w-sm text-sm text-fg-subtle">
            The pipeline is now live on your workspace — Cordon will start
            scoring orders the moment your first webhook lands.
          </p>
          <Link
            href="/dashboard"
            className="mt-2 inline-flex h-11 items-center rounded-md bg-brand px-4 text-sm font-semibold text-brand-fg hover:bg-brand-hover"
          >
            Open dashboard <span className="cordon-arrow ml-1.5">→</span>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-stroke/10 bg-surface p-7 shadow-elevated animate-slide-up">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-danger-subtle text-danger">
          <AlertCircle className="h-5 w-5" />
        </div>
        <h1 className="text-xl font-semibold text-fg">Couldn't verify email</h1>
        <p className="max-w-sm text-sm text-fg-subtle">
          {message ?? "Something went wrong."}
        </p>
        <Link
          href="/dashboard"
          className="mt-2 inline-flex h-10 items-center rounded-md border border-stroke/14 px-4 text-sm font-medium text-fg hover:bg-surface-raised"
        >
          Continue to dashboard
        </Link>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailContent />
    </Suspense>
  );
}
