import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  CheckCircle2,
  ShieldCheck,
  Sparkles,
  Truck,
} from "lucide-react";
import { authOptions } from "@/lib/auth";
import { Providers } from "@/app/providers";

/**
 * Auth shell. On md+ a two-pane split: a value-prop column on the left
 * (brand, headline, feature highlights, trust pills) and the form card on
 * the right. On small screens the left column collapses to a slim brand
 * header above the form so we don't crowd the keyboard surface on mobile.
 *
 * The login/signup pages render only the form card (children); everything
 * else here is shared chrome so the visual identity stays consistent
 * between the two routes.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);
  if (session) redirect("/dashboard");

  return (
    <Providers>
    <main className="relative min-h-screen overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(900px_360px_at_50%_-160px,hsl(var(--brand)/0.20),transparent_70%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 -left-40 h-[420px] w-[420px] rounded-full bg-brand/5 blur-3xl"
      />

      <div className="relative z-10 mx-auto grid min-h-screen w-full max-w-6xl grid-cols-1 gap-10 px-4 py-10 md:grid-cols-2 md:gap-16 md:px-8 md:py-16 lg:py-20">
        <ValueColumn />
        <div className="flex items-center md:justify-end">
          <div className="w-full max-w-md">{children}</div>
        </div>
      </div>
    </main>
    </Providers>
  );
}

function ValueColumn() {
  return (
    <section className="flex flex-col gap-8 md:gap-10">
      <Link
        href="/"
        className="flex items-center gap-2.5 self-start rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <span
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white shadow-glow"
          aria-hidden
        >
          L
        </span>
        <span className="text-base font-semibold text-fg">Logistics</span>
      </Link>

      <div className="hidden flex-col gap-5 md:flex">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand">
          <Sparkles className="h-3 w-3" aria-hidden />
          Built for e-commerce merchants in Bangladesh
        </span>
        <h2 className="text-3xl font-semibold leading-[1.1] tracking-tight text-fg lg:text-[2.5rem]">
          One workspace for orders,
          <br />
          couriers, and fraud review.
        </h2>
        <p className="max-w-md text-sm text-fg-muted">
          Stop juggling five tabs. Sync Shopify or WooCommerce, book pickups
          across Pathao / Steadfast / RedX, score every COD, and verify
          customers with one click — all from a single screen.
        </p>

        <ul className="flex flex-col gap-2.5 text-sm text-fg-muted">
          <Highlight icon={Truck}>
            Native to Pathao, Steadfast, RedX, eCourier, Paperfly
          </Highlight>
          <Highlight icon={ShieldCheck}>
            Fraud queue that pays for itself before you ship
          </Highlight>
          <Highlight icon={CheckCircle2}>
            14-day trial · no credit card · cancel anytime
          </Highlight>
        </ul>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-faint">
          <TrustPill>AES-256 at rest</TrustPill>
          <TrustPill>Audit-logged</TrustPill>
          <TrustPill>Role-based access</TrustPill>
        </div>
      </div>

      <div className="md:hidden">
        <p className="text-sm text-fg-muted">
          One workspace for orders, couriers, and fraud review.
        </p>
      </div>
    </section>
  );
}

function Highlight({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand/12 text-brand">
        <Icon className="h-3 w-3" aria-hidden />
      </span>
      <span>{children}</span>
    </li>
  );
}

function TrustPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-stroke/14 bg-surface-overlay/60 px-2 py-0.5">
      <ShieldCheck className="h-3 w-3 text-success" aria-hidden />
      {children}
    </span>
  );
}
