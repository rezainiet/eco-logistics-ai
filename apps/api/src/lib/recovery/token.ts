import { createHash, createHmac, randomBytes } from "node:crypto";
import { env } from "../../env.js";

/**
 * Cart-recovery link tokens.
 *
 * The token is derived, not stored: HMAC-SHA256(server secret, task id +
 * a random per-task nonce). Only its sha256 hash is persisted, so a
 * database read never yields a working link. Deriving it (rather than
 * storing a random value) lets a retried send rebuild the exact same email
 * — which the provider's idempotency key requires — without keeping the
 * plaintext anywhere. 256 bits, base64url, no internal ids in it.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newTokenNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function deriveRecoveryToken(taskId: string, nonce: string): string {
  return createHmac("sha256", `cart-recovery-link:v1:${env.JWT_SECRET}`)
    .update(`${taskId}:${nonce}`)
    .digest("base64url");
}

export function hashRecoveryToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Shape check before any lookup; anything else is rejected outright. */
export function isWellFormedRecoveryToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}
