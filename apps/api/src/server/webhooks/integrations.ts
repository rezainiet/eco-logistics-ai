import express, { type Request, type Response } from "express";
import { Types } from "mongoose";
import { Integration, type IntegrationProvider } from "@ecom/db";
import { adapterFor, hasAdapter } from "../../lib/integrations/index.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { enqueueInboundWebhook } from "../ingest.js";
import { QUEUE_NAMES, safeEnqueue } from "../../lib/queue.js";
import {
  diffShopifyScopes,
  exchangeShopifyCode,
  fetchShopifyShopInfo,
  registerShopifyWebhooks,
  verifyShopifyOAuthHmac,
} from "../../lib/integrations/shopify.js";
import { writeAudit } from "../../lib/audit.js";
import { safeStringEqual } from "../../lib/crypto.js";
import { env } from "../../env.js";

/**
 * Maximum age (ms) of an inbound webhook before we reject it as stale. The
 * inbox unique index already collapses replays into idempotent no-ops, but
 * the freshness gate stops a captured payload from being weaponised hours or
 * days later — pairs with the TTL on `WebhookInbox.expiresAt`.
 */
const WEBHOOK_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;
/** Allow a small clock-skew tolerance for upstream timestamps in the future. */
const WEBHOOK_FUTURE_SKEW_MS = 60 * 1000;

