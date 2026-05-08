/**
 * Address Intelligence v1 — pure-function deliverability scoring.
 *
 * Inputs:  free-form `address` string + optional `district` for context.
 * Output:  AddressQualityResult — score / completeness tier / explainable
 *          signals + the merchant-facing `missingHints` strings the UI
 *          surfaces verbatim.
 *
 * Bangladesh-first heuristics:
 *  - Landmark words (mosque / bazar / school / road / tower) carry weight
 *    because BD addresses are landmark-relative; a landmark-only address
 *    is OFTEN deliverable.
 *  - Mixed-script addresses (Latin + Bangla in the same line) are
 *    statistically harder for couriers and earn a small penalty.
 *  - Numbers (road / house / flat) anchor the address; presence is rewarded.
 *  - Token count is a coarse but reliable completeness proxy.
 *
 * No ML, no LLM, no opaque model — every contribution is a fixed integer
 * with a human-readable rationale. The merchant can debug exactly why an
 * address scored what it scored.
 */

/* -------------------------------------------------------------------------- */
/* Landmark lexicon — Latin + Bangla. Categories track distinct anchor       */
/* types so we can reward "multi-category" addresses.                         */
/* -------------------------------------------------------------------------- */

const LANDMARK_TOKENS: Record<string, ReadonlyArray<string>> = {
  road: ["road", "rd", "lane", "street", "st", "avenue", "রোড", "সড়ক", "লেন"],
  house: ["house", "h#", "h/", "flat", "apt", "apartment", "tower", "building", "বাড়ি", "ফ্ল্যাট", "টাওয়ার", "ভবন"],
  block: ["block", "sector", "section", "ব্লক", "সেক্টর", "সেকশন"],
  worship: ["mosque", "masjid", "mandir", "temple", "church", "মসজিদ", "মন্দির", "চার্চ"],
  education: ["school", "college", "university", "madrasa", "madrassa", "স্কুল", "কলেজ", "মাদ্রাসা", "বিশ্ববিদ্যালয়"],
  market: ["bazar", "bazaar", "market", "mall", "plaza", "বাজার", "মার্কেট", "প্লাজা"],
  health: ["hospital", "clinic", "medical", "হাসপাতাল", "ক্লিনিক"],
  intersection: ["more", "morh", "mor", "circle", "chowrasta", "junction", "মোড়", "চৌরাস্তা"],
  transport: ["station", "bridge", "pump", "stand", "stoppage", "স্টেশন", "ব্রিজ", "পাম্প", "স্ট্যান্ড"],
  authority: ["chairman", "thana", "union", "upazila", "ward", "চেয়ারম্যান", "থানা", "ইউনিয়ন", "উপজেলা", "ওয়ার্ড"],
};

/** Flatten lexicon for fast existence checks. All lowercase. */
const LANDMARK_LOOKUP: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [category, words] of Object.entries(LANDMARK_TOKENS)) {
    for (const w of words) m.set(w.toLowerCase(), category);
  }
  return m;
})();

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type AddressCompleteness = "complete" | "partial" | "incomplete";
export type AddressScriptMix = "latin" | "bangla" | "mixed";

/** Stable hint codes — UI maps these to localized copy. */
export const ADDRESS_HINT_CODES = [
  "no_anchor",       // no landmark AND no number — critical
  "no_landmark",     // landmark missing (number present)
  "no_number",       // number missing (landmark present)
  "too_short",       // < 15 chars
  "too_few_tokens",  // < 3 tokens
  "mixed_script",    // Latin + Bangla mixed in same line
] as const;
export type AddressHintCode = (typeof ADDRESS_HINT_CODES)[number];

