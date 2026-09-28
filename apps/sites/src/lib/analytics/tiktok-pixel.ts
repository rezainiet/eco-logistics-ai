/**
 * TikTok Pixel loader — the only code in apps/sites that talks to `ttq`.
 *
 * Equivalent to TikTok's base snippet as module code: a queueing `ttq` stub
 * (the documented method list, `instance`, `load`) is installed
 * synchronously and events.js is appended with `async`. Calls go through
 * `ttq.instance(pixelId)` so only this page's pixel receives them, each
 * with an `event_id` for de-duplication. Nothing throws if TikTok is slow or
 * blocked.
 */

const EVENTS_SRC = "https://analytics.tiktok.com/i18n/pixel/events.js";
const METHODS = [
  "page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group",
  "enableCookie", "disableCookie", "holdConsent", "revokeConsent", "grantConsent",
] as const;

type Queue = unknown[] & Record<string, unknown>;
interface Ttq extends Queue {
  methods: readonly string[];
  setAndDefer: (target: Queue, method: string) => void;
  instance: (id: string) => Record<string, (...args: unknown[]) => void>;
  load: (id: string) => void;
  _i?: Record<string, Queue>;
  _t?: Record<string, number>;
  _o?: Record<string, unknown>;
}

declare global {
  interface Window {
    ttq?: Ttq;
    TiktokAnalyticsObject?: string;
  }
}

export type TiktokParams = Record<string, unknown>;

export interface TiktokPixel {
  page(): void;
  track(event: string, params?: TiktokParams, eventId?: string): void;
}

const loaded = new Set<string>();

function install(): Ttq {
  if (window.ttq) return window.ttq;
  window.TiktokAnalyticsObject = "ttq";
  const ttq = [] as unknown as Ttq;
  ttq.methods = METHODS;
  ttq.setAndDefer = (target, method) => {
    target[method] = (...args: unknown[]) => {
      target.push([method, ...args]);
    };
  };
  for (const m of METHODS) ttq.setAndDefer(ttq, m);
  ttq.instance = (id: string) => {
    const inst = (ttq._i?.[id] ?? []) as Queue;
    for (const m of METHODS) ttq.setAndDefer(inst, m);
    return inst as unknown as Record<string, (...args: unknown[]) => void>;
  };
  ttq.load = (id: string) => {
    ttq._i = ttq._i || {};
    const q = [] as unknown as Queue;
    q._u = EVENTS_SRC;
    ttq._i[id] = q;
    ttq._t = ttq._t || {};
    ttq._t[id] = Date.now();
    ttq._o = ttq._o || {};
    ttq._o[id] = {};
    const script = document.createElement("script") as HTMLScriptElement;
    script.async = true;
    script.src = `${EVENTS_SRC}?sdkid=${encodeURIComponent(id)}&lib=ttq`;
    document.head.appendChild(script);
  };
  window.ttq = ttq;
  return ttq;
}

export function tiktokPixel(pixelId: string): TiktokPixel {
  const ttq = install();
  // Load once per page (window), even if this module is re-instantiated.
  if (!loaded.has(pixelId) && !ttq._i?.[pixelId]) ttq.load(pixelId);
  loaded.add(pixelId);
  const target = () => {
    try {
      return window.ttq?.instance(pixelId);
    } catch {
      return undefined;
    }
  };
  return {
    page: () => {
      try {
        target()?.page?.();
      } catch {
        // Analytics must never break the page.
      }
    },
    track: (event, params, eventId) => {
      try {
        target()?.track?.(event, params ?? {}, eventId ? { event_id: eventId } : {});
      } catch {
        // Analytics must never break the page.
      }
    },
  };
}
