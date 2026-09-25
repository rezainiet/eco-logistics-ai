import type { CtaAction, CtaValue } from "./fields.js";
import { EMAIL_RE, PHONE_RE, SECTION_ID_RE, isExternalHref, phoneDigits, safeUrl } from "./safe.js";

export interface ResolvedHref {
  href: string;
  external: boolean;
}

/**
 * Turn a typed CTA action into an href, re-validating every part. Returns
 * `null` for `none` and for anything unsafe, in which case components
 * render the label without a link.
 */
export function ctaHref(action: CtaAction | null | undefined): ResolvedHref | null {
  if (!action) return null;
  switch (action.kind) {
    case "link": {
      const href = safeUrl(action.url);
      return href ? { href, external: isExternalHref(href) } : null;
    }
    case "phone": {
      if (!PHONE_RE.test(action.phone)) return null;
      return { href: `tel:${phoneDigits(action.phone)}`, external: false };
    }
    case "whatsapp": {
      if (!PHONE_RE.test(action.phone)) return null;
      const digits = phoneDigits(action.phone).replace(/^\+/, "");
      const text = action.message ? `?text=${encodeURIComponent(action.message)}` : "";
      return { href: `https://wa.me/${digits}${text}`, external: true };
    }
    case "email": {
      if (!EMAIL_RE.test(action.email)) return null;
      const href = safeUrl(`mailto:${action.email}`);
      return href ? { href, external: false } : null;
    }
    case "section":
      return SECTION_ID_RE.test(action.sectionId) ? { href: `#${action.sectionId}`, external: false } : null;
    case "none":
      return null;
  }
}

export function hasCta(value: CtaValue | null | undefined): value is CtaValue {
  return !!value && typeof value.label === "string" && value.label.trim().length > 0;
}