export interface AddressQualityResult {
  score: number;                  // 0..100
  completeness: AddressCompleteness;
  /** Detected landmark categories (e.g. ["road", "worship"]). */
  landmarks: string[];
  hasNumber: boolean;
  tokenCount: number;
  scriptMix: AddressScriptMix;
  missingHints: AddressHintCode[];
  computedAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const TOKEN_SPLIT_RE = /[\s,.\-/()|]+/u;

/** Match Bangla code-block (Unicode range U+0980 .. U+09FF). */
const BANGLA_CHAR_RE = /[ঀ-৿]/g;
const LATIN_CHAR_RE = /[a-zA-Z]/g;
const DIGIT_RE = /\d/;

/** Detect script mix on the raw address. Threshold-free: any Bangla AND
 *  any Latin character makes the line "mixed". This is intentional — even
 *  a single Bangla word in a Latin address is enough to confuse a typical
 *  rider's reading flow. */
function detectScriptMix(raw: string): AddressScriptMix {
  const banglaHits = (raw.match(BANGLA_CHAR_RE) ?? []).length;
  const latinHits = (raw.match(LATIN_CHAR_RE) ?? []).length;
  if (banglaHits > 0 && latinHits > 0) return "mixed";
  if (banglaHits > 0) return "bangla";
  return "latin";
}

/** Find landmark categories present in the token stream. Returns up to one
 *  category per match — duplicate landmark words in the same category
 *  collapse so a merchant can't game the score with "Mosque Mosque Mosque". */
function detectLandmarks(tokens: string[], rawLower: string): string[] {
  const found = new Set<string>();
  // Token-level matches (fast path).
  for (const t of tokens) {
    const cat = LANDMARK_LOOKUP.get(t);
    if (cat) found.add(cat);
  }
  // Substring fallback for tokens our splitter can't isolate cleanly —
  // primarily multi-byte Bangla glyphs that attach to surrounding text
  // without whitespace. Gated tightly to avoid Latin false positives:
  //   - any Bangla glyph passes (highly specific by nature)
  //   - Latin words must be ≥ 4 chars (a 2-char alias like "st" / "rd"
  //     would false-positive against "just", "card", "order", etc.)
  if (found.size < Object.keys(LANDMARK_TOKENS).length) {
    for (const [word, cat] of LANDMARK_LOOKUP) {
      if (found.has(cat)) continue;
      const isBangla = /[ঀ-৿]/.test(word);
      if (!isBangla && word.length < 4) continue;
      if (rawLower.includes(word)) found.add(cat);
    }
  }
  return [...found];
}

/* -------------------------------------------------------------------------- */
/* Main scoring function                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Pure deliverability scorer.
 *
 * Returns `null` only when the input is missing/empty — callers should treat
 * `null` as "no quality data" and surface neither score nor hints.
 */
export function computeAddressQuality(
  address: string | null | undefined,
  district?: string | null,
): AddressQualityResult | null {
  if (!address || typeof address !== "string") return null;
  const trimmed = address.trim();
  if (trimmed.length === 0) return null;

  const lower = trimmed.toLowerCase();
  const tokens = lower.split(TOKEN_SPLIT_RE).filter((t) => t.length > 0);
  const tokenCount = tokens.length;

  const scriptMix = detectScriptMix(trimmed);
  const hasNumber = DIGIT_RE.test(trimmed);
  const landmarks = detectLandmarks(tokens, lower);
  const _districtPresent = !!district && String(district).trim().length > 0;

  // ---- Score composition -------------------------------------------------
  let score = 50; // neutral baseline

  // Positive contributions
  if (tokenCount >= 5) score += 10;
  if (tokenCount >= 8) score += 5;
  if (hasNumber) score += 10;
  if (landmarks.length > 0) score += 10;
  if (landmarks.length >= 2) score += 5;
  if (_districtPresent) score += 5;

  // Penalties
  if (scriptMix === "mixed") score -= 5;
  if (trimmed.length < 15) score -= 20;
  if (tokenCount < 3) score -= 25;
  // No anchor at all — neither landmark nor number — is the costliest gap;
  // this is what makes BD addresses undeliverable.
  if (landmarks.length === 0 && !hasNumber) score -= 10;

  // Clamp
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  // ---- Hints (mutually exclusive critical-vs-individual) -----------------
  const missingHints: AddressHintCode[] = [];
  if (landmarks.length === 0 && !hasNumber) {
    missingHints.push("no_anchor");
  } else {
    if (landmarks.length === 0) missingHints.push("no_landmark");
    if (!hasNumber) missingHints.push("no_number");
  }
  if (trimmed.length < 15) missingHints.push("too_short");
  if (tokenCount < 3) missingHints.push("too_few_tokens");
  if (scriptMix === "mixed") missingHints.push("mixed_script");

  // ---- Tier --------------------------------------------------------------
  let completeness: AddressCompleteness;
  if (
    score >= 70 &&
    tokenCount >= 5 &&
    (hasNumber || landmarks.length > 0)
  ) {
    completeness = "complete";
  } else if (score >= 40) {
    completeness = "partial";
  } else {
    completeness = "incomplete";
  }

  return {
    score,
    completeness,
    landmarks,
    hasNumber,
    tokenCount,
    scriptMix,
    missingHints,
    computedAt: new Date(),
  };
}
