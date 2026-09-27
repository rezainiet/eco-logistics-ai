import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared-secret checks for courier webhooks.
 *
 * None of the three couriers signs its webhook body. Per their official
 * integrations (verified in Phase 1.1), each one presents the shared secret
 * itself:
 *   Pathao    — header `X-PATHAO-Signature: <webhook secret>`
 *   Steadfast — header `Authorization: Bearer <token>`
 *   RedX      — query parameter on the callback URL: `?token=<token>`
 * The secret is the courier config's encrypted `apiSecret` — the value the
 * merchant pastes into the courier portal (webhook-registration.ts).
 *
 * Comparison hashes both sides first so `timingSafeEqual` always sees equal
 * lengths: neither content nor length of the secret leaks through timing.
 * Nothing here logs the provided or expected value.
 */
export function secretsMatch(provided: unknown, secret: string | undefined): boolean {
  if (!secret || typeof provided !== "string" || provided.length === 0) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Single header value (Express may hand over a string array). */
export function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** The token of an `Authorization: Bearer <token>` header, else undefined. */
export function bearerToken(authorization: string | string[] | undefined): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec((firstHeader(authorization) ?? "").trim());
  return m ? m[1]!.trim() : undefined;
}
