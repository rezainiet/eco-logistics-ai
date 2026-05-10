import "dotenv/config";
import mongoose, { Types } from "mongoose";
import { Integration } from "@ecom/db";
import { env } from "../env.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { migrateNonExpiringShopifyOfflineToken } from "../lib/integrations/shopify.js";

const CONFIRMATION = "I_UNDERSTAND_THIS_REVOKES_THE_OLD_TOKEN";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function usage(): never {
  console.error(`Usage:
  Dry-run audit:
    npm --workspace apps/api exec -- tsx src/scripts/shopifyTokenMigration.ts

  One-shop canary migration:
    npm --workspace apps/api exec -- tsx src/scripts/shopifyTokenMigration.ts --execute --integrationId=<mongo id> --confirm=${CONFIRMATION}

Notes:
  - Dry-run is the default and performs no token exchange.
  - --execute requires one integrationId; there is intentionally no bulk execute mode.
  - Shopify revokes the original non-expiring offline token after successful migration.
`);
  process.exit(1);
}

type CandidateRow = {
  _id: Types.ObjectId;
  merchantId: Types.ObjectId;
  accountKey: string;
  status: string;
  connectedAt?: Date | null;
  health?: { ok?: boolean; lastError?: string | null };
  credentials?: {
    apiKey?: string | null;
    apiSecret?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
    accessTokenExpiresAt?: Date | null;
  } | null;
};

function isLegacyCandidate(row: CandidateRow): boolean {
  return !!(
    row.credentials?.accessToken &&
    (!row.credentials.refreshToken || !row.credentials.accessTokenExpiresAt)
  );
}

mongoose.set("strictQuery", true);
if (env.NODE_ENV === "production") {
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
}
await mongoose.connect(env.MONGODB_URI);

try {
  const execute = hasFlag("execute");
  if (!execute) {
    const rows = (await Integration.find({
      provider: "shopify",
      status: { $in: ["connected", "error", "pending"] },
    })
      .select(
        "_id merchantId accountKey status connectedAt health credentials.accessToken credentials.refreshToken credentials.accessTokenExpiresAt",
      )
      .lean()) as CandidateRow[];

    const candidates = rows.filter(isLegacyCandidate);
    const byStatus = candidates.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      JSON.stringify(
        {
          mode: "dry_run",
          checked: rows.length,
          migrationCandidates: candidates.length,
          byStatus,
          candidates: candidates.map((row) => ({
            integrationId: String(row._id),
            merchantId: String(row.merchantId),
            accountKey: row.accountKey,
            status: row.status,
            connectedAt: row.connectedAt ?? null,
            healthOk: row.health?.ok ?? null,
            healthLastError: row.health?.lastError ?? null,
            hasAccessToken: !!row.credentials?.accessToken,
            hasRefreshToken: !!row.credentials?.refreshToken,
            hasAccessTokenExpiresAt: !!row.credentials?.accessTokenExpiresAt,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    const integrationId = argValue("integrationId");
    const confirm = argValue("confirm");
    if (!integrationId || !Types.ObjectId.isValid(integrationId)) usage();
    if (confirm !== CONFIRMATION) usage();

    const integration = (await Integration.findOne({
      _id: new Types.ObjectId(integrationId),
      provider: "shopify",
      status: { $in: ["connected", "error", "pending"] },
    })) as CandidateRow | null;
    if (!integration) {
      throw new Error("Shopify integration not found or not active");
    }
    if (!isLegacyCandidate(integration)) {
      console.log(
        JSON.stringify({
          mode: "execute",
          integrationId,
          skipped: true,
          reason: "row already has refresh metadata or has no access token",
        }),
      );
    } else {

  const creds = integration.credentials ?? {};
  if (!creds.apiKey || !creds.apiSecret || !creds.accessToken) {
    throw new Error("stored Shopify credentials are incomplete");
  }

  const apiKey = decryptSecret(creds.apiKey);
  const apiSecret = decryptSecret(creds.apiSecret);
  const nonExpiringAccessToken = decryptSecret(creds.accessToken);
  const migrated = await migrateNonExpiringShopifyOfflineToken({
    shopDomain: integration.accountKey,
    nonExpiringAccessToken,
    apiKey,
    apiSecret,
  });

  const setPayload: Record<string, unknown> = {
    "credentials.accessToken": encryptSecret(migrated.accessToken),
    status: "connected",
    "health.ok": true,
    "health.lastError": null,
    "health.lastCheckedAt": new Date(),
    lastSyncStatus: "ok",
    lastError: null,
    errorCount: 0,
  };
  if (migrated.refreshToken) {
    setPayload["credentials.refreshToken"] = encryptSecret(migrated.refreshToken);
  }
  if (typeof migrated.expiresIn === "number") {
    setPayload["credentials.accessTokenExpiresAt"] = new Date(
      Date.now() + migrated.expiresIn * 1000,
    );
  }
  if (migrated.scope) {
    setPayload.permissions = migrated.scope
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  await Integration.updateOne({ _id: integration._id }, { $set: setPayload });

      console.log(
        JSON.stringify({
          mode: "execute",
          migrated: true,
          integrationId,
          accountKey: integration.accountKey,
          expiresIn: migrated.expiresIn ?? null,
          hasRefreshToken: !!migrated.refreshToken,
        }),
      );
    }
  }
} finally {
  await mongoose.disconnect();
}
