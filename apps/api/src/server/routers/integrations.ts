import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import { env } from "../../env.js";
import {
  ImportJob,
  Integration,
  INTEGRATION_PROVIDERS,
  Merchant,
  WebhookInbox,
  type IntegrationProvider,
} from "@ecom/db";
import { billableProcedure, merchantObjectId, protectedProcedure, router, type SubscriptionSnapshot } from "../trpc.js";
import { decryptSecret, encryptSecret, maskSecretPayload } from "../../lib/crypto.js";
import { adapterFor, hasAdapter } from "../../lib/integrations/index.js";
import {
  assertIntegrationCapacity,
  assertIntegrationProvider,
  entitlementsFor,
} from "../../lib/entitlements.js";
import type { PlanTier } from "../../lib/plans.js";
import {
  buildShopifyInstallUrl,
  registerShopifyWebhooks,
} from "../../lib/integrations/shopify.js";
import { registerWooWebhooks } from "../../lib/integrations/woocommerce.js";
import type { IntegrationCredentials } from "../../lib/integrations/types.js";
import {
  replayWebhookInbox,
  WEBHOOK_RETRY_MAX_ATTEMPTS,
} from "../ingest.js";
import { enqueueCommerceImport } from "../../workers/commerceImport.js";
import { writeAudit } from "../../lib/audit.js";

function decryptCreds(stored: Record<string, unknown> | null | undefined): IntegrationCredentials {
  const s = (stored ?? {}) as Record<string, string | null | undefined>;
  const out: IntegrationCredentials = {};
  if (s.apiKey) out.apiKey = decryptSafe(s.apiKey);
  if (s.apiSecret) out.apiSecret = decryptSafe(s.apiSecret);
  if (s.accessToken) out.accessToken = decryptSafe(s.accessToken);
  if (s.consumerKey) out.consumerKey = decryptSafe(s.consumerKey);
  if (s.consumerSecret) out.consumerSecret = decryptSafe(s.consumerSecret);
  if (s.siteUrl) out.siteUrl = s.siteUrl;
  return out;
}

function decryptSafe(payload: string): string {
  try {
    return decryptSecret(payload);
  } catch {
    return "";
  }
}

/**
 * `shop.myshopify.com`. The subdomain must start with a letter or digit and
 * may contain letters, digits, and hyphens — Shopify's own naming rule.
 * Anything else (custom domains, typos, http://) gets a clear inline error
 * before we even try to mint an install URL.
 */
const SHOP_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

const connectShopifySchema = z.object({
  provider: z.literal("shopify"),
  shopDomain: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(120)
    .regex(
      SHOP_DOMAIN_RE,
      "Use your Shopify store address like mystore.myshopify.com",
    ),
  // Optional in the simple flow. When the platform has
  // SHOPIFY_APP_API_KEY/SECRET configured, the merchant only needs to enter
  // their shop domain — we drive OAuth with the platform-level app
  // credentials. When the platform vars are unset, the connect handler
  // requires these (legacy custom-app path) and surfaces a clear error.
  apiKey: z.string().min(1).optional(),
  apiSecret: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
  scopes: z.array(z.string()).default(["read_orders", "write_orders", "read_customers"]),
  /**
   * The merchant has explicitly confirmed they want to overwrite an existing
   * connected integration (rotating credentials / forcing a fresh OAuth).
   * Without this flag, the handler refuses to clobber a connected store and
   * returns the existing integration unchanged so accidental double-clicks
   * never lose a working access token.
   */
  confirmOverwrite: z.boolean().optional(),
});

const connectWooSchema = z.object({
  provider: z.literal("woocommerce"),
  siteUrl: z.string().url(),
  consumerKey: z.string().min(1),
  consumerSecret: z.string().min(1),
});

const connectCustomSchema = z.object({
  provider: z.literal("custom_api"),
  label: z.string().min(1).max(120).optional(),
});

const connectCsvSchema = z.object({
  provider: z.literal("csv"),
  label: z.string().min(1).max(120).optional(),
});

const connectInputSchema = z.discriminatedUnion("provider", [
  connectShopifySchema,
  connectWooSchema,
  connectCustomSchema,
  connectCsvSchema,
]);

