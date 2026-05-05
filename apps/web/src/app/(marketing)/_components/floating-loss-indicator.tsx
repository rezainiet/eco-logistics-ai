"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Floating loss indicator — persistent reminder of the user's calculated
 * monthly bleed. Shows up at the bottom-right after the user moves the
 * calculator's sliders, follows them down the page, and stays until they
 * either click through or dismiss it.
 *
 * Talks to the calculator via a window CustomEvent (`cordon:calc-update`)
 * — no shared state container, no provider wrapper. Hidden on mobile so it
 * doesn't fight the sticky CTA bar that already lives there.
 */

const fmt = new Intl.NumberFormat("en-IN");

type CalcSnapshot = {
  monthlyBleed: number;
  monthlySavings: number;
};

export function FloatingLossIndicator() {
  const [snap, setSnap] = useState<CalcSnapshot | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    function onUpdate(e: Event) {
      const detail = (e as CustomEvent<CalcSnapshot>).detail;
      if (!detail) return;
      setSnap(detail);
    }
    window.addEventListener("cordon:calc-update", onUpdate);
    return () => window.removeEventListener("cordon:calc-update", onUpdate);
  }, []);

  if (!snap || dismissed) return null;

  return (
    <aside className="floating-loss" aria-live="polite">
      <button
        type="button"
        className="floating-loss-close"
        aria-label="Dismiss loss indicator"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
      <div className="floating-loss-label">Your monthly bleed</div>
      <div className="floating-loss-value">
        ৳{fmt.format(Math.round(snap.monthlyBleed))}
      </div>
      <div className="floating-loss-sub">
        Cordon stops <strong>৳{fmt.format(Math.round(snap.monthlySavings))}</strong> of it.
      </div>
      <Link href="/signup" className="btn btn-primary floating-loss-cta">
        Stop the bleed <span className="arrow">→</span>
      </Link>
    </aside>
  );
}
