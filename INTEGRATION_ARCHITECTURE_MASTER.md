# INTEGRATION ARCHITECTURE MASTER

How orders enter the system. This document is the operational truth for
inbound webhook processing, HMAC verification, idempotency, polling fallback,
and the canonical `ingestNormalizedOrder` pipeline.

Source of truth files:
- `apps/api/src/lib/integrations/{shopify,woocommerce,customApi,index,types,health,safe-fetch}.ts`
- `apps/api/src/server/webhooks/{integrations,shopify-gdpr,courier,sms-inbound,sms-dlr,stripe,twilio}.ts`
- `apps/api/src/server/ingest.ts`
- `apps/api/src/workers/{commerceImport,orderSync.worker,webhookProcess,webhookRetry}.ts`

---

## 1. Topology of order ingest

```
                ┌─── shopify ───┐         ┌─── woocommerce ───┐         ┌─── custom_api ───┐
                │  (push)       │         │  (push)            │         │  (push)          │
                │  HMAC sha256  │         │  HMAC sha256       │         │  HMAC sha256     │
                │  base64       │         │  base64            │         │  hex             │
                └─────┬─────────┘         └─────────┬──────────┘         └────────┬─────────┘
                      │                             │                              │
                      ▼                             ▼                              ▼
       ┌──────────────────────────────────────────────────────────────────────┐
       │ Express route: /api/integrations/webhook  (raw body)                 │
       │ webhookLimiter ─► HMAC verify ─► freshness gate ─► WebhookInbox.create│
       │ ─► safeEnqueue(webhookProcess, { inboxId })                          │
       └──────────────────────────────────────────────────────────────────────┘
                      │
                      ▼
         ┌──────────────────────────────────────────┐
         │ webhookProcess worker (concurrency=8)    │
         │  replayWebhookInbox(inboxId)             │
         │   ▼                                      │
         │  ingestNormalizedOrder(payload, ctx)     │
         └──────────────┬───────────────────────────┘
                        │
                        ▼
         ┌──────────────────────────────────────────┐
         │ orderSync worker (cron 5m, fallback)     │
         │  Shopify+Woo only; cursor on             │
         │  newestPlacedAt                          │
         └──────────────────────────────────────────┘
```

Push (webhooks) is the primary channel; `orderSync` is the safety net for "silent revenue holes" — uninstall+reinstall, scope drop, platform outage.

---

## 2. Per-provider connect, register, verify

### 2.1 Shopify

**Connect** (`integrations.connect({provider:"shopify"})` mutation):
- If platform-level OAuth is configured (`SHOPIFY_APP_API_KEY` + `SHOPIFY_APP_API_SECRET` env), merchant supplies only the shop domain; we redirect to the platform install URL with `state` cookie.
- Legacy custom-app fallback: merchant supplies `apiKey + apiSecret` directly. Stored encrypted (`v1:iv:tag:ct` AES-256-GCM via `lib/crypto.ts` keyed on `COURIER_ENC_KEY`).
- OAuth completion handler `/api/integrations` (GET) validates `state`, exchanges code for `access_token`, persists to `Integration.credentials.{accessToken, scopes, siteUrl}`.

**Webhook registration** (auto, on connect):
- `orders/create`
- `orders/updated`
- `app/uninstalled` (so we know to mark `Integration.status=disconnected`)
- Subscriptions stored in `Integration.webhookStatus.subscriptions[]`.

**Webhook entrypoint**: `POST /api/integrations/webhook/shopify`.
- Header: `x-shopify-hmac-sha256` (base64), `x-shopify-webhook-id`, `x-shopify-shop-domain`, `x-shopify-triggered-at`.
- HMAC: `HMAC-SHA256(rawBody, credentials.apiSecret)`, base64-encoded; constant-time compare.
- Freshness gate: `x-shopify-triggered-at` within 5 min (±60s clock skew tolerance).
- **Idempotency key**: `(merchantId, "shopify", x-shopify-webhook-id)`.

