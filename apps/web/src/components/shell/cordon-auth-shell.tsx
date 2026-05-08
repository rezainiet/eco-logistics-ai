"use client";

import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { isPlanTier, PLANS } from "@ecom/types";
import {
  CheckCircle2,
  ShieldCheck,
  Truck,
  type LucideIcon,
} from "lucide-react";

/**
 * Cordon auth shell — shared chrome for the four auth surfaces:
 *   /(auth)/login
 *   /(auth)/signup
 *   /forgot-password
 *   /reset-password
 *
 * All four wrap their `children` (the form card) with this component so the
 * Cordon visual identity (lime accent, near-black surfaces, serif italic
 * headline accent, mono eyebrows, hard trust band) is identical regardless
 * of which auth route the merchant is on.
 *
 * Token strategy: a wrapper class `.cordon-auth` redefines the HSL CSS
 * custom properties that Tailwind's brand/surface tokens resolve to.
 * Every `bg-brand`, `text-brand`, `bg-surface*`, focus ring etc. inside
 * this subtree picks up the lime + near-black palette automatically.
 * Outside this subtree, the dashboard / admin / marketing surfaces keep
 * their existing tokens intact.
 */

const CORDON_AUTH_TOKENS = `
  .cordon-auth {
    /* Surfaces — match landing.module.css --c-bg, --c-surface, etc. */
    --surface-base: 240 4% 5%;       /* #0A0A0B */
    --surface: 240 4% 7%;            /* #111113 */
    --surface-raised: 240 4% 10%;    /* #18181B */
    --surface-overlay: 240 5% 12%;   /* #1F1F23 */
    --surface-hover: 240 5% 14%;

    /* Foregrounds */
    --fg: 0 0% 98%;                  /* #FAFAFA */
    --fg-muted: 240 5% 65%;          /* #A1A1AA */
    --fg-subtle: 240 5% 65%;
    --fg-faint: 240 5% 45%;          /* #71717A */

    /* Strokes */
    --stroke-subtle: 240 5% 26%;
    --stroke-default: 240 5% 26%;    /* #3F3F46 */
    --stroke-strong: 240 5% 36%;

    /* Brand — lime #C6F84F with dark foreground for contrast */
    --brand: 76 92% 64%;             /* #C6F84F */
    --brand-hover: 85 84% 50%;       /* #8AE619 */
    --brand-active: 85 84% 44%;
    --brand-fg: 240 6% 5%;           /* #0A0A0B */

    /* shadcn legacy aliases keep primitives in sync */
    --primary: var(--brand);
    --primary-foreground: var(--brand-fg);
    --ring: var(--brand);
    --input: var(--surface-raised);

    color: hsl(var(--fg));
    background:
      radial-gradient(900px 360px at 50% -160px, hsl(76 92% 64% / 0.18), transparent 70%),
      linear-gradient(180deg, hsl(240 4% 5%) 0%, hsl(240 4% 4%) 100%);
    min-height: 100vh;
  }

  /* Serif italic accent — ported from landing.module.css .serif */
  .cordon-auth .cordon-serif {
    font-family: var(--font-serif), serif;
    font-style: italic;
    font-weight: 400;
    letter-spacing: 0;
    color: hsl(var(--fg) / 0.85);
  }

  /* Mono eyebrow — ported from landing.module.css .section-eyebrow */
  .cordon-auth .cordon-eyebrow {
    font-family: var(--font-mono), monospace;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: hsl(var(--brand));
  }

  /* Pulse — ported from landing.module.css .eyebrow .pulse */
  .cordon-auth .cordon-pulse {
    width: 6px; height: 6px; border-radius: 50%;
    background: hsl(var(--brand));
    box-shadow: 0 0 8px hsl(var(--brand));
    animation: cordonAuthPulse 1.8s ease-in-out infinite;
    display: inline-block;
  }
  @keyframes cordonAuthPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.85); }
  }
  @media (prefers-reduced-motion: reduce) {
    .cordon-auth .cordon-pulse { animation: none; }
  }

  /* Logo dot — ported from landing.module.css .logo-dot */
  .cordon-auth .cordon-logo-dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: hsl(var(--brand));
    box-shadow: 0 0 14px hsl(var(--brand));
    display: inline-block;
  }

  /* Card silhouette — landing's 22px radius + hover lift */
  .cordon-auth .cordon-card {
    border-radius: 22px;
    transition: border-color .25s, transform .25s, box-shadow .25s;
  }

  /* Animated arrow on CTAs — ported from landing.module.css .btn .arrow */
  .cordon-auth .cordon-arrow {
    display: inline-block;
    transition: transform .25s;
  }
  .cordon-auth button:hover .cordon-arrow,
  .cordon-auth a:hover .cordon-arrow {
    transform: translateX(4px);
  }
`;

export function CordonAuthShell({ children }: { children: ReactNode }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CORDON_AUTH_TOKENS }} />
      <main className="cordon-auth relative overflow-hidden">
        <div className="relative z-10 mx-auto grid min-h-screen w-full max-w-6xl grid-cols-1 gap-8 px-4 py-8 md:grid-cols-2 md:gap-16 md:px-8 md:py-16 lg:py-20">
          {/*
            useSearchParams() requires a Suspense boundary in Next 14
            App Router because the shell is rendered inside server-built
            layouts. Falling back to the wordmark-only header keeps the
            initial paint budget tiny while the URL params resolve.
          */}
          <Suspense fallback={<WordmarkOnly />}>
            <ValueColumn />
          </Suspense>
          <div className="flex items-center md:justify-end">
            <div className="w-full max-w-md">{children}</div>
          </div>
        </div>
      </main>
    </>
  );
}

