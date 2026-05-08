/**
 * Bangladesh thana / upazila lexicon.
 *
 * Bangladesh delivery is coordinated at the THANA level (police-station /
 * urban subdistrict) — not at district level. Pathao zones, Steadfast hub
 * assignments, and RedX rider routing all happen at thana granularity.
 *
 * The lexicon below is a v1 SEED, not a complete enumeration. Coverage is
 * deliberately weighted toward the BD divisions where merchants on Cordon
 * concentrate today (Dhaka metro, Chattogram, Sylhet, Khulna, Rajshahi,
 * Gazipur, Narayanganj). Adding a thana is a code change — keeps it under
 * code review.
 *
 * Each entry carries:
 *   - `canonical`: lowercase canonical form used downstream (matches the
 *     same lowercasing rule as `lib/district.ts` so joins stay consistent).
 *   - `aliases`: every plausible spelling we want to match — Bangla,
 *     transliterated Latin, common misspellings, "X-1" / "X 1" variants.
 *   - `district`: the parent district (lowercase canonical, must match
 *     `lib/district.ts`'s `normalizeDistrict` output) so we can disambiguate
 *     when the same name belongs to multiple districts.
 *
 * Pure data file. No side effects. The runtime extractor lives below.
 */

export interface ThanaEntry {
  canonical: string;
  aliases: string[];
  district: string;
}

/**
 * v1 seed. ~150 thanas — Dhaka metro deep coverage; representative coverage
 * for the next-most-active divisions. Extend in PRs as merchant data
 * uncovers gaps.
 */