**Pause / disconnect**: `app/uninstalled` flips `Integration.status=disconnected`; subsequent webhooks still inbox-stamp but `webhookProcess` short-circuits with `skipReason=integration_disconnected`.

### 2.2 WooCommerce

**Connect**:
- Merchant supplies `consumerKey` + `consumerSecret` + `siteUrl`. Stored encrypted.
- Auth-strategy probe: REST `/wc/v3/system_status` is hit to detect Basic vs querystring auth (Cloudflare-fronted hosts often reject Basic). The discovered strategy is persisted and reused on subsequent calls.

**Webhook registration**:
- POST `/wc/v3/webhooks` registers `order.created` and `order.updated` subscriptions.
- Webhook secret is **minted by us** (not from Woo) and stored on `Integration.webhookSecret`.

**Webhook entrypoint**: `POST /api/integrations/webhook/woocommerce`.
- Header: `x-wc-webhook-signature` (base64).
- HMAC: `HMAC-SHA256(rawBody, integration.webhookSecret)`, base64-encoded; constant-time compare.
- No freshness header from Woo → freshness gate skipped (relies on WebhookInbox dedupe instead).
- **Idempotency key**: `(merchantId, "woocommerce", upstreamId)` where `upstreamId` is the Woo order id from the payload.

**SSRF guard**: every Woo HTTP call goes through `lib/integrations/safe-fetch.ts` which DNS-resolves the URL and rejects private IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, link-local, loopback, IPv6 ULA). Closes the DNS-rebinding gap that pure static URL validation leaves open.

### 2.3 custom_api

**Connect**:
- Merchant supplies an arbitrary `apiKey` (we store encrypted). We mint and return a `webhookSecret` they configure on their side.

**Webhook entrypoint**: `POST /api/integrations/webhook/custom_api`.
- Header: `x-ecom-signature: sha256=<hex>`.
- HMAC: `HMAC-SHA256(rawBody, integration.webhookSecret)`, hex-encoded.
- **Idempotency key**: `(merchantId, "custom_api", payload.externalId || payloadHash)`.
- Phone is required (just like Shopify/Woo); missing phone routes to `WebhookInbox.status=needs_attention` with `skipReason=missing_phone`.

### 2.4 csv

No webhook adapter. Bulk upload via `orders.bulkUpload` mutation — `BulkUploadBatch` row stamped first as anti-replay guard; CSV parsed via `csv-parse`; per row → `ingestNormalizedOrder`.

---

## 3. The webhook entrypoint (`server/webhooks/integrations.ts`)

Mounted at `/api/integrations/webhook` **before** `express.json` so HMAC sees raw bytes.

Verbatim from `index.ts`:
> *"Commerce-platform webhooks (Shopify, Woo, custom_api) sign over raw bytes, so the router MUST mount before the global JSON parser."*

Per-provider flow (regardless of provider):

1. `webhookLimiter` (per-IP rate limit, `middleware/rateLimit.ts`).
2. `express.raw({ type: '*/*', limit: '5mb' })` to expose `req.rawBody` Buffer.
3. Resolve `Integration` by URL hint (`?shop=...` for Shopify, `accountKey` derived from header for Woo, etc.) → if not found, 404.
4. HMAC verify (provider-specific). If invalid → 401, no inbox row.
5. Freshness gate (where supported). If stale → 401.
6. **Compute idempotency key** (provider-specific source).
7. **`WebhookInbox.create({...})`**. The unique `(merchantId, provider, externalId)` index catches replays:
   - On E11000: read prior row, return its `resolvedOrderId` (or 200 with `{duplicate: true}` if no order).
   - Why an explicit duplicate path? Quota refund correctness — the original create already charged usage; a replay must not double-charge.
8. `safeEnqueue(QUEUE_NAMES.webhookProcess, "process", { inboxId }, { merchantId, description: "webhook process" })`.
9. Return 200.

**Phone-required enforcement** is a recent fix. Verbatim semantics:
> *"Orders now emit skip envelopes instead of silent null → merchant sees 'needs_attention' notification and can manually replay."*

