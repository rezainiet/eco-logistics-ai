import { Integration } from "@ecom/db";
import type { Document, Types } from "mongoose";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { getRedis } from "../redis.js";
import { refreshShopifyAccessToken } from "./shopify.js";

export const SHOPIFY_TOKEN_MIGRATION_REQUIRED =
  "shopify_token_migration_required";

export class ShopifyTokenMigrationRequiredError extends Error {
  readonly code = SHOPIFY_TOKEN_MIGRATION_REQUIRED;

  constructor(message = "Shopify token migration required") {
    super(message);
    this.name = "ShopifyTokenMigrationRequiredError";
  }
}

export function isShopifyTokenMigrationRequiredError(
  err: unknown,
): err is ShopifyTokenMigrationRequiredError {
  return (
    err instanceof ShopifyTokenMigrationRequiredError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === SHOPIFY_TOKEN_MIGRATION_REQUIRED)
  );
}

export const SHOPIFY_TOKEN_MIGRATION_REQUIRED_MESSAGE =
  "Shopify token migration required: stored token is legacy non-expiring offline token metadata. Reconnect or run the expiring-token migration.";

/**
 * Lazily rotate a Shopify access token before any Admin API call.
 *
 * Behaviour:
 *   - If the integration has no `accessTokenExpiresAt` (legacy install
 *     before we started persisting it), no refresh is attempted — the
 *     existing access token is returned and the call site will see a
 *     403 from Shopify ("non-expiring tokens no longer accepted") if
 *     it really is the legacy non-expiring kind. The merchant fix is
 *     to disconnect + reinstall once.
 *   - If the access token expires within `leadMs` (default 5 min) or
 *     has already expired, AND we have a refresh token, we POST to
 *     Shopify's token endpoint with grant_type=refresh_token, write
 *     the new accessToken/refreshToken/expiresAt back to Mongo
 *     (encrypted), and return the new accessToken.
 *   - On refresh failure, we log + leave the integration row alone.
 *     The caller will hit Shopify with the stale token and surface a
 *     real 401, which the merchant-facing reconnect banner picks up.
 *
 * Idempotent — calling it twice in a row when the token is already
 * fresh is a single read with no writes.
 *
 * Pass `force: true` to refresh unconditionally (used by the
 * refresh-on-401 fallback path so callers can short-circuit a stale
 * token after a real Admin API rejection).
 */

const DEFAULT_LEAD_MS = 5 * 60 * 1000;

/**
 * Single-flight lock TTL. Sized to comfortably outlast the Shopify
 * token endpoint round-trip (which has its own 10s timeout in
 * shopify.ts) plus the Mongo updateOne. If the holder crashes the
 * lock auto-expires so a subsequent caller can retry.
 */
const REFRESH_LOCK_TTL_SEC = 30;

/**
 * Minimum acceptable `expiresIn` (seconds) on a refresh response.
 * Shopify documents 24h lifetimes; anything below ~60s is almost
 * certainly a protocol-level error and would immediately re-trigger
 * the lazy-refresh path on the next API call, hot-looping until
 * Shopify rate-limits us. When the response is below this floor we
 * persist the new accessToken/refreshToken but DROP the expiresAt
 * so the next call falls back to the non-expiring read path.
 */
const MIN_EXPIRES_IN_SEC = 60;

function refreshLockKey(integrationId: Types.ObjectId | string): string {
  return `shopify:token:refresh:${String(integrationId)}`;
}

/**
 * Acquire a single-flight lock so two concurrent refresh attempts on
 * the same integration don't both POST to Shopify (which rotates the
 * refresh_token on every use — the slower writer would persist a
 * refresh_token that the faster writer just invalidated).
 *
 * Best-effort: if Redis isn't reachable (dev without REDIS_URL),
 * returns `null` and the caller proceeds without the lock. The race
 * window is small and the failure mode (one wasted refresh) is
 * recoverable on the next call.
 */
