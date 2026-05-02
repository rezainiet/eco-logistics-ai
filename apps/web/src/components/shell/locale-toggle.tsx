"use client";

import { Languages } from "lucide-react";
import { useI18n } from "@/lib/i18n";

/**
 * Small EN ↔ BN toggle in the topbar. Persists through localStorage so
 * the merchant's choice survives reloads. Aligns the UI nav labels +
 * a handful of dashboard headings with the merchant's preferred
 * language. Does NOT translate dynamic data (order numbers, error
 * messages from upstreams, etc.) — that's a longer project.
 */
export function LocaleToggle() {
  const { locale, setLocale } = useI18n();
  const next = locale === "en" ? "bn" : "en";
  return (
    <button
      type="button"
      onClick={() => setLocale(next)}
      aria-label={`Switch to ${next === "bn" ? "Bangla" : "English"}`}
      title={`Switch to ${next === "bn" ? "Bangla" : "English"}`}
      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-stroke/12 bg-surface px-2.5 text-xs font-semibold text-fg-subtle transition-colors hover:border-stroke/24 hover:text-fg sm:px-3"
    >
      <Languages className="h-4 w-4" aria-hidden />
      <span className="hidden uppercase sm:inline">
        {locale === "en" ? "EN" : "বাংলা"}
      </span>
    </button>
  );
}