Inside `replayWebhookInbox`, if normalization yields no phone, the row goes to `status=needs_attention` (not `failed`) so the retry sweeper does **not** auto-retry — merchant action required.

---

## 4. The canonical ingest pipeline — `ingestNormalizedOrder`

Source: `apps/api/src/server/ingest.ts`. The function is the only path through which a Mongoose Order document is created. Both webhook replay and dashboard create funnel through it.

Pipeline steps:

1. **Phone canonicalization** — `normalizePhoneE164(rawPhone, country)`. Rejects garbage; returns canonical form for dedupe + identity-resolution. If undeliverable, throw `phone_invalid` (caught by caller for `needs_attention` routing).
2. **Address normalization + thana extraction** — under `env.ADDRESS_QUALITY_ENABLED` flag (default ON); `extractThana(address, district)` populates `customer.thana` only when the lexicon disambiguates a single match.
3. **Duplicate guard** — `Order.findOne({ merchantId, "source.externalId": externalId })`. If found, return existing — defense in depth on top of `WebhookInbox` dedupe.
4. **Quota reserve** — `reserveQuota(merchantId, "ordersCreated")` from `lib/usage.ts` and `lib/entitlements.ts`. Refunded on subsequent failure.
5. **Address Intelligence v1 stamp** — synchronous, pure: `computeAddressQuality(address, district)` writes to `address.quality` (score, completeness, missingHints, scriptMix, tokenCount, hasNumber, landmarks, computedAt). Observation-only — never blocks ingest. Kill switch: `ADDRESS_QUALITY_ENABLED=0` skips both this and thana extraction.
6. **Compute risk** — `computeRisk(...)` in `server/risk.ts`. Pulls 30-day phone history (decayed signals), IP velocity, address reuse, blocklists; cross-merchant network bonus via `lib/fraud-network.ts` `lookupNetworkRisk(phoneHash, addressHash)`. Hard-block rules can pin to HIGH unconditionally. Output: `riskScore`, `level`, `reasons[]`, `signals[]`, `confidence`, `pRto`. See `FRAUD_AND_INTELLIGENCE_ENGINE_MASTER.md` for the registry.
7. **Order.create** — inside a Mongoose transaction. Source.externalId partial-unique catches a parallel race; on E11000 the duplicate guard above is treated as the canonical answer. Post-save hook updates `MerchantStats` in the same session.
8. **FraudPrediction.create** — best-effort; feeds the monthly weight tuning worker. `outcome` is null at this point — stamped later by trackingSync when the shipment lands a terminal state.
9. **Cross-merchant contribution** — `contributeOutcome(phoneHash, addressHash, "open")` is **not** called here (only on terminal outcomes from trackingSync). At ingest we only *read* the network.
10. **Integration counters** — `Integration.counts.ordersImported` $inc'd; `health.{ok, lastCheckedAt}` snapshot.
11. **Identity resolution** (fire-and-forget) — match `TrackingSession` rows by phone/email and stamp `resolvedOrderId`.
12. **Intent scoring** (fire-and-forget) — `scoreIntentForOrder(orderId)` — under `env.INTENT_SCORING_ENABLED` flag (default ON). Reads the just-resolved sessions, computes intent, writes to `Order.intent`. Observation-only — never feeds `computeRisk` in v1.
13. **Auto-confirm / auto-book decision** — based on `Merchant.automationConfig`:
    - `manual` → `automation.state = pending_confirmation` → enqueue `automationSms`.
    - `semi_auto` → low risk: `auto_confirmed`; medium/high: `pending_confirmation`. No auto-book by default.
    - `full_auto` → low risk + `riskScore <= maxRiskForAutoConfirm`: `auto_confirmed` + enqueue `automationBook`. Medium → `pending_confirmation`. High → `requires_review`.

If any step fails after step 4, **`releaseQuota`** refunds the reservation. The fix here is real: parameter alignment in the original release call was wrong, so refunds didn't apply on race conditions.

