/**
 * Phone normalization → E.164.
 *
 * The platform's primary market is Bangladesh, so the BD branch is exhaustive:
 * we accept all the variants merchants and storefronts type ("01711…",
 * "8801711…", "+880 1711-111-111") and emit a single canonical form
 * (`+8801711111111`). Other countries are accepted only when the input is
 * already E.164 (begins with `+CC` and the digit count is sane), since we
 * don't want to silently mis-stitch identities by guessing an area code.
 *
 * Returns `null` for inputs that can't be reliably normalized — callers
 * should fall back to the raw value with a warning rather than fabricating a
 * number that points at the wrong customer.
 *
 * No external library — keeps the bundle lean. Coverage is the markets we
 * actually serve (Day-6 catalogue: BD, PK, IN, LK, NP, ID, PH, VN, MY, TH).
 */

export type CountryCode =
  | "BD"
  | "PK"
  | "IN"
  | "LK"
  | "NP"
  | "ID"
  | "PH"
  | "VN"
  | "MY"
  | "TH";

const COUNTRY_DIAL: Record<CountryCode, { cc: string; nationalLen: number[] }> = {
  BD: { cc: "880", nationalLen: [10] },
  PK: { cc: "92", nationalLen: [10] },
  IN: { cc: "91", nationalLen: [10] },
  LK: { cc: "94", nationalLen: [9] },
  NP: { cc: "977", nationalLen: [10] },
  ID: { cc: "62", nationalLen: [9, 10, 11, 12] },
  PH: { cc: "63", nationalLen: [10] },
  VN: { cc: "84", nationalLen: [9, 10] },
  MY: { cc: "60", nationalLen: [9, 10] },
  TH: { cc: "66", nationalLen: [9] },
};

const ALL_CC = Object.values(COUNTRY_DIAL).map((c) => c.cc);

/** Strip everything except digits and a leading +. */
function clean(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D+/g, "");
  return hasPlus ? `+${digits}` : digits;
}

function withinE164Bounds(digits: string): boolean {
  // E.164 max 15 digits including country code. Min loosely 7.
  return digits.length >= 7 && digits.length <= 15;
}

/**
 * Normalize to E.164. Returns `null` when normalization is ambiguous (e.g.
 * 10-digit number with no country hint and no defaultCountry).
 */
export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry: CountryCode = "BD",
): string | null {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = clean(raw);
  if (!cleaned) return null;

  // Already a + prefixed candidate — validate length, accept as-is.
  if (cleaned.startsWith("+")) {
    const digits = cleaned.slice(1);
    if (!withinE164Bounds(digits)) return null;
    return `+${digits}`;
  }

  // No prefix — the leading bytes might already be a country code. Check
  // every supported CC longest-first so "880" wins over "88".
  const sorted = [...ALL_CC].sort((a, b) => b.length - a.length);
  for (const cc of sorted) {
    if (cleaned.startsWith(cc)) {
      const candidate = `+${cleaned}`;
      if (withinE164Bounds(cleaned)) return candidate;
    }
  }

  // Fall back to defaultCountry rules.
  const country = COUNTRY_DIAL[defaultCountry];
  if (!country) return null;

  // BD-special: "01XXXXXXXXX" (11 digits, leading 0) → +880 + drop leading 0.
  if (defaultCountry === "BD" && /^0\d{10}$/.test(cleaned)) {
    const national = cleaned.slice(1);
    return `+${country.cc}${national}`;
  }

  // Other countries with a national leading 0 — strip it.
  if (cleaned.startsWith("0")) {
    const national = cleaned.slice(1);
    if (country.nationalLen.includes(national.length)) {
      return `+${country.cc}${national}`;
    }
  }

  // Plain national digits (no leading 0, no CC).
  if (country.nationalLen.includes(cleaned.length)) {
    return `+${country.cc}${cleaned}`;
  }

  return null;
}

/**
 * Best-effort variant: returns the normalized form when possible, otherwise
 * the cleaned (digits-only with optional +) form. Use for storage when you'd
 * rather keep something the merchant typed than drop the value entirely.
 */
export function normalizePhoneOrRaw(
  raw: string | null | undefined,
  defaultCountry: CountryCode = "BD",
): string | null {
  if (!raw || typeof raw !== "string") return null;
  const normalized = normalizePhone(raw, defaultCountry);
  if (normalized) return normalized;
  const cleaned = clean(raw);
  return cleaned || null;
}

/**
 * Build the lookup set for identity-resolution queries — every plausible
 * variant a merchant order or SDK identify call might send for the same
 * underlying phone. Always includes the canonical E.164 form when we can
 * compute it.
 */
export function phoneLookupVariants(
  raw: string | null | undefined,
  defaultCountry: CountryCode = "BD",
): string[] {
  if (!raw) return [];
  const variants = new Set<string>();
  const cleaned = clean(raw);
  if (cleaned) variants.add(cleaned);
  variants.add(raw.trim());
  const normalized = normalizePhone(raw, defaultCountry);
  if (normalized) {
    variants.add(normalized);
    // Also record the national-digits-only form so legacy data without "+"
    // still matches.
    const country = COUNTRY_DIAL[defaultCountry];
    if (country && normalized.startsWith(`+${country.cc}`)) {
      const national = normalized.slice(1 + country.cc.length);
      variants.add(`0${national}`);
      variants.add(national);
      variants.add(`${country.cc}${national}`);
    }
  }
  return [...variants].filter(Boolean);
}
