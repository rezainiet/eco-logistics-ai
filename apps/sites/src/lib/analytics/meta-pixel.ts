/**
 * Meta Pixel loader — the only code in apps/sites that talks to `fbq`.
 *
 * Equivalent to Meta's base snippet, but as module code instead of an inline
 * <script> string: a queueing `fbq` stub is installed synchronously and
 * fbevents.js is appended with `async`, so it never blocks rendering. If Meta
 * is unreachable or blocked, calls simply stay queued — nothing throws and
 * the page keeps working.
 *
 * Events are sent with `trackSingle*` so they reach only the configured
 * pixel, each with an eventID (ready for Conversions API de-duplication).
 * Meta's automatic event detection is switched off (`autoConfig`), so the
 * only events are the ones landing-analytics sends.
 */

const FBEVENTS_SRC = "https://connect.facebook.net/en_US/fbevents.js";

type FbqArgs = unknown[];
interface Fbq {
  (...args: FbqArgs): void;
  callMethod?: (...args: FbqArgs) => void;
  queue: FbqArgs[];
  push: Fbq;
  loaded: boolean;
  version: string;
  disablePushState?: boolean;
}

declare global {
  interface Window {
    fbq?: Fbq;
    _fbq?: Fbq;
  }
}

export type PixelParams = Record<string, string | number | string[] | Array<Record<string, string | number>> | undefined>;

export interface MetaPixel {
  /** `eventId` makes an event deterministic (e.g. one Purchase per order) for de-duplication. */
  track(event: string, params?: PixelParams, eventId?: string): void;
  trackCustom(event: string, params?: PixelParams): void;
}

const initialised = new Set<string>();

function installStub(): Fbq {
  if (window.fbq) return window.fbq;
  const fbq = function (this: unknown, ...args: FbqArgs) {
    if (fbq.callMethod) fbq.callMethod(...args);
    else fbq.queue.push(args);
  } as Fbq;
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = "2.0";
  fbq.queue = [];
  // Meta otherwise sends an extra PageView whenever the URL changes via
  // history/hash — e.g. every in-page "#products" button. A landing page is
  // one page view per load; landing-analytics sends it exactly once.
  fbq.disablePushState = true;
  window.fbq = fbq;
  if (!window._fbq) window._fbq = fbq;
  const script = document.createElement("script");
  script.async = true;
  script.src = FBEVENTS_SRC;
  document.head.appendChild(script);
  return fbq;
}

function eventId(name: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${name}.${rand}`;
}

function clean(params: PixelParams | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== "") out[k] = v;
  return out;
}

export function metaPixel(pixelId: string): MetaPixel {
  const fbq = installStub();
  if (!initialised.has(pixelId)) {
    fbq("set", "autoConfig", false, pixelId);
    fbq("init", pixelId);
    initialised.add(pixelId);
  }
  const send = (method: "trackSingle" | "trackSingleCustom", name: string, params?: PixelParams, id?: string) => {
    try {
      window.fbq?.(method, pixelId, name, clean(params), { eventID: id ?? eventId(name) });
    } catch {
      // Analytics must never break the page.
    }
  };
  return {
    track: (name, params, id) => send("trackSingle", name, params, id),
    trackCustom: (name, params) => send("trackSingleCustom", name, params),
  };
}
