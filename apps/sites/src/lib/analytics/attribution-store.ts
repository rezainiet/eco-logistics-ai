import { type Attribution, mergeTouches, sanitizeAttribution, touchFromVisit } from "@ecom/landing";

/**
 * First/last-touch marketing attribution for this landing page, kept in
 * the visitor's own browser (localStorage of the page's origin — every
 * landing page is its own subdomain, so pages never share it).
 *
 * `captureAttribution()` runs once per page load: the first attributable
 * visit becomes firstTouch and is never replaced; lastTouch moves to the
 * current visit only when it is attributable (UTM, ad-click id or an
 * external referrer). A direct visit changes nothing. The checkout sends the
 * pair with the order. First-party and independent of any pixel: it works
 * with all tracking switched off, and stores no personal data.
 */

const KEY = "confirmx:attribution:v1";

function read(): Attribution | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? sanitizeAttribution(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function captureAttribution(now: Date = new Date()): Attribution | null {
  if (typeof window === "undefined") return null;
  const stored = read();
  const current = touchFromVisit(window.location.href, document.referrer, window.location.hostname, now);
  const merged = mergeTouches(stored, current);
  if (merged && current) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(merged));
    } catch {
      // Storage unavailable (private mode, quota): attribution is best-effort.
    }
  }
  return merged;
}

/** What the checkout sends with the order (null when nothing attributable was seen). */
export function storedAttribution(): Attribution | null {
  if (typeof window === "undefined") return null;
  return read();
}
