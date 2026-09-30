import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { Integration } from "@ecom/db";
import { createMerchant, disconnectDb, resetDb } from "./helpers.js";
import { decryptSecret, encryptSecret } from "../src/lib/crypto.js";

// Passthrough to the real helper; a test can swap in a failure mode the
// order-sync worker can't reach on its own (it never passes
// `requireRefreshable`, so the migration error needs forcing).
const tokenOverride = vi.hoisted(() => ({
  impl: null as null | ((...args: unknown[]) => Promise<unknown>),
}));
vi.mock("../src/lib/integrations/shopify-token-refresh.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/integrations/shopify-token-refresh.js")>();
  return {
    ...actual,
    ensureFreshShopifyAccessToken: (...args: unknown[]) =>
      tokenOverride.impl
        ? tokenOverride.impl(...args)
        : (actual.ensureFreshShopifyAccessToken as (...a: unknown[]) => Promise<unknown>)(...args),
  };
});

const {
  ensureFreshShopifyAccessToken,
  isShopifyCredentialsUnreadableError,
  isShopifyTokenMigrationRequiredError,
  ShopifyTokenMigrationRequiredError,
  SHOPIFY_CREDENTIALS_UNREADABLE_MESSAGE,
  SHOPIFY_TOKEN_MIGRATION_REQUIRED_MESSAGE,
} = await import("../src/lib/integrations/shopify-token-refresh.js");
const { runOrderSyncOnce, syncOneIntegration } = await import("../src/workers/orderSync.worker.js");

const SECRET = "shpat_do_not_log_0123456789abcdef";

/**
 * A well-formed v1 payload whose GCM tag belongs to a different message —
 * decrypts exactly like a token written under another key: Node throws
 * "Unsupported state or unable to authenticate data".
 */
function undecryptable(plaintext: string): string {
  const [v, iv, , ct] = encryptSecret(plaintext).split(":");
  const [, , otherTag] = encryptSecret("something else").split(":");
  return [v, iv, otherTag, ct].join(":");
}

function shopifyCreds(accessToken: string) {
  return {
    apiKey: encryptSecret("k"),
    apiSecret: encryptSecret("s"),
    accessToken,
    refreshToken: encryptSecret("shrt_valid"),
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    siteUrl: "shop.myshopify.com",
  };
}

async function shopifyIntegration(merchantId: Types.ObjectId, accessToken: string) {
  return Integration.create({
    merchantId,
    provider: "shopify",
    accountKey: "shop.myshopify.com",
    status: "connected",
    health: { ok: true },
    credentials: shopifyCreds(accessToken),
  });
}

