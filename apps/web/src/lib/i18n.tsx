"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Locale = "en" | "bn";

const STORAGE_KEY = "merchant_locale";

/**
 * Minimal-scope i18n: a small string table for the navigation + a few
 * top-level dashboard labels. Real internationalisation across the
 * entire UI is a multi-week project; this is a useful first step that
 * proves Bangla support and signals product intent to BD merchants.
 *
 * Adding a key is a 1-line change here. Strings not in the table fall
 * through to English (the input string itself).
 */
const TABLE: Record<string, { en: string; bn: string }> = {
  Dashboard: { en: "Dashboard", bn: "ড্যাশবোর্ড" },
  Orders: { en: "Orders", bn: "অর্ডার" },
  Review: { en: "Review", bn: "পর্যালোচনা" },
  "Fraud review": { en: "Fraud review", bn: "জালিয়াতি পর্যালোচনা" },
  "Call customer": { en: "Call customer", bn: "কাস্টমার কল" },
  Recovery: { en: "Recovery", bn: "পুনরুদ্ধার" },
  Analytics: { en: "Analytics", bn: "বিশ্লেষণ" },
  Behavior: { en: "Behavior", bn: "আচরণ" },
  Integrations: { en: "Integrations", bn: "ইন্টিগ্রেশন" },
  Billing: { en: "Billing", bn: "বিলিং" },
  Settings: { en: "Settings", bn: "সেটিংস" },
  Help: { en: "Help", bn: "সাহায্য" },
  Home: { en: "Home", bn: "হোম" },
  Support: { en: "Support", bn: "সাপোর্ট" },
  WhatsApp: { en: "WhatsApp", bn: "হোয়াটসঅ্যাপ" },
  "Welcome back": { en: "Welcome back", bn: "স্বাগতম" },
};

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: "en",
  setLocale: () => {},
  t: (k) => k,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  // Hydrate from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "bn") setLocaleState(saved);
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, l);
    }
    // Update <html lang> so screen readers + browser features pick the
    // right language for what's actually being rendered.
    if (typeof document !== "undefined") {
      document.documentElement.lang = l;
    }
  }, []);

  const t = useCallback(
    (key: string) => {
      const entry = TABLE[key];
      if (!entry) return key;
      return entry[locale];
    },
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}

/** Test helper: list all translatable keys. */
export function __getTranslatableKeys() {
  return Object.keys(TABLE);
}
