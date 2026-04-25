"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertCircle, Loader2, Sparkles } from "lucide-react";
import { isPlanTier, PLANS } from "@ecom/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const schema = z.object({
  businessName: z.string().min(1, "Business name is required"),
  email: z.string().email(),
  password: z.string().min(8, "At least 8 characters"),
  phone: z
    .string()
    .regex(/^\+?[0-9]{7,15}$/, "Invalid phone")
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
      setError(typeof body.error === "string" ? body.error : "Signup failed");
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
    router.push("/dashboard/orders");
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-stroke/10 bg-surface p-7 shadow-elevated animate-slide-up">
      <div className="mb-6 space-y-1.5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          Create your workspace
        </h1>
        <p className="text-sm text-fg-subtle">
          Start managing your logistics in under 60 seconds.
        </p>
        {selectedPlan ? (
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand-subtle px-2.5 py-1 text-xs font-medium text-brand">
            <Sparkles className="h-3 w-3" /> 14-day trial · {selectedPlan.name} plan when you upgrade
          </p>
        ) : null}
      </div>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="businessName">Business name</Label>
          <Input id="businessName" placeholder="Acme Traders" {...register("businessName")} />
          {errors.businessName && (
            <p className="text-xs text-danger">{errors.businessName.message}</p>
          )}
        </div>
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
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            placeholder="At least 8 characters"
            {...register("password")}
          />
          {errors.password && (
            <p className="text-xs text-danger">{errors.password.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">
            Phone <span className="text-fg-faint">(optional)</span>
          </Label>
          <Input id="phone" placeholder="+8801XXXXXXXXX" {...register("phone")} />
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
          className="w-full bg-brand text-white hover:bg-brand-hover"
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Creating account…
            </>
          ) : (
            "Create account"
          )}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-fg-subtle">
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
