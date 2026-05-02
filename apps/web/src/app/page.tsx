import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  PackageCheck,
  Phone,
  ShieldCheck,
  Truck,
} from "lucide-react";

const FEATURES = [
  {
    icon: PackageCheck,
    title: "Unified order ops",
    description:
      "Create, upload in bulk, and book courier pickups across Pathao, Steadfast, RedX and more — all from one queue.",
  },
  {
    icon: ShieldCheck,
    title: "Fraud review that pays for itself",
    description:
      "Risk-score every COD, route suspicious orders into a human-review queue, and claw back RTO costs before they ship.",
  },
  {
    icon: Phone,
    title: "Twilio call center, built in",
    description:
      "Verify customers with one click. Every call, recording and outcome logged against the order automatically.",
  },
  {
    icon: Truck,
    title: "Live tracking — no tabs",
    description:
      "Poll courier APIs on a schedule, surface failures, and show a unified timeline per order inside your dashboard.",
  },
];

const COURIERS = ["Pathao", "Steadfast", "RedX", "eCourier", "Paperfly"];

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-hidden">
      {/* Decorative backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(900px_360px_at_50%_-120px,hsl(var(--brand)/0.18),transparent_70%)]"
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
            href="/pricing"
            className="hidden h-9 items-center rounded-md px-3 text-sm font-medium text-fg-muted transition-colors hover:text-fg sm:inline-flex"
          >
            Pricing
          </Link>
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
            Create account
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </nav>
      </header>

      <section className="relative z-10 mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 pb-14 pt-8 text-center md:pt-16">
        <span className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand-subtle px-3 py-1 text-xs font-medium text-brand">
          <span className="h-1.5 w-1.5 rounded-full bg-brand" />
          Built for e-commerce merchants in Bangladesh
        </span>
        <h1 className="text-4xl font-semibold tracking-tight text-fg md:text-6xl">
          Ship faster.
          <br />
          <span className="text-gradient-brand">With clarity.</span>
        </h1>
        <p className="max-w-xl text-balance text-base leading-relaxed text-fg-subtle md:text-lg">
          One dashboard for orders, couriers, fraud review and customer calls.
          Stop juggling five tabs — run your whole fulfilment operation from
          a single workspace.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/signup"
            className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-brand px-5 text-sm font-semibold text-white shadow-glow transition-colors hover:bg-brand-hover"
          >
            Start 14-day trial
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/login"
            className="inline-flex h-11 items-center rounded-lg border border-stroke/14 bg-surface px-5 text-sm font-medium text-fg-muted transition-colors hover:border-stroke/24 hover:text-fg"
          >
            Sign in
          </Link>
        </div>
        <div className="flex flex-col items-center gap-3 pt-4 text-xs text-fg-subtle md:flex-row md:gap-6">
          <span>No credit card required</span>
          <span className="hidden h-1 w-1 rounded-full bg-fg-faint md:inline-block" />
          <span>Cancel anytime</span>
          <span className="hidden h-1 w-1 rounded-full bg-fg-faint md:inline-block" />
          <span>Encrypted courier credentials</span>
        </div>
      </section>

      <section className="relative z-10 mx-auto max-w-5xl px-6 pb-12">
        <p className="mb-4 text-center text-2xs font-semibold uppercase tracking-[0.08em] text-fg-faint">
          Connects natively to
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm font-medium text-fg-subtle">
          {COURIERS.map((c) => (
            <span
              key={c}
              className="rounded-md border border-stroke/10 bg-surface px-3 py-1.5"
            >
              {c}
            </span>
          ))}
        </div>
      </section>

      <section className="relative z-10 mx-auto max-w-6xl px-6 pb-20">
        <div className="mb-8 text-center">
          <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-brand">
            Features
          </p>
          <h2 className="mt-1 text-3xl font-semibold tracking-tight text-fg">
            Everything your ops team needs. Nothing they don't.
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="group flex flex-col gap-3 rounded-xl border border-stroke/10 bg-surface p-5 shadow-card transition-all hover:border-stroke/20 hover:shadow-elevated"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/12 text-brand">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold text-fg">{f.title}</h3>
                  <p className="text-xs leading-relaxed text-fg-subtle">
                    {f.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="relative z-10 mx-auto max-w-5xl px-6 pb-20">
        <div className="flex flex-col items-start gap-4 rounded-2xl border border-stroke/10 bg-surface p-8 shadow-card md:flex-row md:items-center md:justify-between md:p-10">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand/12 text-brand">
              <BarChart3 className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-fg">
                Ready to see your failed-delivery rate drop?
              </h2>
              <p className="max-w-lg text-sm text-fg-subtle">
                Spin up a workspace in under 60 seconds. Import your first
                batch of orders and watch the fraud queue fill itself.
              </p>
            </div>
          </div>
          <Link
            href="/signup"
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-5 text-sm font-semibold text-white shadow-glow transition-colors hover:bg-brand-hover"
          >
            Create your workspace
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <footer className="relative z-10 border-t border-stroke/8">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-8 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-subtle">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-stroke/12 bg-surface px-2 py-1">
              <ShieldCheck className="h-3 w-3 text-success" /> AES-256-GCM at rest
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-stroke/12 bg-surface px-2 py-1">
              <ShieldCheck className="h-3 w-3 text-success" /> Audit-logged
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-stroke/12 bg-surface px-2 py-1">
              <ShieldCheck className="h-3 w-3 text-success" /> Role-based access
            </span>
          </div>
          <div className="flex flex-col items-start gap-3 text-xs text-fg-subtle md:items-end">
            <div className="flex items-center gap-5">
              <Link href="/pricing" className="hover:text-fg">
                Pricing
              </Link>
              <Link href="/login" className="hover:text-fg">
                Sign in
              </Link>
              <Link href="/signup" className="hover:text-fg">
                Sign up
              </Link>
            </div>
            <p>© {new Date().getFullYear()} Logistics · Built for Bangladesh e-commerce.</p>
          </div>
        </div>
      </footer>
    </main>
  );
}
