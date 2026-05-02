import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify the HMAC signature on an inbound SMS webhook (SMS reply OR DLR).
 *
 * Both endpoints are completely trustless without this — anyone who knows
 * the URL could otherwise post arbitrary payloads. We require the gateway
 * to compute HMAC-SHA256(rawBody, sharedSecret) and ship it as a hex
 * digest in the `x-signature` header (alias `x-sms-signature` accepted).
 *
 * Returns true on a constant-time match. Returns false on any malformed
 * input — never throws.
 */

const KNOWN_HEADER_KEYS = [
  "x-signature",
  "x-sms-signature",
  "x-ssl-signature",
  "x-bulksms-signature",
] as const;

export function readSignatureHeader(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  for (const key of KNOWN_HEADER_KEYS) {
    const v = headers[key];
    if (!v) continue;
    return Array.isArray(v) ? (v[0] ?? null) : v;
  }
  return null;
}

export function verifySmsWebhookSignature(
  rawBody: string | Buffer,
  signature: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || typeof secret !== "string") return false;
  if (!signature || typeof signature !== "string") return false;
  const provided = signature.trim();
  if (provided.length === 0) return false;

  const computed = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? rawBody : rawBody)
    .digest("hex");

  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(provided, "hex");
    b = Buffer.from(computed, "hex");
  } catch {
    return false;
  }
  if (a.length === 0 || a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Helper used by route handlers — bundles the header-read + verify-call so
 * each handler is one line. Returns `{ ok, reason? }` so the caller can
 * decide the response shape.
 */
export interface SmsWebhookVerifyResult {
  ok: boolean;
  reason?: "no_secret_configured" | "missing_signature" | "mismatch";
}

export function checkSmsWebhookAuth(
  rawBody: string | Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string | undefined,
): SmsWebhookVerifyResult {
  if (!secret) return { ok: false, reason: "no_secret_configured" };
  const sig = readSignatureHeader(headers);
  if (!sig) return { ok: false, reason: "missing_signature" };
  return verifySmsWebhookSignature(rawBody, sig, secret)
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}