function readUpstreamTimestamp(headers: Record<string, unknown>): Date | null {
  // Shopify ships ISO8601 in `x-shopify-triggered-at`. Custom-API senders use
  // `x-event-timestamp` (epoch seconds OR ISO). Woo doesn't send a timestamp
  // header, so callers without one fall through and skip the freshness check.
  const candidates = [
    "x-shopify-triggered-at",
    "x-event-timestamp",
    "x-timestamp",
  ];
  for (const key of candidates) {
    const v = headers[key];
    const raw = Array.isArray(v) ? v[0] : v;
    if (typeof raw !== "string" || !raw) continue;
    // Numeric epoch — accept seconds OR milliseconds.
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      const ms = n < 1e12 ? n * 1000 : n;
      const d = new Date(ms);
      if (!isNaN(d.getTime())) return d;
      continue;
    }
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Inbound webhook receiver for commerce platforms. Mounted at
 * `/api/integrations/webhook/:provider/:integrationId` so each connector has
 * its own URL — that lets us look up the merchant + secret without trusting
 * any header sent by the upstream.
 *
 * Express's default JSON parser is replaced with `express.raw` here because
 * Shopify and Woo HMAC the *raw bytes* — re-stringifying parsed JSON would
 * change whitespace and break verification.
 */
export const integrationsWebhookRouter = express.Router();

integrationsWebhookRouter.post(
  "/:provider/:integrationId",
  express.raw({ type: "*/*", limit: "2mb" }),
  async (req: Request, res: Response) => {
    const { provider, integrationId } = req.params;
    if (!provider || !integrationId) {
      return res.status(400).json({ ok: false, error: "missing route params" });
    }
    if (!Types.ObjectId.isValid(integrationId)) {
      return res.status(400).json({ ok: false, error: "invalid integration id" });
    }
    if (!hasAdapter(provider as IntegrationProvider)) {
      return res.status(400).json({ ok: false, error: "unknown provider" });
    }

    const integration = await Integration.findById(integrationId).lean();
    if (!integration) {
      return res.status(404).json({ ok: false, error: "integration not found" });
    }
    if (String(integration.provider) !== provider) {
      return res.status(400).json({ ok: false, error: "provider mismatch" });
    }
    if (integration.status !== "connected") {
      return res.status(409).json({ ok: false, error: "integration not connected" });
    }

    const adapter = adapterFor(provider as IntegrationProvider);
    const rawBody = req.body as Buffer;
    if (!Buffer.isBuffer(rawBody)) {
      // Defence-in-depth: if a future middleware change ever lets the global
      // JSON parser run first, HMAC verification becomes mathematically
      // impossible. Fail loudly rather than silently 401 every delivery.
      console.error(
        "[webhook] expected Buffer body — middleware ordering regressed",
      );
      return res.status(500).json({ ok: false, error: "raw body unavailable" });
    }
    const rawString = rawBody.toString("utf8");

    // HMAC key resolution differs by platform:
    //   - Shopify signs every webhook with the app's `client_secret`
    //     (== our stored `credentials.apiSecret`). The platform doesn't know
    //     about any secret we mint locally.
    //   - WooCommerce, custom_api: we configure the secret on their side
    //     during connect, so `integration.webhookSecret` is the source of
    //     truth.
    let secret: string | undefined;
    try {
      if (provider === "shopify") {
        const stored = (integration.credentials as Record<string, string | undefined> | undefined)
          ?.apiSecret;
        secret = stored ? decryptSecret(stored) : undefined;
      } else {
        secret = integration.webhookSecret
          ? decryptSecret(integration.webhookSecret)
          : undefined;
      }
    } catch {
      secret = undefined;
    }

    const valid = adapter.verifyWebhookSignature({
      rawBody: rawString,
      headers: req.headers,
      secret,
    });
    if (!valid) {
      await Integration.updateOne(
        { _id: integration._id },
        {
          $inc: { "webhookStatus.failures": 1 },
          $set: { "webhookStatus.lastError": "signature mismatch" },
        },
      );
      return res.status(401).json({ ok: false, error: "invalid signature" });
    }

    // Freshness gate — reject replays of captured payloads. Only enforced
    // when the upstream sends a verifiable timestamp; absence means the
    // platform doesn't ship one (Woo) and we must accept the delivery.
    const upstreamAt = readUpstreamTimestamp(
      req.headers as Record<string, unknown>,
    );
    if (upstreamAt) {
      const skew = Date.now() - upstreamAt.getTime();
      if (skew > WEBHOOK_FRESHNESS_WINDOW_MS) {
        return res
          .status(400)
          .json({ ok: false, error: "stale webhook (outside 5m window)" });
      }
      if (skew < -WEBHOOK_FUTURE_SKEW_MS) {
        return res
          .status(400)
          .json({ ok: false, error: "future-dated webhook" });
      }
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawString);
    } catch {
      return res.status(400).json({ ok: false, error: "invalid json" });
    }

    const topic =
      (req.headers["x-shopify-topic"] as string | undefined) ||
      (req.headers["x-wc-webhook-topic"] as string | undefined) ||
      (req.headers["x-event-topic"] as string | undefined) ||
      "order.created";

    const externalId =
      (req.headers["x-shopify-webhook-id"] as string | undefined) ||
      (req.headers["x-wc-webhook-delivery-id"] as string | undefined) ||
      (req.headers["x-ecom-event-id"] as string | undefined) ||
      (() => {
        const p = payload as { id?: number | string; externalId?: string };
        return p?.externalId ? String(p.externalId) : p?.id ? String(p.id) : "";
      })();

    if (!externalId) {
      return res.status(400).json({ ok: false, error: "missing external id" });
    }

    // Stamp the inbox row in `received` state. The unique index collapses
    // duplicate deliveries into a no-op so we can ACK immediately without
    // ever touching the ingestion pipeline twice.
    let stamped;
    try {
      stamped = await enqueueInboundWebhook({
        merchantId: integration.merchantId as Types.ObjectId,
        integrationId: integration._id as Types.ObjectId,
        provider,
        topic,
        externalId,
        rawPayload: payload,
        payloadBytes: rawBody.byteLength,
      });
    } catch (err) {
      console.error(
        "[webhook] inbox stamp failed",
        (err as Error).message,
      );
      // 5xx so the upstream retries — we never lost the event.
      return res.status(500).json({ ok: false, error: "inbox unavailable" });
    }

    // Bookkeeping that doesn't gate the ACK — fire-and-forget.
    void Integration.updateOne(
      { _id: integration._id },
      { $set: { "webhookStatus.lastEventAt": new Date() } },
    ).catch((e) =>
      console.error("[webhook] integration touch failed", (e as Error).message),
    );

    if (stamped.duplicate) {
      // Already processed (or in-flight). Echo the prior order id when known.
      return res.status(202).json({
        ok: true,
        duplicate: true,
        orderId: stamped.resolvedOrderId ?? null,
      });
    }

    // Hand off to the worker. `safeEnqueue` never throws — on Redis outage
    // it returns ok:false and notifies the merchant, but the inbox row is
    // already on disk so the next sweep will still pick it up.
    void safeEnqueue(
      QUEUE_NAMES.webhookProcess,
      "webhook-process:ingest",
      { inboxId: String(stamped.inboxId) },
      {
        // Job-level retries are off — the inbox row owns the canonical
        // backoff schedule via `nextRetryAt`.
        attempts: 1,
      },
      {
        merchantId: String(integration.merchantId),
        description: `${provider} webhook ingest`,
      },
    );

    return res.status(202).json({ ok: true, queued: true });
  },
);

