/**
 * Inbound-SMS body parser.
 *
 * Provider-agnostic — the gateway routing layer maps each provider's MO
 * payload into `{ from, body }`; this file only interprets `body`.
 *
 * BD reality (audit, 2026-05): real customers almost never reply the
 * textbook "YES 482917". They reply "ok", "হ্যাঁ", "ji", "done", "👍",
 * "লাগবে না", sometimes with the code, usually without. The previous
 * parser (a) required a 6–8 digit code and (b) tokenised on
 * `[^a-z0-9]+`, which silently deletes all Bangla script — so a
 * Bangla "হ্যাঁ" was never recognised at all. That is the single
 * biggest "customer replied but the system ignored it" leak.
 *
 * This parser is intentionally conservative:
 *   - It recognises an informal intent (confirm / reject) in EN, common
 *     transliterations, Bangla script, and the two unambiguous emoji.
 *   - It still extracts the code when present (the safest binding).
 *   - When intent is clear but there is NO code, it returns
 *     `code: null` and lets the webhook bind ONLY if the sender's phone
 *     has exactly one pending order — never guesses across orders.
 *   - Conflicting signals (a confirm word AND a reject word) → ignore.
 *   - `matchedOn` is returned for the audit log so every normalisation
 *     decision is explainable after the fact.
 */

export type SmsInboundIntent =
  | { kind: "confirm"; code: string | null; matchedOn: string }
  | { kind: "reject"; code: string | null; matchedOn: string }
  | { kind: "ignore"; reason: string };

// ASCII / transliteration tokens, matched token-exact (word boundary)
// after lowercasing. Kept tight: every entry is something a BD customer
// actually sends as a standalone confirmation.
const CONFIRM_TOKENS = new Set([
  "yes", "y", "ye", "yeah", "yep", "yup",
  "ok", "oke", "okk", "okay", "oki", "k", "kk",
  "confirm", "confirmed", "cnfrm", "cnfm",
  "accept", "acpt", "sure", "done",
  "ha", "haa", "han", "hae", "hmm", "hm", "hu", "hum",
  "ji", "jee", "jii", "1",
]);

const REJECT_TOKENS = new Set([
  "no", "n", "nope", "nay",
  "cancel", "cancle", "cancl", "stop",
  "na", "naa", "nah", "nai", "0",
]);

// Bangla-script + emoji CONFIRM phrases. Substring scan (the body is a
// short reply, not prose) because Bangla has no ASCII word boundaries.
const CONFIRM_PHRASES = [
  "হ্যাঁ", "হ্যা", "হাঁ", "হা", "হু", "হুম", "জি", "জ্বি", "জী",
  "ঠিক আছে", "ঠিকাছে", "ঠিক", "আচ্ছা", "ওকে", "নিশ্চিত", "কনফার্ম",
  "👍", "✅", "✔",
];

// Bangla-script + emoji REJECT phrases. The bare negative "না" is
// matched separately (boundary-guarded) to avoid firing on it as an
// incidental substring of an unrelated word.
const REJECT_PHRASES = [
  "নাহ", "নাই", "লাগবে না", "লাগবেনা", "দরকার নেই", "দরকার নাই",
  "চাই না", "চাইনা", "বাতিল", "ক্যান্সেল", "ক্যানসেল", "নো",
  "👎", "❌", "✖",
];
// Standalone Bangla "no": start/space-bounded so "জানা"/"মানা" etc.
// (which merely contain না) never read as a rejection.
const BANGLA_NO_RE = /(^|\s)না(\s|।|\.|!|$)/;

const CODE_RE = /\b(\d{6,8})\b/;

export function parseSmsInbound(body: string): SmsInboundIntent {
  if (!body || typeof body !== "string") {
    return { kind: "ignore", reason: "empty body" };
  }
  // Lowercase is safe for Bangla (no-op) and normalises ASCII.
  const cleaned = body.replace(/\s+/g, " ").trim().toLowerCase();
  if (!cleaned) return { kind: "ignore", reason: "blank after trim" };

  const codeMatch = CODE_RE.exec(cleaned);
  const code = codeMatch ? codeMatch[1]! : null;

  const tokens = cleaned.split(/[^a-z0-9]+/).filter(Boolean);

  let confirmHit: string | null = null;
  let rejectHit: string | null = null;

  for (const t of tokens) {
    if (!confirmHit && CONFIRM_TOKENS.has(t)) confirmHit = t;
    if (!rejectHit && REJECT_TOKENS.has(t)) rejectHit = t;
  }
  if (!confirmHit) {
    const p = CONFIRM_PHRASES.find((x) => cleaned.includes(x));
    if (p) confirmHit = p;
  }
  if (!rejectHit) {
    const p = REJECT_PHRASES.find((x) => cleaned.includes(x));
    if (p) rejectHit = p;
    else if (BANGLA_NO_RE.test(cleaned)) rejectHit = "না";
  }

  // Conflicting signals — refuse to guess. (e.g. "na ok" / mixed reply.)
  if (confirmHit && rejectHit) {
    return { kind: "ignore", reason: "conflicting intent" };
  }
  if (confirmHit) {
    return { kind: "confirm", code, matchedOn: confirmHit };
  }
  if (rejectHit) {
    return { kind: "reject", code, matchedOn: rejectHit };
  }
  // A bare code with no intent word stays ignored — deliberately not
  // assumed to be a "yes" (dangerous false positive). It is logged at
  // the webhook so the founder still sees the pattern.
  return {
    kind: "ignore",
    reason: code ? "code present but no intent word" : "no recognised intent",
  };
}
