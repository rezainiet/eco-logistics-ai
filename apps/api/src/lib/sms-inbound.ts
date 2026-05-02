/**
 * Inbound-SMS body parser.
 *
 * Provider-agnostic — the SSL Wireless DLR webhook, an SMS gateway like
 * BulkSMS BD, and (later) the WhatsApp Business webhook all reduce to a
 * `from` (E.164 phone) and a `body` (free text). This file only knows how
 * to interpret the `body` — the routing layer maps each provider's payload
 * into `{ from, body }` first.
 *
 * Supported intents:
 *   "YES 123456" / "yes 123456" / "Y 123456" / "1 123456"  → confirm
 *   "NO 123456"  / "no 123456"  / "N 123456" / "0 123456" / "CANCEL 123456" → reject
 *   "HA 123456"  (Bangla "yes")  → confirm
 *   "NA 123456"  (Bangla "no")   → reject
 *
 * Anything else → `{ kind: "ignore" }` (worker no-ops, returns 200 to provider).
 *
 * The 6-digit code is mandatory — without it the customer's reply could
 * map to any number of pending orders. We refuse to guess.
 */

export type SmsInboundIntent =
  | { kind: "confirm"; code: string }
  | { kind: "reject"; code: string }
  | { kind: "ignore"; reason: string };

const CONFIRM_TOKENS = new Set([
  "yes",
  "y",
  "confirm",
  "ok",
  "ha",     // Bangla "yes" (transliterated)
  "han",
  "hyan",
  "1",
]);

const REJECT_TOKENS = new Set([
  "no",
  "n",
  "cancel",
  "stop",
  "na",     // Bangla "no" (transliterated)
  "nah",
  "0",
]);

// Accept BOTH 6 and 8 digit codes during the transition window —
// new mints use 8, in-flight orders may still carry 6.
const CODE_RE = /\b(\d{6,8})\b/;

export function parseSmsInbound(body: string): SmsInboundIntent {
  if (!body || typeof body !== "string") {
    return { kind: "ignore", reason: "empty body" };
  }

  // Strip non-printables, normalize whitespace, lowercase.
  const cleaned = body.replace(/\s+/g, " ").trim().toLowerCase();
  if (!cleaned) return { kind: "ignore", reason: "blank after trim" };

  // First mandatory: pull a 6-digit code.
  const codeMatch = CODE_RE.exec(cleaned);
  if (!codeMatch) {
    return { kind: "ignore", reason: "no code in message" };
  }
  const code = codeMatch[1]!;

  // Tokenize and look for the first recognised intent word.
  const tokens = cleaned.split(/[^a-z0-9]+/).filter(Boolean);
  for (const t of tokens) {
    if (CONFIRM_TOKENS.has(t)) return { kind: "confirm", code };
    if (REJECT_TOKENS.has(t)) return { kind: "reject", code };
  }
  return { kind: "ignore", reason: "no recognised intent token" };
}