---

## 5. Non-commerce webhooks

### 5.1 Courier — `server/webhooks/courier.ts`

Mount: `/api/webhooks/courier/{merchantId}/{provider}` — merchantId is in the URL path.
- HMAC depends on courier; signing key is `Merchant.couriers[n].apiSecret` (decrypted at request time).
- Idempotency: SHA1 hash of `(trackingCode, providerStatus, timestamp)`.
- Tenant-scoped: derives merchantId from URL but also re-checks `order.merchantId` matches (defense in depth).
- 5-min replay window distinguishes hot retries from late re-deliveries.
- Writes append `Order.logistics.trackingEvents` (sliced -100), updates `lastWebhookAt`. On RTO/cancelled normalized status → `enqueueRescore`.

### 5.2 Stripe — `server/webhooks/stripe.ts`

Mount: `/api/webhooks/stripe`. Mounted **after** `express.json` global because the router internalises `express.raw({type:'*/*'})` for the signature path.
- Verify via Stripe SDK `constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET)`.
- Idempotency:
  - `Payment.providerEventId` partial-unique — covers single-event invoices and Checkout sessions.
  - `Payment.invoiceId` partial-unique — covers recurring subscription invoices.
- Subscription state machine maps Stripe status → ours and clears `gracePeriodEndsAt` on `invoice.payment_succeeded`.
- Mid-cycle plan switches: detect tier change, update `Merchant.subscription.tier` + emit downgrade enforcement async (`enforceDowngradeIfNeeded` is no-op on upgrade).

### 5.3 Twilio — `server/webhooks/twilio.ts`

Voice + SMS callbacks (call status, recording, inbound SMS via the Twilio path). Twilio signature header verified with `validateRequest`. Updates `CallLog` rows by `callSid`.

### 5.4 SSL Wireless inbound + DLR — `server/webhooks/sms-inbound.ts`, `sms-dlr.ts`

- `SMS_WEBHOOK_SHARED_SECRET` HMAC verification (mandatory in prod; dev bypasses with loud warn).
- **Inbound SMS**: parse `YES <code>` reply; look up Order by `automation.confirmationCode`. If matched and within window: confirm + enqueue `automationBook` (full_auto). If past auto-reject window: stamp `automation.lateReplyAcknowledgedAt` + reply with courtesy "order expired" SMS (once-per-order guard).
- **DLR**: update `Order.automation.confirmationDeliveryStatus` (`pending → delivered | failed`), with `confirmationDeliveredAt` or `confirmationDeliveryFailedAt` and `confirmationDeliveryError` truncated to 500 chars.

### 5.5 Shopify GDPR — `server/webhooks/shopify-gdpr.ts`

Three Shopify App-Store mandatory privacy webhooks:
- `customers/data_request` — log to `AuditLog` (no automatic data dump).
- `customers/redact` — find Orders by hashed-email; redact PII (`lib/gdpr/redaction.ts`) — phone → masked, address → "[redacted]"; preserve aggregates so analytics aren't corrupted.
- `shop/redact` — issued 48h after uninstall; mark Integration `status=disconnected_redacted` and redact all merchant orders.

HMAC keyed on `SHOPIFY_APP_API_SECRET` env, **not** the per-merchant credential. Email is hashed in audit trail (no plaintext).

---

## 6. orderSync polling fallback (`workers/orderSync.worker.ts`)

Wired 2026-05-07. Comment in `index.ts:171-176`:
> *"Polling fallback for upstream order sync — runs alongside webhooks so a merchant whose webhook delivery silently breaks (uninstall + reinstall, scope drop, platform outage) still gets their orders pulled in. Absence of this worker is the canonical 'silent revenue hole' failure mode; it was previously declared but not wired."*