export const integrationsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    // Hide disconnected rows from the dashboard's Connections panel — when
    // a merchant clicks the trash icon, they expect the card to look fresh
    // again. The row stays in the DB (soft delete) so audit trails, prior
    // ingestion counts, and webhook history are preserved; reconnecting
    // upserts the same row back to `pending` -> `connected`.
    const rows = await Integration.find({
      merchantId,
      status: { $ne: "disconnected" },
    })
      .sort({ createdAt: -1 })
      .lean();
    return rows.map((row) => ({
      id: String(row._id),
      provider: row.provider as IntegrationProvider,
      label: row.label ?? null,
      accountKey: row.accountKey,
      status: row.status,
      health: {
        ok: row.health?.ok ?? true,
        lastError: row.health?.lastError ?? null,
        lastCheckedAt: row.health?.lastCheckedAt ?? null,
      },
      webhookStatus: {
        registered: row.webhookStatus?.registered ?? false,
        lastEventAt: row.webhookStatus?.lastEventAt ?? null,
        failures: row.webhookStatus?.failures ?? 0,
        lastError: row.webhookStatus?.lastError ?? null,
      },
      permissions: row.permissions ?? [],
      counts: {
        ordersImported: row.counts?.ordersImported ?? 0,
        ordersFailed: row.counts?.ordersFailed ?? 0,
      },
      credentialsPreview: {
        apiKey: maskSecretPayload(row.credentials?.apiKey),
        accessToken: maskSecretPayload(row.credentials?.accessToken),
        consumerKey: maskSecretPayload(row.credentials?.consumerKey),
        siteUrl: row.credentials?.siteUrl ?? null,
      },
      connectedAt: row.connectedAt ?? null,
      disconnectedAt: row.disconnectedAt ?? null,
      lastSyncAt: row.lastSyncAt ?? null,
      createdAt: row.createdAt,
    }));
  }),

  connect: billableProcedure
    .input(connectInputSchema)
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const sub = ctx.subscription as SubscriptionSnapshot | null;
      const tier: PlanTier = sub?.tier ?? "starter";
      // Plan gates: provider allowlist + simultaneous-connector cap.
      // CSV is uncapped (manual fallback), enforced inside the helper.
      assertIntegrationProvider(tier, input.provider);
      await assertIntegrationCapacity(merchantId, tier, input.provider);

      // One-shop-per-provider guard. For domain-keyed connectors (Shopify,
      // WooCommerce) a merchant should only ever have ONE active integration
      // — connecting a different storefront on top of an existing one is
      // almost certainly a mistake. Reconnecting the SAME accountKey is
      // allowed (the upsert below + `confirmOverwrite` flow handle that
      // case). To switch stores the merchant must disconnect first, which
      // is one click in the Connections panel.
      if (input.provider === "shopify" || input.provider === "woocommerce") {
        const targetAccountKey =
          input.provider === "shopify"
            ? input.shopDomain.toLowerCase()
            : input.siteUrl.toLowerCase();
        const conflicting = await Integration.findOne({
          merchantId,
          provider: input.provider,
          status: { $in: ["connected", "pending"] },
          accountKey: { $ne: targetAccountKey },
        }).select("accountKey status").lean();
        if (conflicting) {
          throw new TRPCError({
            code: "CONFLICT",
            // Encoded as `<code>:<existing-account-key>` so the web client
            // can parse + render a friendly message naming the existing
            // store, without us baking copy into the API.
            message: `integration_provider_one_shop_only:${conflicting.accountKey}`,
          });
        }
      }

      const now = new Date();
      let accountKey: string;
      let credentialsPayload: Record<string, string> = {};
      const permissions: string[] = [];
      // Resolved Shopify app credentials. Populated only when
      // `input.provider === "shopify"`; consumed when minting the install
      // URL further down so the simple-flow merchant (no apiKey/apiSecret
      // typed) still gets a valid OAuth redirect via env-level credentials.
      let resolvedShopifyAppKey = "";

      if (input.provider === "shopify") {
        accountKey = input.shopDomain.toLowerCase();
        // Resolve which Shopify app credentials to use. Priority:
        //   1. Merchant-supplied (Advanced section in the connect dialog —
        //      legacy custom-app path)
        //   2. Platform-level env (`SHOPIFY_APP_API_KEY`/`_SECRET`) for the
        //      simple flow where the merchant only enters a shop domain.
        const appKey = input.apiKey ?? env.SHOPIFY_APP_API_KEY ?? "";
        const appSecret = input.apiSecret ?? env.SHOPIFY_APP_API_SECRET ?? "";
        resolvedShopifyAppKey = appKey;
        if (!appKey || !appSecret) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            // The web client maps this to a friendly inline message that
            // points the merchant at the Advanced section.
            message:
              "shopify_credentials_required: paste your Shopify app's API key + secret in the Advanced section, or contact support to enable one-click connect.",
          });
        }
        credentialsPayload = {
          apiKey: encryptSecret(appKey),
          apiSecret: encryptSecret(appSecret),
          siteUrl: input.shopDomain,
        };
        if (input.accessToken) {
          credentialsPayload.accessToken = encryptSecret(input.accessToken);
        }
        permissions.push(...input.scopes);
      } else if (input.provider === "woocommerce") {
        accountKey = input.siteUrl;
        credentialsPayload = {
          consumerKey: encryptSecret(input.consumerKey),
          consumerSecret: encryptSecret(input.consumerSecret),
          siteUrl: input.siteUrl,
        };
        permissions.push("read_orders", "write_orders");
      } else if (input.provider === "custom_api") {
        accountKey = `custom-${randomBytes(4).toString("hex")}`;
        const apiKey = randomBytes(24).toString("base64url");
        credentialsPayload = { apiKey: encryptSecret(apiKey) };
        permissions.push("ingest_orders");
      } else {
        accountKey = "csv";
        permissions.push("bulk_upload");
      }

      // Detect existing integration up front so we know whether the connect
      // call is creating a new resource (in which case the merchant must see
      // the freshly-minted webhook secret / apiKey ONCE so they can paste it
      // into their CMS) or reconnecting to an existing one (in which case we
      // never re-emit plaintext — they must use the explicit reveal/rotate
      // endpoints, which require re-auth and are audit-logged).
      const existing = await Integration.findOne({
        merchantId,
        provider: input.provider,
        accountKey,
      })
        .select("_id webhookSecret status credentials")
        .lean();
      const isNewIntegration = !existing;

      // Reconnect safety: if a Shopify integration is already CONNECTED
      // (i.e. it has a working accessToken), refuse to clobber it unless
      // the merchant has explicitly confirmed via `confirmOverwrite`. This
      // protects the most punishing past behaviour — accidental
      // double-clicks wiping a working token. The web client surfaces a
      // confirmation dialog and re-issues the call with the flag set.
      const existingShopifyAccessToken =
        existing && input.provider === "shopify"
          ? ((existing.credentials as Record<string, string | undefined> | undefined)
              ?.accessToken ?? null)
          : null;
      if (
        input.provider === "shopify" &&
        existing?.status === "connected" &&
        existingShopifyAccessToken &&
        !input.accessToken &&
        !input.confirmOverwrite
      ) {
        return {
          id: String(existing._id),
          status: "connected" as const,
          provider: "shopify" as const,
          alreadyConnected: true as const,
          webhookSecretPreview: maskSecretPayload(existing.webhookSecret),
          revealedOnce: false,
        };
      }

      // Reuse the existing webhookSecret on reconnect so that any signed
      // webhooks already configured in the merchant's CMS keep validating.
      // A fresh secret is minted only on first creation; rotation is
      // explicit via rotateWebhookSecret.
      const webhookSecretPlaintext = isNewIntegration
        ? randomBytes(32).toString("base64")
        : null;
      const status = input.provider === "shopify" && !("accessToken" in input && input.accessToken)
        ? "pending"
        : "connected";

      // For Shopify reconnects without a fresh access token, preserve the
      // previously-stored token so a confirmed overwrite of credentials
      // doesn't strand the merchant in "pending" until they re-do OAuth.
      // The OAuth callback still overwrites this with the latest token.
      if (
        input.provider === "shopify" &&
        existingShopifyAccessToken &&
        !input.accessToken
      ) {
        credentialsPayload.accessToken = existingShopifyAccessToken;
      }
      const setPayload: Record<string, unknown> = {
        label:
          "label" in input && input.label
            ? input.label
            : `${input.provider} · ${accountKey}`,
        status,
        credentials: credentialsPayload,
        "webhookStatus.registered": false,
        "webhookStatus.failures": 0,
        permissions,
        "health.ok": true,
        "health.lastError": null,
        "health.lastCheckedAt": now,
        connectedAt: status === "connected" ? now : null,
        disconnectedAt: null,
      };
      if (webhookSecretPlaintext) {
        setPayload.webhookSecret = encryptSecret(webhookSecretPlaintext);
      }
      const integration = await Integration.findOneAndUpdate(
        { merchantId, provider: input.provider, accountKey },
        {
          $set: setPayload,
          $setOnInsert: { merchantId, provider: input.provider, accountKey },
        },
        { upsert: true, new: true },
      );

      // For Woo webhook registration we need the plaintext secret. On reconnect
      // we decrypt the stored value; on insert we already have it in memory.
      const webhookSecret =
        webhookSecretPlaintext ??
        (existing?.webhookSecret ? decryptSafe(existing.webhookSecret) : "");

      // Auto-register webhooks for Woo on connect — Shopify's flow waits for
      // OAuth completion (handled in the callback router). Woo uses long-
      // lived consumer keys so we can do it inline.
      let wooWebhookSummary: { registered: string[]; errors: string[] } | null = null;
      if (input.provider === "woocommerce" && status === "connected") {
        const callbackUrl = `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/integrations/webhook/woocommerce/${String(integration._id)}`;
        try {
          wooWebhookSummary = await registerWooWebhooks({
            siteUrl: input.siteUrl,
            consumerKey: input.consumerKey,
            consumerSecret: input.consumerSecret,
            callbackUrl,
            webhookSecret,
          });
          await Integration.updateOne(
            { _id: integration._id },
            {
              $set: {
                "webhookStatus.registered": wooWebhookSummary.registered.length > 0,
                "webhookStatus.lastError":
                  wooWebhookSummary.errors.length > 0
                    ? wooWebhookSummary.errors.join("; ").slice(0, 500)
                    : null,
              },
            },
          );
        } catch (err) {
          // Never fail connect on webhook registration — the merchant still
          // has the credentials and can set the URL manually if needed.
          await Integration.updateOne(
            { _id: integration._id },
            {
              $set: {
                "webhookStatus.lastError": (err as Error).message.slice(0, 500),
              },
            },
          );
        }
      }

      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "integration.connected",
        subjectType: "integration",
        subjectId: integration._id,
        meta: {
          provider: input.provider,
          accountKey,
          status,
          newIntegration: isNewIntegration,
          ...(wooWebhookSummary
            ? {
                webhooksRegistered: wooWebhookSummary.registered,
                webhookErrors: wooWebhookSummary.errors,
              }
            : {}),
        },
      });

      const result: {
        id: string;
        status: typeof status;
        provider: typeof input.provider;
        // Plaintext secrets are emitted ONLY on first creation. Reconnect
        // returns the masked preview — merchants must call the explicit
        // reveal endpoint (password re-auth + audit log) to retrieve the
        // real value, or rotateWebhookSecret to mint a new one.
        webhookSecret?: string;
        webhookSecretPreview: string;
        plaintextApiKey?: string;
        apiKeyPreview?: string;
        installUrl?: string;
        revealedOnce: boolean;
        alreadyConnected?: boolean;
      } = {
        id: String(integration._id),
        status,
        provider: input.provider,
        webhookSecretPreview: maskSecretPayload(integration.webhookSecret),
        revealedOnce: isNewIntegration,
      };
      if (isNewIntegration && webhookSecretPlaintext) {
        result.webhookSecret = webhookSecretPlaintext;
      }
      if (input.provider === "custom_api") {
        result.apiKeyPreview = maskSecretPayload(credentialsPayload.apiKey);
        if (isNewIntegration) {
          result.plaintextApiKey = decryptSafe(credentialsPayload.apiKey!);
        }
      }
      if (isNewIntegration) {
        void writeAudit({
          merchantId,
          actorId: merchantId,
          action: "integration.secret_revealed",
          subjectType: "integration",
          subjectId: integration._id,
          meta: { provider: input.provider, reason: "initial_creation" },
        });
      }
      if (input.provider === "shopify" && status === "pending") {
        const state = randomBytes(16).toString("hex");
        const installStartedAt = new Date();
        // Persist the install timestamp on the credentials blob so the
        // OAuth callback can compute and log "callback arrived Xs after
        // install start". That number is the cleanest signal we have for
        // "Shopify itself is slow" vs "merchant clicked away" vs "our
        // callback handler is slow" — three very different debugging
        // paths.
        await Integration.updateOne(
          { _id: integration._id },
          {
            $set: {
              "credentials.installNonce": state,
              "credentials.installStartedAt": installStartedAt.toISOString(),
            },
          },
        );
        const redirectUri = `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/integrations/oauth/shopify/callback`;
        // Surface the install-URL parameters to API stdout so a stuck
        // OAuth flow is debuggable without reproducing it.
        console.log("[shopify-oauth] start install", {
          shop: accountKey,
          appKeyPrefix: resolvedShopifyAppKey.slice(0, 8) + "...",
          redirectUri,
          scopes: input.scopes,
          statePrefix: state.slice(0, 6) + "...",
          installStartedAt: installStartedAt.toISOString(),
        });
        result.installUrl = buildShopifyInstallUrl({
          shopDomain: accountKey,
          apiKey: resolvedShopifyAppKey,
          redirectUri,
          scopes: input.scopes,
          state,
        });
      }
      return result;
    }),

  test: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const integration = await Integration.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      });
      if (!integration) {
        throw new TRPCError({ code: "NOT_FOUND", message: "integration not found" });
      }
      if (!hasAdapter(integration.provider as IntegrationProvider)) {
        return { ok: true, detail: "no live test for this provider" };
      }
      const adapter = adapterFor(integration.provider as IntegrationProvider);
      const creds = decryptCreds(integration.credentials ?? {});
      const startedAt = Date.now();
      const result = await adapter.testConnection(creds);
      const latencyMs = Date.now() - startedAt;
      integration.health = {
        ok: result.ok,
        lastError: result.ok ? undefined : result.detail?.slice(0, 500),
        lastCheckedAt: new Date(),
      };
      if (!result.ok) {
        integration.status = "error";
      } else if (integration.status === "error") {
        // A successful test clears the prior error state — merchant fixed
        // the credential problem, treat the integration as connected again.
        integration.status = "connected";
      }
      await integration.save();
      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "integration.test",
        subjectType: "integration",
        subjectId: integration._id,
        meta: { provider: integration.provider, ok: result.ok, latencyMs },
      });
      return { ok: result.ok, detail: result.detail ?? null, latencyMs };
    }),

  fetchSample: protectedProcedure
    .input(z.object({ id: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const integration = await Integration.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      });
      if (!integration) {
        throw new TRPCError({ code: "NOT_FOUND", message: "integration not found" });
      }
      if (!hasAdapter(integration.provider as IntegrationProvider)) {
        return { ok: true, count: 0, sample: [] };
      }
      const adapter = adapterFor(integration.provider as IntegrationProvider);
      const creds = decryptCreds(integration.credentials ?? {});
      const result = await adapter.fetchSampleOrders(creds, input.limit);
      return result;
    }),

  /**
   * Async pull-style import. Replaces the old synchronous loop — the
   * mutation now creates an `ImportJob` row, enqueues the worker, and
   * returns the job id immediately. The dashboard polls `getImportJob` for
   * progress.
   */
  importOrders: protectedProcedure
    .input(z.object({ id: z.string().min(1), limit: z.number().int().min(1).max(50).default(25) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const integration = await Integration.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      })
        .select("_id provider")
        .lean();
      if (!integration) {
        throw new TRPCError({ code: "NOT_FOUND", message: "integration not found" });
      }
      if (!hasAdapter(integration.provider as IntegrationProvider)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "this provider does not support pull-style import",
        });
      }
      // Reject when an import is already in flight for this integration so
      // double-clicks don't fan out duplicate work.
      const existingActive = await ImportJob.findOne({
        integrationId: integration._id,
        status: { $in: ["queued", "running"] },
      })
        .select("_id")
        .lean();
      if (existingActive) {
        return { jobId: String(existingActive._id), status: "queued" as const };
      }
      const job = await ImportJob.create({
        merchantId,
        integrationId: integration._id,
        provider: integration.provider,
        status: "queued",
        requestedLimit: input.limit,
        triggeredBy: merchantId,
      });
      await enqueueCommerceImport({ importJobId: String(job._id) });
      return { jobId: String(job._id), status: "queued" as const };
    }),

  /** Poll endpoint for the import-progress UI. */
  getImportJob: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const job = await ImportJob.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      }).lean();
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "import job not found" });
      const total = job.totalRows ?? 0;
      const processed = job.processedRows ?? 0;
      return {
        id: String(job._id),
        integrationId: String(job.integrationId),
        provider: job.provider,
        status: job.status,
        totalRows: total,
        processedRows: processed,
        importedRows: job.importedRows ?? 0,
        duplicateRows: job.duplicateRows ?? 0,
        failedRows: job.failedRows ?? 0,
        progressPct: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0,
        lastError: job.lastError ?? null,
        startedAt: job.startedAt ?? null,
        finishedAt: job.finishedAt ?? null,
      };
    }),

  /**
   * Mint a NEW webhook secret and return it ONCE. The previous secret is
   * destroyed (any in-flight webhooks signed with it will fail validation
   * thereafter). Requires the merchant's password to confirm the action.
   * Audit-logged.
   */
  rotateWebhookSecret: protectedProcedure
    .input(z.object({ id: z.string().min(1), password: z.string().min(8).max(200) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const merchant = await Merchant.findById(merchantId).select("passwordHash").lean();
      if (!merchant?.passwordHash) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      const passwordOk = await bcrypt.compare(input.password, merchant.passwordHash);
      if (!passwordOk) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid password" });
      }
      const integration = await Integration.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      });
      if (!integration) {
        throw new TRPCError({ code: "NOT_FOUND", message: "integration not found" });
      }
      const newSecret = randomBytes(32).toString("base64");
      integration.webhookSecret = encryptSecret(newSecret);
      await integration.save();
      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "integration.webhook_secret_rotated",
        subjectType: "integration",
        subjectId: integration._id,
        meta: { provider: integration.provider },
      });
      return { secret: newSecret, preview: maskSecretPayload(integration.webhookSecret) };
    }),

  /**
   * Reveal a previously-issued webhook secret (or custom_api apiKey). The
   * merchant must supply their password — the value is sensitive enough
   * that a stolen session alone should not be able to exfiltrate it.
   * Audit-logged so the merchant can review reveal events.
   */
  revealSecret: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        which: z.enum(["webhookSecret", "apiKey"]),
        password: z.string().min(8).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const merchant = await Merchant.findById(merchantId).select("passwordHash").lean();
      if (!merchant?.passwordHash) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      const passwordOk = await bcrypt.compare(input.password, merchant.passwordHash);
      if (!passwordOk) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid password" });
      }
      const integration = await Integration.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      })
        .select("webhookSecret credentials provider")
        .lean();
      if (!integration) {
        throw new TRPCError({ code: "NOT_FOUND", message: "integration not found" });
      }
      let plaintext = "";
      if (input.which === "webhookSecret") {
        plaintext = integration.webhookSecret ? decryptSafe(integration.webhookSecret) : "";
      } else {
        const stored = (integration.credentials as Record<string, string | undefined> | undefined)
          ?.apiKey;
        plaintext = stored ? decryptSafe(stored) : "";
      }
      if (!plaintext) {
        throw new TRPCError({ code: "NOT_FOUND", message: "secret not set" });
      }
      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "integration.secret_revealed",
        subjectType: "integration",
        subjectId: new Types.ObjectId(input.id),
        meta: { provider: integration.provider, which: input.which },
      });
      return { value: plaintext };
    }),

  disconnect: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const integration = await Integration.findOneAndUpdate(
        { _id: new Types.ObjectId(input.id), merchantId },
        {
          $set: {
            status: "disconnected",
            disconnectedAt: new Date(),
            "webhookStatus.registered": false,
          },
        },
        { new: true },
      );
      if (!integration) {
        throw new TRPCError({ code: "NOT_FOUND", message: "integration not found" });
      }
      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "integration.disconnected",
        subjectType: "integration",
        subjectId: integration._id,
        meta: { provider: integration.provider },
      });
      return { id: String(integration._id), disconnected: true };
    }),

  /**
   * Retry Shopify webhook auto-registration on a connected integration.
   * Surfaced to the merchant as a "Retry webhooks" button when the
   * post-OAuth callback flagged `?warning=webhooks_not_registered` (e.g.
   * because Shopify rate-limited the webhook subscribe call right after
   * the install). Idempotent — uses the same dedup pass as the original
   * registration so a successful first call won't pile up duplicates.
   *
   * Cheap to call: bounded by SHOPIFY_FETCH_TIMEOUT_MS per topic, fire
   * one POST per missing topic at most. No background queue needed.
   */
  retryShopifyWebhooks: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const integration = await Integration.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
        provider: "shopify",
      });
      if (!integration) {
        throw new TRPCError({ code: "NOT_FOUND", message: "integration not found" });
      }
      if (integration.status !== "connected") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Integration must be connected before webhooks can be registered.",
        });
      }
      const accessTokenEnc = integration.credentials?.accessToken as string | undefined;
      if (!accessTokenEnc) {
        throw new TRPCError({
          code: "FAILED_PRECONDITION",
          message: "Access token missing — disconnect and reconnect.",
        });
      }
      let accessToken: string;
      try {
        accessToken = decryptSecret(accessTokenEnc);
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not read stored credentials. Disconnect and reconnect.",
        });
      }
      const callbackUrl = `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/integrations/webhook/shopify/${String(integration._id)}`;
      const reg = await registerShopifyWebhooks({
        shopDomain: integration.accountKey,
        accessToken,
        callbackUrl,
      });
      const allRegistered = reg.errors.length === 0;
      integration.webhookStatus = {
        registered: reg.registered.length > 0,
        lastEventAt: integration.webhookStatus?.lastEventAt,
        failures: integration.webhookStatus?.failures ?? 0,
        lastError:
          reg.errors.length > 0 ? reg.errors.join("; ").slice(0, 500) : undefined,
      };
      await integration.save();
      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "integration.shopify_webhooks_retried",
        subjectType: "integration",
        subjectId: integration._id,
        meta: {
          registered: reg.registered,
          errors: reg.errors,
          allRegistered,
        },
      });
      return {
        ok: allRegistered,
        registered: reg.registered,
        errors: reg.errors,
      };
    }),

  /** Recent webhook deliveries — surfaces the merchant's debug pane. */
  recentWebhooks: protectedProcedure
    .input(
      z
        .object({ integrationId: z.string().optional(), limit: z.number().int().min(1).max(50).default(20) })
        .default({ limit: 20 }),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const filter: Record<string, unknown> = { merchantId };
      if (input.integrationId && Types.ObjectId.isValid(input.integrationId)) {
        filter.integrationId = new Types.ObjectId(input.integrationId);
      }
      const rows = await WebhookInbox.find(filter)
        .sort({ receivedAt: -1 })
        .limit(input.limit)
        .lean();
      return rows.map((r) => ({
        id: String(r._id),
        provider: r.provider,
        topic: r.topic,
        externalId: r.externalId,
        status: r.status,
        attempts: r.attempts,
        lastError: r.lastError ?? null,
        receivedAt: r.receivedAt,
        processedAt: r.processedAt ?? null,
        nextRetryAt: r.nextRetryAt ?? null,
        deadLetteredAt: r.deadLetteredAt ?? null,
        resolvedOrderId: r.resolvedOrderId ? String(r.resolvedOrderId) : null,
        canReplay:
          (r.status === "failed" || r.status === "received") &&
          (r.attempts ?? 0) < WEBHOOK_RETRY_MAX_ATTEMPTS,
      }));
    }),

  /**
   * Inspect a single webhook delivery — full payload + error trail. Used by
   * the dashboard's debug pane. Returns 404 cleanly so a bad id doesn't leak
   * presence information.
   */
  inspectWebhook: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const row = await WebhookInbox.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      }).lean();
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "webhook not found" });
      }
      return {
        id: String(row._id),
        provider: row.provider,
        topic: row.topic,
        externalId: row.externalId,
        status: row.status,
        attempts: row.attempts ?? 0,
        lastError: row.lastError ?? null,
        receivedAt: row.receivedAt,
        processedAt: row.processedAt ?? null,
        nextRetryAt: row.nextRetryAt ?? null,
        deadLetteredAt: row.deadLetteredAt ?? null,
        resolvedOrderId: row.resolvedOrderId ? String(row.resolvedOrderId) : null,
        payload: row.payload ?? null,
        payloadBytes: row.payloadBytes ?? 0,
        canReplay:
          (row.status === "failed" || row.status === "received") &&
          (row.attempts ?? 0) < WEBHOOK_RETRY_MAX_ATTEMPTS,
      };
    }),

  /**
   * Plan-aware entitlements view. Drives the dashboard's upgrade CTAs and
   * disables provider rows the merchant isn't allowed to connect. Cheap to
   * call — derived from a single Merchant.findById + plan lookup.
   */
  getEntitlements: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const m = await Merchant.findById(merchantId).select("subscription.tier").lean();
    const tier = (m?.subscription?.tier ?? "starter") as PlanTier;
    const view = entitlementsFor(tier);
    const activeCount = await Integration.countDocuments({
      merchantId,
      status: { $in: ["pending", "connected"] },
      provider: { $ne: "csv" },
    });
    // Tells the web client whether the platform has Shopify Partner-app
    // credentials set in env. When false, "one-click connect" cannot work
    // for ANY merchant — the modal needs to surface that honestly instead
    // of repeating "no API keys, no copy-paste" and letting the Continue
    // call blow up with a generic error.
    const platformShopifyConfigured = Boolean(
      env.SHOPIFY_APP_API_KEY && env.SHOPIFY_APP_API_SECRET,
    );

    // For each domain-keyed provider (shopify/woocommerce), surface the
    // accountKey of the merchant's existing connected/pending integration
    // (if any) so the web can disable the Connect button on that card and
    // explain why with a tooltip naming the existing store. Mirrors the
    // server-side `integration_provider_one_shop_only` guard in `connect`.
    const oneShopProviders = ["shopify", "woocommerce"] as const;
    const existingShopByProvider: Record<string, string | null> = {
      shopify: null,
      woocommerce: null,
    };
    const existing = await Integration.find({
      merchantId,
      provider: { $in: oneShopProviders as unknown as string[] },
      status: { $in: ["pending", "connected"] },
    })
      .select("provider accountKey")
      .lean();
    for (const row of existing) {
      existingShopByProvider[row.provider] = row.accountKey;
    }

    return {
      ...view,
      activeIntegrationCount: activeCount,
      remainingIntegrationSlots:
        view.maxIntegrations <= 0
          ? 0
          : Math.max(0, view.maxIntegrations - activeCount),
      platformShopifyConfigured,
      existingShopByProvider,
    };
  }),

  /**
   * Manual webhook replay — reruns ingestion for a failed `WebhookInbox` row.
   * Audit-logged with the merchant as the actor. Bypasses the worker's
   * `nextRetryAt` gate so the merchant can debug interactively.
   */
  replayWebhook: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const inbox = await WebhookInbox.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      }).select("_id status attempts");
      if (!inbox) {
        throw new TRPCError({ code: "NOT_FOUND", message: "webhook not found" });
      }
      if (inbox.status === "succeeded") {
        return { ok: true, status: "skipped" as const, attempts: inbox.attempts ?? 0 };
      }
      const result = await replayWebhookInbox({
        inboxId: inbox._id,
        actorId: merchantId,
        manual: true,
      });
      return {
        ok: result.ok,
        status: result.status,
        attempts: result.attempts,
        orderId: result.orderId ?? null,
        error: result.error ?? null,
        duplicate: !!result.duplicate,
      };
    }),
});

export const ALL_INTEGRATION_PROVIDERS = INTEGRATION_PROVIDERS;
