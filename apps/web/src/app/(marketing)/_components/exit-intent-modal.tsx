"use client";

import { useEffect, useState } from "react";

/**
 * Exit-intent modal — fires once per session when the cursor crosses the
 * top edge of the viewport (toward URL bar / tab close). Desktop only;
 * mobile already has the sticky CTA bar covering the same intent.
 *
 * Reads the latest calc snapshot two ways: (1) listens to subsequent
 * `cordon:calc-update` events, (2) reads `window.__cordonCalc` on mount
 * so it can reflect interactions that happened before this listener
 * subscribed. If no snapshot exists, falls back to a "calculate now" CTA.
 */

const fmt = new Intl.NumberFormat("en-IN");

type CalcSnapshot = {
  monthlyBleed?: number;
  monthlySavings?: number;
};

const SESSION_FLAG = "cordon:exit-shown";

export function ExitIntentModal() {
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState<CalcSnapshot | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(max-width: 899px)").matches) return; // desktop only
    if (sessionStorage.getItem(SESSION_FLAG) === "1") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Honor accessibility preference — no surprise modals on reduced-motion.
      return;
    }

    // Catch up on any snapshot the calculator already published.
    const w = window as unknown as { __cordonCalc?: CalcSnapshot };
    if (w.__cordonCalc) setSnap(w.__cordonCalc);

    function onCalc(e: Event) {
      const detail = (e as CustomEvent<CalcSnapshot>).detail;
      if (detail) setSnap(detail);
    }
    function onLeave(e: MouseEvent) {
      // The reliable "moving toward URL bar" signal: mouseout with no
      // related target (left the document) and Y near the top edge.
      if (e.relatedTarget === null && e.clientY <= 0) {
        setOpen(true);
        sessionStorage.setItem(SESSION_FLAG, "1");
      }
    }

    window.addEventListener("cordon:calc-update", onCalc);
    document.addEventListener("mouseout", onLeave);
    return () => {
      window.removeEventListener("cordon:calc-update", onCalc);
      document.removeEventListener("mouseout", onLeave);
    };
  }, []);

  // Lock body scroll while open so the modal feels modal.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Close on ESC.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const hasNumbers =
    typeof snap?.monthlyBleed === "number" && snap.monthlyBleed > 0;
  const bleed = hasNumbers ? Math.round(snap!.monthlyBleed!) : 0;
  const savings =
    hasNumbers && typeof snap?.monthlySavings === "number"
      ? Math.round(snap.monthlySavings)
      : 0;

  return (
    <div
      className="exit-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="exit-modal-title"
      onClick={() => setOpen(false)}
    >
      <div className="exit-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="exit-modal-close"
          aria-label="Close"
          onClick={() => setOpen(false)}
        >
          ×
        </button>
        <div className="exit-modal-eyebrow">
          <span className="exit-modal-pulse" />
          Wait —
        </div>

        {hasNumbers ? (
          <>
            <h3 id="exit-modal-title">
              You&apos;re bleeding{" "}
              <span className="exit-modal-num">৳{fmt.format(bleed)}</span> a
              month <span className="serif">right now.</span>
            </h3>
            <p>
              Cordon stops <strong>৳{fmt.format(savings)}</strong> of it. Two
              minutes to set up. Don&apos;t close this tab without locking it
              in.
            </p>
          </>
        ) : (
          <>
            <h3 id="exit-modal-title">
              Calculate your monthly bleed{" "}
              <span className="serif">before you go.</span>
            </h3>
            <p>
              Three sliders. One real number. Two seconds. Then you decide
              whether to keep paying the RTO tax.
            </p>
          </>
        )}

        <div className="exit-modal-ctas">
          <a
            href="#calculator"
            className="btn btn-primary btn-lg"
            onClick={() => setOpen(false)}
          >
            {hasNumbers ? "See the full report" : "Show me my number"}{" "}
            <span className="arrow">→</span>
          </a>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setOpen(false)}
          >
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}
