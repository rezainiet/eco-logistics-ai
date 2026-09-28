/**
 * Google tag (gtag.js) loader for GA4 and Google Ads — the only code in
 * apps/sites that talks to `gtag`.
 *
 * Equivalent to Google's base snippet as module code: `dataLayer` + a
 * queueing `gtag` are installed synchronously and gtag.js is appended with
 * `async`, so it never blocks rendering and nothing throws if Google is slow
 * or blocked. Automatic page views are off (`send_page_view: false`):
 * landing-analytics sends exactly one per page load. Every event names its
 * targets with `send_to`, so only this page's IDs receive it.
 */

const GTAG_SRC = "https://www.googletagmanager.com/gtag/js";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export interface GoogleTagConfig {
  ga4MeasurementId?: string;
  googleAds?: { id: string; purchaseLabel?: string };
}

export type GoogleParams = Record<string, unknown>;

export interface GoogleTag {
  /** Targets every configured tag (GA4 and/or Google Ads). */
  event(name: string, params?: GoogleParams): void;
  /** GA4 only (ecommerce / engagement events). */
  analytics(name: string, params?: GoogleParams): void;
  /** Google Ads purchase conversion — only when a conversion label is configured. */
  purchaseConversion(params: { value: number; currency: string; transactionId: string }): void;
}

const configured = new Set<string>();

function install(firstId: string): (...args: unknown[]) => void {
  if (!window.gtag) {
    window.dataLayer = window.dataLayer || [];
    // gtag.js reads the `arguments` object itself, exactly as Google's snippet pushes it.
    window.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments);
    };
    window.gtag("js", new Date());
    const script = document.createElement("script") as HTMLScriptElement;
    script.async = true;
    script.src = `${GTAG_SRC}?id=${encodeURIComponent(firstId)}`;
    document.head.appendChild(script);
  }
  return window.gtag;
}

export function googleTag(cfg: GoogleTagConfig): GoogleTag | null {
  const ids = [cfg.ga4MeasurementId, cfg.googleAds?.id].filter((v): v is string => !!v);
  if (!ids.length) return null;
  const gtag = install(ids[0]!);
  // Configure each tag once per page (window), even if this module is re-instantiated.
  const done = ((window as unknown as { __confirmxGtagConfigured?: Set<string> }).__confirmxGtagConfigured ??= configured);
  for (const id of ids) {
    if (done.has(id)) continue;
    gtag("config", id, { send_page_view: false });
    done.add(id);
  }
  const call = (name: string, params: GoogleParams | undefined, sendTo: string | string[]) => {
    try {
      window.gtag?.("event", name, { ...(params ?? {}), send_to: sendTo });
    } catch {
      // Analytics must never break the page.
    }
  };
  return {
    event: (name, params) => call(name, params, ids.length === 1 ? ids[0]! : ids),
    analytics: (name, params) => {
      if (cfg.ga4MeasurementId) call(name, params, cfg.ga4MeasurementId);
    },
    purchaseConversion: ({ value, currency, transactionId }) => {
      const ads = cfg.googleAds;
      if (!ads?.purchaseLabel) return;
      call("conversion", { value, currency, transaction_id: transactionId }, `${ads.id}/${ads.purchaseLabel}`);
    },
  };
}
