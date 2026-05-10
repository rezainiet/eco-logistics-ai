import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import { isAllowedWooSiteUrl, WOO_SITE_URL_ERROR } from "@ecom/types";
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
import { evaluateIntegrationHealth } from "../../lib/integrations/health.js";
import {
  assertIntegrationCapacity,
  assertIntegrationProvider,
  entitlementsFor,
} from "../../lib/entitlements.js";
import type { PlanTier } from "../../lib/plans.js";
import {
  buildShopifyInstallUrl,
  registerShopifyWebhooks,
  revokeShopifyAccessToken,
} from "../../lib/integrations/shopify.js";
import {
  deleteWooWebhooks,
  registerWooWebhooks,
} from "../../lib/integrations/woocommerce.js";
import type { IntegrationCredentials } from "../../lib/integrations/types.js";
import {
  replayWebhookInbox,
  WEBHOOK_RETRY_MAX_ATTEMPTS,
} from "../ingest.js";
import { enqueueCommerceImport } from "../../workers/commerceImport.js";
import { syncOneIntegration } from "../../workers/orderSync.worker.js";
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
  // Plain string — not a secret, just metadata about which Woo auth
  // wire form the host accepts. Whitelist-validated to keep an
  // unexpected DB value from coercing into the union.
  if (s.authStrategy === "basic" || s.authStrategy === "querystring") {
    out.authStrategy = s.authStrategy;
  }
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
  // Use the shared validator from @ecom/types so client and server
  // enforce the exact same rule. `z.string().url()` would accept
  // ftp://, file://, javascript: — and the previous regex on the
  // dashboard was https-only, blocking the very-common dev case of
  // pointing at http://localhost:8881. The shared helper allows
  // https:// for any host AND http:// for localhost / 127.0.0.1 /
  // ::1 / *.local / *.test / *.localhost, rejecting everything else.
  siteUrl: z.string().refine(isAllowedWooSiteUrl, {
    message: WOO_SITE_URL_ERROR,
  }),
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
      // Surface the system-set "stop trying recovery" flag so the
      // dashboard's health card can disable action buttons on rows the
      // alert worker has already given up on.
      degraded: row.degraded ?? false,
      // Observability snapshot fields — surfaced on the list response
      // so the merchant-facing Connections panel can render an inline
      // health dot ("● Healthy / Sync issue / Idle") without an extra
      // round-trip per card. Reads only; no contract change for any
      // existing consumer that ignores them.
      lastSyncStatus:
        (row.lastSyncStatus as "ok" | "error" | "idle" | undefined) ?? "idle",
      errorCount: row.errorCount ?? 0,
      lastWebhookAt: row.lastWebhookAt ?? null,
      lastImportAt: row.lastImportAt ?? null,
      lastError: row.lastError ?? null,
      // Pause state — surfaced so the dashboard can render the
      // "Paused" banner and toggle the action buttons. Distinct from
      // `status: "disconnected"` (which means the credentials are
      // gone). Both fields can be null.
      pausedAt: row.pausedAt ?? null,
      pausedReason: row.pausedReason ?? null,
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

      // For a Shopify install, mint the nonce + installStartedAt UP FRONT
      // so they go into the same atomic upsert below. The previous flow
      // used a separate `updateOne` afterward to set them via dot-notation,
      // which was broken in two ways:
      //   1. installStartedAt wasn't on the schema → strict mode silently
      //      dropped the write → every callback logged
      //      "(no installStartedAt)" with no timing signal.
      //   2. The window between the upsert and the second updateOne was a
      //      brief but real gap during which a callback could land on a
      //      row with no install nonce → "integration_not_found".
      // We mint here so the pending row has full install context the
      // instant Mongo accepts the upsert.
      let installNonce: string | undefined;
      let installStartedAt: Date | undefined;
      if (input.provider === "shopify" && status === "pending") {
        installNonce = randomBytes(16).toString("hex");
        installStartedAt = new Date();
        credentialsPayload.installNonce = installNonce;
        // Date instance — Mongoose serialises it; the schema field is
        // `{ type: Date }` so toISOString round-trips on read.
        (credentialsPayload as Record<string, unknown>).installStartedAt =
          installStartedAt;
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
      // RACE-SAFETY: webhookSecret lives in `$setOnInsert`, not `$set`. On
      // a same-accountKey concurrent connect, both callers' upserts target
      // the same canonical row; Mongo serializes them — one INSERT, one
      // UPDATE. With the secret in `$set`, the UPDATE branch would
      // overwrite the INSERTer's ciphertext and the merchant who saw the
      // first response would hold a plaintext that no longer matches the
      // DB (HMAC verification on the next inbound webhook fails silently).
      // Putting it in `$setOnInsert` makes the INSERTer's secret
      // canonical; the UPDATE branch leaves it untouched. We then check
      // the upsert metadata to decide whether to surface the plaintext to
      // THIS caller (only when WE inserted; the other caller gets the
      // reconnect-shaped response with `revealedOnce: false`).
      const setOnInsertPayload: Record<string, unknown> = {
        merchantId,
        provider: input.provider,
        accountKey,
      };
      if (webhookSecretPlaintext) {
        setOnInsertPayload.webhookSecret = encryptSecret(webhookSecretPlaintext);
      }

      // E11000 from the partial unique on `(merchantId, provider)` for
      // active rows. Happens when two parallel connects race with
      // DIFFERENT accountKeys (the canonical case is custom_api, whose
      // accountKey is a fresh random per call so the
      // `(merchantId, provider, accountKey)` index can't collapse the
      // races). The winner already finished the connect (audit, webhook
      // registration, secret reveal) — the loser surfaces it as an
      // already-connected response so the merchant sees the same row
      // they would have if they'd checked the dashboard first.
      // Closure-mutated holder. Plain `let` would be narrowed to `null` by
      // TS's control-flow analysis (closure assignments don't propagate to
      // the outer scope's narrowing), and the post-IIFE `if (raceWinner)`
      // guard would collapse to `never`. The holder object preserves the
      // union type at the read site.
      type RaceWinner = {
        _id: Types.ObjectId;
        status: string;
        webhookSecret?: string;
      };
      const raceWinnerHolder: { value: RaceWinner | null } = { value: null };
      const integration = await (async () => {
        try {
          return await Integration.findOneAndUpdate(
            { merchantId, provider: input.provider, accountKey },
            { $set: setPayload, $setOnInsert: setOnInsertPayload },
            { upsert: true, new: true },
          );
        } catch (err) {
          const code = (err as { code?: number }).code;
          if (code !== 11000) throw err;
          const winner = await Integration.findOne({
            merchantId,
            provider: input.provider,
            status: { $in: ["pending", "connected"] },
          }).lean();
          if (!winner) throw err;
          raceWinnerHolder.value = {
            _id: winner._id,
            status: String(winner.status),
            webhookSecret: winner.webhookSecret ?? undefined,
          };
          return null;
        }
      })();
      if (raceWinnerHolder.value) {
        const w = raceWinnerHolder.value;
        return {
          id: String(w._id),
          status: w.status as typeof status,
          provider: input.provider,
          alreadyConnected: true as const,
          webhookSecretPreview: maskSecretPayload(w.webhookSecret),
          revealedOnce: false,
        };
      }
      if (!integration) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "integration upsert returned no document",
        });
      }
      // Did THIS caller's $setOnInsert ciphertext reach disk? If the
      // persisted webhookSecret decrypts to the plaintext we minted in
      // memory, we're the inserter — safe to surface plaintext and audit
      // the reveal. If it doesn't match, a concurrent caller won the
      // accountKey race; their secret is canonical and we hand back only
      // the masked preview so the merchant doesn't see a secret that
      // won't validate any future webhook.
      let wasActuallyInserted = false;
      if (
        isNewIntegration &&
        webhookSecretPlaintext &&
        integration.webhookSecret
      ) {
        try {
          wasActuallyInserted =
            decryptSecret(integration.webhookSecret as string) ===
            webhookSecretPlaintext;
        } catch {
          wasActuallyInserted = false;
        }
      }

      // For Woo webhook registration we need the plaintext secret. On reconnect
      // we decrypt the stored value; on insert we already have it in memory.
      const webhookSecret =
        webhookSecretPlaintext ??
        (existing?.webhookSecret ? decryptSafe(existing.webhookSecret) : "");

      // Auto-register webhooks for Woo on connect — Shopify's flow waits for
      // OAuth completion (handled in the callback router). Woo uses long-
      // lived consumer keys so we can do it inline.
      //
      // Persists per-topic subscription IDs returned by WC so the
      // disconnect handler can hit DELETE /webhooks/{id} for symmetric
      // uninstall (no need to re-list, which would also fail if the
      // merchant rotated the API key in the meantime).
      let wooWebhookSummary: {
        registered: Array<{ topic: string; id: number; deliveryUrl: string }>;
        errors: string[];
        authStrategy?: "basic" | "querystring";
      } | null = null;
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
          // Persist the auth strategy that the first authenticated
          // call resolved. Stored as plaintext metadata on the
          // credentials blob (it isn't a secret) so all subsequent
          // calls — disconnect, retryWooWebhooks, fetchSample, the
          // import worker — pass it to wooFetch and skip the
          // Basic→querystring escalation probe.
          const persistSet: Record<string, unknown> = {
            "webhookStatus.registered": wooWebhookSummary.registered.length > 0,
            "webhookStatus.lastError":
              wooWebhookSummary.errors.length > 0
                ? wooWebhookSummary.errors.join("; ").slice(0, 500)
                : null,
            "webhookStatus.subscriptions": wooWebhookSummary.registered,
          };
          if (wooWebhookSummary.authStrategy) {
            persistSet["credentials.authStrategy"] = wooWebhookSummary.authStrategy;
          }
          await Integration.updateOne(
            { _id: integration._id },
            { $set: persistSet },
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

      // Auto-register Shopify webhooks when the merchant supplied an
      // access token via the "Advanced" path (i.e. status flipped to
      // "connected" without going through OAuth). Mirrors the OAuth
      // callback's registration block (server/webhooks/integrations.ts).
      // Without this the integration shows "connected" in the UI but
      // Shopify never POSTs to /api/integrations/webhook/shopify/{id}
      // because no subscription was ever created server-side.
      if (
        input.provider === "shopify" &&
        status === "connected" &&
        "accessToken" in input &&
        input.accessToken
      ) {
        const callbackUrl = `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/integrations/webhook/shopify/${String(integration._id)}`;
        try {
          const reg = await registerShopifyWebhooks({
            shopDomain: integration.accountKey,
            accessToken: input.accessToken,
            callbackUrl,
          });
          // Surface the raw registration result in deploy logs so operators
          // can debug subscription failures without needing to query the
          // integration's webhookStatus directly. Without this we lose the
          // actual Shopify error messages (HMAC, scope, malformed URL etc.)
          // because they're only persisted in webhookStatus.lastError on
          // the Integration doc, which isn't surfaced in the dashboard yet.
          console.log(
            `[integrations.connect/shopify] integration=${String(
              integration._id,
            )} callbackUrl=${callbackUrl} registered=${JSON.stringify(
              reg.registered,
            )} errors=${JSON.stringify(reg.errors)}`,
          );
          await Integration.updateOne(
            { _id: integration._id },
            {
              $set: {
                "webhookStatus.registered": reg.registered.length > 0,
                "webhookStatus.lastError":
                  reg.errors.length > 0
                    ? reg.errors.join("; ").slice(0, 500)
                    : null,
              },
            },
          );
          // Audit-log under the EXISTING enum value used by the manual
          // retry path. Adding a new enum entry would require a schema
          // migration; reusing the retried action is fine because the
          // audit's meta still distinguishes the connect-time call (it
          // includes the callbackUrl) from the retry mutation.
          void writeAudit({
            merchantId,
            actorId: merchantId,
            action: "integration.shopify_webhooks_retried",
            subjectType: "integration",
            subjectId: integration._id,
            meta: {
              registered: reg.registered,
              errors: reg.errors,
              callbackUrl,
              source: "connect",
            },
          });
        } catch (err) {
          // Never fail connect on registration — merchant can hit
          // retryShopifyWebhooks afterwards, or operate without
          // real-time sync if Shopify is down.
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
                // Audit only the topics (not the numeric IDs) — the
                // IDs are an implementation detail of WC and noisy in
                // human-readable audit views.
                webhooksRegistered: wooWebhookSummary.registered.map((s) => s.topic),
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
        // Truth source: the upsert metadata, NOT the pre-read. A caller
        // that LOST the `$setOnInsert` race had `isNewIntegration: true`
        // (their pre-read returned null) but `wasActuallyInserted: false`
        // (Mongo found the winner's row by the time their write ran).
        // We must NOT mark `revealedOnce: true` here or claim plaintext
        // ownership for the loser — their plaintext doesn't match the
        // canonical ciphertext on disk.
        revealedOnce: isNewIntegration && wasActuallyInserted,
      };
      if (isNewIntegration && wasActuallyInserted && webhookSecretPlaintext) {
        result.webhookSecret = webhookSecretPlaintext;
      }
      if (input.provider === "custom_api") {
        result.apiKeyPreview = maskSecretPayload(credentialsPayload.apiKey);
        if (isNewIntegration && wasActuallyInserted) {
          result.plaintextApiKey = decryptSafe(credentialsPayload.apiKey!);
        }
      }
      if (isNewIntegration && wasActuallyInserted) {
        void writeAudit({
          merchantId,
          actorId: merchantId,
          action: "integration.secret_revealed",
          subjectType: "integration",
          subjectId: integration._id,
          meta: { provider: input.provider, reason: "initial_creation" },
        });
      }
      if (
        input.provider === "shopify" &&
        status === "pending" &&
        installNonce &&
        installStartedAt
      ) {
        const redirectUri = `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/integrations/oauth/shopify/callback`;
        // Surface the install-URL parameters to API stdout so a stuck
        // OAuth flow is debuggable without reproducing it. nonce +
        // installStartedAt are already persisted by the upsert above.
        console.log("[shopify-oauth] start install", {
          shop: accountKey,
          appKeyPrefix: resolvedShopifyAppKey.slice(0, 8) + "...",
          redirectUri,
          scopes: input.scopes,
          statePrefix: installNonce.slice(0, 6) + "...",
          installStartedAt: installStartedAt.toISOString(),
        });
        result.installUrl = buildShopifyInstallUrl({
          shopDomain: accountKey,
          apiKey: resolvedShopifyAppKey,
          redirectUri,
          scopes: input.scopes,
          state: installNonce,
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
      // Humanize transient network failures (ECONNREFUSED, ENOTFOUND,
      // timeout) into a single "Connection error: <reason>" string the
      // dashboard pill and merchant runbook can both lean on. The kind
      // is the routing contract — anything not "transient" keeps the
      // adapter's exact wording so auth/schema errors stay debuggable.
      const friendlyDetail = (() => {
        if (result.ok) return null;
        const raw = result.detail ?? "unknown error";
        if (result.kind === "transient" || result.kind === "timeout") {
          // Pull a host hint out of the credentials so the merchant
          // sees WHICH endpoint is unreachable — the dashboard
          // otherwise just says "Connection error" with no anchor.
          let host: string | null = null;
          try {
            if (creds.siteUrl) host = new URL(creds.siteUrl).host;
          } catch {
            host = creds.siteUrl ?? null;
          }
          return `Connection error${host ? ` — cannot reach ${host}` : ""}: ${raw}`;
        }
        return raw;
      })();
      integration.health = {
        ok: result.ok,
        lastError: result.ok ? undefined : friendlyDetail?.slice(0, 500),
        lastCheckedAt: new Date(),
      };
      if (!result.ok) {
        // Detect the "credentials irrecoverably revoked" case and
        // soft-disconnect, instead of leaving the integration stuck in
        // "error" forever (which keeps consuming the merchant's
        // one-shop slot and surfaces a useless Test/Reconnect dance).
        //
        // For Shopify, a 401 / "Invalid API key or access token" from
        // the Admin API means the OAuth access token has been
        // permanently invalidated — the only thing that does that is
        // a merchant-side uninstall (or a manual rotate, which our
        // flow doesn't expose). Either way, the row will never
        // recover without a full reconnect, so flipping it to
        // "disconnected" is the correct UX: the card frees up, the
        // merchant clicks Connect, fresh token, working integration.
        //
        // We catch this here as a backstop in case the
        // `app/uninstalled` webhook didn't reach us (network blip,
        // pre-subscription install, Shopify outage). For any 5xx /
        // network / transient error we keep the existing "error"
        // status so the merchant can retry.
        const detail = (result.detail ?? "").toLowerCase();
        // Per-provider auth-failure heuristics. Both end up flipping
        // the row to `disconnected` so the dashboard frees the
        // merchant's slot instead of stranding them in "error".
        //
        // Shopify: 401 / "Invalid API key or access token" → token
        //   was revoked, only an uninstall does that. Reconnect is
        //   the only recovery. Still uses substring matching pending
        //   the Phase 2 migration to kinded errors on the Shopify
        //   adapter.
        // WooCommerce: now driven by the discriminated `kind` on the
        //   adapter result. 401 / 403 → `auth_rejected` → merchant
        //   deleted or rotated the REST API key in their wp-admin;
        //   only recovery is reconnect with new credentials. The old
        //   substring heuristic was fragile (W-EX-01 in the
        //   failure-modes audit): any wording change to the
        //   `IntegrationError` detail silently broke auto-disconnect,
        //   leaving merchants wedged in `error` until the next
        //   retry.
        // Tightened auth-failure heuristic for Shopify. Previously we
        // matched the bare substring "access token" — which mistakenly
        // triggered on Shopify's 403 "Non-expiring access tokens are
        // no longer accepted" message. That 403 is a TOKEN-FORMAT
        // policy rejection, not a token-revoked event: the merchant
        // didn't uninstall, the OAuth grant is technically valid, the
        // app just needs the modern Token Access framework. Auto-
        // disconnecting on it stranded merchants in a loop.
        //
        // Rule: only flip to disconnected on a true revoked/invalid
        // token signal (401, "invalid api key", "unrecognized
        // login"). Anything else — 403 policy errors, scope
        // mismatches, transient 5xx — keeps the row in "error" so
        // the merchant can retry without losing their slot.
        const isPermanentAuthFailure =
          (integration.provider === "shopify" &&
            (detail.includes("401") ||
              detail.includes("invalid api key") ||
              detail.includes("invalid access token") ||
              detail.includes("unrecognized login"))) ||
          (integration.provider === "woocommerce" &&
            result.kind === "auth_rejected");
        if (isPermanentAuthFailure) {
          integration.status = "disconnected";
          integration.disconnectedAt = new Date();
          if (integration.webhookStatus) {
            integration.webhookStatus.registered = false;
          }
        } else {
          integration.status = "error";
        }
        // Mirror the failure onto the dashboard-facing observability
        // fields so the Health pill flips from "Idle" / "Healthy" to
        // "Error" the moment a Test fails — without this the merchant
        // would see an unchanged green pill until the next scheduled
        // sync stamped the row. `lastError` is the top-level field the
        // list/health readers project; `health.lastError` (set above)
        // is kept for the dedicated credential-test history. They
        // diverge intentionally: health.lastError survives a successful
        // sync that clears `lastError`, so we can show "auth was fine
        // 5min ago, then sync failed" diagnostics in the runbook.
        integration.lastSyncStatus = "error";
        integration.lastError = friendlyDetail?.slice(0, 500);
        integration.errorCount = (integration.errorCount ?? 0) + 1;
      } else if (integration.status === "error") {
        // A successful test clears the prior error state — merchant fixed
        // the credential problem, treat the integration as connected again.
        integration.status = "connected";
        integration.lastSyncStatus = "ok";
        integration.lastError = undefined;
        integration.errorCount = 0;
      } else {
        // Steady-state pass-through: even when the row was already
        // healthy, a green test resets the error counters. Without this
        // a flaky transient that bumped `errorCount` once would never
        // decay back to zero unless an actual sync ran.
        integration.lastSyncStatus = "ok";
        integration.lastError = undefined;
        integration.errorCount = 0;
      }
      // Persist the resolved Woo auth strategy when the adapter
      // surfaced one. The first successful test on a row that
      // pre-dates Phase 2 (no stored strategy) learns it here; later
      // tests confirm it's still valid. Stored as plaintext metadata
      // on the credentials blob — Mongoose will only commit if the
      // schema knows about the field, which it does as of the
      // matching `packages/db` migration.
      if (
        integration.provider === "woocommerce" &&
        result.authStrategy &&
        integration.credentials
      ) {
        const credsBlob = integration.credentials as Record<string, unknown>;
        if (credsBlob.authStrategy !== result.authStrategy) {
          credsBlob.authStrategy = result.authStrategy;
          // Mongoose mixed/sub-document mutations need an explicit
          // markModified; without it, save() silently skips the
          // write. Same trap that bit `installStartedAt` historically.
          integration.markModified("credentials");
        }
      }
      await integration.save();
      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "integration.test",
        subjectType: "integration",
        subjectId: integration._id,
        meta: {
          provider: integration.provider,
          ok: result.ok,
          latencyMs,
          autoDisconnected: integration.status === "disconnected",
        },
      });
      return {
        ok: result.ok,
        detail: result.detail ?? null,
        latencyMs,
        // Web client uses this to surface the friendly "we
        // auto-disconnected — click Connect to start fresh" toast
        // and immediately invalidate the integrations.list query so
        // the row disappears.
        autoDisconnected: integration.status === "disconnected",
      };
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

      // Read the row BEFORE flipping it so we can hit Shopify's
      // revoke endpoint with the live access token. If we flipped
      // first then revoked, a crash between the two writes would
      // leave the merchant with a healthy Shopify-side install but
      // a disconnected row on our side — the exact asymmetry the
      // merchant complained about ("trash on dashboard didn't
      // uninstall the app on Shopify").
      const existing = await Integration.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "integration not found" });
      }

      // Best-effort symmetric uninstall on the remote platform's
      // side. Three ground rules apply for ALL providers:
      //   1. NEVER block the local disconnect on this — the merchant
      //      should always be able to disconnect, even if the remote
      //      side is down or the credentials are already invalid.
      //   2. ALWAYS audit the outcome so a stranded remote-side
      //      install is debuggable.
      //   3. csv / custom_api have nothing to revoke; skip.
      //
      // Per-provider mechanism:
      //   - Shopify: revoke the OAuth access token. Cancels every
      //              webhook subscription tied to it AND removes the
      //              app from the merchant's Shopify admin in one call.
      //   - Woo:     no remote credential revoke (consumer keys are
      //              wp-admin only), so we delete the webhook
      //              subscriptions we registered. This stops Woo from
      //              spamming our endpoint with deliveries the
      //              merchant didn't ask for. Wipe consumerSecret
      //              locally so a leaked DB can't replay it.
      type RemoteRevokeOutcome =
        | { ok: true }
        | { ok: true; alreadyRevoked: true; status: number }
        | { ok: true; deleted: number; alreadyGone: number }
        | { ok: false; kind: string; detail: string }
        | null;
      let remoteRevoke: RemoteRevokeOutcome = null;

      if (existing.provider === "shopify") {
        const stored = (existing.credentials as Record<string, string | undefined> | undefined)
          ?.accessToken;
        if (stored) {
          let token: string | null = null;
          try {
            token = decryptSecret(stored);
          } catch {
            remoteRevoke = {
              ok: false,
              kind: "credential_decrypt_failed",
              detail: "stored access token unreadable — skipping remote revoke",
            };
          }
          if (token) {
            try {
              const r = await revokeShopifyAccessToken({
                shopDomain: existing.accountKey,
                accessToken: token,
              });
              remoteRevoke = r;
            } catch (err) {
              // fetchWithTimeout already rescues most errors; this
              // is a belt-and-braces in case the helper itself
              // throws unexpectedly.
              remoteRevoke = {
                ok: false,
                kind: "uncaught",
                detail: (err as Error).message.slice(0, 200),
              };
            }
          }
        } else {
          remoteRevoke = {
            ok: false,
            kind: "no_access_token",
            detail: "row had no stored access token (e.g. install never completed)",
          };
        }
      } else if (existing.provider === "woocommerce") {
        const credsBlob = existing.credentials as
          | Record<string, string | undefined>
          | undefined;
        const subscriptions =
          (existing.webhookStatus?.subscriptions as Array<{ id: number }> | undefined) ?? [];
        const webhookIds = subscriptions
          .map((s) => s?.id)
          .filter((id): id is number => typeof id === "number" && id > 0);
        if (webhookIds.length === 0) {
          remoteRevoke = {
            ok: false,
            kind: "no_subscriptions",
            detail: "no webhook ids on file — skipping remote delete",
          };
        } else if (!credsBlob?.consumerKey || !credsBlob?.consumerSecret) {
          remoteRevoke = {
            ok: false,
            kind: "no_credentials",
            detail: "consumer key/secret missing — skipping remote delete",
          };
        } else {
          let consumerKey: string | null = null;
          let consumerSecret: string | null = null;
          try {
            consumerKey = decryptSecret(credsBlob.consumerKey);
            consumerSecret = decryptSecret(credsBlob.consumerSecret);
          } catch {
            remoteRevoke = {
              ok: false,
              kind: "credential_decrypt_failed",
              detail: "stored woo credentials unreadable — skipping remote delete",
            };
          }
          if (consumerKey && consumerSecret) {
            try {
              // Pass the persisted auth strategy through. The DELETE
              // calls happen one per webhook id, so without this, a
              // Cloudflare-fronted store that requires querystring
              // auth would burn a whole Basic→fallback cycle on every
              // single delete — doubling the disconnect latency.
              const storedStrategy =
                credsBlob?.authStrategy === "basic" ||
                credsBlob?.authStrategy === "querystring"
                  ? credsBlob.authStrategy
                  : undefined;
              const r = await deleteWooWebhooks({
                siteUrl: existing.accountKey,
                consumerKey,
                consumerSecret,
                webhookIds,
                authStrategy: storedStrategy,
              });
              remoteRevoke = r;
            } catch (err) {
              remoteRevoke = {
                ok: false,
                kind: "uncaught",
                detail: (err as Error).message.slice(0, 200),
              };
            }
          }
        }
      }

      // Per-provider field wipes. Both wipe the most-sensitive secret
      // (Shopify access token / Woo consumer secret) so a disconnected
      // row can't be replayed if the DB is later leaked.
      const credentialWipe: Record<string, undefined> =
        existing.provider === "shopify"
          ? { "credentials.accessToken": undefined }
          : existing.provider === "woocommerce"
            ? { "credentials.consumerSecret": undefined }
            : {};

      const integration = await Integration.findOneAndUpdate(
        { _id: new Types.ObjectId(input.id), merchantId },
        {
          $set: {
            status: "disconnected",
            disconnectedAt: new Date(),
            "webhookStatus.registered": false,
            // Clear the per-topic subscription IDs — they're meaningless
            // once we've asked the platform to delete them, and a stale
            // ID might confuse a future reconnect attempt.
            "webhookStatus.subscriptions": [],
            ...credentialWipe,
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
        meta: {
          provider: integration.provider,
          remoteRevoke,
        },
      });
      return {
        id: String(integration._id),
        disconnected: true,
        // Echoed back so the web client can flag a stranded
        // remote-side install in a follow-up toast if the revoke
        // wasn't acknowledged. Pure UX hint — local state is already
        // correct.
        remoteRevoked:
          remoteRevoke === null ? null : remoteRevoke.ok === true,
      };
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
          // `FAILED_PRECONDITION` is a gRPC status name and isn't in
          // tRPC v10's `TRPC_ERROR_CODES_BY_KEY` — TS rejected it and
          // tRPC was silently mapping it to 500. `PRECONDITION_FAILED`
          // is the canonical v10 name (HTTP 412) and preserves the
          // original intent: "the merchant's stored state isn't ready
          // for this action — reconnect first." Merchant-facing
          // message string unchanged; only the HTTP status corrects.
          code: "PRECONDITION_FAILED",
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
      // The `subscriptions` field on `webhookStatus` is required by
      // the Mongoose schema (added when Woo's symmetric disconnect
      // started persisting per-topic IDs). Shopify doesn't use it,
      // but the type still demands it. Cast preserves the existing
      // empty/missing value rather than fabricating a default —
      // matches the pattern in `retryWooWebhooks` below.
      integration.webhookStatus = {
        registered: reg.registered.length > 0,
        lastEventAt: integration.webhookStatus?.lastEventAt,
        failures: integration.webhookStatus?.failures ?? 0,
        lastError:
          reg.errors.length > 0 ? reg.errors.join("; ").slice(0, 500) : undefined,
      } as typeof integration.webhookStatus;
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

  /**
   * Retry WooCommerce webhook auto-registration on a connected
   * integration. Mirror of retryShopifyWebhooks — surfaced as a
   * "Retry webhooks" button when the initial registration partially
   * failed (e.g. WC was rate-limiting, the merchant's hosting
   * provider was slow, the wp-cron worker was paused).
   *
   * Idempotent — the helper's list-then-skip pass dedups, so a
   * successful first call won't pile up duplicate subscriptions on
   * the merchant's WP admin.
   */
  retryWooWebhooks: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const integration = await Integration.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
        provider: "woocommerce",
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
      const credsBlob = integration.credentials as Record<string, string | undefined> | undefined;
      const consumerKeyEnc = credsBlob?.consumerKey;
      const consumerSecretEnc = credsBlob?.consumerSecret;
      const webhookSecretEnc = integration.webhookSecret;
      if (!consumerKeyEnc || !consumerSecretEnc || !webhookSecretEnc) {
        throw new TRPCError({
          // See note in `retryShopifyWebhooks`: tRPC v10 uses
          // `PRECONDITION_FAILED`, not the gRPC-style `FAILED_PRECONDITION`.
          code: "PRECONDITION_FAILED",
          message:
            "Stored credentials are incomplete — disconnect and reconnect.",
        });
      }
      let consumerKey: string;
      let consumerSecret: string;
      let webhookSecret: string;
      try {
        consumerKey = decryptSecret(consumerKeyEnc);
        consumerSecret = decryptSecret(consumerSecretEnc);
        webhookSecret = decryptSecret(webhookSecretEnc);
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not read stored credentials. Disconnect and reconnect.",
        });
      }
      // Reuse the stored auth strategy (if any) so the retry call
      // doesn't re-probe Basic on a host where we already learned
      // querystring works.
      const storedStrategy =
        credsBlob?.authStrategy === "basic" ||
        credsBlob?.authStrategy === "querystring"
          ? credsBlob.authStrategy
          : undefined;
      const callbackUrl = `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/integrations/webhook/woocommerce/${String(integration._id)}`;
      const reg = await registerWooWebhooks({
        siteUrl: integration.accountKey,
        consumerKey,
        consumerSecret,
        callbackUrl,
        webhookSecret,
        authStrategy: storedStrategy,
      });
      const allRegistered = reg.errors.length === 0;
      integration.webhookStatus = {
        registered: reg.registered.length > 0,
        lastEventAt: integration.webhookStatus?.lastEventAt,
        failures: integration.webhookStatus?.failures ?? 0,
        lastError:
          reg.errors.length > 0 ? reg.errors.join("; ").slice(0, 500) : undefined,
        // Persist the fresh subscription IDs so a future disconnect
        // can DELETE them by id rather than re-listing.
        subscriptions: reg.registered,
      } as typeof integration.webhookStatus;
      // If the retry resolved a fresh strategy (e.g. the row
      // pre-dates Phase 2 and never had one persisted), commit it now.
      if (
        reg.authStrategy &&
        credsBlob &&
        credsBlob.authStrategy !== reg.authStrategy
      ) {
        (integration.credentials as Record<string, unknown>).authStrategy =
          reg.authStrategy;
        integration.markModified("credentials");
      }
      await integration.save();
      void writeAudit({
        merchantId,
        actorId: merchantId,
        action: "integration.woo_webhooks_retried",
        subjectType: "integration",
        subjectId: integration._id,
        meta: {
          registered: reg.registered.map((s) => s.topic),
          errors: reg.errors,
          allRegistered,
        },
      });
      return {
        ok: allRegistered,
        registered: reg.registered.map((s) => s.topic),
        errors: reg.errors,
      };
    }),

  /** Recent webhook deliveries — surfaces the merchant's debug pane. */
  recentWebhooks: protectedProcedure
    .input(
      z
        .object({
          integrationId: z.string().optional(),
          /**
           * Optional status filter. Drives the Health card's
           * `NeedsAttentionSummary` banner (only fetches needs_attention
           * rows) and lets the inspect dialog pre-filter by lifecycle
           * state without a follow-up roundtrip. Backwards-compat:
           * undefined behaves exactly like the old query.
           */
          status: z
            .enum([
              "received",
              "processing",
              "succeeded",
              "failed",
              "needs_attention",
            ])
            .optional(),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .default({ limit: 20 }),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const filter: Record<string, unknown> = { merchantId };
      if (input.integrationId && Types.ObjectId.isValid(input.integrationId)) {
        filter.integrationId = new Types.ObjectId(input.integrationId);
      }
      if (input.status) {
        filter.status = input.status;
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
        // `skipReason` populated only on `needs_attention` rows; null
        // for everything else. Surfaces the adapter's classification
        // (missing_phone, missing_external_id, …) so the dashboard can
        // render a translated label instead of the raw enum value.
        skipReason: r.skipReason ?? null,
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

  /**
   * Manual "Sync now" trigger from the dashboard. Thin wrapper around
   * the auto-sync worker's per-integration entry point — same code
   * path the scheduled tick uses, so dedup, cursor advancement, and
   * the observability writes all behave identically. Merchant-scoped:
   * a stranger calling this against another tenant's integration 404s.
   */
  syncNow: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const integration = await Integration.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      })
        .select("_id status provider")
        .lean();
      if (!integration) {
        throw new TRPCError({ code: "NOT_FOUND", message: "integration not found" });
      }
      if (integration.status !== "connected") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Integration must be connected before sync.",
        });
      }
      const result = await syncOneIntegration(
        integration._id as Types.ObjectId,
      );
      return {
        ok: result.failed === 0,
        enqueued: result.enqueued,
        duplicates: result.duplicates,
        failed: result.failed,
      };
    }),

  /**
   * Manual "Retry failed" trigger from the dashboard. Replays this
   * integration's failed inbox rows (capped at 20 per call) through
   * the same `replayWebhookInbox` path the retry sweep + alert worker
   * already use. Successful replays produce real Order documents and
   * reset the integration's `errorCount` via the shared ingest path.
   */
  retryFailed: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const integration = await Integration.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      })
        .select("_id")
        .lean();
      if (!integration) {
        throw new TRPCError({ code: "NOT_FOUND", message: "integration not found" });
      }
      const due = await WebhookInbox.find({
        integrationId: integration._id,
        merchantId,
        status: "failed",
        attempts: { $lt: WEBHOOK_RETRY_MAX_ATTEMPTS },
      })
        .sort({ receivedAt: 1 })
        .limit(20)
        .select("_id")
        .lean();
      let succeeded = 0;
      let failedAgain = 0;
      let deadLettered = 0;
      for (const row of due) {
        const r = await replayWebhookInbox({
          inboxId: row._id as Types.ObjectId,
          actorId: merchantId,
          manual: true,
        });
        if (r.status === "succeeded") succeeded += 1;
        else if (r.status === "dead_lettered") deadLettered += 1;
        else if (r.status === "failed") failedAgain += 1;
      }
      return {
        ok: succeeded > 0 || due.length === 0,
        attempted: due.length,
        succeeded,
        failedAgain,
        deadLettered,
      };
    }),

  /**
   * Health snapshot for one integration. Drives the dashboard's
   * "is sync working?" panel. Returns the merchant-facing observability
   * fields plus derived alert flags from `evaluateIntegrationHealth`.
   *
   * Read-only and cheap — single Mongo lookup, scoped to the merchant
   * so attempting to read another tenant's integration 404s.
   */
  getHealth: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const row = await Integration.findOne({
        _id: new Types.ObjectId(input.id),
        merchantId,
      })
        .select(
          "lastWebhookAt lastImportAt lastSyncStatus errorCount lastError provider status pausedAt pausedReason accountKey",
        )
        .lean();
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "integration not found",
        });
      }
      const snapshot = {
        status: (row.lastSyncStatus ?? "idle") as "ok" | "error" | "idle",
        lastWebhookAt: row.lastWebhookAt ?? null,
        lastImportAt: row.lastImportAt ?? null,
        errorCount: row.errorCount ?? 0,
        lastError: row.lastError ?? null,
      };
      const flags = evaluateIntegrationHealth(snapshot);
      return {
        ...snapshot,
        provider: row.provider,
        integrationStatus: row.status,
        // Pause state — drives the control panel toggle + the
        // "Paused" banner that explains why no events are coming in.
        pausedAt: row.pausedAt ?? null,
        pausedReason: row.pausedReason ?? null,
        accountKey: row.accountKey ?? null,
        flags,
      };
    }),

  /**
   * Manually replay a single webhook from the inbox. Used by the
   * dashboard's "Retry" button on a failed delivery row. Idempotent:
   * succeeded rows short-circuit, fresh failures bump attempts and
   * re-schedule via the same `replayWebhookInbox` path the retry sweep +
   * alert worker use, so manual + automatic share one code path.
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
        return {
          ok: true,
          status: "skipped" as const,
          attempts: inbox.attempts ?? 0,
        };
      }
      const result = await replayWebhookInbox({
        inboxId: inbox._id as Types.ObjectId,
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

  /**
   * Soft-pause an integration. Stops both webhook ingestion and the
   * polling sweep without tearing the upstream connection down. Idempotent
   * — pausing an already-paused row just refreshes the reason. The
   * dashboard surfaces the pause banner so merchants don't lose track of
   * why nothing's coming in.
   */
  pause: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        reason: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const upd = await Integration.findOneAndUpdate(
        { _id: new Types.ObjectId(input.id), merchantId, status: "connected" },
        {
          $set: {
            pausedAt: new Date(),
            pausedReason: input.reason || "Paused by merchant",
            pausedBy: merchantId,
          },
        },
        { new: true },
      );
      if (!upd) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "integration not found or not connected",
        });
      }
      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "merchant",
        action: "integration.paused",
        subjectType: "integration",
        subjectId: upd._id,
        meta: {
          reason: input.reason ?? null,
          provider: upd.provider,
        },
      });
      return {
        ok: true,
        pausedAt: upd.pausedAt,
        pausedReason: upd.pausedReason,
      };
    }),

  /**
   * Resume a paused integration. Idempotent — resuming a non-paused
   * row is a no-op. Does NOT backfill missed deliveries; the merchant
   * is expected to click "Sync now" if they want a catchup.
   */
  resume: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid id" });
      }
      const merchantId = merchantObjectId(ctx);
      const upd = await Integration.findOneAndUpdate(
        { _id: new Types.ObjectId(input.id), merchantId },
        {
          $set: {
            pausedAt: null,
            pausedReason: null,
            pausedBy: null,
          },
        },
        { new: true },
      );
      if (!upd) {
        throw new TRPCError({ code: "NOT_FOUND", message: "integration not found" });
      }
      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "merchant",
        action: "integration.resumed",
        subjectType: "integration",
        subjectId: upd._id,
        meta: { provider: upd.provider },
      });
      return { ok: true };
    }),

  /**
   * Cross-integration list of "stuck" inbox rows for the issues page.
   * Returns needs_attention + dead-lettered failed rows scoped to the
   * merchant, sorted oldest first so the merchant sees the longest-
   * standing problems on top. Respects an optional reason filter so
   * the page can paginate by category.
   */
  listIssues: protectedProcedure
    .input(
      z
        .object({
          /** Filter to a specific failure reason (skipReason). Empty = all. */
          reason: z.string().max(60).optional(),
          /** Filter to a specific integration id (rendered as a sub-tab). */
          integrationId: z.string().optional(),
          limit: z.number().int().min(1).max(200).default(100),
        })
        .default({ limit: 100 }),
    )
    .query(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      // We surface two terminal states to the merchant as "issues":
      //   - needs_attention: adapter rejected the payload (missing phone, etc.)
      //   - failed + attempts >= MAX: dead-lettered after retries
      const baseFilter: Record<string, unknown> = {
        merchantId,
        $or: [
          { status: "needs_attention" },
          { status: "failed", attempts: { $gte: WEBHOOK_RETRY_MAX_ATTEMPTS } },
        ],
      };
      if (input.reason) {
        // Reason matches either the explicit skipReason (needs_attention)
        // or a substring of lastError (dead-lettered). The latter is
        // best-effort — we use $regex with a literal escape to keep
        // arbitrary user input from breaking the query.
        baseFilter.$and = [
          {
            $or: [
              { skipReason: input.reason },
              {
                lastError: {
                  $regex: input.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                  $options: "i",
                },
              },
            ],
          },
        ];
      }
      if (
        input.integrationId &&
        Types.ObjectId.isValid(input.integrationId)
      ) {
        baseFilter.integrationId = new Types.ObjectId(input.integrationId);
      }
      const rows = await WebhookInbox.find(baseFilter)
        .sort({ receivedAt: -1 })
        .limit(input.limit)
        .lean();

      // Summary counts per skipReason — drives the "group by reason"
      // tabs at the top of the issues page. Use a single aggregation
      // so the tab counts always agree with the list view.
      const summary = await WebhookInbox.aggregate([
        { $match: { merchantId, status: "needs_attention" } },
        {
          $group: {
            _id: { $ifNull: ["$skipReason", "unknown"] },
            count: { $sum: 1 },
          },
        },
      ]);
      const reasonsCount = Object.fromEntries(
        summary.map((r: { _id: string; count: number }) => [r._id, r.count]),
      );

      // Pull integration metadata once so we can tag every row with a
      // human label + provider hint. Avoids per-row N+1 lookups in the
      // UI without bloating the response.
      const integrationIds = Array.from(
        new Set(rows.map((r) => String(r.integrationId)).filter(Boolean)),
      );
      const integrations = integrationIds.length
        ? await Integration.find({
            _id: { $in: integrationIds.map((s) => new Types.ObjectId(s)) },
            merchantId,
          })
            .select("_id provider accountKey label")
            .lean()
        : [];
      const integrationById = new Map(
        integrations.map((i) => [String(i._id), i]),
      );

      // Integration-level health issues. The merchant's "Issues" page
      // previously only counted dead-lettered inbox rows, so a broken
      // connection (e.g. Shopify Admin API rejecting the access token,
      // webhook registration failing during install, credential test
      // returning 403) showed "All caught up" while every order import
      // silently 403'd. Roll these up here so the UI can surface them
      // at the top of the list with first-class fix actions.
      //
      // We deliberately exclude integrations the merchant has explicitly
      // paused (`pausedAt` set) or torn down (`status: "disconnected"`).
      // Those are intentional states — surfacing them as "issues" would
      // be noise. We also exclude `pending` rows: those are mid-install
      // and have no health signal yet.
      const healthCandidates = await Integration.find({
        merchantId,
        status: { $in: ["connected", "error"] },
        pausedAt: { $in: [null, undefined] },
        ...(input.integrationId &&
        Types.ObjectId.isValid(input.integrationId)
          ? { _id: new Types.ObjectId(input.integrationId) }
          : {}),
      })
        .select(
          "_id provider accountKey label status health webhookStatus lastError lastSyncStatus errorCount degraded lastWebhookAt lastImportAt connectedAt counts",
        )
        .lean();

      type IntegrationIssueKind =
        | "credentials_failing"
        | "webhook_not_registered"
        | "sync_failing"
        | "degraded"
        | "no_imports_yet";

      const integrationIssues: Array<{
        integrationId: string;
        provider: string;
        providerLabel: string | null;
        providerAccountKey: string | null;
        kind: IntegrationIssueKind;
        severity: "critical" | "warning";
        message: string;
        detail: string | null;
        lastCheckedAt: Date | null;
      }> = [];

      const NO_IMPORT_GRACE_MS = 24 * 60 * 60 * 1000; // 24h
      const nowMs = Date.now();

      for (const it of healthCandidates) {
        const providerLabel = it.label ?? null;
        const providerAccountKey = it.accountKey ?? null;
        const base = {
          integrationId: String(it._id),
          provider: it.provider,
          providerLabel,
          providerAccountKey,
        };

        // 1. Hard credential failure — the most important issue to
        //    surface, because every downstream sync/webhook will fail
        //    until the merchant reconnects or rotates the token.
        const healthOk = it.health?.ok ?? true;
        if (!healthOk || it.status === "error") {
          integrationIssues.push({
            ...base,
            kind: "credentials_failing",
            severity: "critical",
            message:
              "Connection isn't authenticating with " +
              (it.provider === "shopify"
                ? "Shopify"
                : it.provider === "woocommerce"
                  ? "WooCommerce"
                  : it.provider) +
              ".",
            detail:
              it.health?.lastError ??
              it.lastError ??
              "Reconnect the integration to mint a fresh access token.",
            lastCheckedAt: it.health?.lastCheckedAt ?? null,
          });
          continue;
        }

        // 2. The system flipped this row to "stop trying recovery" after
        //    repeated alert-worker retries. Treat it as a critical issue
        //    even if `health.ok` hasn't been refreshed.
        if (it.degraded) {
          integrationIssues.push({
            ...base,
            kind: "degraded",
            severity: "critical",
            message: "Connection is degraded — automated recovery gave up.",
            detail:
              it.lastError ??
              "Reconnect from the integrations page to restore service.",
            lastCheckedAt: it.health?.lastCheckedAt ?? null,
          });
          continue;
        }

        // 3. Connected but no webhook subscriptions on the upstream.
        //    The merchant won't receive real-time order events; new
        //    orders will only land via polling fallback (slow / partial).
        const webhookRegistered = it.webhookStatus?.registered ?? false;
        if (!webhookRegistered) {
          integrationIssues.push({
            ...base,
            kind: "webhook_not_registered",
            severity: "critical",
            message: "Real-time order updates aren't subscribed.",
            detail:
              it.webhookStatus?.lastError ??
              "We couldn't register webhooks during install. Reconnect to retry.",
            lastCheckedAt: it.health?.lastCheckedAt ?? null,
          });
          continue;
        }

        // 4. Recent sync failed (lastSyncStatus === "error") even though
        //    creds + webhooks are still good. Usually a transient
        //    upstream outage; surface as a warning so the merchant
        //    knows the latest poll didn't land.
        if (it.lastSyncStatus === "error") {
          integrationIssues.push({
            ...base,
            kind: "sync_failing",
            severity: "warning",
            message: "Latest sync didn't complete.",
            detail:
              it.lastError ??
              "Try the Sync now button on the integration card.",
            lastCheckedAt: it.health?.lastCheckedAt ?? null,
          });
          continue;
        }

        // 5. Connected for >24h but no orders ever imported. Could be
        //    a quiet store, but also catches the "credentials valid,
        //    webhook subscribed, but the install never minted a working
        //    polling cursor" failure mode that's otherwise invisible.
        const ordersImported =
          (it as { counts?: { ordersImported?: number } }).counts?.ordersImported ?? 0;
        const connectedAtMs = it.connectedAt
          ? new Date(it.connectedAt as Date).getTime()
          : null;
        if (
          ordersImported === 0 &&
          !it.lastWebhookAt &&
          !it.lastImportAt &&
          connectedAtMs !== null &&
          nowMs - connectedAtMs > NO_IMPORT_GRACE_MS
        ) {
          integrationIssues.push({
            ...base,
            kind: "no_imports_yet",
            severity: "warning",
            message: "No orders have imported since you connected.",
            detail:
              "If your store has had orders, try Sync now or place a test order to verify the pipeline.",
            lastCheckedAt: it.health?.lastCheckedAt ?? null,
          });
          continue;
        }
      }

      const integrationIssuesCount = integrationIssues.length;

      return {
        rows: rows.map((r) => {
          const meta = integrationById.get(String(r.integrationId));
          return {
            id: String(r._id),
            integrationId: r.integrationId
              ? String(r.integrationId)
              : null,
            provider: r.provider,
            providerLabel: meta?.label ?? null,
            providerAccountKey: meta?.accountKey ?? null,
            topic: r.topic,
            externalId: r.externalId,
            status: r.status,
            attempts: r.attempts,
            skipReason: r.skipReason ?? null,
            lastError: r.lastError ?? null,
            receivedAt: r.receivedAt,
            processedAt: r.processedAt ?? null,
          };
        }),
        reasonsCount,
        total: rows.length,
        integrationIssues,
        integrationIssuesCount,
      };
    }),

  /**
   * Bulk replay all currently-stuck rows for a merchant (or filtered
   * subset). Capped at 50 per call to keep a single click from
   * starving the worker pool. Returns counters so the dashboard can
   * tell the merchant "5 fixed, 3 still need attention".
   */
  bulkReplayIssues: protectedProcedure
    .input(
      z.object({
        ids: z.array(z.string().min(1)).max(50).optional(),
        integrationId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const filter: Record<string, unknown> = {
        merchantId,
        $or: [
          { status: "needs_attention" },
          { status: "failed", attempts: { $gte: WEBHOOK_RETRY_MAX_ATTEMPTS } },
        ],
      };
      if (input.ids && input.ids.length > 0) {
        filter._id = {
          $in: input.ids
            .filter((s) => Types.ObjectId.isValid(s))
            .map((s) => new Types.ObjectId(s)),
        };
      } else if (
        input.integrationId &&
        Types.ObjectId.isValid(input.integrationId)
      ) {
        filter.integrationId = new Types.ObjectId(input.integrationId);
      }
      const due = await WebhookInbox.find(filter)
        .sort({ receivedAt: 1 })
        .limit(50)
        .select("_id")
        .lean();
      let succeeded = 0;
      let stillStuck = 0;
      let deadLettered = 0;
      for (const row of due) {
        const r = await replayWebhookInbox({
          inboxId: row._id as Types.ObjectId,
          actorId: merchantId,
          manual: true,
        });
        if (r.status === "succeeded") succeeded += 1;
        else if (r.status === "dead_lettered") deadLettered += 1;
        else stillStuck += 1;
      }
      return {
        ok: true,
        attempted: due.length,
        succeeded,
        stillStuck,
        deadLettered,
      };
    }),

  /**
   * Cross-merchant system status snapshot. Aggregates inbox + integration
   * counters for the merchant into a single payload that drives the
   * "System status" widget. One query each for inbox aggregations and
   * integration counts — keeps the page render to two round-trips total.
   *
   * Read-only and safe to poll (the dashboard's transparency panel
   * does so every 30s by default).
   */
  systemStatus: protectedProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    // Single $facet aggregation — keeps the work in Mongo and avoids
    // shipping every row back. Each branch gates on a partial index
    // we already maintain for the worker sweeps so it's effectively
    // free.
    const inboxFacet = await WebhookInbox.aggregate([
      { $match: { merchantId } },
      {
        $facet: {
          lastWebhook: [
            { $sort: { receivedAt: -1 } },
            { $limit: 1 },
            { $project: { receivedAt: 1, provider: 1 } },
          ],
          lastSuccess: [
            { $match: { status: "succeeded" } },
            { $sort: { processedAt: -1 } },
            { $limit: 1 },
            { $project: { processedAt: 1, provider: 1 } },
          ],
          counts: [
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
              },
            },
          ],
          retryQueue: [
            {
              $match: {
                status: "failed",
                nextRetryAt: { $gt: new Date() },
                attempts: { $lt: WEBHOOK_RETRY_MAX_ATTEMPTS },
              },
            },
            { $count: "n" },
          ],
          deadLettered: [
            {
              $match: {
                status: "failed",
                attempts: { $gte: WEBHOOK_RETRY_MAX_ATTEMPTS },
              },
            },
            { $count: "n" },
          ],
        },
      },
    ]);
    const facet = inboxFacet[0] ?? {};
    type InboxCount = { _id: string; count: number };
    type Bare = { n?: number };
    const counts = (facet.counts as InboxCount[] | undefined) ?? [];
    const countByStatus = Object.fromEntries(
      counts.map((c) => [c._id, c.count]),
    );

    // Integration roster — counts and the most-recently-active row
    // give the merchant a one-line "X of Y connected, Z paused".
    const integrationCounts = await Integration.aggregate([
      { $match: { merchantId } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          connected: {
            $sum: { $cond: [{ $eq: ["$status", "connected"] }, 1, 0] },
          },
          paused: {
            $sum: { $cond: [{ $ifNull: ["$pausedAt", false] }, 1, 0] },
          },
          disconnected: {
            $sum: { $cond: [{ $eq: ["$status", "disconnected"] }, 1, 0] },
          },
        },
      },
    ]);
    const intStats = integrationCounts[0] ?? {
      total: 0,
      connected: 0,
      paused: 0,
      disconnected: 0,
    };

    return {
      lastWebhookReceivedAt:
        (facet.lastWebhook as Array<{ receivedAt: Date }> | undefined)?.[0]
          ?.receivedAt ?? null,
      lastSuccessfulImportAt:
        (facet.lastSuccess as Array<{ processedAt: Date }> | undefined)?.[0]
          ?.processedAt ?? null,
      queue: {
        received: countByStatus.received ?? 0,
        processing: countByStatus.processing ?? 0,
        succeeded: countByStatus.succeeded ?? 0,
        failed: countByStatus.failed ?? 0,
        needsAttention: countByStatus.needs_attention ?? 0,
      },
      retry: {
        scheduled:
          (facet.retryQueue as Bare[] | undefined)?.[0]?.n ?? 0,
        deadLettered:
          (facet.deadLettered as Bare[] | undefined)?.[0]?.n ?? 0,
      },
      integrations: {
        total: intStats.total ?? 0,
        connected: intStats.connected ?? 0,
        paused: intStats.paused ?? 0,
        disconnected: intStats.disconnected ?? 0,
      },
    };
  }),

  /**
   * "Mark resolved" — the merchant has decided this row doesn't need
   * to ingest. Maybe the upstream order was cancelled, maybe it was a
   * test. We flip the status to `succeeded` with a sentinel
   * `lastError: "resolved by merchant"` so the audit trail stays
   * clean. Idempotent on re-call.
   */
  resolveIssues: protectedProcedure
    .input(
      z.object({
        ids: z.array(z.string().min(1)).min(1).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const oids = input.ids
        .filter((s) => Types.ObjectId.isValid(s))
        .map((s) => new Types.ObjectId(s));
      if (oids.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "no valid ids" });
      }
      // Only flip rows the merchant actually owns AND that are
      // currently stuck — never overwrite a succeeded or in-flight
      // row. Keeping the original skipReason gives the audit pane
      // historical context after the resolve.
      const res = await WebhookInbox.updateMany(
        {
          _id: { $in: oids },
          merchantId,
          $or: [
            { status: "needs_attention" },
            { status: "failed" },
          ],
        },
        {
          $set: {
            status: "succeeded",
            processedAt: new Date(),
            lastError: "resolved by merchant",
            nextRetryAt: null,
          },
        },
      );
      // Audit a single batch entry rather than one per row — keeps
      // the audit log readable for merchants who clear hundreds.
      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "merchant",
        action: "integration.issues_resolved",
        subjectType: "integration",
        subjectId: oids[0]!,
        meta: {
          requested: input.ids.length,
          modified: res.modifiedCount ?? 0,
        },
      });
      return { ok: true, resolved: res.modifiedCount ?? 0 };
    }),

  /**
   * Finalize a public-install Shopify connection.
   *
   * Pre-condition: the visitor hit /api/shopify/install, completed
   * Shopify's OAuth approval screen, and our callback (shopifyOauthRouter)
   * exchanged the code for an access token, stashed
   * { shop, accessToken, scopes } in Redis under
   * shopify:install:claim:<token>, and bounced them to
   * /install/shopify/complete?token=<token>&shop=... on the web app.
   *
   * The web app gets them through sign-up / sign-in (or recognises an
   * existing session), then calls THIS mutation with the claim token.
   *
   * What this mutation does:
   *   1. Reads & deletes the claim from Redis (single-use token).
   *   2. Refuses to clobber another already-connected Shopify store on the
   *      same merchant (same one-shop-only rule the regular connect
   *      mutation enforces).
   *   3. Upserts the Integration row with the access token, marks
   *      connected, and writes the audit log entry the public install
   *      endpoint deliberately deferred (it had no merchantId yet).
   *
   * Errors are mapped to short codes the web claim page can humanise:
   *   - claim_not_found_or_expired (15-min TTL elapsed, or already used).
   *   - claim_storage_unavailable (Redis is sick).
   *   - another_shop_already_connected:<existing> (merchant already has
   *     a different .myshopify.com connected).
   */
  completeShopifyInstall: billableProcedure
    .input(z.object({ token: z.string().min(8).max(256) }))
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);

      const { getRedis } = await import("../../lib/redis.js");
      const { SHOPIFY_INSTALL_CLAIM_REDIS_PREFIX } = await import(
        "../webhooks/integrations.js"
      );

      let redis;
      try {
        redis = getRedis();
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "claim_storage_unavailable",
        });
      }

      const key = `${SHOPIFY_INSTALL_CLAIM_REDIS_PREFIX}${input.token}`;
      let raw: string | null;
      try {
        raw = await redis.get(key);
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "claim_storage_unavailable",
        });
      }
      if (!raw) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "claim_not_found_or_expired",
        });
      }
      try {
        await redis.del(key);
      } catch {
        // non-fatal: TTL will reap it
      }

      type Claim = {
        shop: string;
        accessToken: string;
        scopes: string[];
        installedFrom: string;
        createdAt: number;
        // Modern Token Access framework: Shopify ships an `expires_in` +
        // `refresh_token` alongside the access token. The OAuth callback
        // stashes both into the Redis claim; we MUST round-trip them
        // into the Integration row here, otherwise the rotation helper
        // has nothing to refresh against and the merchant's token dies
        // after 24h with no recovery.
        expiresIn?: number;
        refreshToken?: string;
      };
      let claim: Claim;
      try {
        claim = JSON.parse(raw) as Claim;
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "claim_corrupt",
        });
      }
      const shop = claim.shop.toLowerCase().trim();
      if (
        !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ||
        !claim.accessToken
      ) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "claim_corrupt",
        });
      }

      const tier: PlanTier =
        ((ctx.subscription as unknown as SubscriptionSnapshot | undefined)?.tier as PlanTier) ??
        "starter";
      assertIntegrationProvider(tier, "shopify");
      await assertIntegrationCapacity(merchantId, tier, "shopify");

      const conflicting = await Integration.findOne({
        merchantId,
        provider: "shopify",
        status: { $in: ["connected", "pending"] },
        accountKey: { $ne: shop },
      })
        .select("accountKey status")
        .lean();
      if (conflicting) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `another_shop_already_connected:${conflicting.accountKey}`,
        });
      }

      const now = new Date();
      // Persist refreshToken (encrypted) + accessTokenExpiresAt so the
      // commerce-import worker's ensureFreshShopifyAccessToken call can
      // rotate the access token before each Admin API call. Without
      // this round-trip, modern Shopify installs lose the refresh
      // token at claim time and degrade to legacy non-expiring
      // behaviour after 24h — which Shopify now rejects with a 403 on
      // every Admin endpoint.
      const credentialsPayload: Record<string, string | Date> = {
        apiKey: encryptSecret(env.SHOPIFY_APP_API_KEY ?? ""),
        apiSecret: encryptSecret(env.SHOPIFY_APP_API_SECRET ?? ""),
        siteUrl: shop,
        accessToken: encryptSecret(claim.accessToken),
      };
      if (typeof claim.refreshToken === "string" && claim.refreshToken) {
        credentialsPayload.refreshToken = encryptSecret(claim.refreshToken);
      }
      if (typeof claim.expiresIn === "number") {
        credentialsPayload.accessTokenExpiresAt = new Date(
          Date.now() + claim.expiresIn * 1000,
        );
      }

      const integration = await Integration.findOneAndUpdate(
        { merchantId, provider: "shopify", accountKey: shop },
        {
          $set: {
            label: `Shopify · ${shop}`,
            status: "connected",
            credentials: credentialsPayload,
            permissions: claim.scopes,
            connectedAt: now,
            disconnectedAt: null,
            health: { ok: true, lastCheckedAt: now },
          },
          $setOnInsert: {
            merchantId,
            provider: "shopify",
            accountKey: shop,
            createdAt: now,
          },
        },
        { upsert: true, new: true },
      );

      void writeAudit({
        merchantId,
        actorId: merchantId,
        actorType: "merchant",
        action: "integration.shopify_oauth",
        subjectType: "integration",
        subjectId: integration._id,
        meta: {
          ok: true,
          shop,
          installedFrom: claim.installedFrom,
          scopes: claim.scopes,
        },
      });

      return {
        ok: true as const,
        integrationId: String(integration._id),
        shop,
      };
    }),
});

export const ALL_INTEGRATION_PROVIDERS = INTEGRATION_PROVIDERS;
