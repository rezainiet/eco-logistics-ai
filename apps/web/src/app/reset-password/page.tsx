"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const schema = z
  .object({
    password: z.string().min(8, "At least 8 characters."),
    confirm: z.string().min(8),
  })
  .refine((v) => v.password === v.confirm, {
    message: "Passwords do not match.",
    path: ["confirm"],
  });
type FormValues = z.infer<typeof schema>;

function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ email: string } | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  if (!token) {
    return (
      <div className="cordon-card border border-stroke/30 bg-surface p-7 shadow-elevated">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-danger-subtle text-danger">
            <AlertCircle className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-semibold text-fg">Reset link missing</h1>
          <p className="text-sm text-fg-subtle">
            This page needs a token in the URL. Open the latest reset email
            or request a new link.
          </p>
          <Link
            href="/forgot-password"
            className="mt-2 inline-flex h-10 items-center rounded-md bg-brand px-4 text-sm font-semibold text-brand-fg hover:bg-brand-hover"
          >
            Request a new link
          </Link>
        </div>
      </div>
    );
  }

  async function onSubmit(values: FormValues) {
    setError(null);
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    const res = await fetch(`${apiUrl}/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: values.password }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      // Differentiate the three reset-token failure modes so the merchant
      // knows whether to request a new link, sign in, or just retry. The
      // backend already returns these strings; we just translate them.
      const raw = typeof body.error === "string" ? body.error.toLowerCase() : "";
      let detail = "This reset link is invalid or has expired.";
      if (raw.includes("expired")) {
        detail = "This reset link has expired. Request a new one.";
      } else if (raw.includes("used")) {
        detail = "This link has already been used. Sign in or request a new link.";
      } else if (raw.includes("invalid")) {
        detail = "This reset link is invalid. Request a new one.";
      } else if (typeof body.error === "string" && body.error) {
        detail = body.error;
      }
      setError(detail);
      return;
    }
    const body = (await res.json()) as { email?: string };
    setDone({ email: body.email ?? "" });

    // Best-effort auto-login so the merchant lands inside the dashboard.
    // Aligned with login/signup: always /dashboard, never /dashboard/orders
    // — the dashboard layout does its own NewMerchantRedirect routing.
    if (body.email) {
      const signed = await signIn("credentials", {
        email: body.email,
        password: values.password,
        redirect: false,
      });
      if (signed && !signed.error) {
        router.push("/dashboard");
        router.refresh();
        return;
      }
    }
    setTimeout(() => router.push("/login"), 1500);
  }

  if (done) {
    return (
      <div className="cordon-card animate-slide-up border border-stroke/30 bg-surface p-7 shadow-elevated">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-success-subtle text-success">
            <CheckCircle2 className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-semibold text-fg">Password updated</h1>
          <p className="text-sm text-fg-subtle">
            We&apos;ve signed out every other session. Taking you to your
            dashboard… If nothing happens, head back to{" "}
            <Link href="/login" className="text-brand underline-offset-4 hover:underline">
              sign in
            </Link>
            .
          </p>
        </div>
      </div>
    );
  }

  const password = watch("password") ?? "";
  const strength = passwordStrength(password);

  return (
    <div className="cordon-card animate-slide-up border border-stroke/30 bg-surface p-7 shadow-elevated">
      <div className="mb-6 space-y-1.5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          Choose a new password
        </h1>
        <p className="text-sm text-fg-subtle">
          Use at least 8 characters. A passphrase you&apos;ll remember works well.
        </p>
      </div>
      {/*
        SECURITY: explicit method="post" + dummy action + capturing
        onSubmit with native preventDefault. Without this, a slow
        first-compile / hydration error causes the browser's native
        form submit to fall through as GET, putting the new password
        in the URL — history, dev stdout, every reverse-proxy log.
        See login/page.tsx for the original incident note.
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
          <Label htmlFor="password">New password</Label>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              className="pr-11"
              {...register("password")}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-fg-faint hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              tabIndex={-1}
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
          {errors.password && <p className="text-xs text-danger">{errors.password.message}</p>}
          {password ? <StrengthMeter strength={strength} /> : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input
            id="confirm"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            placeholder="Repeat the password"
            {...register("confirm")}
          />
          {errors.confirm && <p className="text-xs text-danger">{errors.confirm.message}</p>}
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
              Updating…
            </>
          ) : (
            "Update password"
          )}
        </Button>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetForm />
    </Suspense>
  );
}

function passwordStrength(p: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (p.length < 8) return { score: 0, label: "Too short" };
  let s = 1;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s += 1;
  if (/[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p)) s += 1;
  if (p.length >= 14) s += 1;
  const score = Math.min(3, s) as 0 | 1 | 2 | 3;
  // "Good" replaces the previous "Fine" — clearer signal that the password
  // passes the bar, without sounding indifferent.
  const labels = ["Too short", "Weak", "Good", "Strong"] as const;
  return { score, label: labels[score] };
}

function StrengthMeter({ strength }: { strength: { score: 0 | 1 | 2 | 3; label: string } }) {
  const tone =
    strength.score >= 3
      ? "bg-success"
      : strength.score === 2
        ? "bg-brand"
        : strength.score === 1
          ? "bg-warning"
          : "bg-danger";
  const widthPct = ((strength.score + 1) / 4) * 100;
  return (
    <div className="space-y-1">
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-raised">
        <div className={`h-full ${tone} transition-all`} style={{ width: `${widthPct}%` }} />
      </div>
      <p className="text-2xs text-fg-faint">Strength: {strength.label}</p>
    </div>
  );
}
