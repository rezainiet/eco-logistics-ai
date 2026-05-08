"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Box,
  Check,
  Code2,
  FileText,
  ShieldCheck,
  ShoppingBag,
  Store,
  Webhook,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * First-run integrations experience.
 *
 * Shown when the merchant has zero connected integrations AND the URL
 * carries no OAuth callback params (so a returning merchant who just
 * disconnected and is mid-reconnect still sees the advanced view).
 *
 * Hierarchy is intentional and product-driven:
 *   Shopify  → primary card. Largest BD merchant pool; one-click OAuth.
 *   Woo      → secondary. REST + signed webhooks; needs the Advanced
 *              section in the dialog (consumer key/secret paste).
 *   Custom   → tertiary; for merchants on a homegrown stack.
 *   CSV      → escape hatch. Not a connector — bulk-upload escape.
 *
 * Stateless. Selection opens the existing connect dialog on the
 * advanced page (same `setOpenProvider` ref the existing card grid
 * uses), so the OAuth + webhook + entitlement plumbing is unchanged.
 *
 * Why this lives in `_components/` rather than next to the existing
 * 1,917-line page: keeping the new first-run UI as a standalone island
 * means the existing component is untouched. The page-level wrapper
 * just forks between the two based on `list.data.length`.
 */

type ProviderKey = "shopify" | "woocommerce" | "custom_api" | "csv";

interface ConnectFlowProps {
  /** Opens the existing connect dialog from the advanced page. */
  onSelectProvider: (provider: ProviderKey) => void;
  /** When true, dim Shopify and surface a one-line ops note. */
  shopifyConfigGap?: boolean;
}

const PROVIDERS: Array<{
  key: ProviderKey;
  label: string;
  hint: string;
  icon: LucideIcon;
  primary?: boolean;
  description: string;
}> = [
  {
    key: "shopify",
    label: "Shopify",
    hint: "Most BD merchants start here.",
    icon: ShoppingBag,
    primary: true,
    description:
      "One-click OAuth. We auto-register the order webhooks (orders/create, orders/updated, app/uninstalled) so risk scoring runs the moment your next order arrives.",
  },
  {
    key: "woocommerce",
    label: "WooCommerce",
    hint: "Self-hosted WordPress.",
    icon: Store,
    description:
      "REST API + signed webhooks. Paste your store URL plus a consumer key/secret — Cordon takes it from there.",
  },
  {
    key: "custom_api",
    label: "Custom API",
    hint: "Anything else.",
    icon: Code2,
    description:
      "Push orders from any storefront via signed webhook. Cordon issues the URL + secret; you paste them into your stack.",
  },
];

export function ConnectFlow({
  onSelectProvider,
  shopifyConfigGap = false,
}: ConnectFlowProps) {
  const [selected, setSelected] = useState<ProviderKey | null>(null);

  return (
    <section className="space-y-8">
      {/* Eyebrow + headline — same voice/rhythm as the auth shell so the
          first-run flow feels like a continuation of signup, not a
          context switch. */}
      <header className="space-y-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-1 text-2xs font-medium uppercase tracking-[0.12em] text-brand">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_8px_hsl(var(--brand))]"
          />
          Step 01 · Connect
        </span>
        <h1 className="text-2xl font-semibold leading-[1.1] tracking-tight text-fg md:text-3xl">
          Connect the store you sell on.
        </h1>
        <p className="max-w-xl text-sm text-fg-muted">
          Cordon needs read access to your orders to score risk and book
          couriers. We never touch payouts and never write to your
          storefront. Most merchants are connected in under 2 minutes.
        </p>
      </header>

      {/* Trust band carried over from the landing — three claims a
          merchant on the verge of OAuth needs to see again right at the
          point of decision. Mirrors the value column of the auth shell. */}
      <div className="flex flex-wrap items-center gap-2 text-2xs text-fg-faint">
        <TrustChip icon={ShieldCheck}>read-only access</TrustChip>
        <TrustChip icon={Webhook}>auto-registered webhooks</TrustChip>
        <TrustChip icon={Box}>read_orders scope only</TrustChip>
      </div>

      {/* Provider grid — Shopify is wider than Woo + Custom for visual
          weight, since it's the recommended path for most merchants. */}
      <div className="grid gap-4 md:grid-cols-3">
        {PROVIDERS.map((p) => {
          const Icon = p.icon;
          const isSelected = selected === p.key;
          const isShopify = p.key === "shopify";
          const dimmed = isShopify && shopifyConfigGap;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => setSelected(p.key)}
              aria-pressed={isSelected}
              className={
                "group relative overflow-hidden rounded-2xl border p-5 text-left transition-all " +
                (p.primary ? "md:col-span-2 " : "") +
                (isSelected
                  ? "border-brand bg-brand/8 shadow-[0_0_0_1px_hsl(var(--brand)/0.4)]"
                  : "border-stroke/30 bg-surface hover:border-stroke/50 hover:bg-surface-raised") +
                (dimmed ? " opacity-70" : "")
              }
            >
              {p.primary ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 bg-[radial-gradient(420px_140px_at_20%_-20%,hsl(var(--brand)/0.12),transparent_70%)]"
                />
              ) : null}
              <div className="relative flex items-start gap-4">
                <span
                  className={
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl " +
                    (isSelected ? "bg-brand text-brand-fg" : "bg-surface-raised text-fg-muted")
                  }
                >
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold tracking-tight text-fg">
                      {p.label}
                    </span>
                    {p.primary ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-brand/15 px-1.5 py-0.5 text-2xs font-medium text-brand">
                        <Zap className="h-2.5 w-2.5" aria-hidden /> Recommended
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-2xs text-fg-faint">{p.hint}</p>
                  <p className="mt-3 text-xs leading-relaxed text-fg-muted">
                    {p.description}
                  </p>
                </div>
                {isSelected ? (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-brand-fg">
                    <Check className="h-3 w-3" aria-hidden />
                  </span>
                ) : null}
              </div>
              {dimmed ? (
                <div className="relative mt-4 rounded-md border border-warning-border/60 bg-warning-subtle px-2.5 py-1.5 text-2xs text-warning">
                  Custom-app credentials needed — open the dialog and use the
                  Advanced section.
                </div>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Footer actions — primary continues to the existing connect
          dialog (preserves OAuth + webhook flow), secondary escapes to
          CSV upload. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stroke/15 pt-5">
        <Link
          href="/dashboard/orders?bulk=1"
          className="inline-flex items-center gap-2 text-xs text-fg-muted hover:text-fg"
        >
          <FileText className="h-3.5 w-3.5" aria-hidden />
          Skip for now · upload a CSV instead
        </Link>
        <button
          type="button"
          disabled={!selected}
          onClick={() => selected && onSelectProvider(selected)}
          className="inline-flex h-11 items-center gap-2 rounded-md bg-brand px-5 text-sm font-semibold text-brand-fg transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Continue
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </section>
  );
}

function TrustChip({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-stroke/30 bg-surface-overlay/60 px-2 py-0.5">
      <Icon className="h-3 w-3 text-success" aria-hidden />
      {children}
    </span>
  );
}
