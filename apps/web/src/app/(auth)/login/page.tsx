"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  // Default to /dashboard so the layout's NewMerchantRedirect can route
  // fresh merchants to the getting-started flow and returning merchants to
  // the KPI overview. The previous default (/dashboard/orders) dropped
  // every fresh signup straight onto an empty orders table.
  const callbackUrl = params.get("callbackUrl") ?? "/dashboard";
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setError(null);
    const res = await signIn("credentials", { ...values, redirect: false });
    if (!res || res.error) {
      setError("Invalid email or password");
      return;
    }
    router.push(callbackUrl);
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-stroke/10 bg-surface p-7 shadow-elevated animate-slide-up">
      <div className="mb-6 space-y-1.5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Welcome back</h1>
        <p className="text-sm text-fg-subtle">Sign in to your merchant workspace.</p>
      </div>
      {/*
        SECURITY: explicit method="post" + action="" + capturing onSubmit
        with native preventDefault. Defense-in-depth against credential
        leaks via the URL query string.

        The bug we're guarding: if React hasn't hydrated yet (slow first
        compile, hydration error, JS disabled), clicking submit triggers
        a native form submission. The browser default method is GET,
        which serializes ALL named fields into the URL query string —
        i.e. the password ends up in the URL bar, browser history,
        every reverse-proxy access log, and our own dev server stdout.
        Saw exactly that happen in dev:
          GET /Login?email=...&password=... 200

        Three layers of protection so this can't recur:
          1. method="post" — even on native fallback, no fields go in URL
          2. action="/api/auth/__nope" — a non-existent endpoint, so a
             native fall-through gets a 404 (loud) instead of silently
             reloading with credentials still in memory
          3. onSubmit's first line is e.preventDefault() — running
             unconditionally, regardless of whether react-hook-form's
             handleSubmit later succeeds or throws
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
          {errors.email && (
            <p className="text-xs text-danger">{errors.email.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link
              href="/forgot-password"
              className="text-xs font-medium text-fg-muted hover:text-brand"
            >
              Forgot?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder="At least 8 characters"
            {...register("password")}
          />
          {errors.password && (
            <p className="text-xs text-danger">{errors.password.message}</p>
          )}
        </div>
        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
        <Button
          type="submit"
          className="w-full bg-brand text-white hover:bg-brand-hover"
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Signing in…
            </>
          ) : (
            "Sign in"
          )}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-fg-subtle">
        No account?{" "}
        <Link
          href="/signup"
          className="font-medium text-brand underline-offset-4 hover:underline"
        >
          Create one
        </Link>
      </p>
    </div>
  );
}