function WordmarkOnly() {
  return (
    <Link
      href="/"
      className="flex items-center gap-2.5 self-start rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand"
    >
      <span className="cordon-logo-dot" aria-hidden />
      <span className="text-base font-semibold tracking-tight text-fg">Cordon</span>
    </Link>
  );
}

function ValueColumn() {
  // Read `?plan=` so the auth shell echoes the merchant's pricing-page
  // selection. The eyebrow, headline, and proof points re-skin to the
  // plan when present; otherwise the default Cordon hero stays.
  const params = useSearchParams();
  const planParam = params?.get("plan") ?? null;
  const plan = isPlanTier(planParam) ? PLANS[planParam] : null;

  return (
    <section className="flex flex-col gap-6 md:gap-10">
      <Link
        href="/"
        className="flex items-center gap-2.5 self-start rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <span className="cordon-logo-dot" aria-hidden />
        <span className="text-base font-semibold tracking-tight text-fg">Cordon</span>
      </Link>

      {/* Mobile proof-band — preserves the brand voice + trust signals on
          phones, where ~60% of BD signups happen. The desktop ValueColumn
          stays hidden below md; this band stays hidden above md. */}
      <div className="md:hidden">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-1 text-2xs font-medium text-brand">
          <span className="cordon-pulse" aria-hidden />
          {plan ? `${plan.name} · 14-day trial` : "Built for Bangladesh's COD economy"}
        </span>
        <h2 className="mt-3 text-[1.4rem] font-semibold leading-[1.15] tracking-tight text-fg">
          {plan ? (
            <>
              Start your{" "}
              <span className="cordon-serif">{plan.name.toLowerCase()}</span>{" "}
              trial.
            </>
          ) : (
            <>
              Stop shipping to{" "}
              <span className="cordon-serif">fraudsters.</span>
            </>
          )}
        </h2>
        <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl border border-stroke/30 bg-surface/60 p-2.5 text-center">
          <div>
            <div className="font-mono text-xs font-semibold text-fg">200+</div>
            <div className="text-2xs text-fg-faint">BD merchants</div>
          </div>
          <div className="border-x border-stroke/30">
            <div className="font-mono text-xs font-semibold text-fg">৳45 Cr+</div>
            <div className="text-2xs text-fg-faint">RTO prevented</div>
          </div>
          <div>
            <div className="font-mono text-xs font-semibold text-fg">99.9%</div>
            <div className="text-2xs text-fg-faint">webhook uptime</div>
          </div>
        </div>
      </div>

      <div className="hidden flex-col gap-5 md:flex">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand">
          <span className="cordon-pulse" aria-hidden />
          {plan ? `${plan.name} plan · 14-day trial · no card` : "Built for Bangladesh's COD economy"}
        </span>
        <h2 className="text-3xl font-semibold leading-[1.05] tracking-tight text-fg lg:text-[2.5rem]">
          {plan ? (
            <>
              Start your{" "}
              <span className="cordon-serif">{plan.name.toLowerCase()}</span>{" "}
              trial.
              <br />
              <span className="text-fg-muted">{plan.tagline}</span>
            </>
          ) : (
            <>
              Stop shipping to{" "}
              <span className="cordon-serif">fraudsters.</span>
              <br />
              Get paid for what you actually deliver.
            </>
          )}
        </h2>
        <p className="max-w-md text-sm text-fg-muted">
          {plan ? (
            <>
              You picked <strong className="text-fg">{plan.name}</strong>{" "}
              (৳{plan.priceBDT.toLocaleString()} / month after the trial). 14
              days free, no card. Cancel before day 14 and you&apos;re not
              charged.
            </>
          ) : (
            <>
              Real-time fraud scoring across a cross-merchant network,
              automated booking on Pathao / Steadfast / RedX, and webhook
              delivery you can actually trust. Cordon merchants cut RTO by
              up to 60%.
            </>
          )}
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

        {/* Hard trust band — mirrors the landing's proof-band stats. */}
        <div className="mt-2 grid grid-cols-3 gap-3 rounded-xl border border-stroke/30 bg-surface/60 p-3 text-center">
          <div>
            <div className="font-mono text-sm font-semibold text-fg">200+</div>
            <div className="text-2xs text-fg-faint">BD merchants</div>
          </div>
          <div className="border-x border-stroke/30">
            <div className="font-mono text-sm font-semibold text-fg">৳45 Cr+</div>
            <div className="text-2xs text-fg-faint">RTO prevented</div>
          </div>
          <div>
            <div className="font-mono text-sm font-semibold text-fg">99.9%</div>
            <div className="text-2xs text-fg-faint">webhook delivery</div>
          </div>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-faint">
          <TrustPill>AES-256 at rest</TrustPill>
          <TrustPill>Audit-logged</TrustPill>
          <TrustPill>Role-based access</TrustPill>
        </div>
      </div>
    </section>
  );
}

function Highlight({
  icon: Icon,
  children,
}: {
  // Use LucideIcon directly so the prop type matches what the lucide
  // imports actually expose (ForwardRefExoticComponent w/ Booleanish
  // aria-hidden). A hand-rolled React.ComponentType<{ "aria-hidden"?:
  // boolean }> drifts away from lucide's Validator and tsc bails.
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand">
        <Icon className="h-3 w-3" aria-hidden />
      </span>
      <span>{children}</span>
    </li>
  );
}

function TrustPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-stroke/30 bg-surface-overlay/60 px-2 py-0.5">
      <ShieldCheck className="h-3 w-3 text-success" aria-hidden />
      {children}
    </span>
  );
}
