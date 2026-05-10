import { Integration } from "@ecom/db";
import type { Document, Types } from "mongoose";
import { decryptSecret, encryptSecret } from "../crypto.js";
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
        ...(typeof result.expiresIn === "number"
          ? {
              "credentials.accessTokenExpiresAt": new Date(
                Date.now() + result.expiresIn * 1000,
              ),
            }
          : {}),
      },
    },
  );
  console.log("[shopify-token-refresh] rotated", {
    integrationId: String(integration._id),
    expiresIn: result.expiresIn ?? null,
  });
  // Mirror the changes on the in-memory document so the immediate
  // caller sees the fresh values without a re-read.
  if (integration.credentials) {
    integration.credentials.accessToken = encryptSecret(result.accessToken);
    if (result.refreshToken) {
      integration.credentials.refreshToken = encryptSecret(result.refreshToken);
    }
    if (typeof result.expiresIn === "number") {
      integration.credentials.accessTokenExpiresAt = new Date(
        Date.now() + result.expiresIn * 1000,
      );
    }
  }
  return { accessToken: result.accessToken, refreshed: true };
}
