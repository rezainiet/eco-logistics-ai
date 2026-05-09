import { createHash } from "node:crypto";

/**
 * Address canonicalization — Phase 2 foundation for Bangladesh address
 * intelligence. Pure function. Same input → same output. No DB, no I/O,
 * no clock reads, no env reads.
 *
 * Replay-safety contract (binding):
 *   - This module is ADDITIVE. It NEVER replaces or invalidates the
 *     existing `Order.source.addressHash` (token-sort SHA-256[:32]).
 *   - Output carries a `pipelineVersion` so downstream consumers can
 *     gate on schema. Bumping the version in a future change does NOT
 *     mutate prior CanonicalAddress rows; it produces new rows under
 *     the new version while old rows remain readable.
 *   - Identical raw input under the same `pipelineVersion` ALWAYS
 *     produces a byte-identical CanonicalAddress (modulo `computedAt`).
 *     Re-running the pipeline on an already-canonicalised order is
 *     therefore safe: write the same bytes, no aggregate impact.
 *
 * Deterministic, explainable, no fuzzy/AI/ML matching. The only
 * tolerance for spelling variation is a bounded edit-distance ≤1
 * lookup against the gazetteer alias index, applied ONLY when no exact
 * match exists, and surfaced via `confidence: "medium"`. A medium
 * match never silently merges aggregates — that's a Phase 3 decision.
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export const ADDRESS_PIPELINE_VERSION = "v1" as const;
export type AddressPipelineVersion = typeof ADDRESS_PIPELINE_VERSION;

export type AddressMatchConfidence = "high" | "medium" | "low";
export type AddressGeoLevel =
  | "division"
  | "district"
  | "thana"
  | "area"
  | "road"
  | "house"
  | "block"
  | "flat";

export interface CanonicalAddress {
  pipelineVersion: AddressPipelineVersion;
  /** Hierarchical geo (lowercase canonical). Absent when the gazetteer didn't match. */
  division?: string;
  district?: string;
  thana?: string;
  /** Sub-thana area / neighbourhood (Dhanmondi, Banani, Mirpur-10). Optional. */
  area?: string;
  /** Structural anchors. Normalised forms ("road-10", "house-5a", "block-c", "flat-3b"). */
  road?: string;
  house?: string;
  block?: string;
  flat?: string;
  /** Token cloud — sorted, deduped, used for the canonical hashes. */
  tokens: string[];
  /** Building-level key — same building, regardless of unit. */
  buildingKey: string;
  /** Unit-level key — same unit (flat / apt). Falls back to buildingKey when no flat. */
  unitKey: string;
  confidence: AddressMatchConfidence;
  /** Which gazetteer / anchor levels matched. Operator-readable. */
  matchedOn: AddressGeoLevel[];
  computedAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Gazetteer interface                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Structural shape the canonicalizer reads from. Loose intentionally — the
 * gazetteer module supplies a concrete implementation backed by an in-memory
 * Map, but tests can supply a stub without pulling Mongoose in.
 */
export interface GazetteerEntry {
  level: AddressGeoLevel;
  canonical: string;
  parent?: string;
  aliases: string[];
}

export interface GazetteerLookup {
  /** Exact alias hit. Returns the highest-priority entry by level (district > thana > area). */
  findByAlias(alias: string): GazetteerEntry | null;
  /** Edit-distance ≤1 alias hit. Used only when no exact match exists. */
  findByFuzzyAlias?(alias: string): GazetteerEntry | null;
}

/* -------------------------------------------------------------------------- */
/* Step 1: Unicode normalization + lowercase                                  */
/* -------------------------------------------------------------------------- */

