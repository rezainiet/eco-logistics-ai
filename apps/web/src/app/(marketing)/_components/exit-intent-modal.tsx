"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Exit-intent modal — fires once per 10-minute window when the cursor
 * crosses the top edge of the viewport (toward URL bar / tab close).
 * Desktop only; mobile already has the sticky CTA bar.
 *
 * Behavior contract:
 *   - On close, persist a timestamped dismissal in localStorage under
 *     "cordon_modal_dismissed". Subsequent triggers within 10 minutes are
 *     suppressed across this AND future page loads.
 *   - The dismissal check runs INSIDE the mouseout listener, not just at
 *     mount. (Earlier bug: the gate was checked once on mount, then the
 *     listener stayed registered and re-fired setOpen(true) on every
 *     subsequent top-edge mouseout. That's what caused the modal to
 *     reopen after the user closed it.)
 *   - If the user changes calculator inputs significantly (>20% bleed
 *     delta from the snapshot at dismissal time), the dismissal is
 *     cleared — they're effectively re-engaging, so a re-trigger is
 *     warranted on next exit-intent.
 *   - Honors prefers-reduced-motion (early return — no surprise modals).
 *   - Reads from window.__cordonCalc on mount + subscribes to subsequent
 *     `cordon:calc-update` events so the displayed numbers always match
 *     the latest calculator state.
 */

const fmt = new Intl.NumberFormat("en-IN");

const DISMISS_KEY = "cordon_modal_dismissed";
const DISMISS_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const SIGNIFICANT_CHANGE_THRESHOLD = 0.2; // 20% bleed delta resets dismissal

type CalcSnapshot = {
  monthlyBleed?: number;
  monthlySavings?: number;
};

type DismissalRecord = {
  at: number;
  bleed: number | null;
};

function readDismissal(): DismissalRecord | null {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as DismissalRecord;
    if (typeof data?.at !== "number") return null;
    return {
      at: data.at,
      bleed: typeof data.bleed === "number" ? data.bleed : null,
    };
  } catch {
    return null;
  }
}

function isRecentlyDismissed(): boolean {
  const rec = readDismissal();
  if (!rec) return false;
  return Date.now() - rec.at < DISMISS_WINDOW_MS;
}

function markDismissed(snap: CalcSnapshot | null) {
  try {
    const payload: DismissalRecord = {
      at: Date.now(),
      bleed:
        typeof snap?.monthlyBleed === "number" ? snap.monthlyBleed : null,
    };
    localStorage.setItem(DISMISS_KEY, JSON.stringify(payload));
  } catch {
    // localStorage may be disabled (Safari private mode, quota exceeded,
    // browser settings). Failing silently is correct here — the worst
    // case is the user sees the modal again, which is the existing
    // behavior they were already willing to accept on this device.
  }
}

function clearDismissal() {
  try {
    localStorage.removeItem(DISMISS_KEY);
  } catch {
    /* see note in markDismissed */
  }
}

export function ExitIntentModal() {
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState<CalcSnapshot | null>(null);
  // Mirrors `snap` in a ref so the close handler can read the latest
  // snapshot synchronously without triggering re-renders or stale-closure
  // bugs when called from event listeners.
  const snapRef = useRef<CalcSnapshot | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(max-width: 899px)").matches) return; // desktop only
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Catch up on any snapshot the calculator already published before
    // this component mounted.
    const w = window as unknown as { __cordonCalc?: CalcSnapshot };
    if (w.__cordonCalc) {
      snapRef.current = w.__cordonCalc;
      setSnap(w.__cordonCalc);
    }

    function onCalc(e: Event) {
      const detail = (e as CustomEvent<CalcSnapshot>).detail;
      if (!detail) return;
      snapRef.current = detail;
      setSnap(detail);

      // Reset dismissal if the user's bleed has changed significantly
      // since they last dismissed. They're engaging with the calculator
      // again; the number on screen is materially different from what
      // they walked away from. We want exit-intent to be eligible to
      // fire on next top-edge mouseout.
      const rec = readDismissal();
      if (
        rec &&
        rec.bleed !== null &&
        rec.bleed > 0 &&
        typeof detail.monthlyBleed === "number"
      ) {
        const change =
          Math.abs(detail.monthlyBleed - rec.bleed) / rec.bleed;
        if (change > SIGNIFICANT_CHANGE_THRESHOLD) {
          clearDismissal();
        }
      }
    }

    function onLeave(e: MouseEvent) {
      // Top-edge mouseout signal: cursor left the document toward the
      // URL bar / tab strip.
      if (e.relatedTarget !== null || e.clientY > 0) return;
      // Re-check dismissal at trigger time, not just on mount. THIS is
      // the bug fix — keeps the modal closed once the user has dismissed
      // it, regardless of how many times they cross the top edge.
      if (isRecentlyDismissed()) return;
      // setOpen(true) is a React no-op when state is already true, so
      // repeated triggers while open don't cause re-renders or flicker.
      setOpen(true);
    }

    window.addEventListener("cordon:calc-update", onCalc);
    document.addEventListener("mouseout", onLeave);
    return () => {
      window.removeEventListener("cordon:calc-update", onCalc);
      document.removeEventListener("mouseout", onLeave);
    };
  }, []);

  // Body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // ESC closes (and counts as a dismissal).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Single source of truth for closing. Every close path goes through
  // here, so the dismissal record is always written — no path can close
  // the modal without recording the dismissal.
  function close() {
    markDismissed(snapRef.current);
    setOpen(false);
  }

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
      onClick={close}
    >
      <div className="exit-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="exit-modal-close"
          aria-label="Close"
          onClick={close}
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
            onClick={close}
          >
            {hasNumbers ? "See the full report" : "Show me my number"}{" "}
            <span className="arrow">→</span>
          </a>
          <button type="button" className="btn btn-secondary" onClick={close}>
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}
