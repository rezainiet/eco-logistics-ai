"use client";

import { useEffect } from "react";

/**
 * Listens for cordon:calc-update events and toggles a `recommended` class
 * on the pricing card whose data-plan attribute matches the calculator's
 * current recommendation. No DOM is rendered — this component is a
 * side-effect-only listener mounted near the pricing section.
 *
 * Mount order doesn't matter: if the calculator dispatched before we
 * subscribed, we read window.__cordonCalc on mount to catch up.
 */
export function PricingHighlighter() {
  useEffect(() => {
    function applyHighlight(planName: string | undefined) {
      const cards = document.querySelectorAll<HTMLElement>("[data-plan]");
      cards.forEach((card) => {
        card.classList.toggle(
          "recommended",
          card.dataset.plan === planName,
        );
      });
    }

    // Catch-up on mount if calculator already dispatched.
    const w = window as unknown as { __cordonCalc?: { plan?: string } };
    if (w.__cordonCalc?.plan) applyHighlight(w.__cordonCalc.plan);

    function onUpdate(e: Event) {
      const detail = (e as CustomEvent<{ plan?: string }>).detail;
      applyHighlight(detail?.plan);
    }
    window.addEventListener("cordon:calc-update", onUpdate);
    return () => window.removeEventListener("cordon:calc-update", onUpdate);
  }, []);

  return null;
}
