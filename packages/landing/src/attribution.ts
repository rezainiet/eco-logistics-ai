/**
 * Marketing attribution for landing-page orders — shared by the public
 * renderer (capture in the browser) and the API (server-side sanitising).
 *
 * A "touch" is what brought a visitor to the page: UTM parameters, which
 * ad-click identifier was present (only its TYPE — never the id value),
 * the external referrer's host (never the full URL) and the landing path
 * (never the query string). Nothing personal is read or stored.
 *
 * Per landing page (each page is its own origin), the browser keeps:
 *   firstTouch  the first attributable visit — never overwritten
 *   lastTouch   the most recent attributable visit
 * A visit with no UTM, no click id and no external referrer ("direct") is
 * not attributable and changes neither. The pair travels with the checkout
 * request and is stored on the order the server creates. It is analytics
 * metadata only: the merchant and page always come from the hostname.
 */

export const CLICK_ID_TYPES = ["fbclid", "gclid", "gbraid", "wbraid", "ttclid", "msclkid"] as const;
export type ClickIdType = (typeof CLICK_ID_TYPES)[number];

export interface Touch {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
  clickIdType?: ClickIdType;
  /** Host of an external referrer, e.g. "l.facebook.com". */
  referrerHost?: string;
  /** Path the visitor landed on, without query or fragment. */
  landingPath?: string;
  /** ISO time of the visit. */
  at: string;
}

export interface Attribution {
  firstTouch?: Touch;
  lastTouch?: Touch;
}

export const ATTRIBUTION_LIMITS = {
  source: 80,
  medium: 80,
  campaign: 200,
  term: 120,
  content: 200,
  referrerHost: 253,
  landingPath: 200,
} as const;

const TEXT_FIELDS = ["source", "medium", "campaign", "term", "content"] as const;
/** Oldest touch accepted from a browser (the rest is ignored as stale/forged). */
const MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Trim, drop control characters, collapse whitespace, clamp. Empty → undefined. */
function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return s ? s : undefined;
}

function cleanHost(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const h = v.trim().toLowerCase().replace(/\.$/, "");
  return HOST_RE.test(h) ? h : undefined;
}

function cleanPath(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.startsWith("/")) return undefined;
  const path = v.split(/[?#]/)[0]!;
  return cleanText(path, ATTRIBUTION_LIMITS.landingPath);
}

/** True when a touch says something about where the visit came from. */
export function isAttributable(t: Omit<Touch, "at"> | null | undefined): boolean {
  return !!t && !!(t.source || t.medium || t.campaign || t.term || t.content || t.clickIdType || t.referrerHost);
}

/** Validates one touch from an untrusted source; null when unusable. */
export function sanitizeTouch(raw: unknown, now: Date = new Date()): Touch | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const at = typeof r.at === "string" ? new Date(r.at) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const age = now.getTime() - at.getTime();
  if (age > MAX_AGE_MS || age < -MAX_FUTURE_MS) return null;
  const t: Touch = { at: at.toISOString() };
  for (const k of TEXT_FIELDS) {
    const v = cleanText(r[k], ATTRIBUTION_LIMITS[k]);
    if (v) t[k] = v;
  }
  if (typeof r.clickIdType === "string" && (CLICK_ID_TYPES as readonly string[]).includes(r.clickIdType)) {
    t.clickIdType = r.clickIdType as ClickIdType;
  }
  const host = cleanHost(r.referrerHost);
  if (host) t.referrerHost = host;
  const path = cleanPath(r.landingPath);
  if (path) t.landingPath = path;
  return isAttributable(t) ? t : null;
}

/** Validates a first/last pair from an untrusted source; null when empty. */
export function sanitizeAttribution(raw: unknown, now: Date = new Date()): Attribution | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const firstTouch = sanitizeTouch(r.firstTouch, now) ?? undefined;
  const lastTouch = sanitizeTouch(r.lastTouch, now) ?? undefined;
  if (!firstTouch && !lastTouch) return null;
  // A lone touch is both the first and the last one we know of.
  return { firstTouch: firstTouch ?? lastTouch, lastTouch: lastTouch ?? firstTouch };
}

/**
 * Reads the touch of the current visit from the page URL and referrer.
 * `ownHost` is the page's own host: internal navigation is not a referrer.
 * Returns null for a direct (non-attributable) visit.
 */
export function touchFromVisit(href: string, referrer: string | null | undefined, ownHost: string, now: Date = new Date()): Touch | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const p = url.searchParams;
  const raw: Record<string, unknown> = {
    at: now.toISOString(),
    source: p.get("utm_source"),
    medium: p.get("utm_medium"),
    campaign: p.get("utm_campaign"),
    term: p.get("utm_term"),
    content: p.get("utm_content"),
    clickIdType: CLICK_ID_TYPES.find((k) => (p.get(k) ?? "").trim() !== ""),
    landingPath: url.pathname,
  };
  if (referrer) {
    try {
      const ref = new URL(referrer);
      const host = ref.hostname.toLowerCase();
      if ((ref.protocol === "https:" || ref.protocol === "http:") && host !== ownHost.toLowerCase()) raw.referrerHost = host;
    } catch {
      // Unparseable referrer: ignored.
    }
  }
  return sanitizeTouch(raw, now);
}

/**
 * Combines what the browser already stored with the current visit:
 * first touch is kept forever once set; last touch moves to the current
 * visit only when that visit is attributable.
 */
export function mergeTouches(stored: Attribution | null | undefined, current: Touch | null): Attribution | null {
  const first = stored?.firstTouch ?? current ?? undefined;
  const last = current ?? stored?.lastTouch ?? stored?.firstTouch ?? undefined;
  if (!first && !last) return null;
  return { firstTouch: first, lastTouch: last };
}
