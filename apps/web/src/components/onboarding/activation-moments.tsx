"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ShieldCheck, ArrowRight, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { formatBDT } from "@/lib/formatters";

/**
 * Activation moments — the emotional spine of Plan B.
 *
 * Two surfaces, both client-only, both reading existing tRPC data:
 *
 *   <ActivationToaster />   — fires a single celebratory toast the FIRST
 *                             time we observe a meaningful milestone:
 *                               1. First inbound order ingested
 *                               2. First risky order detected
 *                             Mounts at the dashboard layout level so
 *                             the merchant sees it the moment Cordon
 *                             produces value, regardless of which page
 *                             they're on.
 *
 *   <FirstFlagBanner />     — persists the "first risky order caught"
 *                             moment as an inline brand-coloured banner
 *                             on the dashboard. Stays visible for 7 days
 *                             after the first detection (or until the
 *                             merchant dismisses it) so the activation
 *                             beat is encountered every time they open
 *                             the app, not just at the moment it fires.
 *
 * Storage strategy: per-device localStorage gates the celebrations so a
 * merchant who already saw the moment doesn't re-trigger on subsequent
 * page loads. Multi-device behaviour is intentional — if the merchant
 * signs in from a new device they get to see the moment once there too,
 * which is fine product-wise (it's still legitimately a celebration).
 *
 * Failure isolation: every read is best-effort; localStorage parse
 * failures, missing tRPC data, or stale queries all degrade silently.
 * The activation system NEVER blocks render or causes a paint flicker.
 */

const STORAGE = {
  firstOrderToast: "cordon:activation:first-order-toast-v1",
  firstFlagToast: "cordon:activation:first-flag-toast-v1",
  firstFlagBannerAt: "cordon:activation:first-flag-banner-at-v1",
  firstFlagBannerDismissed: "cordon:activation:first-flag-banner-dismissed-v1",
};

const BANNER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — silently no-op */
  }
}

export function ActivationToaster() {
  // Use the same data sources the dashboard already pulls — identical
  // staleTime/cache keys mean this component piggybacks on cached data
  // rather than adding network round-trips.
  const orders = trpc.orders.listOrders.useQuery(
    { limit: 1 } as never,
    { staleTime: 60_000, refetchOnWindowFocus: false },
  );
  const fraud = trpc.fraud.getReviewStats.useQuery(
    { days: 30 },
    { staleTime: 60_000, refetchOnWindowFocus: false },
  );

  // Track which toasts we've already fired in THIS browser tab so even
  // if the React tree re-mounts (route change), we don't re-fire. The
  // localStorage gate handles the cross-session case below.
  const firedFirstOrderRef = useRef(false);
  const firedFirstFlagRef = useRef(false);

  useEffect(() => {
    if (orders.isLoading || orders.isError) return;
    if (firedFirstOrderRef.current) return;
    if (readStorage(STORAGE.firstOrderToast)) return;

    const data = orders.data as
      | { items?: Array<unknown> }
      | Array<unknown>
      | undefined
      | null;
    const list = Array.isArray(data) ? data : data?.items ?? [];
    if (list.length === 0) return;

    firedFirstOrderRef.current = true;
    writeStorage(STORAGE.firstOrderToast, new Date().toISOString());
    toast.success(
      "First order is live in Cordon",
      "Webhook delivery confirmed. Risk scoring is running.",
    );
  }, [orders.isLoading, orders.isError, orders.data]);

  useEffect(() => {
    if (fraud.isLoading || fraud.isError) return;
    if (firedFirstFlagRef.current) return;
    if (readStorage(STORAGE.firstFlagToast)) return;

    const risky = fraud.data?.window?.risky ?? 0;
    if (risky <= 0) return;

    firedFirstFlagRef.current = true;
    writeStorage(STORAGE.firstFlagToast, new Date().toISOString());
    // Also stamp the banner-show date so <FirstFlagBanner> renders for
    // the next 7 days. Stamps independently so a merchant who clears
    // localStorage and re-fires only the toast still gets the banner.
    if (!readStorage(STORAGE.firstFlagBannerAt)) {
      writeStorage(STORAGE.firstFlagBannerAt, new Date().toISOString());
    }
    const codSaved = fraud.data?.window?.codSaved ?? 0;
    toast.success(
      "Cordon caught its first risky order",
      codSaved > 0
        ? `${formatBDT(codSaved)} protected from going on the road as COD.`
        : "It's queued for your review on the Fraud queue.",
    );
  }, [fraud.isLoading, fraud.isError, fraud.data]);

  return null;
}

/**
 * Persistent celebratory banner — anchors the first-flag moment on the
 * dashboard for 7 days so the merchant feels it on every visit, not
 * just the millisecond it first triggered.
 */
export function FirstFlagBanner() {
  const fraud = trpc.fraud.getReviewStats.useQuery(
    { days: 30 },
    { staleTime: 60_000, refetchOnWindowFocus: false },
  );
  // Hydrate from localStorage on mount. Until then we render nothing —
  // the banner is decorative, not critical, so a 50ms blank is fine and
  // avoids a paint flicker between SSR null and client-true.
  const [bannerAt, setBannerAt] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
    const raw = readStorage(STORAGE.firstFlagBannerAt);
    if (raw) {
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) setBannerAt(parsed);
    }
    setDismissed(readStorage(STORAGE.firstFlagBannerDismissed) === "1");
  }, []);

  // Stamp the banner-show date the moment we observe risky > 0 so
  // a merchant who lands on the dashboard AFTER the toast already
  // fired on a different page still sees the banner for 7 days.
  useEffect(() => {
    if (!hydrated) return;
    if (bannerAt !== null) return;
    if (fraud.isLoading || fraud.isError) return;
    const risky = fraud.data?.window?.risky ?? 0;
    if (risky <= 0) return;
    const now = new Date();
    writeStorage(STORAGE.firstFlagBannerAt, now.toISOString());
    setBannerAt(now.getTime());
  }, [hydrated, bannerAt, fraud.isLoading, fraud.isError, fraud.data]);

  if (!hydrated) return null;
  if (dismissed) return null;
  if (bannerAt === null) return null;
  if (Date.now() - bannerAt > BANNER_TTL_MS) return null;

  const codSaved = fraud.data?.window?.codSaved ?? 0;
  const risky = fraud.data?.window?.risky ?? 0;

  return (
    <div className="relative overflow-hidden rounded-xl border border-brand/30 bg-brand/8 px-4 py-3">
      {/* Soft brand-tinted gradient — same visual language as the landing
          hero glow, scaled down. Pure CSS, no animation library. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(420px_140px_at_30%_-30%,hsl(var(--brand)/0.18),transparent_70%)]"
      />
      <div className="relative flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand">
            <ShieldCheck className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight text-fg">
              Cordon caught its first{" "}
              <span className="cordon-serif">risky order.</span>
            </div>
            <div className="mt-0.5 text-xs text-fg-muted">
              {risky} flagged in the last 30 days
              {codSaved > 0 ? (
                <>
                  {" · "}
                  <strong className="font-semibold text-fg">
                    {formatBDT(codSaved)}
                  </strong>{" "}
                  protected from going out as COD
                </>
              ) : null}
              .
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard/fraud-review"
            className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:bg-brand-hover"
          >
            See the queue <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <button
            type="button"
            onClick={() => {
              writeStorage(STORAGE.firstFlagBannerDismissed, "1");
              setDismissed(true);
            }}
            aria-label="Dismiss"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-faint hover:bg-surface-raised hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
