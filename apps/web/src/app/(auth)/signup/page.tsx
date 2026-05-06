"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertCircle, Eye, EyeOff, Loader2, Sparkles } from "lucide-react";
import { isPlanTier, PHONE_RE, PLANS } from "@ecom/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const schema = z.object({
  businessName: z.string().min(1, "Business name is required."),
  email: z.string().email("That doesn't look like an email."),
  password: z.string().min(8, "At least 8 characters."),
  phone: z
    .string()
    .regex(PHONE_RE, "Use BD format like +8801XXXXXXXXX.")
    .optional()
    .or(z.literal("")),
});

type FormValues = z.infer<typeof schema>;

function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const planParam = params.get("plan");
  const selectedPlan = isPlanTier(planParam) ? PLANS[planParam] : null;
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setError(null);
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    const payload = { ...values, phone: values.phone || undefined };
    const res = await fetch(`${apiUrl}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      // Map server detail into something the merchant can act on. The API
      // surfaces the specific reason (duplicate email, weak password, etc.)
      // — we keep that, but fall back to a friendly default rather than
      // the bare-string "Signup failed".
      const detail =
        typeof body.error === "string"
          ? body.error
          : "We couldn't create the account. Check your details and try again.";
      setError(detail);
      return;
    }
    const signInRes = await signIn("credentials", {
      email: values.email,
      password: values.password,
      redirect: false,
    });
    if (!signInRes || signInRes.error) {
      router.push("/login");
      return;
    }
    // Land on the welcome surface, not the (empty) orders list. New
    // merchants need the onboarding checklist + KPI tiles to orient
    // themselves; an empty table is a trust killer on the first screen.
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="cordon-card animate-slide-up border border-stroke/30 bg-surface p-7 shadow-elevated">
      <div className="mb-6 space-y-2 text-center">
        <h1 className="text-[1.6rem] font-semibold leading-[1.1] tracking-tight text-fg">
          Start blocking fake orders{" "}
          <span className="cordon-serif">in 2 minutes.</span>
        </h1>
        <p className="text-sm text-fg-subtle">
          Create your Cordon workspace. 14-day trial. No credit card.
        </p>
        {selectedPlan ? (
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand">
            <Sparkles className="h-3 w-3" /> 14-day trial · {selectedPlan.name} plan when you upgrade
          </p>
        ) : null}
      </div>
      {/*
        SECURITY: explicit method="post" + dummy action + capturing
        onSubmit with native preventDefault. Same defense-in-depth as
        the login form — if React hasn't hydrated when the user clicks
        Submit, the browser native fallback is GET, which would put
        email + password + business name in the URL (history, dev
        stdout, every reverse-proxy log). See login/page.tsx for the
        full incident note.
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
          <Label htmlFor="businessName">Business name</Label>
          <Input id="businessName" placeholder="Acme Traders" {...register("businessName")} />
          {errors.businessName && (
            <p className="text-xs text-danger">{errors.businessName.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Work email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@business.com"
            {...register("email")}
          />
          {errors.email && <p className="text-xs text-danger">{errors.email.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
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
          <p className="text-2xs text-fg-faint">
            8+ characters. A passphrase you&apos;ll remember works great.
          </p>
          {errors.password && (
            <p className="text-xs text-danger">{errors.password.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">
            Phone <span className="text-fg-faint">(optional)</span>
          </Label>
          <Input id="phone" placeholder="+8801XXXXXXXXX" {...register("phone")} />
          <p className="text-2xs text-fg-faint">
            Used for courier OTP and ops alerts. Optional.
          </p>
          {errors.phone && <p className="text-xs text-danger">{errors.phone.message}</p>}
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
              Creating workspace…
            </>
          ) : (
            <>
              Start saving <span className="cordon-arrow">→</span>
            </>
          )}
        </Button>
      </form>

      {/* Trust band — mirrors the proof-band on the landing hero so the
          merchant carries the same hard signals across the click. */}
      <div className="mt-5 flex items-center justify-center gap-2 text-center text-2xs text-fg-faint">
        <span className="cordon-pulse" aria-hidden />
        <span>
          Used by{" "}
          <strong className="font-semibold text-fg-muted">200+ BD merchants</strong>
          {" · "}
          <strong className="font-semibold text-fg-muted">৳45 Cr+</strong> RTO prevented
        </span>
      </div>

      <p className="mt-5 text-center text-xs text-fg-faint">
        By creating an account, you agree to our{" "}
        <Link href="/legal/terms" className="underline-offset-4 hover:text-fg-muted hover:underline">
          Terms
        </Link>{" "}
        and{" "}
        <Link href="/legal/privacy" className="underline-offset-4 hover:text-fg-muted hover:underline">
          Privacy Policy
        </Link>
        .
      </p>

      <p className="mt-5 text-center text-sm text-fg-subtle">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-medium text-brand underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>
      <p className="mt-2 text-center text-xs text-fg-faint">
        See plans on the{" "}
        <Link href="/pricing" className="hover:text-fg">
          pricing page
        </Link>
        .
      </p>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  );
}