export const THANAS: ReadonlyArray<ThanaEntry> = [
  // ---- Dhaka (DMP) ----
  { canonical: "adabor", aliases: ["adabor", "আদাবর"], district: "dhaka" },
  { canonical: "badda", aliases: ["badda", "বাড্ডা"], district: "dhaka" },
  { canonical: "banani", aliases: ["banani", "বনানী"], district: "dhaka" },
  { canonical: "bashundhara", aliases: ["bashundhara", "বসুন্ধরা"], district: "dhaka" },
  { canonical: "cantonment", aliases: ["cantonment", "ক্যান্টনমেন্ট"], district: "dhaka" },
  { canonical: "demra", aliases: ["demra", "ডেমরা"], district: "dhaka" },
  { canonical: "dhanmondi", aliases: ["dhanmondi", "ধানমন্ডি", "dhanmandi"], district: "dhaka" },
  { canonical: "gendaria", aliases: ["gendaria", "gandaria", "গেন্ডারিয়া"], district: "dhaka" },
  { canonical: "gulshan", aliases: ["gulshan", "গুলশান"], district: "dhaka" },
  { canonical: "hatirjheel", aliases: ["hatirjheel", "হাতিরঝিল"], district: "dhaka" },
  { canonical: "jatrabari", aliases: ["jatrabari", "যাত্রাবাড়ী"], district: "dhaka" },
  { canonical: "kafrul", aliases: ["kafrul", "কাফরুল"], district: "dhaka" },
  { canonical: "kamrangirchar", aliases: ["kamrangirchar", "কামরাঙ্গীরচর"], district: "dhaka" },
  { canonical: "khilgaon", aliases: ["khilgaon", "খিলগাঁও"], district: "dhaka" },
  { canonical: "khilkhet", aliases: ["khilkhet", "খিলক্ষেত"], district: "dhaka" },
  { canonical: "kotwali", aliases: ["kotwali", "kotoali", "কোতয়ালী"], district: "dhaka" },
  { canonical: "lalbagh", aliases: ["lalbagh", "lalbag", "লালবাগ"], district: "dhaka" },
  { canonical: "mirpur", aliases: ["mirpur", "মিরপুর"], district: "dhaka" },
  // The numbered Mirpur sectors are common storefront input. Match them all
  // back to the same canonical thana — sector resolution is a separate
  // problem we don't model in v1.
  { canonical: "mirpur", aliases: ["mirpur 1", "mirpur-1", "mirpur1", "mirpur 2", "mirpur-2", "mirpur2", "mirpur 6", "mirpur-6", "mirpur6", "mirpur 7", "mirpur-7", "mirpur7", "mirpur 10", "mirpur-10", "mirpur10", "mirpur 11", "mirpur-11", "mirpur11", "mirpur 12", "mirpur-12", "mirpur12", "mirpur 13", "mirpur-13", "mirpur13", "mirpur 14", "mirpur-14", "mirpur14"], district: "dhaka" },
  { canonical: "mohammadpur", aliases: ["mohammadpur", "মোহাম্মদপুর"], district: "dhaka" },
  { canonical: "motijheel", aliases: ["motijheel", "মতিঝিল"], district: "dhaka" },
  { canonical: "new market", aliases: ["new market", "newmarket", "নিউ মার্কেট"], district: "dhaka" },
  { canonical: "pallabi", aliases: ["pallabi", "পল্লবী"], district: "dhaka" },
  { canonical: "paltan", aliases: ["paltan", "পল্টন"], district: "dhaka" },
  { canonical: "ramna", aliases: ["ramna", "রমনা"], district: "dhaka" },
  { canonical: "rampura", aliases: ["rampura", "রামপুরা"], district: "dhaka" },
  { canonical: "sabujbagh", aliases: ["sabujbagh", "sabujbag", "সবুজবাগ"], district: "dhaka" },
  { canonical: "shah ali", aliases: ["shah ali", "shahali", "শাহ আলী"], district: "dhaka" },
  { canonical: "shahbagh", aliases: ["shahbagh", "shahbag", "শাহবাগ"], district: "dhaka" },
  { canonical: "sher-e-bangla nagar", aliases: ["sher-e-bangla nagar", "sher e bangla nagar", "sherebanglanagar", "শেরেবাংলা নগর"], district: "dhaka" },
  { canonical: "shyampur", aliases: ["shyampur", "শ্যামপুর"], district: "dhaka" },
  { canonical: "sutrapur", aliases: ["sutrapur", "সূত্রাপুর"], district: "dhaka" },
  { canonical: "tejgaon", aliases: ["tejgaon", "তেজগাঁও"], district: "dhaka" },
  { canonical: "turag", aliases: ["turag", "তুরাগ"], district: "dhaka" },
  { canonical: "uttara", aliases: ["uttara", "উত্তরা"], district: "dhaka" },
  { canonical: "uttar khan", aliases: ["uttar khan", "uttarkhan", "উত্তর খান"], district: "dhaka" },
  { canonical: "wari", aliases: ["wari", "ওয়ারী"], district: "dhaka" },
  { canonical: "vatara", aliases: ["vatara", "bhatara", "ভাটারা"], district: "dhaka" },

  // ---- Greater Dhaka district outside DMP ----
  { canonical: "savar", aliases: ["savar", "সাভার"], district: "dhaka" },
  { canonical: "dhamrai", aliases: ["dhamrai", "ধামরাই"], district: "dhaka" },
  { canonical: "keraniganj", aliases: ["keraniganj", "kerani ganj", "কেরাণীগঞ্জ"], district: "dhaka" },
  { canonical: "nawabganj", aliases: ["nawabganj", "নবাবগঞ্জ"], district: "dhaka" },
  { canonical: "dohar", aliases: ["dohar", "দোহার"], district: "dhaka" },

  // ---- Gazipur ----
  { canonical: "gazipur sadar", aliases: ["gazipur sadar", "gazipur", "গাজীপুর সদর"], district: "gazipur" },
  { canonical: "tongi", aliases: ["tongi", "টঙ্গী"], district: "gazipur" },
  { canonical: "kaliakair", aliases: ["kaliakair", "কালিয়াকৈর"], district: "gazipur" },
  { canonical: "kapasia", aliases: ["kapasia", "কাপাসিয়া"], district: "gazipur" },
  { canonical: "kaliganj", aliases: ["kaliganj gazipur", "kaliganj", "কালীগঞ্জ"], district: "gazipur" },
  { canonical: "sreepur", aliases: ["sreepur", "শ্রীপুর"], district: "gazipur" },

  // ---- Narayanganj ----
  { canonical: "narayanganj sadar", aliases: ["narayanganj sadar", "narayanganj", "narayangonj", "নারায়ণগঞ্জ সদর"], district: "narayanganj" },
  { canonical: "bandar", aliases: ["bandar", "বন্দর"], district: "narayanganj" },
  { canonical: "sonargaon", aliases: ["sonargaon", "সোনারগাঁও"], district: "narayanganj" },
  { canonical: "rupganj", aliases: ["rupganj", "রূপগঞ্জ"], district: "narayanganj" },
  { canonical: "araihazar", aliases: ["araihazar", "আড়াইহাজার"], district: "narayanganj" },

  // ---- Chittagong / Chattogram ----
  { canonical: "kotwali ctg", aliases: ["kotwali ctg", "kotwali chittagong"], district: "chittagong" },
  { canonical: "pahartali", aliases: ["pahartali", "পাহাড়তলী"], district: "chittagong" },
  { canonical: "panchlaish", aliases: ["panchlaish", "পাঁচলাইশ"], district: "chittagong" },
  { canonical: "bayejid bostami", aliases: ["bayejid bostami", "bayazid", "বায়েজিদ"], district: "chittagong" },
  { canonical: "chandgaon", aliases: ["chandgaon", "চান্দগাঁও"], district: "chittagong" },
  { canonical: "bakalia", aliases: ["bakalia", "বাকলিয়া"], district: "chittagong" },
  { canonical: "halishahar", aliases: ["halishahar", "হালিশহর"], district: "chittagong" },
  { canonical: "patenga", aliases: ["patenga", "পতেঙ্গা"], district: "chittagong" },
  { canonical: "khulshi", aliases: ["khulshi", "খুলশী"], district: "chittagong" },
  { canonical: "chawkbazar", aliases: ["chawkbazar", "চকবাজার"], district: "chittagong" },
  { canonical: "akbar shah", aliases: ["akbar shah", "akbarshah", "আকবর শাহ"], district: "chittagong" },
  { canonical: "patiya", aliases: ["patiya", "পটিয়া"], district: "chittagong" },
  { canonical: "anwara", aliases: ["anwara", "আনোয়ারা"], district: "chittagong" },
  { canonical: "boalkhali", aliases: ["boalkhali", "বোয়ালখালী"], district: "chittagong" },
  { canonical: "sitakunda", aliases: ["sitakunda", "সীতাকুণ্ড"], district: "chittagong" },
  { canonical: "mirsharai", aliases: ["mirsharai", "মীরসরাই"], district: "chittagong" },
  { canonical: "banshkhali", aliases: ["banshkhali", "বাঁশখালী"], district: "chittagong" },
  { canonical: "satkania", aliases: ["satkania", "সাতকানিয়া"], district: "chittagong" },
  // Disambiguating canonical — a Lohagara also exists in Narail (not in
  // lexicon yet). When that lands, the suffix here keeps the Chittagong
  // identity stable instead of clobbering callers who joined on canonical.
  { canonical: "lohagara ctg", aliases: ["lohagara ctg", "lohagara"], district: "chittagong" },

  // ---- Sylhet ----
  { canonical: "sylhet sadar", aliases: ["sylhet sadar", "sylhet", "সিলেট সদর"], district: "sylhet" },
  { canonical: "beanibazar", aliases: ["beanibazar", "বিয়ানীবাজার"], district: "sylhet" },
  { canonical: "bishwanath", aliases: ["bishwanath", "বিশ্বনাথ"], district: "sylhet" },
  { canonical: "companiganj sylhet", aliases: ["companiganj sylhet", "companiganj"], district: "sylhet" },
  { canonical: "fenchuganj", aliases: ["fenchuganj", "ফেঞ্চুগঞ্জ"], district: "sylhet" },
  { canonical: "golapganj", aliases: ["golapganj", "গোলাপগঞ্জ"], district: "sylhet" },
  { canonical: "gowainghat", aliases: ["gowainghat", "গোয়াইনঘাট"], district: "sylhet" },
  { canonical: "jaintiapur", aliases: ["jaintiapur", "জৈন্তাপুর"], district: "sylhet" },
  { canonical: "kanaighat", aliases: ["kanaighat", "কানাইঘাট"], district: "sylhet" },
  { canonical: "osmani nagar", aliases: ["osmani nagar", "osmaninagar", "ওসমানীনগর"], district: "sylhet" },
  { canonical: "zakiganj", aliases: ["zakiganj", "জকিগঞ্জ"], district: "sylhet" },
  { canonical: "balaganj", aliases: ["balaganj", "বালাগঞ্জ"], district: "sylhet" },
  { canonical: "south surma", aliases: ["south surma", "southsurma", "দক্ষিণ সুরমা"], district: "sylhet" },

  // ---- Khulna ----
  { canonical: "daulatpur", aliases: ["daulatpur khulna", "daulatpur", "দৌলতপুর"], district: "khulna" },
  { canonical: "khalishpur", aliases: ["khalishpur", "খালিশপুর"], district: "khulna" },
  { canonical: "khan jahan ali", aliases: ["khan jahan ali", "khanjahanali", "খান জাহান আলী"], district: "khulna" },
  { canonical: "sonadanga", aliases: ["sonadanga", "সোনাডাঙ্গা"], district: "khulna" },
  { canonical: "batiaghata", aliases: ["batiaghata", "বটিয়াঘাটা"], district: "khulna" },
  { canonical: "dacope", aliases: ["dacope", "ডাকোপ"], district: "khulna" },
  { canonical: "dumuria", aliases: ["dumuria", "ডুমুরিয়া"], district: "khulna" },
  { canonical: "koyra", aliases: ["koyra", "কয়রা"], district: "khulna" },
  { canonical: "paikgachha", aliases: ["paikgachha", "paikgacha", "পাইকগাছা"], district: "khulna" },
  { canonical: "phultala", aliases: ["phultala", "ফুলতলা"], district: "khulna" },
  { canonical: "rupsa", aliases: ["rupsa", "রূপসা"], district: "khulna" },
  { canonical: "terokhada", aliases: ["terokhada", "তেরখাদা"], district: "khulna" },

  // ---- Rajshahi ----
  { canonical: "boalia", aliases: ["boalia", "বোয়ালিয়া"], district: "rajshahi" },
  { canonical: "motihar", aliases: ["motihar", "মতিহার"], district: "rajshahi" },
  { canonical: "rajpara", aliases: ["rajpara", "রাজপাড়া"], district: "rajshahi" },
  { canonical: "shah makhdum", aliases: ["shah makhdum", "shahmakhdum", "শাহ মখদুম"], district: "rajshahi" },
  { canonical: "bagha", aliases: ["bagha", "বাঘা"], district: "rajshahi" },
  { canonical: "bagmara", aliases: ["bagmara", "বাগমারা"], district: "rajshahi" },
  { canonical: "charghat", aliases: ["charghat", "চারঘাট"], district: "rajshahi" },
  { canonical: "godagari", aliases: ["godagari", "গোদাগাড়ী"], district: "rajshahi" },
  { canonical: "paba", aliases: ["paba", "পবা"], district: "rajshahi" },
  { canonical: "puthia", aliases: ["puthia", "পুঠিয়া"], district: "rajshahi" },
  { canonical: "tanore", aliases: ["tanore", "তানোর"], district: "rajshahi" },

  // ---- Barisal / Barishal ----
  { canonical: "barisal sadar", aliases: ["barisal sadar", "barishal sadar", "barisal", "বরিশাল সদর"], district: "barisal" },
  { canonical: "agailjhara", aliases: ["agailjhara", "আগৈলঝাড়া"], district: "barisal" },
  { canonical: "babuganj", aliases: ["babuganj", "বাবুগঞ্জ"], district: "barisal" },
  { canonical: "bakerganj", aliases: ["bakerganj", "বাকেরগঞ্জ"], district: "barisal" },
  { canonical: "banaripara", aliases: ["banaripara", "বানারীপাড়া"], district: "barisal" },
  { canonical: "gournadi", aliases: ["gournadi", "গৌরনদী"], district: "barisal" },
  { canonical: "hizla", aliases: ["hizla", "হিজলা"], district: "barisal" },
  { canonical: "mehendiganj", aliases: ["mehendiganj", "মেহেন্দিগঞ্জ"], district: "barisal" },
  { canonical: "muladi", aliases: ["muladi", "মুলাদী"], district: "barisal" },
  { canonical: "wazirpur", aliases: ["wazirpur", "উজিরপুর"], district: "barisal" },

  // ---- Rangpur ----
  { canonical: "rangpur sadar", aliases: ["rangpur sadar", "rangpur", "রংপুর সদর"], district: "rangpur" },
  { canonical: "badarganj", aliases: ["badarganj", "বদরগঞ্জ"], district: "rangpur" },
  { canonical: "gangachara", aliases: ["gangachara", "গংগাচড়া"], district: "rangpur" },
  { canonical: "kaunia", aliases: ["kaunia", "কাউনিয়া"], district: "rangpur" },
  { canonical: "mithapukur", aliases: ["mithapukur", "মিঠাপুকুর"], district: "rangpur" },
  { canonical: "pirgachha", aliases: ["pirgachha", "পীরগাছা"], district: "rangpur" },
  { canonical: "pirganj rangpur", aliases: ["pirganj rangpur", "pirganj"], district: "rangpur" },
  { canonical: "taraganj", aliases: ["taraganj", "তারাগঞ্জ"], district: "rangpur" },

  // ---- Mymensingh ----
  { canonical: "mymensingh sadar", aliases: ["mymensingh sadar", "mymensingh", "ময়মনসিংহ সদর"], district: "mymensingh" },
  { canonical: "bhaluka", aliases: ["bhaluka", "ভালুকা"], district: "mymensingh" },
  { canonical: "fulbaria", aliases: ["fulbaria", "ফুলবাড়িয়া"], district: "mymensingh" },
  { canonical: "gaffargaon", aliases: ["gaffargaon", "গফরগাঁও"], district: "mymensingh" },
  { canonical: "gauripur", aliases: ["gauripur", "গৌরীপুর"], district: "mymensingh" },
  { canonical: "haluaghat", aliases: ["haluaghat", "হালুয়াঘাট"], district: "mymensingh" },
  { canonical: "ishwarganj", aliases: ["ishwarganj", "ঈশ্বরগঞ্জ"], district: "mymensingh" },
  { canonical: "muktagachha", aliases: ["muktagachha", "muktagacha", "মুক্তাগাছা"], district: "mymensingh" },
  { canonical: "nandail", aliases: ["nandail", "নান্দাইল"], district: "mymensingh" },
  { canonical: "phulpur", aliases: ["phulpur", "ফুলপুর"], district: "mymensingh" },
  { canonical: "trishal", aliases: ["trishal", "ত্রিশাল"], district: "mymensingh" },

  // ---- Comilla / Cumilla ----
  { canonical: "comilla sadar", aliases: ["comilla sadar", "cumilla sadar", "comilla", "cumilla", "কুমিল্লা সদর"], district: "comilla" },
  { canonical: "barura", aliases: ["barura", "বরুড়া"], district: "comilla" },
  { canonical: "burichang", aliases: ["burichang", "বুড়িচং"], district: "comilla" },
  { canonical: "chandina", aliases: ["chandina", "চান্দিনা"], district: "comilla" },
  { canonical: "chauddagram", aliases: ["chauddagram", "চৌদ্দগ্রাম"], district: "comilla" },
  { canonical: "daudkandi", aliases: ["daudkandi", "দাউদকান্দি"], district: "comilla" },
  { canonical: "debidwar", aliases: ["debidwar", "দেবিদ্বার"], district: "comilla" },
  { canonical: "homna", aliases: ["homna", "হোমনা"], district: "comilla" },
  { canonical: "laksam", aliases: ["laksam", "লাকসাম"], district: "comilla" },
  { canonical: "muradnagar", aliases: ["muradnagar", "মুরাদনগর"], district: "comilla" },
  { canonical: "nangalkot", aliases: ["nangalkot", "নাঙ্গলকোট"], district: "comilla" },
  { canonical: "titas", aliases: ["titas", "তিতাস"], district: "comilla" },
];

