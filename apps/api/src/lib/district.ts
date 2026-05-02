/**
 * District normalization for the courier-intelligence engine.
 *
 * BD merchants spell districts inconsistently: "Dhaka", "dhaka", "DHAKA",
 * "dhaka ", "Dhaka City", "ঢাকা". The CourierPerformance bucket is keyed
 * on district, so without normalization the same place becomes ten
 * different rows and the scoring engine never accumulates enough evidence.
 *
 * Pure function. Same input → same output. Returns the canonical lowercase
 * key. Empty/missing input → "_GLOBAL_" (matches the merchant-wide bucket
 * sentinel so downstream scoring degrades gracefully).
 *
 * The alias map covers the most common BD-district spelling variants
 * observed in real merchant data. Add new ones as they show up. Anything
 * not in the map is canonicalized via the same trim+lowercase rule, so
 * the engine still benefits from the basic normalization even for novel
 * districts.
 */

export const DISTRICT_GLOBAL = "_GLOBAL_" as const;

const ALIASES: Record<string, string> = {
  // BD divisions / common cities — Bangla → English; common misspellings.
  "ঢাকা": "dhaka",
  "ঢাকা সিটি": "dhaka",
  "dhaka city": "dhaka",
  "dhaka metropolitan": "dhaka",
  "ctg": "chittagong",
  "chittagong": "chittagong",
  "চট্টগ্রাম": "chittagong",
  "chattogram": "chittagong",
  "চট্টগ্রাম সিটি": "chittagong",
  "sylhet": "sylhet",
  "সিলেট": "sylhet",
  "khulna": "khulna",
  "খুলনা": "khulna",
  "rajshahi": "rajshahi",
  "রাজশাহী": "rajshahi",
  "barisal": "barisal",
  "barishal": "barisal",
  "বরিশাল": "barisal",
  "rangpur": "rangpur",
  "রংপুর": "rangpur",
  "mymensingh": "mymensingh",
  "ময়মনসিংহ": "mymensingh",
  "narayanganj": "narayanganj",
  "narayangonj": "narayanganj",
  "নারায়ণগঞ্জ": "narayanganj",
  "gazipur": "gazipur",
  "গাজীপুর": "gazipur",
  "savar": "savar",
  "comilla": "comilla",
  "cumilla": "comilla",
  "কুমিল্লা": "comilla",
};

export function normalizeDistrict(raw: string | null | undefined): string {
  if (!raw) return DISTRICT_GLOBAL;
  const key = String(raw).trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return DISTRICT_GLOBAL;
  if (ALIASES[key]) return ALIASES[key]!;
  // Strip a trailing "city"/"district"/"division" qualifier and re-check
  // ("Khulna District" / "Sylhet Division" → "khulna" / "sylhet").
  const stripped = key.replace(/\s+(city|district|division|sadar)$/u, "").trim();
  if (stripped && stripped !== key && ALIASES[stripped]) return ALIASES[stripped]!;
  // Fall through: trimmed-lowercase IS the canonical for unknown districts.
  return stripped || key;
}

/** Convenience export for tests. */
export const __TEST = { ALIASES };
