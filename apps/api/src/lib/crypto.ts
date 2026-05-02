import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env } from "../env.js";

/**
 * AES-256-GCM envelope encryption for at-rest secrets (courier API keys etc).
 *
 * Format: `v1:<b64 iv>:<b64 tag>:<b64 ciphertext>` (no key id yet — single key).
 * IV is a per-message 12-byte random; tag is the 16-byte GCM auth tag.
 *
 * COURIER_ENC_KEY is REQUIRED in every environment (dev / test / staging /
 * production). The env-loader rejects boot without it. Tests must set it
 * in their global setup. There is intentionally no JWT_SECRET-derived
 * fallback — silently using a derived key risks leaking ciphertexts that
 * a future production key rotation would render unreadable.
 */

const VERSION = "v1";
const ALG = "aes-256-gcm";
const IV_LEN = 12;
const KEY_LEN = 32;

let _key: Buffer | null = null;

function getKey(): Buffer {
  if (_key) return _key;
  // env.ts enforces presence + base64 + 32-byte decoded length BEFORE this
  // module is reached. The defensive check below catches the (now
  // impossible) case where someone bypasses env loading.
  if (!env.COURIER_ENC_KEY) {
    throw new Error(
      "COURIER_ENC_KEY is required in every environment. Generate one with: openssl rand -base64 32",
    );
  }
  _key = Buffer.from(env.COURIER_ENC_KEY, "base64");
  if (_key.length !== KEY_LEN) {
    throw new Error(`COURIER_ENC_KEY must decode to ${KEY_LEN} bytes`);
  }
  return _key;
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) throw new Error("encryptSecret: empty plaintext");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(payload: string): string {
  if (!payload) throw new Error("decryptSecret: empty payload");
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("decryptSecret: unsupported payload format");
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv(ALG, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function isEncryptedPayload(value: string): boolean {
  return typeof value === "string" && value.startsWith(`${VERSION}:`) && value.split(":").length === 4;
}

/** UI-safe preview — last 4 chars only, never decrypts. */
export function maskSecretPayload(payload: string | undefined | null): string {
  if (!payload) return "";
  if (!isEncryptedPayload(payload)) return "••••";
  try {
    const plain = decryptSecret(payload);
    if (plain.length <= 4) return "••••";
    return `••••${plain.slice(-4)}`;
  } catch {
    return "••••";
  }
}

/** Constant-time string compare — useful where a user-supplied value is checked against a stored one. */
export function safeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