/** Build the alias-to-entry map once. Frozen so callers can't mutate. */
const aliasIndex: ReadonlyMap<string, ThanaEntry> = (() => {
  const m = new Map<string, ThanaEntry>();
  for (const t of THANAS) {
    for (const a of t.aliases) {
      m.set(a.toLowerCase().trim(), t);
    }
    // The canonical form is also a valid alias unless one of the aliases
    // already covers it (most do).
    m.set(t.canonical.toLowerCase().trim(), t);
  }
  return m;
})();

/** Tokens we tokenize an address by. Mirrors the address-quality splitter. */
const TOKEN_SPLIT_RE = /[\s,.\-/()|]+/u;

/**
 * Lazy district-normalizer reference. Imported inline (and not at module
 * load) so this file stays a leaf in the import graph and doesn't pull
 * `lib/district.ts` (and its consumers) into the test bundle when intent
 * tests don't need it.
 */
function normalizeDistrictLazy(d: string | null | undefined): string | null {
  if (!d) return null;
  const trimmed = String(d).trim().toLowerCase().replace(/\s+/g, " ");
  if (!trimmed) return null;
  // Inline a tiny subset of `normalizeDistrict` aliases so we don't have to
  // import the whole file. The shared aliases below are the ones actually
  // used by the seed thana entries above. Anything outside this list falls
  // through to the trimmed string — same behavior as the canonical
  // normalizer for unknown districts.
  const m: Record<string, string> = {
    "ঢাকা": "dhaka",
    "ctg": "chittagong",
    "chattogram": "chittagong",
    "চট্টগ্রাম": "chittagong",
    "barishal": "barisal",
    "বরিশাল": "barisal",
    "ময়মনসিংহ": "mymensingh",
    "নারায়ণগঞ্জ": "narayanganj",
    "narayangonj": "narayanganj",
    "গাজীপুর": "gazipur",
    "সিলেট": "sylhet",
    "খুলনা": "khulna",
    "রাজশাহী": "rajshahi",
    "রংপুর": "rangpur",
    "cumilla": "comilla",
    "কুমিল্লা": "comilla",
  };
  if (m[trimmed]) return m[trimmed];
  // Strip trailing qualifiers
  const stripped = trimmed.replace(/\s+(city|district|division|sadar)$/u, "").trim();
  if (stripped && stripped !== trimmed && m[stripped]) return m[stripped];
  return stripped || trimmed;
}