Cadence: 5 minutes (default).
Scope: Shopify + WooCommerce only; `custom_api` (no upstream pull API contract guaranteed) and `csv` (no API at all) skipped.
Cursor: `Integration.lastSyncedAt`. Adapter `fetchSampleOrders(since)`. On adapter error, leave cursor untouched.
Each fetched order goes through `enqueueInboundWebhook` → `webhookProcess` → `replayWebhookInbox` → `ingestNormalizedOrder`. Same dedupe path as live webhooks (`WebhookInbox(merchantId, provider, externalId)` unique). Polling never produces a duplicate Order.

---

## 7. Idempotency contracts (the matrix)

| Surface                         | Key                                                              | Persistence            |
| ------------------------------- | ---------------------------------------------------------------- | ---------------------- |
| Inbound webhook (any provider)  | `(merchantId, provider, externalId)`                             | `WebhookInbox` (forever)|
| Inbound order create            | `(merchantId, source.externalId)` partial-unique                 | `Order` (forever)       |
| Dashboard order create          | `(merchantId, source.clientRequestId)` partial-unique            | `Order` (forever)       |
| CSV bulk upload                 | `(merchantId, externalBatchId)`                                  | `BulkUploadBatch` (forever) |
| Stripe one-shot event           | `Payment.providerEventId` partial-unique                         | `Payment` (forever)     |
| Stripe recurring invoice        | `Payment.invoiceId` partial-unique                               | `Payment` (forever)     |
| Stripe checkout session         | `Payment.providerSessionId` partial-unique                       | `Payment` (forever)     |
| Manual payment submission       | `(merchantId, clientRequestId)` partial-unique                   | `Payment` (forever)     |
| Courier booking attempt         | `idempotencyKey = sha256(orderId + ":" + attempt)` (sent header) | `PendingAwb` + upstream |
| Courier webhook                 | sha1 of `(trackingCode, providerStatus, timestamp)`              | per-event dedupe in app |
| Tracking event SDK batch        | `(merchantId, sessionId, clientEventId)` partial-unique          | `TrackingEvent`         |
| Outbound enqueue                | jobId per worker (e.g. `auto-sms:{orderId}`)                     | BullMQ                  |

The entire system's correctness is built on these. Removing any one of them produces a duplicate-on-replay bug that is hard to debug after the fact.

---

## 8. Operational guarantees (verbatim where possible)

- **Defense in depth**: even if a `WebhookInbox` row is deleted manually, `Order.source.externalId` partial-unique still rejects the duplicate.
- **Race-safe insert**: the unique partial index `(merchantId, source.externalId)` plus E11000 catch handles webhook races (two `order.updated` arriving milliseconds apart).
- **SSRF closure**: `safeFetch()` DNS-resolves *after* static URL validation; rejects DNS rebinding to private ranges.
- **Phone-required floor**: orders with no phone go to `needs_attention`, not silently null. Merchant has a manual-replay UI.
- **Quota refund**: parameter alignment fix means `reserveQuota` / `releaseQuota` actually round-trip on race failure.
- **Address quality kill-switch**: outages can never block order creation — `ADDRESS_QUALITY_ENABLED=0` short-circuits stamping; ingest proceeds.
- **Intent scoring kill-switch**: `INTENT_SCORING_ENABLED=0` short-circuits the post-ingest stamp; `Order.intent` simply not written.

---

## 9. What is NOT in the integration layer (status, not roadmap)

- **Multi-store Shopify under one Cordon merchant**: supported via `(merchantId, provider, accountKey)` unique. Multiple `Integration` rows allowed.
- **Bidirectional sync**: we *read* orders from upstream; we never push order/status updates back. Status: PLANNED (no current code path).
- **Custom adapters beyond Shopify/Woo/custom_api/csv**: not in v1.
- **Upstream order edit** (e.g. customer changes Shopify order): handled by `orders/updated` event → re-runs `ingestNormalizedOrder`. Dedupe key catches it; an existing order's mutable fields are merged. Status: IMPLEMENTED, but mutation-merging logic is conservative; deep diff is not modeled.
- **Replay from arbitrary point in time**: must be merchant-initiated (`integrations.replayWebhooks` admin op); no automatic backfill beyond `orderSync` cursor advance.