async function acquireRefreshLock(
  integrationId: Types.ObjectId | string,
): Promise<{ release: () => Promise<void> } | null> {
  let redis;
  try {
    redis = getRedis();
  } catch {
    return null;
  }
  const key = refreshLockKey(integrationId);
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  let acquired: "OK" | null = null;
  try {
    acquired = await redis.set(key, token, "EX", REFRESH_LOCK_TTL_SEC, "NX");
  } catch (err) {
    console.warn("[shopify-token-refresh] lock_acquire_failed", {
      integrationId: String(integrationId),
      err: (err as Error).message.slice(0, 120),
    });
    return null;
  }
  if (acquired !== "OK") return null;
  return {
    release: async () => {
      // Only release if we still own the lock (token match). Prevents
      // a slow holder from clobbering a successor's lock if our TTL
      // already expired. Uses a CAS-via-Lua to keep the GET-then-DEL
      // atomic.
      try {
        const lua =
          "if redis.call('get', KEYS[1]) == ARGV[1] " +
          "then return redis.call('del', KEYS[1]) " +
          "else return 0 end";
        await redis.eval(lua, 1, key, token);
      } catch (err) {
        console.warn("[shopify-token-refresh] lock_release_failed", {
          integrationId: String(integrationId),
          err: (err as Error).message.slice(0, 120),
        });
      }
    },
  };
}

// The Mongoose Integration document stores credential fields as
// `string | null | undefined` (Mongoose's default for optional fields
// is to materialise unset paths as `null`, not `undefined`). Mirror
// that here so we can accept the live document without a cast.
type IntegrationLike = Document & {
  _id: Types.ObjectId;
  // For Shopify, the shop domain (`shop.myshopify.com`) is stored on
  // `accountKey`, NOT on `credentials.siteUrl`. WooCommerce uses
  // `credentials.siteUrl`. We read `accountKey` first, falling back
  // to `siteUrl`, so this helper works for both — though by name it
  // is Shopify-specific and call sites only invoke it for shopify.
  accountKey?: string | null;
  credentials?: {
    apiKey?: string | null;
    apiSecret?: string | null;
    siteUrl?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
    accessTokenExpiresAt?: Date | null;
  } | null;
  save: () => Promise<unknown>;
};

