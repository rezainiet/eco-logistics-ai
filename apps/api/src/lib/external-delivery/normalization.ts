import { createHash } from "node:crypto";

/**
 * external-delivery / normalization — pure functions for canonical
 * BD phone normalization + hashing.
 *
 * The canonical form is the digit-only "8801XXXXXXXXX" shape (13 digits).
 * Mirrors the existing `lib/phone.ts:normalizePhoneOrRaw` semantics but
 * is decoupled from the merchant ingest path so the external-delivery
 * orchestrator can call it without pulling that module.
 *
 * Same hash function as `hashPhoneForNetwork` in `lib/fraud-network.ts`
 * (sha256 of `p:<normalized>`, truncated to 32 hex chars). Producing
 * matching hashes lets future risk-scoring code cross-reference an
 * external profile against the existing FraudSignal aggregates without
 * a separate hash key.
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface NormalizedPhone {
  /** Canonical 13-digit BD form ("8801XXXXXXXXX"). */
  normalized: string;
  /** SHA-256[:32] of `p:<normalized>` — matches hashPhoneForNetwork. */
  phoneHash: string;
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

const BD_CANONICAL_RE = /^8801[3-9]\d{8}$/;

/**
 * Normalise a free-form BD mobile number to the canonical 13-digit form.
 * Returns null when the input is structurally not a BD mobile (foreign
 * numbers, all-same-digit placeholders, too-short / too-long).
 *
 * Pure — no DB, no I/O, no env reads. Same input → same output.
 */
export function normalizeBdPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length === 0) return null;

  // All-same-digit placeholder
  if (/^(\d)\1+$/.test(digits)) return null;

  // Already canonical 13-digit form
  if (digits.length === 13 && BD_CANONICAL_RE.test(digits)) return digits;

  // 11-digit local form: "01XXXXXXXXX" → "8801XXXXXXXXX"
  if (digits.length === 11 && /^01[3-9]\d{8}$/.test(digits)) {
    return `88${digits}`;
  }

  // Country-code without leading 0: "8801XXXXXXXXX" already covered.
  // 10-digit: "1XXXXXXXXX" → reject (ambiguous with non-BD).
  return null;
}

/**
 * Hash a normalised phone with the same shape `hashPhoneForNetwork` uses
 * in the cross-merchant fraud network. Returns null for inputs that
 * can't be normalised — callers can short-circuit.
 */
export function hashNormalizedPhone(normalized: string | null): string | null {
  if (!normalized) return null;
  return createHash("sha256").update(`p:${normalized}`).digest("hex").slice(0, 32);
}

/**
 * Combined helper — accepts free-form input, returns the normalised
 * form + matching hash, or null when input isn't a BD mobile.
 */
export function normalizeAndHashBdPhone(raw: unknown): NormalizedPhone | null {
  const normalized = normalizeBdPhone(raw);
  if (!normalized) return null;
  const phoneHash = hashNormalizedPhone(normalized);
  if (!phoneHash) return null;
  return { normalized, phoneHash };
}

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  BD_CANONICAL_RE,
};
