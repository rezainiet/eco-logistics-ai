"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertCircle, ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const schema = z.object({
  email: z.string().email("That doesn't look like an email."),
});
type FormValues = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    getValues,
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setError(null);
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    const res = await fetch(`${apiUrl}/auth/request-reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!res.ok) {
      // Differentiate transient/network failure from rate-limit so the
      // merchant knows whether to retry now or wait. Anything else falls
      // back to the generic "couldn't reach service" copy.
      if (res.status === 429) {
        setError(
          "Too many reset requests. Wait a few minutes before trying again.",
        );
      } else {
        setError(
          "We couldn't reach the reset service. Try again in a moment.",
        );
      }
      return;
    }
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="cordon-card animate-slide-up border border-stroke/30 bg-surface p-7 shadow-elevated">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-success-subtle text-success">
            <CheckCircle2 className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">
            Check your inbox
          </h1>
          <p className="max-w-sm text-sm text-fg-subtle">
            If an account exists for{" "}
            <strong className="text-fg">{getValues("email")}</strong>, we just
            emailed a password reset link. It expires in 60 minutes.
          </p>
          <p className="text-xs text-fg-faint">
            Didn&apos;t receive it? Check spam or{" "}
            <button
              type="button"
              onClick={() => setSubmitted(false)}
              className="font-medium text-brand underline-offset-4 hover:underline"
            >
              try a different email
            </button>
            .
          </p>
        </div>
        <Link
          href="/login"
          className="mt-6 inline-flex w-full items-center justify-center gap-1.5 text-sm font-medium text-fg-muted hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="cordon-card animate-slide-up border border-stroke/30 bg-surface p-7 shadow-elevated">
      <div className="mb-6 space-y-1.5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          Forgot password?
        </h1>
        <p className="text-sm text-fg-subtle">
          Enter the email on your Cordon account. We&apos;ll send a reset link.
        </p>
      </div>
      {/*
        SECURITY: explicit method="post" + dummy action + capturing
        onSubmit with preventDefault. Even though this form only takes
        an email (lower-stakes than the password forms), we apply the
        same hardening so the pattern is uniform across every auth
        surface — easier to audit, no exception that could miss a
        future field.
      */}
      <form
        method="post"
        action="/api/auth/__nope"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit(onSubmit)(e);
        }}
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@business.com"
            {...register("email")}
          />
          {errors.email && <p className="text-xs text-danger">{errors.email.message}</p>}
        </div>
        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
        <Button
          type="submit"
          className="h-11 w-full bg-brand font-semibold text-brand-fg hover:bg-brand-hover"
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Sending link…
            </>
          ) : (
            "Send reset link"
          )}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-fg-subtle">
        Remembered it?{" "}
        <Link
          href="/login"
          className="font-medium text-brand underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