export async function ensureFreshShopifyAccessToken(
  integration: IntegrationLike,
  options: { leadMs?: number; force?: boolean } = {},
): Promise<{ accessToken: string; refreshed: boolean }> {
  const creds = integration.credentials ?? {};
  const accessTokenEnc = creds.accessToken;
  if (!accessTokenEnc) {
    throw new Error("integration has no access token to refresh");
  }
  const accessToken = decryptSecret(accessTokenEnc);

  const expiresAt = creds.accessTokenExpiresAt
    ? new Date(creds.accessTokenExpiresAt).getTime()
    : null;
  const leadMs = options.leadMs ?? DEFAULT_LEAD_MS;
  const needsRefresh =
    options.force === true ||
    (expiresAt !== null && expiresAt - Date.now() <= leadMs);

  // Prefer accountKey (Shopify install path stores shop.myshopify.com
  // there) and fall back to credentials.siteUrl (legacy/Woo path).
  // Without a shop domain we can't hit Shopify's token endpoint at all
  // — abort cleanly.
  const shopDomain = integration.accountKey ?? creds.siteUrl ?? null;
  if (!creds.refreshToken || expiresAt === null) {
    throw new ShopifyTokenMigrationRequiredError(
      SHOPIFY_TOKEN_MIGRATION_REQUIRED_MESSAGE,
    );
  }
  if (!needsRefresh || !shopDomain) {
    return { accessToken, refreshed: false };
  }

  let apiKey = "";
  let apiSecret = "";
  let refreshToken = "";
  try {
    apiKey = creds.apiKey ? decryptSecret(creds.apiKey) : "";
    apiSecret = creds.apiSecret ? decryptSecret(creds.apiSecret) : "";
    refreshToken = decryptSecret(creds.refreshToken);
  } catch (err) {
    console.warn("[shopify-token-refresh] decrypt_failed", {
      integrationId: String(integration._id),
      err: (err as Error).message.slice(0, 120),
    });
    return { accessToken, refreshed: false };
  }
  if (!apiKey || !apiSecret || !refreshToken) {
    return { accessToken, refreshed: false };
  }

  // Single-flight refresh: only one worker per integration should
  // POST to Shopify's token endpoint at a time. Refresh tokens rotate
  // on every use — a concurrent second call would either invalidate
  // the first writer's freshly-minted refresh_token or be invalidated
  // by it, depending on write ordering. If we can't acquire the lock,
  // another worker is already refreshing; re-read the integration to
  // pick up the fresh credentials they're about to persist.
  const lock = await acquireRefreshLock(integration._id);
  if (!lock) {
    const refreshed = await Integration.findOne({ _id: integration._id })
      .select("credentials")
      .lean();
    const freshEnc = refreshed?.credentials?.accessToken;
    if (freshEnc && freshEnc !== accessTokenEnc) {
      // Another worker already rotated. Decrypt and return the
      // post-rotation token; mirror to the in-memory document so the
      // immediate caller doesn't hit a still-stale handle.
      try {
        const decoded = decryptSecret(freshEnc);
        if (integration.credentials) {
          integration.credentials.accessToken = freshEnc;
          if (refreshed?.credentials?.refreshToken) {
            integration.credentials.refreshToken =
              refreshed.credentials.refreshToken;
          }
          if (refreshed?.credentials?.accessTokenExpiresAt) {
            integration.credentials.accessTokenExpiresAt = new Date(
              refreshed.credentials.accessTokenExpiresAt,
            );
          }
        }
        return { accessToken: decoded, refreshed: false };
      } catch {
        // Fall through to returning the original token — the next
        // call will see the rotation completed.
      }
    }
    // Lock held but the peer hasn't persisted yet (or rotation
    // failed). Returning the current token is safe — the caller will
    // either succeed or surface a 401 that triggers a force-refresh.
    return { accessToken, refreshed: false };
  }

  try {
    // Re-read the integration after acquiring the lock. The previous
    // lock holder may have rotated already; if so, return their
    // result without burning another Shopify request.
    const latest = await Integration.findOne({ _id: integration._id })
      .select("credentials")
      .lean();
    const latestEnc = latest?.credentials?.accessToken;
    const latestExpiresAt = latest?.credentials?.accessTokenExpiresAt
      ? new Date(latest.credentials.accessTokenExpiresAt).getTime()
      : null;
    if (
      latestEnc &&
      latestEnc !== accessTokenEnc &&
      latestExpiresAt !== null &&
      latestExpiresAt - Date.now() > leadMs
    ) {
      try {
        const decoded = decryptSecret(latestEnc);
        if (integration.credentials) {
          integration.credentials.accessToken = latestEnc;
          if (latest?.credentials?.refreshToken) {
            integration.credentials.refreshToken =
              latest.credentials.refreshToken;
          }
          integration.credentials.accessTokenExpiresAt = new Date(
            latestExpiresAt,
          );
        }
        return { accessToken: decoded, refreshed: false };
      } catch {
        // Fall through to refresh.
      }
    }

    let result;
    try {
      result = await refreshShopifyAccessToken({
        shopDomain,
        apiKey,
        apiSecret,
        refreshToken,
      });
    } catch (err) {
      console.warn("[shopify-token-refresh] refresh_failed", {
        integrationId: String(integration._id),
        err: (err as Error).message.slice(0, 200),
      });
      return { accessToken, refreshed: false };
    }

    // Validate the returned lifetime. Below the floor we still
    // persist the new tokens (they're valid; just shorter-lived than
    // expected) but drop the expiresAt so the next call doesn't
    // immediately re-enter this branch in a tight loop.
    const hasUsableExpiry =
      typeof result.expiresIn === "number" &&
      Number.isFinite(result.expiresIn) &&
      result.expiresIn >= MIN_EXPIRES_IN_SEC;
    if (
      typeof result.expiresIn === "number" &&
      !hasUsableExpiry
    ) {
      console.warn("[shopify-token-refresh] suspicious_expiresIn", {
        integrationId: String(integration._id),
        expiresIn: result.expiresIn,
      });
    }
    const newExpiresAt = hasUsableExpiry
      ? new Date(Date.now() + (result.expiresIn as number) * 1000)
      : null;

    // Persist the new token pair. Refresh tokens rotate on use, so we
    // always overwrite both — never keep the old refreshToken.
    await Integration.updateOne(
      { _id: integration._id },
      {
        $set: {
          "credentials.accessToken": encryptSecret(result.accessToken),
          ...(result.refreshToken
            ? { "credentials.refreshToken": encryptSecret(result.refreshToken) }
            : {}),
          ...(newExpiresAt
            ? { "credentials.accessTokenExpiresAt": newExpiresAt }
            : { "credentials.accessTokenExpiresAt": null }),
        },
      },
    );
    console.log("[shopify-token-refresh] rotated", {
      integrationId: String(integration._id),
      expiresIn: result.expiresIn ?? null,
      persistedExpiresAt: !!newExpiresAt,
    });
    // Mirror the changes on the in-memory document so the immediate
    // caller sees the fresh values without a re-read.
    if (integration.credentials) {
      integration.credentials.accessToken = encryptSecret(result.accessToken);
      if (result.refreshToken) {
        integration.credentials.refreshToken = encryptSecret(result.refreshToken);
      }
      integration.credentials.accessTokenExpiresAt = newExpiresAt;
    }
    return { accessToken: result.accessToken, refreshed: true };
  } finally {
    await lock.release();
  }
}
