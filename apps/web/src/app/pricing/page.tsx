import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  CreditCard,
  Crown,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { listPlans, type PlanTier } from "@ecom/types";

export const metadata = {
  title: "Pricing — Logistics",
  description:
    "Simple, predictable pricing for e-commerce merchants in Bangladesh. 14-day free trial on every plan.",
};

const ICON: Record<PlanTier, typeof Sparkles> = {
  starter: Sparkles,
  growth: Zap,
  scale: CreditCard,
  enterprise: Crown,
};

const FEATURED: PlanTier = "growth";

const TRUST_POINTS = [
  "14-day free trial — no credit card",
  "Bangladesh-ready manual payments (bKash / Nagad / bank)",
  "Cancel anytime, keep access until the period ends",
  "AES-256-GCM encryption for every courier credential",
];

const FAQ = [
  {
    q: "Can I switch plans later?",
    a: "Yes — upgrades take effect immediately, downgrades apply at the next renewal so you never lose access mid-cycle.",
  },
  {
    q: "How does the trial work?",
    a: "Every account starts on a 14-day trial of the full Starter feature set. Your data stays put even if you don't subscribe — you can pick a plan whenever you're ready.",
  },
  {
    q: "Do you support international stores?",
    a: "Yes. The platform is built for Bangladesh first, but the dashboard speaks 9 languages and supports merchants across South & Southeast Asia.",
  },
  {
    q: "What about webhook fees, calls, SMS?",
    a: "All Twilio call-center minutes shown above are included in your plan. Webhook ingestion and analytics are unlimited within your monthly order quota.",
  },
];

function formatBDT(n: number): string {
  return `৳${n.toLocaleString()}`;
}

export default function PricingPage() {
  const plans = listPlans();
  return (
    <main className="relative min-h-screen overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(900px_360px_at_50%_-120px,hsl(var(--brand)/0.18),transparent_70%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand/40 to-transparent"
      />

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white shadow-glow">
            L
          </span>
          <span className="text-sm font-semibold text-fg">Logistics</span>
        </Link>
        <nav className="flex items-center gap-2">
          <Link
            href="/login"
            className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-fg-muted transition-colors hover:text-fg"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="inline-flex h-9 items-center gap-1 rounded-md bg-brand px-3.5 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
          >
            Start free trial
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </nav>
      </header>

      <section className="relative z-10 mx-auto max-w-3xl px-6 pb-12 pt-6 text-center md:pt-12">
        <span className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand-subtle px-3 py-1 text-xs font-medium text-brand">
          <Sparkles className="h-3 w-3" />
          14-day free trial on every plan
        </span>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight text-fg md:text-5xl">
          Pricing built for Bangladesh.
        </h1>
        <p className="mt-4 text-balance text-base leading-relaxed text-fg-subtle md:text-lg">
          One workspace for orders, fraud review, courier sync and behavior analytics — at a price
          your COD margin can carry.
        </p>
      </section>

      <section className="relative z-10 mx-auto max-w-6xl px-6 pb-12">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {plans.map((p) => {
            const Icon = ICON[p.tier] ?? Sparkles;
            const featured = p.tier === FEATURED;
            return (
              <div
                key={p.tier}
                className={`relative flex flex-col gap-5 rounded-2xl border p-6 transition-all ${
                  featured
                    ? "border-brand/40 bg-surface shadow-elevated ring-1 ring-brand/20"
                    : "border-stroke/10 bg-surface shadow-card hover:border-stroke/20 hover:shadow-elevated"
                }`}
              >
                {featured ? (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand px-2.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.06em] text-white shadow-glow">
                    Most popular
                  </span>
                ) : null}
                <div className="flex items-center justify-between">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand/14 text-brand">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-fg-faint">
                    {p.tier}
                  </span>
                </div>
                <div className="space-y-1">
                  <h3 className="text-lg font-semibold text-fg">{p.name}</h3>
                  <p className="min-h-[40px] text-xs text-fg-subtle">{p.tagline}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-3xl font-semibold tracking-tight text-fg">
                    {formatBDT(p.priceBDT)}
                    <span className="ml-1 text-xs font-normal text-fg-subtle">/ month</span>
                  </p>
                  <p className="text-2xs text-fg-faint">≈ ${p.priceUSD} USD</p>
                </div>
                <ul className="space-y-1.5 text-xs text-fg-muted">
                  {p.highlights.map((h) => (
                    <li key={h} className="flex items-start gap-2">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  href={`/signup?plan=${p.tier}`}
                  className={`mt-auto inline-flex h-10 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-semibold transition-colors ${
                    featured
                      ? "bg-brand text-white shadow-glow hover:bg-brand-hover"
                      : "border border-stroke/14 bg-surface text-fg hover:bg-surface-raised"
                  }`}
                >
                  Start free trial
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            );
          })}
        </div>
      </section>

      <section className="relative z-10 mx-auto max-w-5xl px-6 pb-12">
        <div className="rounded-2xl border border-stroke/10 bg-surface p-6 shadow-card md:p-8">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-success-subtle text-success">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-semibold text-fg">Built to be trusted</h2>
              <p className="mt-1 text-sm text-fg-subtle">
                Same security posture across every plan — encryption, audit logging, and rate
                limiting are not premium add-ons.
              </p>
            </div>
          </div>
          <ul className="mt-5 grid gap-2.5 sm:grid-cols-2">
            {TRUST_POINTS.map((t) => (
              <li
                key={t}
                className="flex items-start gap-2 rounded-lg border border-stroke/8 bg-surface-raised/40 px-3 py-2.5 text-xs text-fg-muted"
              >
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="relative z-10 mx-auto max-w-3xl px-6 pb-16">
        <h2 className="mb-6 text-center text-2xl font-semibold tracking-tight text-fg">
          Frequently asked
        </h2>
        <dl className="space-y-3">
          {FAQ.map((f) => (
            <details
              key={f.q}
              className="group rounded-xl border border-stroke/10 bg-surface px-5 py-4 text-sm shadow-card transition-colors hover:border-stroke/20"
            >
              <summary className="flex cursor-pointer items-center justify-between gap-4 font-medium text-fg">
                {f.q}
                <span className="text-fg-faint transition-transform group-open:rotate-180">
                  <ArrowRight className="h-4 w-4 rotate-90" />
                </span>
              </summary>
              <p className="mt-2 text-fg-subtle">{f.a}</p>
            </details>
          ))}
        </dl>
      </section>

      <section className="relative z-10 mx-auto max-w-5xl px-6 pb-20">
        <div className="flex flex-col items-start gap-4 rounded-2xl border border-stroke/10 bg-surface p-8 shadow-card md:flex-row md:items-center md:justify-between md:p-10">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold text-fg">Try it free for 14 days</h2>
            <p className="max-w-lg text-sm text-fg-subtle">
              No credit card required. Spin up a workspace and import your first orders in under
              60 seconds.
            </p>
          </div>
          <Link
            href="/signup"
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-5 text-sm font-semibold text-white shadow-glow transition-colors hover:bg-brand-hover"
          >
            Start free trial
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <footer className="relative z-10 border-t border-stroke/8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-6 text-xs text-fg-subtle md:flex-row">
          <p>© {new Date().getFullYear()} Logistics · Built for Bangladesh e-commerce.</p>
          <div className="flex items-center gap-5">
            <Link href="/" className="hover:text-fg">
              Home
            </Link>
            <Link href="/login" className="hover:text-fg">
              Sign in
            </Link>
            <Link href="/signup" className="hover:text-fg">
              Sign up
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
