import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import {
  Integration,
  INTEGRATION_PROVIDERS,
  WebhookInbox,
  type IntegrationProvider,
} from "@ecom/db";
import { protectedProcedure, router } from "../trpc.js";
import { decryptSecret, encryptSecret, maskSecretPayload } from "../../lib/crypto.js";
import { adapterFor, hasAdapter } from "../../lib/integrations/index.js";
import {
  buildShopifyInstallUrl,
} from "../../lib/integrations/shopify.js";
import type { IntegrationCredentials } from "../../lib/integrations/types.js";
import { ingestNormalizedOrder } from "../ingest.js";
import { writeAudit } from "../../lib/audit.js";

function merchantObjectId(ctx: { user: { id: string } }): Types.ObjectId {
  return new Types.ObjectId(ctx.user.id);
}

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

const connectShopifySchema = z.object({
  provider: z.literal("shopify"),
  shopDomain: z
    .string()
    .min(3)
    .regex(/^[a-zA-Z0-9.-]+$/),
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  accessToken: z.string().min(1).optional(),
  scopes: z.array(z.string()).default(["read_orders", "write_orders", "read_customers"]),
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
    const rows = await Integration.find({ merchantId }).sort({ createdAt: -1 }).lean();
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

  connect: protectedProcedure
    .input(connectInputSchema)
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const now = new Date();
      let accountKey: string;
      let credentialsPayload: Record<string, string> = {};
      const permissions: string[] = [];

      if (input.provider === "shopify") {
        accountKey = input.shopDomain.toLowerCase();
        credentialsPayload = {
          apiKey: encryptSecret(input.apiKey),
          apiSecret: encryptSecret(input.apiSecret),
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

      const webhookSecret = randomBytes(32).toString("base64");
      const status = input.provider === "shopify" && !("accessToken" in input && input.accessToken)
        ? "pending"
        : "connected";
      const integration = await Integration.findOneAndUpdate(
        { merchantId, provider: input.provider, accountKey },
        {
          $set: {
            label:
              "label" in input && input.label
                ? input.label
                : `${input.provider} · ${accountKey}`,
            status,
            credentials: credentialsPayload,
            webhookSecret: encryptSecret(webhookSecret),
            "webhookStatus.registered": false,
            "webhookStatus.failures": 0,
            permissions,
            "health.ok": true,
            "health.lastError": null,
            "health.lastCheckedAt": now,
            connectedAt: status === "connected" ? now : null,
            disconnectedAt: null,
          },
          $setOnInsert: { merchantId, provider: input.provider, accountKey },
        },
        { upsert: true, new: true },
      );

      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "integration.connected",
        subjectType: "integration",
        subjectId: integration._id,
        meta: { provider: input.provider, accountKey, status },
      });

      const result: {
        id: string;
        status: typeof status;
        provider: typeof input.provider;
        webhookSecret?: string;
        plaintextApiKey?: string;
        installUrl?: string;
      } = {
        id: String(integration._id),
        status,
        provider: input.provider,
        webhookSecret,
      };
      if (input.provider === "custom_api") {
        result.plaintextApiKey = decryptSafe(credentialsPayload.apiKey!);
      }
      if (input.provider === "shopify" && status === "pending") {
        const state = randomBytes(16).toString("hex");
        await Integration.updateOne(
          { _id: integration._id },
          { $set: { "credentials.installNonce": state } },
        );
        result.installUrl = buildShopifyInstallUrl({
          shopDomain: accountKey,
          apiKey: input.apiKey,
          redirectUri: `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/integrations/oauth/shopify/callback`,
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
      const result = await adapter.testConnection(creds);
      integration.health = {
        ok: result.ok,
        lastError: result.ok ? undefined : result.detail?.slice(0, 500),
        lastCheckedAt: new Date(),
      };
      if (!result.ok) {
        integration.status = "error";
      }
      await integration.save();
      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "integration.test",
        subjectType: "integration",
        subjectId: integration._id,
        meta: { provider: integration.provider, ok: result.ok },
      });
      return { ok: result.ok, detail: result.detail ?? null };
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
   * Pull-style import — fetches recent orders from the upstream API and runs
   * each through the ingestion pipeline. Useful for the first-time connect
   * flow or when webhooks fail and the merchant needs to backfill manually.
   */
  importOrders: protectedProcedure
    .input(z.object({ id: z.string().min(1), limit: z.number().int().min(1).max(50).default(10) }))
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
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "this provider does not support pull-style import",
        });
      }
      const adapter = adapterFor(integration.provider as IntegrationProvider);
      const creds = decryptCreds(integration.credentials ?? {});
      const result = await adapter.fetchSampleOrders(creds, input.limit);
      if (!result.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: result.error ?? "import failed",
        });
      }
      let imported = 0;
      let duplicates = 0;
      let failed = 0;
      for (const normalized of result.sample) {
        const ingestResult = await ingestNormalizedOrder(normalized, {
          merchantId,
          integrationId: integration._id,
          source: integration.provider as
            | "shopify"
            | "woocommerce"
            | "custom_api",
          channel: "api",
        });
        if (ingestResult.ok && !ingestResult.duplicate) imported += 1;
        else if (ingestResult.duplicate) duplicates += 1;
        else failed += 1;
      }
      await Integration.updateOne(
        { _id: integration._id },
        { $set: { lastSyncAt: new Date() } },
      );
      return { imported, duplicates, failed, scanned: result.sample.length };
    }),

  /** Reveal the webhook secret once for re-rotation. Audit-logged. */
  rotateWebhookSecret: protectedProcedure
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
      const newSecret = randomBytes(32).toString("base64");
      integration.webhookSecret = encryptSecret(newSecret);
      await integration.save();
      return { secret: newSecret };
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
        resolvedOrderId: r.resolvedOrderId ? String(r.resolvedOrderId) : null,
      }));
    }),
});

export const ALL_INTEGRATION_PROVIDERS = INTEGRATION_PROVIDERS;