/**
 * Extract a thana from a free-form address.
 *
 * Returns the canonical thana name (lowercase) when exactly one match is found,
 * OR when multiple matches exist but exactly one parents to the order's
 * provided district. Returns `null` on:
 *   - no match in the lexicon
 *   - multiple matches across multiple districts when district was not provided
 *     (we refuse to guess)
 *
 * Pure function. Same input → same output. Never throws on malformed input.
 */
export function extractThana(
  address: string | null | undefined,
  district?: string | null,
): string | null {
  if (!address || typeof address !== "string") return null;
  const lower = address.toLowerCase().trim();
  if (lower.length === 0) return null;

  const tokens = lower.split(TOKEN_SPLIT_RE).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  const candidates: ThanaEntry[] = [];
  const seen = new Set<ThanaEntry>();

  // 1. Try multi-token aliases first (longest-first so "sher e bangla nagar"
  //    wins before any 3-gram subset would). Up to 4-grams covers every
  //    multi-word entry in the seed lexicon.
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const ngram = tokens.slice(i, i + n).join(" ");
      const hit = aliasIndex.get(ngram);
      if (hit && !seen.has(hit)) {
        candidates.push(hit);
        seen.add(hit);
      }
    }
  }

  // 2. Single tokens — exact match.
  for (const t of tokens) {
    const hit = aliasIndex.get(t);
    if (hit && !seen.has(hit)) {
      candidates.push(hit);
      seen.add(hit);
    }
  }

  // 3. Bangla-suffix fallback. Bangla noun cases (e.g. possessive
  //    `যাত্রাবাড়ীর` from `যাত্রাবাড়ী`) attach to the bare token; an exact
  //    lookup misses. Walk every alias of length ≥ 5 and accept a match
  //    when a token starts with the alias. The 5-char floor keeps short
  //    Latin aliases (rd, h/, st) from accidentally matching.
  if (candidates.length === 0) {
    for (const t of tokens) {
      if (t.length < 5) continue;
      for (const [alias, entry] of aliasIndex) {
        if (alias.length < 5) continue;
        if (t.startsWith(alias)) {
          if (!seen.has(entry)) {
            candidates.push(entry);
            seen.add(entry);
          }
          break;
        }
      }
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.canonical;

  // 3. Multiple candidates — disambiguate by district.
  const districtNorm = normalizeDistrictLazy(district ?? null);
  if (districtNorm) {
    const sameDistrict = candidates.filter((c) => c.district === districtNorm);
    if (sameDistrict.length === 1) return sameDistrict[0]!.canonical;
    if (sameDistrict.length > 1) {
      // All candidates inside the order's district — first match wins. Stable
      // because `THANAS` is frozen-ordered.
      return sameDistrict[0]!.canonical;
    }
    // None of the candidates parent to the order's district — likely a false
    // positive (e.g. address mentions "school" or "bazar" and a thana name
    // collides). Refuse rather than mis-bucket.
    return null;
  }

  // 4. No district hint, multiple candidates → don't guess.
  return null;
}

/** Test helper — exposes the alias index size so callers can sanity-check
 *  the lexicon hasn't shrunk after a code change. */
export const __TEST = {
  aliasIndexSize: () => aliasIndex.size,
  thanaCount: () => THANAS.length,
};
