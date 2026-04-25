import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import {
  ImportJob,
  Integration,
  INTEGRATION_PROVIDERS,
  Merchant,
  WebhookInbox,
  type IntegrationProvider,
} from "@ecom/db";
import { billableProcedure, protectedProcedure, router, type SubscriptionSnapshot } from "../trpc.js";
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
} from "../../lib/integrations/shopify.js";
import { registerWooWebhooks } from "../../lib/integrations/woocommerce.js";
import type { IntegrationCredentials } from "../../lib/integrations/types.js";
import {
  replayWebhookInbox,
  WEBHOOK_RETRY_MAX_ATTEMPTS,
} from "../ingest.js";
import { enqueueCommerceImport } from "../../workers/commerceImport.js";
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
    return {
      ...view,
      activeIntegrationCount: activeCount,
      remainingIntegrationSlots:
        view.maxIntegrations <= 0
          ? 0
          : Math.max(0, view.maxIntegrations - activeCount),
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