describe("order-sync: Shopify token-step failures", () => {
  let logs: string[] = [];
  const originalFetch = globalThis.fetch;
  const events = (evt: string) =>
    logs
      .filter((l) => l.includes(`"evt":"${evt}"`))
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  beforeEach(async () => {
    await resetDb();
    logs = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    tokenOverride.impl = null;
    globalThis.fetch = originalFetch;
  });
  afterAll(disconnectDb);

  it("the helper surfaces an undecryptable token as a typed error with the unchanged decrypt message", async () => {
    const m = await createMerchant();
    const payload = undecryptable(SECRET);
    expect(() => decryptSecret(payload)).toThrow("Unsupported state or unable to authenticate data");
    const integration = await shopifyIntegration(m._id as Types.ObjectId, payload);

    const err = await ensureFreshShopifyAccessToken(integration).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isShopifyCredentialsUnreadableError(err)).toBe(true);
    expect(isShopifyTokenMigrationRequiredError(err)).toBe(false);
    // Other callers only read err.message — it is exactly what they saw before.
    expect((err as Error).message).toBe("Unsupported state or unable to authenticate data");
  });

  it("undecryptable token: failed=1, permanent error + reconnect message, dropped from the next sweep", async () => {
    const m = await createMerchant();
    const payload = undecryptable(SECRET);
    const integration = await shopifyIntegration(m._id as Types.ObjectId, payload);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await syncOneIntegration(integration._id as Types.ObjectId);
    expect(res).toEqual({ enqueued: 0, duplicates: 0, failed: 1 });

    const row: any = await Integration.findById(integration._id).lean();
    expect(row.status).toBe("error");
    expect(row.health.ok).toBe(false);
    expect(row.health.lastError).toBe(SHOPIFY_CREDENTIALS_UNREADABLE_MESSAGE);
    expect(row.lastError).toBe(SHOPIFY_CREDENTIALS_UNREADABLE_MESSAGE);
    expect(row.lastSyncStatus).toBe("error");
    expect(row.errorCount).toBe(1);
    // Credentials are left exactly as stored — nothing deleted or re-encrypted.
    expect(row.credentials.accessToken).toBe(payload);

    expect(events("order_sync.token_error")).toEqual([
      {
        evt: "order_sync.token_error",
        integrationId: String(integration._id),
        provider: "shopify",
        merchantId: String(m._id),
        code: "shopify_credentials_unreadable",
        permanent: true,
        error: SHOPIFY_CREDENTIALS_UNREADABLE_MESSAGE,
      },
    ]);

    // The connected-only sweep no longer selects it.
    expect(await runOrderSyncOnce()).toEqual({ scanned: 0, enqueued: 0, duplicates: 0, failed: 0 });
    // No Shopify request at any point.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never writes the token or its ciphertext to logs or persisted errors", async () => {
    const m = await createMerchant();
    const payload = undecryptable(SECRET);
    const integration = await shopifyIntegration(m._id as Types.ObjectId, payload);
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await syncOneIntegration(integration._id as Types.ObjectId);
    const row: any = await Integration.findById(integration._id).lean();
    const surfaces = [...logs, row.lastError, row.health.lastError].join("\n");
    for (const needle of [SECRET, payload, ...payload.split(":").slice(1)]) {
      expect(surfaces).not.toContain(needle);
    }
  });

  it.each([
    ["Shopify 503", () => new Response("upstream unavailable", { status: 503, headers: { "Retry-After": "0" } })],
    [
      "network failure",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("temporary %s stays connected and is retried on the next sweep", async (_label, respond) => {
    const m = await createMerchant();
    const integration = await shopifyIntegration(m._id as Types.ObjectId, encryptSecret(SECRET));
    const fetchMock = vi.fn(async () => respond());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await syncOneIntegration(integration._id as Types.ObjectId)).toEqual({ enqueued: 0, duplicates: 0, failed: 1 });
    const row: any = await Integration.findById(integration._id).lean();
    expect(row.status).toBe("connected");
    expect(row.health.ok).toBe(true);
    expect(row.lastSyncStatus).toBe("error");
    expect(row.errorCount).toBe(1);
    expect(events("order_sync.fetch_failed")).toHaveLength(1);
    expect(events("order_sync.token_error")).toEqual([]);

    // Still selected: the next sweep retries it.
    expect(await runOrderSyncOnce()).toEqual({ scanned: 1, enqueued: 0, duplicates: 0, failed: 1 });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("a non-permanent token-step failure is now logged but still leaves the integration connected", async () => {
    const m = await createMerchant();
    const integration = await Integration.create({
      merchantId: m._id,
      provider: "shopify",
      accountKey: "shop.myshopify.com",
      status: "connected",
      health: { ok: true },
      credentials: { apiKey: encryptSecret("k"), apiSecret: encryptSecret("s"), siteUrl: "shop.myshopify.com" },
    });
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    expect(await syncOneIntegration(integration._id as Types.ObjectId)).toEqual({ enqueued: 0, duplicates: 0, failed: 1 });
    const row: any = await Integration.findById(integration._id).lean();
    expect(row.status).toBe("connected");
    expect(row.health.ok).toBe(true);
    expect(row.lastError).toBe("integration has no access token to refresh");
    expect(events("order_sync.token_error")).toEqual([
      expect.objectContaining({ permanent: false, code: null, error: "integration has no access token to refresh" }),
    ]);
  });

  it("token-migration-required keeps its existing state transition", async () => {
    const m = await createMerchant();
    const integration = await shopifyIntegration(m._id as Types.ObjectId, encryptSecret(SECRET));
    tokenOverride.impl = async () => {
      throw new ShopifyTokenMigrationRequiredError(SHOPIFY_TOKEN_MIGRATION_REQUIRED_MESSAGE);
    };
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    expect(await syncOneIntegration(integration._id as Types.ObjectId)).toEqual({ enqueued: 0, duplicates: 0, failed: 1 });
    const row: any = await Integration.findById(integration._id).lean();
    expect(row.status).toBe("error");
    expect(row.health.ok).toBe(false);
    expect(row.health.lastError).toBe(SHOPIFY_TOKEN_MIGRATION_REQUIRED_MESSAGE);
    expect(row.lastError).toBe(SHOPIFY_TOKEN_MIGRATION_REQUIRED_MESSAGE);
    expect(row.lastSyncStatus).toBe("error");
    expect(row.errorCount).toBe(1);
    expect(events("order_sync.token_error")).toEqual([
      expect.objectContaining({ code: "shopify_token_migration_required", permanent: true }),
    ]);
  });
});