function nfcLower(raw: string): string {
  return raw.normalize("NFC").toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* Step 2: Bangla → Latin transliteration (bounded lookup table)              */
/*                                                                            */
/* Limited to high-frequency BD address tokens. We DO NOT attempt full        */
/* Bangla NLP — the goal is to make `Mirpur` and `মিরপুর` collapse to the    */
/* same token. Anything not in the table is preserved verbatim and survives  */
/* into the token cloud (so it still matters for the building key, just      */
/* without a Latin counterpart for matching).                                 */
/* -------------------------------------------------------------------------- */

const BANGLA_LATIN: Record<string, string> = {
  "ঢাকা": "dhaka",
  "চট্টগ্রাম": "chittagong",
  "চিটাগাং": "chittagong",
  "চিটাগং": "chittagong",
  "সিলেট": "sylhet",
  "খুলনা": "khulna",
  "রাজশাহী": "rajshahi",
  "বরিশাল": "barisal",
  "রংপুর": "rangpur",
  "ময়মনসিংহ": "mymensingh",
  "নারায়ণগঞ্জ": "narayanganj",
  "গাজীপুর": "gazipur",
  "মিরপুর": "mirpur",
  "ধানমন্ডি": "dhanmondi",
  "গুলশান": "gulshan",
  "বনানী": "banani",
  "উত্তরা": "uttara",
  "মোহাম্মদপুর": "mohammadpur",
  "যাত্রাবাড়ী": "jatrabari",
  "মতিঝিল": "motijheel",
  "তেজগাঁও": "tejgaon",
  "রামপুরা": "rampura",
  "বাড্ডা": "badda",
  "শাহবাগ": "shahbagh",
  "নিউ মার্কেট": "new market",
  // Numbered suffixes
  "নং": "no",
  // Anchors
  "রোড": "road",
  "সড়ক": "road",
  "লেন": "lane",
  "বাড়ি": "house",
  "ফ্ল্যাট": "flat",
  "টাওয়ার": "tower",
  "ভবন": "building",
  "ব্লক": "block",
  "সেক্টর": "sector",
  // Role prefixes (rural pattern)
  "গ্রাম": "village",
  "ডাকঘর": "po",
  "থানা": "ps",
  "উপজেলা": "upazila",
  "জেলা": "district",
};

function transliterate(s: string): string {
  // Replace each Bangla phrase with its Latin equivalent. Phrases first, so
  // multi-token entries ("নিউ মার্কেট") win before single-token ones.
  const phrases = Object.entries(BANGLA_LATIN).sort(
    (a, b) => b[0].length - a[0].length,
  );
  let out = s;
  for (const [bn, en] of phrases) {
    if (out.includes(bn)) {
      // simple global replace; case already lowered via nfcLower
      out = out.split(bn).join(` ${en} `);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Step 3: Punctuation collapse                                               */
/* -------------------------------------------------------------------------- */

const PUNCT_RE = /[,./\-\\#()|;:_*"'`+]+/g;

function collapsePunct(s: string): string {
  return s.replace(PUNCT_RE, " ").replace(/\s+/g, " ").trim();
}

/* -------------------------------------------------------------------------- */
/* Step 4: Role-prefix strip (rural / structured BD addresses)                */
/* -------------------------------------------------------------------------- */

const ROLE_PREFIXES = new Set([
  "vill", "village", "vil",
  "po", "post", "postoffice",
  "ps", "thana",
  "upazila", "upz",
  "dist", "district",
  "div", "division",
  "ward",
  "union",
]);

function stripRolePrefixes(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (ROLE_PREFIXES.has(t)) {
      // Drop the role token; the value follows. Don't drop the value.
      continue;
    }
    out.push(t);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Step 5: Abbreviation expansion                                             */
/* -------------------------------------------------------------------------- */

const ABBREVIATIONS: Record<string, string> = {
  // House
  "h": "house",
  "ho": "house",
  "hno": "house",
  "house#": "house",
  // Road / street
  "rd": "road",
  "r": "road",
  "st": "street",
  "ln": "lane",
  // Avenue / sector / block
  "ave": "avenue",
  "av": "avenue",
  "sec": "sector",
  "blk": "block",
  // Flat / apartment
  "fl": "flat",
  "flt": "flat",
  "apt": "flat",
  "apartment": "flat",
  // Number
  "no": "no",
  "num": "no",
  "number": "no",
  "#": "no",
  // R/A (residential area)
  "ra": "residential",
  // BD common
  "ctg": "chittagong",
  "chattogram": "chittagong",
};

function expandAbbreviations(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (ABBREVIATIONS[t]) {
      out.push(ABBREVIATIONS[t]!);
      continue;
    }
    // "h-10", "h/10", "h10" → ["house", "10"] (after punct collapse, only "h10" remains).
    // Handle the merged form: a token starting with an abbreviation prefix
    // followed by digits.
    const m = /^([a-z]+)(\d+[a-z]?)$/.exec(t);
    if (m) {
      const prefix = m[1]!;
      const suffix = m[2]!;
      if (ABBREVIATIONS[prefix]) {
        out.push(ABBREVIATIONS[prefix]!, suffix);
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Step 6: Number-prefix canonicalisation                                     */
/*                                                                            */
/* Bangladesh addresses commonly invert the number/anchor order:              */
/*   "10 no road"  /  "road 10"  /  "no 10 road"  →  "road-10"                */
/*   "27 number road"  /  "27 nং রোড"             →  "road-27"                */
/* -------------------------------------------------------------------------- */

const ANCHOR_TYPES: Record<string, string> = {
  road: "road",
  street: "road", // collapse street→road for canonicalization
  lane: "lane",
  avenue: "avenue",
  house: "house",
  flat: "flat",
  block: "block",
  sector: "sector",
};

interface AnchorExtraction {
  anchors: { type: string; value: string }[];
  remainingTokens: string[];
}

function extractAnchors(tokens: string[]): AnchorExtraction {
  const anchors: { type: string; value: string }[] = [];
  const consumed = new Set<number>();
  const isAnchor = (t: string) => ANCHOR_TYPES[t] !== undefined;
  const isNumeric = (t: string) => /^\d+[a-z]?$/.test(t); // "10", "10a"
  const isNoMarker = (t: string) => t === "no";

  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const t = tokens[i]!;
    if (!isAnchor(t)) continue;

    // Pattern A:  ANCHOR  [no?]  NUM
    if (i + 1 < tokens.length) {
      const next = tokens[i + 1]!;
      if (isNumeric(next)) {
        anchors.push({ type: ANCHOR_TYPES[t]!, value: next });
        consumed.add(i);
        consumed.add(i + 1);
        continue;
      }
      if (isNoMarker(next) && i + 2 < tokens.length && isNumeric(tokens[i + 2]!)) {
        anchors.push({ type: ANCHOR_TYPES[t]!, value: tokens[i + 2]! });
        consumed.add(i);
        consumed.add(i + 1);
        consumed.add(i + 2);
        continue;
      }
    }

    // Pattern B:  NUM  [no?]  ANCHOR
    if (i - 1 >= 0) {
      const prev = tokens[i - 1]!;
      if (isNumeric(prev) && !consumed.has(i - 1)) {
        anchors.push({ type: ANCHOR_TYPES[t]!, value: prev });
        consumed.add(i);
        consumed.add(i - 1);
        continue;
      }
      if (
        isNoMarker(prev) &&
        i - 2 >= 0 &&
        isNumeric(tokens[i - 2]!) &&
        !consumed.has(i - 2)
      ) {
        anchors.push({ type: ANCHOR_TYPES[t]!, value: tokens[i - 2]! });
        consumed.add(i);
        consumed.add(i - 1);
        consumed.add(i - 2);
        continue;
      }
    }
  }

  // Block letter pattern: "block c", "c block", "block-c" → block-c
  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const t = tokens[i]!;
    if (t !== "block" && t !== "sector") continue;
    if (i + 1 < tokens.length && /^[a-z]$/.test(tokens[i + 1]!) && !consumed.has(i + 1)) {
      anchors.push({ type: t, value: tokens[i + 1]! });
      consumed.add(i);
      consumed.add(i + 1);
      continue;
    }
    if (i - 1 >= 0 && /^[a-z]$/.test(tokens[i - 1]!) && !consumed.has(i - 1)) {
      anchors.push({ type: t, value: tokens[i - 1]! });
      consumed.add(i);
      consumed.add(i - 1);
    }
  }

  const remaining: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!consumed.has(i)) remaining.push(tokens[i]!);
  }
  // Drop bare "no" tokens that survived (orphan number-marker).
  return {
    anchors,
    remainingTokens: remaining.filter((t) => t !== "no"),
  };
}

/* -------------------------------------------------------------------------- */
/* Step 7: Gazetteer match (longest-first n-gram against alias index)         */
/* -------------------------------------------------------------------------- */

interface GazetteerMatch {
  division?: string;
  district?: string;
  thana?: string;
  area?: string;
  matchedOn: AddressGeoLevel[];
  /** True when at least one match required edit-distance fallback. */
  fuzzy: boolean;
  /** Tokens consumed by the gazetteer match. */
  consumedTokens: Set<number>;
}

const LEVEL_PRIORITY: Record<AddressGeoLevel, number> = {
  division: 1,
  district: 2,
  thana: 3,
  area: 4,
  road: 5,
  house: 6,
  block: 7,
  flat: 8,
};

function matchGazetteer(
  tokens: string[],
  gaz: GazetteerLookup,
): GazetteerMatch {
  const out: GazetteerMatch = {
    matchedOn: [],
    fuzzy: false,
    consumedTokens: new Set<number>(),
  };

  // Try n-grams from longest (4) down to single tokens. First wins per slot.
  for (let n = 4; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      // Skip if any token in this window has been consumed already.
      let overlap = false;
      for (let k = 0; k < n; k++) {
        if (out.consumedTokens.has(i + k)) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;

      const ngram = tokens.slice(i, i + n).join(" ");
      let entry = gaz.findByAlias(ngram);
      if (!entry && gaz.findByFuzzyAlias) {
        const fuzzy = gaz.findByFuzzyAlias(ngram);
        if (fuzzy) {
          entry = fuzzy;
          out.fuzzy = true;
        }
      }
      if (!entry) continue;

      // Assign to the slot for this level. If the slot is already filled
      // with the SAME canonical (e.g. parent-inference filled it from a
      // thana match earlier), still consume the tokens so they don't leak
      // into the residual token cloud. Only skip when the slot is filled
      // with a DIFFERENT canonical — that's a genuine ambiguity we keep.
      const level = entry.level;
      const slotEmpty =
        (level === "division" && !out.division) ||
        (level === "district" && !out.district) ||
        (level === "thana" && !out.thana) ||
        (level === "area" && !out.area);
      const slotMatchesSame =
        (level === "division" && out.division === entry.canonical) ||
        (level === "district" && out.district === entry.canonical) ||
        (level === "thana" && out.thana === entry.canonical) ||
        (level === "area" && out.area === entry.canonical);
      if (!slotEmpty && !slotMatchesSame) continue;
      if (level === "division" && slotEmpty) out.division = entry.canonical;
      else if (level === "district" && slotEmpty) out.district = entry.canonical;
      else if (level === "thana" && slotEmpty) out.thana = entry.canonical;
      else if (level === "area" && slotEmpty) out.area = entry.canonical;

      // Parent inference: a thana entry's `parent` is its district. Record
      // the inferred level on `matchedOn` too so confidence-band logic and
      // operator UIs know the district was identified (transitively).
      if (level === "thana" && entry.parent && !out.district) {
        out.district = entry.parent;
        if (!out.matchedOn.includes("district")) out.matchedOn.push("district");
      }
      if (level === "area" && entry.parent && !out.thana) {
        out.thana = entry.parent;
        if (!out.matchedOn.includes("thana")) out.matchedOn.push("thana");
      }

      if (!out.matchedOn.includes(level)) out.matchedOn.push(level);
      for (let k = 0; k < n; k++) out.consumedTokens.add(i + k);
    }
  }

  out.matchedOn.sort((a, b) => LEVEL_PRIORITY[a] - LEVEL_PRIORITY[b]);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Step 8 + 9: anchor → CanonicalAddress hashing                              */
/* -------------------------------------------------------------------------- */

function hashHex(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/* -------------------------------------------------------------------------- */
/* Public canonicaliser                                                       */
/* -------------------------------------------------------------------------- */

export interface CanonicaliseInput {
  /** Free-form `customer.address` string. */
  address: string | null | undefined;
  /** Optional `customer.district` — used as a tie-breaker for gazetteer matching. */
  district?: string | null;
  /** Optional `customer.thana` — used as a tie-breaker. */
  thana?: string | null;
  /** Reference time. Defaults to `new Date()`. Injectable for tests. */
  now?: Date;
}

/**
 * Run the full canonicalization pipeline. Returns `null` when the input is
 * structurally unusable (missing, empty, or shorter than 4 meaningful chars
 * after normalization) — callers treat this as "no canonical address" and
 * fall back to the legacy `addressHash` only.
 */
export function canonicaliseAddress(
  input: CanonicaliseInput,
  gazetteer: GazetteerLookup,
): CanonicalAddress | null {
  const raw = typeof input?.address === "string" ? input.address : "";
  if (!raw) return null;

  // Step 1
  let s = nfcLower(raw);
  // Step 2: transliterate (also normalises the district/thana hints)
  s = transliterate(s);
  // Step 3
  s = collapsePunct(s);
  if (s.length < 4) return null;

  // Tokenize.
  let tokens = s.split(" ").filter((t) => t.length > 0);
  // Step 4
  tokens = stripRolePrefixes(tokens);
  // Step 5
  tokens = expandAbbreviations(tokens);
  if (tokens.length === 0) return null;

  // Mix in the district/thana hints (transliterated + cleaned) so gazetteer
  // matching can leverage caller-provided context. Hints are appended; they
  // don't shadow address tokens.
  const hintFrom = (h: string | null | undefined) =>
    h
      ? collapsePunct(transliterate(nfcLower(h)))
          .split(" ")
          .filter(Boolean)
      : [];
  const hintTokens = [...hintFrom(input.district), ...hintFrom(input.thana)];
  const allTokens = [...tokens, ...hintTokens];

  // Step 6: anchor extraction (operates on combined tokens, but only address
  // tokens are eligible to BECOME anchors — we keep hints purely for
  // gazetteer matching).
  const { anchors, remainingTokens } = extractAnchors(tokens);
  // Step 7: gazetteer match — runs over remaining + hint tokens for max recall.
  const gaz = matchGazetteer([...remainingTokens, ...hintTokens], gazetteer);

  // Tokens that didn't match the gazetteer become part of the building's
  // token cloud (sorted, deduped).
  const cloud = new Set<string>();
  for (let i = 0; i < remainingTokens.length; i++) {
    if (!gaz.consumedTokens.has(i)) cloud.add(remainingTokens[i]!);
  }
  const tokenCloud = Array.from(cloud).filter(Boolean).sort();

  // Anchors → normalised forms
  const findAnchor = (t: string) => anchors.find((a) => a.type === t)?.value;
  const road = findAnchor("road")
    ? `road-${findAnchor("road")}`
    : findAnchor("lane")
      ? `lane-${findAnchor("lane")}`
      : findAnchor("avenue")
        ? `avenue-${findAnchor("avenue")}`
        : undefined;
  const house = findAnchor("house") ? `house-${findAnchor("house")}` : undefined;
  const block = findAnchor("block")
    ? `block-${findAnchor("block")}`
    : findAnchor("sector")
      ? `sector-${findAnchor("sector")}`
      : undefined;
  const flat = findAnchor("flat") ? `flat-${findAnchor("flat")}` : undefined;

  // Confidence
  const matched = new Set<AddressGeoLevel>(gaz.matchedOn);
  if (road) matched.add("road");
  if (house) matched.add("house");
  if (block) matched.add("block");
  if (flat) matched.add("flat");
  const matchedOn = Array.from(matched).sort(
    (a, b) => LEVEL_PRIORITY[a] - LEVEL_PRIORITY[b],
  );

  let confidence: AddressMatchConfidence;
  if (
    gaz.district &&
    gaz.thana &&
    !gaz.fuzzy &&
    (road || house || block)
  ) {
    confidence = "high";
  } else if (gaz.fuzzy || (gaz.district && (gaz.thana || road || house))) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  // Hash composition. All canonical fields go in; `null` slots are
  // represented by the literal string "_" so two addresses missing the
  // same field still hash deterministically.
  const slot = (v: string | undefined) => v ?? "_";
  const buildingComposite = [
    ADDRESS_PIPELINE_VERSION,
    slot(gaz.division),
    slot(gaz.district),
    slot(gaz.thana),
    slot(gaz.area),
    slot(road),
    slot(house),
    slot(block),
    tokenCloud.join("|"),
  ].join("||");
  const buildingKey = hashHex(buildingComposite);
  const unitComposite = `${buildingKey}||${slot(flat)}`;
  const unitKey = flat ? hashHex(unitComposite) : buildingKey;

  return {
    pipelineVersion: ADDRESS_PIPELINE_VERSION,
    division: gaz.division,
    district: gaz.district,
    thana: gaz.thana,
    area: gaz.area,
    road,
    house,
    block,
    flat,
    tokens: tokenCloud,
    buildingKey,
    unitKey,
    confidence,
    matchedOn,
    computedAt:
      input.now instanceof Date && Number.isFinite(input.now.getTime())
        ? input.now
        : new Date(),
  };
}

/* -------------------------------------------------------------------------- */
/* Test surface — exposes step helpers for unit tests so we can exercise      */
/* boundary conditions without re-deriving them.                              */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  nfcLower,
  transliterate,
  collapsePunct,
  stripRolePrefixes,
  expandAbbreviations,
  extractAnchors,
  matchGazetteer,
  hashHex,
  BANGLA_LATIN,
  ABBREVIATIONS,
  ROLE_PREFIXES,
  ANCHOR_TYPES,
};
