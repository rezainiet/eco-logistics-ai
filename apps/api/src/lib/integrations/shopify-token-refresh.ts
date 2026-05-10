import { Integration } from "@ecom/db";
import type { Document, Types } from "mongoose";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { refreshShopifyAccessToken } from "./shopify.js";

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

  if (!needsRefresh || !creds.refreshToken || !creds.siteUrl) {
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
      shopDomain: creds.siteUrl,
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
