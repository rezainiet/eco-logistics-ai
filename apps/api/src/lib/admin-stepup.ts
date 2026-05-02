import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { Merchant } from "@ecom/db";
import { getRedis } from "./redis.js";
import type { Permission } from "./admin-rbac.js";

/**
 * Step-up confirmation token. Issued AFTER the admin re-enters their
 * password (or, if no password gate is configured, after explicit
 * confirmation). The token is bound to:
 *   - the issuing admin's user id
 *   - the specific permission ("payment.approve", "fraud.override", …)
 *   - a 5-minute TTL
 *   - single-use (consume = delete)
 *
 * Why short TTL + single-use: even a leaked token is useless beyond the
 * specific permission it was issued for and the next request — a stolen
 * cookie can't be replayed against a different sensitive endpoint, and
 * accidental double-clicks can't double-charge.
 *
 * Why bound to permission: a finance admin who re-authed for "payment.approve"
 * cannot use the token to "merchant.suspend". Each step-up is action-scoped.
 */

const TTL_SEC = 5 * 60;
const TOKEN_BYTES = 32;

const memoryStore = new Map<string, { value: string; expiresAt: number }>();

function key(userId: string, permission: Permission, tokenHash: string): string {
  return `stepup:${userId}:${permission}:${tokenHash}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tryRedis() {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

/**
 * Issue a fresh step-up confirmation token for `userId` to use on `permission`.
 * The token is returned to the caller in plaintext (delivered to the browser
 * over the same authenticated session); only the SHA-256 hash is stored,
 * mirroring the auth/password-reset pattern.
 */
export async function issueStepupToken(
  userId: string,
  permission: Permission,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(token);
  const k = key(userId, permission, tokenHash);
  const expiresAt = new Date(Date.now() + TTL_SEC * 1000);
  const redis = tryRedis();
  if (redis) {
    await redis.set(k, "1", "EX", TTL_SEC);
  } else {
    memoryStore.set(k, { value: "1", expiresAt: expiresAt.getTime() });
  }
  return { token, expiresAt };
}

/**
 * Atomic check-and-consume: succeeds at most once per token. Returns true if
 * the token existed AND matched the user+permission pair AND was deleted
 * by this call.
 */
export async function consumeStepupToken(
  userId: string,
  permission: Permission,
  token: string,
): Promise<boolean> {
  if (!token || token.length < 8) return false;
  const tokenHash = hashToken(token);
  const k = key(userId, permission, tokenHash);
  const redis = tryRedis();
  if (redis) {
    // GETDEL is atomic: returns the old value AND deletes in one round trip.
    const v = await redis.getdel(k);
    return v !== null;
  }
  const hit = memoryStore.get(k);
  if (!hit) return false;
  if (hit.expiresAt < Date.now()) {
    memoryStore.delete(k);
    return false;
  }
  memoryStore.delete(k);
  return true;
}

/**
 * Re-validate the admin's password before issuing a step-up token. Constant-
 * time comparison; bcrypt does the heavy lifting. Empty / wrong password
 * returns false without leaking whether the user exists (caller should
 * always respond 401 / 403 generically).
 */
export async function verifyAdminPassword(
  userId: string,
  password: string,
): Promise<boolean> {
  if (!password || password.length === 0) return false;
  if (!Types.ObjectId.isValid(userId)) return false;
  const m = await Merchant.findById(userId).select("passwordHash").lean();
  if (!m?.passwordHash) return false;
  try {
    return await bcrypt.compare(password, m.passwordHash);
  } catch {
    return false;
  }
}

/** Test helper. */
export function __resetStepupForTests(): void {
  memoryStore.clear();
}

/** Constant-time equality on two short strings (used by tests). */
export function ctEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