/**
 * Shopify OAuth callback — completes the install kicked off by
 * `integrations.connect({ provider: "shopify" })`. Shopify redirects the
 * merchant browser here with `?code=…&state=…&shop=…&hmac=…`.
 *
 * We:
 *   1. Validate the `state` matches the nonce we stored at install-start.
 *   2. Validate the HMAC over the query string (proves Shopify sent it).
 *   3. POST `code` + app credentials to Shopify, get a permanent access token.
 *   4. Encrypt + persist the token, mark the integration `connected`.
 *   5. Best-effort fetch shop name/plan to populate the dashboard label.
 *   6. Redirect the merchant back to the dashboard with success/error flag.
 *
 * Failure mode: never leak token/error to the URL bar — redirect with a
 * generic `?error=<code>` and write the detail to the audit log.
 */
export const shopifyOauthRouter = express.Router();

shopifyOauthRouter.get(
  "/oauth/shopify/callback",
  async (req: Request, res: Response) => {
    const dashboard = `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3001"}/dashboard/integrations`;
    const fail = (errorCode: string) =>
      res.redirect(`${dashboard}?error=${encodeURIComponent(errorCode)}`);

    // Shopify can land here with an `error=…` param (most commonly
    // `access_denied` when the merchant clicks "Cancel" on the approval
    // screen, or `invalid_request` when the install URL was malformed).
    // Distinguish those from a genuinely missing `code` so the dashboard
    // can show a friendlier message than "Missing OAuth parameters".
    const errorParam = typeof req.query.error === "string" ? req.query.error : null;
    if (errorParam) {
      // `access_denied` → merchant declined; everything else is mapped to
      // a generic "we couldn't complete the install" so we don't leak
      // upstream error vocab into the merchant UI.
      const code =
        errorParam === "access_denied" ? "user_cancelled" : "shopify_install_rejected";
      return fail(code);
    }

    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const shop = typeof req.query.shop === "string" ? req.query.shop : null;
    if (!code || !state || !shop) return fail("missing_params");

    // Shopify ships shop as `<name>.myshopify.com` in the legacy OAuth flow,
    // but the new "managed install" flow has been observed to sometimes ship
    // just `<name>` (no suffix). Normalize defensively before lookup, but
    // keep the legacy regex check on the *normalized* form so we still
    // reject anything that doesn't shape up to a real myshopify domain.
    const normalizedShop = /\.myshopify\.com$/i.test(shop)
      ? shop.toLowerCase()
      : `${shop.toLowerCase()}.myshopify.com`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(normalizedShop)) {
      console.warn("[shopify-oauth] invalid_shop", { rawShop: shop, normalizedShop });
      return fail("invalid_shop");
    }

    // SECURITY: when a platform-level Shopify app secret is configured
    // (env.SHOPIFY_APP_API_SECRET — the one-click path used by 99% of
    // merchants), verify the OAuth HMAC BEFORE any database work. This
    // closes a small enumeration oracle: without the early gate, an
    // attacker could probe random `state` values and observe the
    // difference between `integration_not_found` (state didn't map to a
    // pending row) and `hmac_mismatch` (it did). With the early gate, an
    // attacker without a valid HMAC can never reach the lookup at all.
    //
    // For per-merchant custom-app installs (Advanced panel; rare path)
    // we don't know the secret until we've found the integration row, so
    // we still do HMAC verification post-lookup further down.
    const platformSecret = env.SHOPIFY_APP_API_SECRET;
    const queryForHmac = req.query as Record<string, string | string[] | undefined>;
    if (platformSecret) {
      if (!verifyShopifyOAuthHmac(queryForHmac, platformSecret)) {
        console.warn("[shopify-oauth] hmac_mismatch (platform-secret check)", {
          rawShop: shop,
          normalizedShop,
        });
        return fail("hmac_mismatch");
      }
    }

    // Look up the pending integration by the install nonce we minted at
    // install-start. Going via the nonce instead of the shop domain dodges
    // a Shopify quirk: stores can have multiple myshopify.com hostnames
    // (a vanity one like `devs-9807.myshopify.com` and a canonical one
    // like `dwykhp-en.myshopify.com`). The merchant types the vanity in
    // our connect modal, we mint the install URL pointing at the vanity,
    // but Shopify rewrites the callback `shop` param to the canonical
    // form. Looking up by accountKey+shop would miss the row; looking up
    // by the install nonce is exact and incidentally tightens CSRF
    // (only the issuer of this nonce gets to redeem it).
    const integration = await Integration.findOne({
      provider: "shopify",
      "credentials.installNonce": state,
      status: "pending",
    });
    if (!integration) {
      console.warn("[shopify-oauth] integration_not_found", {
        rawShop: shop,
        normalizedShop,
        statePresent: !!state,
      });
      return fail("integration_not_found");
    }

    // Belt-and-braces nonce check — protects against the (vanishingly
    // rare) case where two pending integrations collide on the same
    // 16-byte random nonce. Mongo would have returned one arbitrarily;
    // we make sure it really is the one we minted.
    const storedNonce = integration.credentials?.installNonce;
    if (!storedNonce || !safeStringEqual(state, storedNonce)) {
      return fail("state_mismatch");
    }

    // Log how long Shopify took between the install URL we minted and
    // the callback landing here. The single most useful signal for
    // debugging "the install screen hangs forever" — we can tell the
    // difference between Shopify being slow (long elapsed, callback
    // does land) and Shopify never redirecting at all (no callback log
    // line, ever).
    const installStartedAtRaw = integration.credentials?.installStartedAt;
    if (installStartedAtRaw) {
      const elapsedMs = Date.now() - new Date(installStartedAtRaw).getTime();
      console.log("[shopify-oauth] callback received", {
        shop: normalizedShop,
        elapsedMs,
        slow: elapsedMs > 15_000,
      });
    } else {
      console.log("[shopify-oauth] callback received (no installStartedAt)", {
        shop: normalizedShop,
      });
    }

    // If Shopify rewrote the shop to a canonical hostname different from
    // what the merchant typed, persist the canonical form so all
    // subsequent webhooks (which Shopify also sends with the canonical
    // shop) match this row, and so the dashboard surfaces the real shop
    // identifier in the Connections panel.
    if (integration.accountKey !== normalizedShop) {
      console.log("[shopify-oauth] canonicalizing accountKey", {
        from: integration.accountKey,
        to: normalizedShop,
      });

      // GOTCHA: the unique index `(merchantId, provider, accountKey)`
      // will reject our save() with E11000 if a stale row already holds
      // the canonical accountKey for this merchant — typically a row
      // left over from a previous install/uninstall cycle (status:
      // "disconnected"). Without this cleanup, the save throws, the
      // exception falls through unhandled, the merchant sees a hung
      // page, the row stays "pending", and the next click loops here
      // forever. Saw exactly that in the logs:
      //   [shopify-oauth] canonicalizing accountKey { from: 'devs-...',
      //                                               to: 'dwykhp-en...' }
      // …repeated 3+ times, integration never flipped to connected.
      //
      // Safety: ONLY delete rows whose status is "disconnected" — never
      // touch a connected row. If somehow a connected row holds the
      // canonical key (race or manual DB tampering), we'd rather let
      // E11000 happen and surface an error than silently overwrite
      // someone's working integration.
      const orphanCleanup = await Integration.deleteMany({
        merchantId: integration.merchantId,
        provider: "shopify",
        accountKey: normalizedShop,
        status: "disconnected",
        _id: { $ne: integration._id },
      });
      if (orphanCleanup.deletedCount > 0) {
        console.log("[shopify-oauth] cleared stale disconnected orphan(s)", {
          merchantId: String(integration.merchantId),
          canonicalKey: normalizedShop,
          deletedCount: orphanCleanup.deletedCount,
        });
      }
      integration.accountKey = normalizedShop;
    }

    let apiKey: string;
    let apiSecret: string;
    try {
      apiKey = decryptSecret(integration.credentials!.apiKey as string);
      apiSecret = decryptSecret(integration.credentials!.apiSecret as string);
    } catch {
      return fail("credential_decrypt_failed");
    }

    // Custom-app fallback HMAC check — only meaningful when we DIDN'T
    // already verify against the platform secret above (env unset).
    // Skipping on the platform path is safe because we already proved the
    // HMAC is valid for the platform secret, and no merchant can install
    // through a different secret without us knowing about it.
    if (!platformSecret) {
      if (!verifyShopifyOAuthHmac(queryForHmac, apiSecret)) {
        void writeAudit({
          merchantId: integration.merchantId as Types.ObjectId,
          actorId: integration.merchantId as Types.ObjectId,
          actorType: "system",
          action: "integration.shopify_oauth",
          subjectType: "integration",
          subjectId: integration._id,
          meta: { ok: false, reason: "hmac_mismatch", shop },
        });
        return fail("hmac_mismatch");
      }
    }

    let exchange;
    try {
      exchange = await exchangeShopifyCode({
        shopDomain: shop,
        apiKey,
        apiSecret,
        code,
      });
    } catch (err) {
      void writeAudit({
        merchantId: integration.merchantId as Types.ObjectId,
        actorId: integration.merchantId as Types.ObjectId,
        actorType: "system",
        action: "integration.shopify_oauth",
        subjectType: "integration",
        subjectId: integration._id,
        meta: { ok: false, reason: (err as Error).message.slice(0, 200), shop },
      });
      return fail("token_exchange_failed");
    }

    // Smoke-test the freshly-issued token while also fetching the shop
    // name for a friendly label. The discriminated result lets us
    // distinguish a transient blip (network/timeout) from a hard auth
    // failure that means the token isn't actually usable.
    const shopInfo = await fetchShopifyShopInfo({
      shopDomain: normalizedShop,
      accessToken: exchange.accessToken,
    });

    // Detect scope subset — Shopify can grant fewer scopes than we asked
    // for if the merchant approved an outdated scope set, or if the
    // deployed app's [access_scopes].scopes drifted from what the web
    // client requests. Without this gate, the integration lands in
    // `connected` state and the FIRST API call surfaces a 403 days later.
    const scopeDiff = diffShopifyScopes(integration.permissions, exchange.scope);

    // Auto-register webhooks so the merchant doesn't have to copy/paste
    // the URL into the Shopify admin panel. Failures DON'T block the
    // connect (the OAuth itself succeeded — token is valid) but they
    // get surfaced via `?warning=webhooks_not_registered` so the
    // dashboard can show a yellow banner with a Retry button. This keeps
    // the OAuth path fast (no synchronous webhook backoff) while still
    // making sure the merchant knows real-time sync isn't ready yet.
    const callbackUrl = `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/integrations/webhook/shopify/${String(integration._id)}`;
    const reg = await registerShopifyWebhooks({
      shopDomain: normalizedShop,
      accessToken: exchange.accessToken,
      callbackUrl,
    });

    // Compose health from the three signals we just collected. The order
    // matters: auth-level shop-info failure trumps everything else (token
    // is bad, nothing else will work either); scope subset is next (some
    // calls will work, others won't); then webhooks (real-time sync only).
    const now = new Date();
    let healthOk = true;
    let healthError: string | undefined;
    const warnings: string[] = [];
    if (shopInfo.ok === false && shopInfo.kind === "auth") {
      healthOk = false;
      healthError = `Shopify token check failed (${shopInfo.status}): ${shopInfo.detail}`;
      warnings.push("token_unusable");
    } else if (scopeDiff.missing.length > 0) {
      healthOk = false;
      healthError = `Missing Shopify scopes: ${scopeDiff.missing.join(", ")}. Reconnect to grant.`;
      warnings.push("scope_subset_granted");
    } else if (shopInfo.ok === false && shopInfo.kind === "transient") {
      // Transient shop-info failure — token's probably fine, just don't
      // upgrade the label. Health stays ok; merchant can retry from the
      // Test connection button.
      console.warn("[shopify-oauth] shop_info_transient", {
        shop: normalizedShop,
        detail: shopInfo.detail,
      });
    }
    if (reg.errors.length > 0 && reg.registered.length === 0) {
      // ALL webhook subscriptions failed — real-time sync is dead.
      // Distinct from healthOk=false because the token IS usable for
      // polling-mode imports; only the live stream is broken.
      warnings.push("webhooks_not_registered");
    } else if (reg.errors.length > 0) {
      // Partial — some topics registered, some didn't. Still warn so
      // the merchant can decide whether the missing topic matters.
      warnings.push("webhooks_partially_registered");
    }

    integration.credentials = {
      ...(integration.credentials ?? {}),
      accessToken: encryptSecret(exchange.accessToken),
      // Wipe install scratch data — nonce so the code can't be replayed,
      // installStartedAt so a future re-connect's elapsed-time log isn't
      // contaminated by the previous attempt.
      installNonce: undefined,
      installStartedAt: undefined,
      scopes: exchange.scope
        ? exchange.scope.split(",").map((s) => s.trim()).filter(Boolean)
        : integration.credentials?.scopes ?? [],
    } as typeof integration.credentials;
    integration.status = "connected";
    integration.connectedAt = now;
    integration.disconnectedAt = null;
    if (shopInfo.ok) {
      integration.label = `Shopify · ${shopInfo.shop.name}`;
    }
    integration.health = {
      ok: healthOk,
      lastError: healthError,
      lastCheckedAt: now,
    };
    integration.webhookStatus = {
      registered: reg.registered.length > 0,
      lastEventAt: integration.webhookStatus?.lastEventAt,
      failures: integration.webhookStatus?.failures ?? 0,
      lastError:
        reg.errors.length > 0 ? reg.errors.join("; ").slice(0, 500) : undefined,
    };
    try {
      await integration.save();
    } catch (err) {
      // Most likely E11000 from the unique (merchantId, provider,
      // accountKey) index — a stale row holds the canonical accountKey
      // and orphan cleanup above missed it (e.g. status was something
      // other than "disconnected"). Audit + redirect with a friendly
      // error code so the merchant sees something actionable instead
      // of a hung tab.
      console.error("[shopify-oauth] save_failed", {
        shop: normalizedShop,
        accountKey: integration.accountKey,
        error: (err as Error).message,
      });
      void writeAudit({
        merchantId: integration.merchantId as Types.ObjectId,
        actorId: integration.merchantId as Types.ObjectId,
        actorType: "system",
        action: "integration.shopify_oauth",
        subjectType: "integration",
        subjectId: integration._id,
        meta: {
          ok: false,
          reason: "callback_save_failed",
          error: (err as Error).message.slice(0, 200),
          shop: normalizedShop,
        },
      });
      return fail("callback_save_failed");
    }

    void writeAudit({
      merchantId: integration.merchantId as Types.ObjectId,
      actorId: integration.merchantId as Types.ObjectId,
      actorType: "system",
      action: "integration.shopify_oauth",
      subjectType: "integration",
      subjectId: integration._id,
      meta: {
        ok: true,
        shop: normalizedShop,
        shopName: shopInfo.ok ? shopInfo.shop.name : null,
        plan: shopInfo.ok ? shopInfo.shop.planName : null,
        scopesGranted: scopeDiff.granted,
        scopesMissing: scopeDiff.missing,
        webhooksRegistered: reg.registered,
        webhookErrors: reg.errors,
        warnings,
        healthOk,
        shopInfoKind: shopInfo.ok ? "ok" : shopInfo.kind,
      },
    });

    // Build the success-or-warning redirect. `warning=` carries
    // semicolon-joined codes so the web can render the appropriate
    // yellow banner(s) without us hard-coding copy here.
    const params = new URLSearchParams({
      connected: "shopify",
      shop: normalizedShop,
    });
    if (warnings.length > 0) params.set("warning", warnings.join(","));
    return res.redirect(`${dashboard}?${params.toString()}`);
  },
);
