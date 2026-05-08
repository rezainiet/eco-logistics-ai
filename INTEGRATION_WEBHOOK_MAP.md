# Integration & Webhook Subsystem Map

## Overview

Orders from Shopify, WooCommerce, custom API, and CSV enter the system through integration adapters. Shopify and Woo use real-time webhooks (HMAC-signed); custom_api and CSV use push/bulk modes. All paths converge on idempotent `WebhookInbox` deduplication, then flow through `ingestNormalizedOrder` for fraud scoring, quota validation, and identity resolution.

---

## Commerce Integrations

### Shopify

**Connect Flow (OAuth)**
- App credentials: `apiKey` (public), `apiSecret` (secret), `accessToken` (issued per-shop, offline)
- Token storage: encrypted in `Integration.credentials.accessToken` via `encryptSecret()`
- OAuth dance: `/oauth/shopify/callback` (lines 402–773 in integrations.ts)
  - Merchant enters shop domain in dashboard
  - Client builds install URL via `buildShopifyInstallUrl()` (line 261)
  - Shopify redirects back with `?code=…&state=…&shop=…&hmac=…`
  - Handler validates HMAC with app secret (platform or per-merchant), exchanges code for token via `exchangeShopifyCode()`
  - Auto-registers webhooks with `registerShopifyWebhooks()` (line 401)
  - Stamps integration `connected` + health snapshot

**Webhook Registration**
- Topics: `orders/create`, `orders/updated`, `app/uninstalled`
- Registration: best-effort auto-subscribe during OAuth callback (no-throw; failures surfaced as yellow banner)
- Subscriptions listed first to avoid duplicates; 422 on duplicate treated as success

**Webhook Entrypoint**
- Route: `POST /api/integrations/webhook/shopify/:integrationId`
- HMAC: `x-shopify-hmac-sha256` over raw body (base64), verified with `credentials.apiSecret`
- Raw body: Express `express.raw()` (line 70) — critical for HMAC verification
- Topic header: `x-shopify-topic`
- Idempotency: `WebhookInbox` unique index `(merchantId, provider, externalId)` where externalId = `x-shopify-webhook-id`

**Special: app/uninstalled**
- Immediate status flip to `disconnected` (line 217, no retry scheduled)
- Audit entry `integration.first_event` logged on first webhook per integration (line 300)

**Disconnect / Revocation**
- Handler calls `revokeShopifyAccessToken()` (line 607) — DELETE `/api_permissions/current.json`
- 401/403/404 treated as already-revoked (success); 5xx treated as transient

**Normalization**
- Mapper: `normalizeShopifyOrder()` (line 141)
- Phone: required; missing → `{ __skip: true, reason: "missing_phone" }` (line 159)
- External ID: `payload.id` (line 179)
- Order number: `payload.name` or `#${order_number}`
- Customer: shipping address preferred over billing (line 150)
- District: city or province (line 167)
- Address: address1 + address2 joined (line 166)
- COD: detected by payment gateway regex `/cash on delivery|cod/i` (line 175)
- Items: title/name/sku from `line_items` (line 168)
- Currency: passed through; total computed from items if missing (line 174)
- Metadata: `financial_status`, payment gateways captured (line 193)

---

### WooCommerce

**Connect Flow (API Credentials)**
- Auth: HTTP Basic (`consumerKey:consumerSecret`)
- Credentials stored: `siteUrl`, `consumerKey`, `consumerSecret`
- SSRF guard: `safeFetch()` (line 38 in woocommerce.ts) DNS-resolves and rejects private/loopback ranges
- Test connection: `GET /wp-json/wc/v3/system_status`
- Auth strategy probe: stored as plaintext `credentials.authStrategy` (basic | querystring) for Cloudflare-fronted hosts that strip Authorization headers (line 120)

**Webhook Registration**
- Topics: `order.created`, `order.updated`
- Auto-register via `registerWooWebhooks()` (line 172)
- Listing scoped to `?per_page=100` to dedupe (line 204)
- Creation stores webhook ID for later delete (line 268)
- Existing subscriptions matched by `(delivery_url, topic, status: active)` (line 216)

**Webhook Entrypoint**
- Route: `POST /api/integrations/webhook/woocommerce/:integrationId`
- HMAC: `x-wc-webhook-signature` (base64-encoded SHA256), verified with `integration.webhookSecret`
- Topic header: `x-wc-webhook-topic`
- Idempotency: same `WebhookInbox` dedup as Shopify; externalId = `x-wc-webhook-delivery-id`

**Disconnect**
- Handler calls `deleteWooWebhooks()` (line 365)
- Per-ID: 200/204 = deleted, 404 = already gone, 401/403 → retry with querystring auth
- SSRF guard applied to DELETE (line 401)

**Normalization**
- Mapper: `normalizeWooOrder()` (line 91)
- Phone: required; missing → skip (line 108)
- External ID: `payload.id` (line 129)
- Customer: shipping preferred over billing (line 99)
- District: shipping.city or billing.city, fallback to state (line 119)
- Address: address_1 + address_2 (line 116)
- COD: regex match on payment_method `/cod|cash[_-]?on/i` (line 127)
- Items: price = `total / quantity` (line 124)
- Metadata: status, payment_method (line 143)

---

### Custom API

**Connect Flow (Simple Key)**
- No OAuth; merchant provides an API key (arbitrary string)
- Credential stored: `credentials.apiKey`
- Webhook secret: auto-generated + encrypted on connect (line 114)
- Test connection: no-op (key is just a string the merchant uses in their POST)

**Webhook Entrypoint**
- Route: `POST /api/integrations/webhook/custom_api/:integrationId`
- HMAC: `x-ecom-signature: sha256=<hex>` or `sha256=<hex>` prefix auto-stripped (line 118)
- Signature computed over raw body, hex-encoded (line 119)
- Idempotency: `WebhookInbox` unique `(merchantId, provider, externalId)` where externalId from payload

**Payload Shape**
```json
{
  "externalId": "string (required)",
  "orderNumber": "string (optional)",
  "customer": {
    "name": "string (optional)",
    "phone": "string (required)",
    "email": "string (optional)",
    "address": "string (optional)",
    "district": "string (optional)"
  },
  "items": [{ "name", "sku?", "quantity", "price" }],
  "cod": "number (optional)",
  "total": "number (optional)",
  "currency": "string (optional)",
  "placedAt": "ISO string (optional)",
  "metadata": "Record<string, unknown> (optional)"
}
```

**Normalization**
- Mapper: `normalizeCustom()` (line 49)
- Phone: required; missing → skip (line 59)
- External ID: `payload.externalId` (line 56, line 76)
- Items default: `[{ name: "Item", quantity: 1, price: total }]` (line 85)
- COD defaults to total if unset (line 74)

---

### CSV (No Adapter)

- No live adapter; orders ingested via bulk-upload flow
- Stored as `provider: "csv"` in Integration rows
- No webhook registration; user manually uploads file

---

## Webhook Idempotency Strategy

### WebhookInbox Table

**Schema**
- Unique index: `(merchantId, provider, externalId)` — deduplicates retries
- Status workflow: `received` → `processing` → `succeeded` | `failed` | `needs_attention` | `dead_lettered`
- `externalId` sources:
  - Shopify: `x-shopify-webhook-id` header
  - Woo: `x-wc-webhook-delivery-id` header
  - Custom API: `payload.externalId` or `payload.id`
  - Courier: hash of `(trackingCode, providerStatus, timestamp)` (SHA1, 32-char prefix)

**Deduplication**
1. Webhook receiver calls `enqueueInboundWebhook()` (line 449 in ingest.ts)
2. Attempts `WebhookInbox.create()` (line 453)
3. On E11000 (duplicate), looks up prior row (line 468) — returns `{ duplicate: true, resolvedOrderId? }`
4. Caller gets 202 ACK immediately; worker doesn't enqueue on duplicate
5. Prevents double-charging quota on webhook races (two rapid-fire order.updated for WC order)

**Freshness Gate** (lines 175–193 in integrations.ts)
- 5-minute window: `WEBHOOK_FRESHNESS_WINDOW_MS = 5 * 60 * 1000` (line 25)
- Rejects payloads older than 5m; clock skew tolerance ±60s
- Timestamp sources: `x-shopify-triggered-at` (ISO), `x-event-timestamp` (epoch sec/ms), custom `x-timestamp`
- Woo doesn't send timestamp → freshness check skipped

**Signature Verification** (lines 146–150 in integrations.ts)
- Secrets resolved based on provider:
  - Shopify: `credentials.apiSecret` (encrypted)
  - Woo/custom_api: `integration.webhookSecret` (encrypted)
- Verification via adapter's `verifyWebhookSignature()` method
- On failure: increment `webhookStatus.failures`, log structured `evt: webhook.signature_invalid`, return 401

**Pause Behavior**
- If `integration.pausedAt` is set, handler ACKs 202 but skips inbox stamp + worker dispatch (line 103)
- "Sync now" button does NOT backfill missed deliveries; manual

---

## Polling Fallback

**Supported Adapters**
- Shopify: `fetchSampleOrders()` (line 215 in shopify.ts) — sample only, not a true poll
- Woo: `fetchSampleOrders()` (line 304) — `GET /orders?per_page=N`
- Custom API: returns empty `{ ok: true, count: 0, sample: [] }` (line 104)
- CSV: N/A

**Usage**
- Dashboard "Test connection" calls `fetchSampleOrders(creds, limit?)` to preview merchant's orders
- Order normalization same path as webhook (skips null + skips envelopes from preview display)
- No automated scheduled polling; user manually triggers via "Sync now" button in UI

---

## Non-Commerce Webhooks

### Courier (Steadfast, Pathao, RedX)

**Entrypoint**
- Route: `/api/webhooks/courier/<provider>/<merchantId>`
- Raw body parser: `express.raw()` (line 49)
- Signature headers: provider-specific (`x-steadfast-signature`, `x-pathao-signature`, `x-redx-signature`)
- Signature verification: provider-specific verifier (lines 77–95)

**Idempotency**
- `WebhookInbox` unique `(merchantId, provider, externalId)`
- `externalId` = SHA1 hash of `(trackingCode, providerStatus, timestamp)` first 32 chars (line 232)
- Duplicate within 5-minute replay window → 200 with `replayWithinWindow: true` (line 267)
- Old duplicates → 200 with `replayWithinWindow: false` (line 270)

**Tenant Isolation**
- `merchantId` from URL path (line 122)
- Order lookup scoped to merchantId (line 186)
- Defence-in-depth check: refuses to write if order.merchantId ≠ URL merchantId (line 195)

**Processing**
- Order found: applies tracking events via `applyTrackingEvents()` (line 287)
- Order NOT found: creates inbox row with `status: succeeded` + `lastError: "order not found"` (line 205), returns 200
- On apply error: updates inbox with `status: failed`, `nextRetryAt: now + 60s`, returns 500 so courier retries

**Status Normalization**
- Provider-specific parser extracts `(trackingCode, providerStatus, normalizedStatus, at, description?, location?, deliveredAt?)`
- Normalized statuses: pending, picked_up, in_transit, out_for_delivery, delivered, failed, rto, unknown

---

### Shopify GDPR

**Entrypoint**
- Route: `/api/webhooks/shopify/gdpr/:topicSegment(*)`
- Raw body parser: `express.raw()` (line 98)
- Signature verification: `verifyShopifyBodyHmac()` (line 77) — HMAC-SHA256 base64, uses `SHOPIFY_APP_API_SECRET`

**Topics**
1. `customers/data_request` → audit-logged; no automated redaction (line 209)
2. `customers/redact` → calls `redactCustomer()` (line 227)
3. `shop/redact` → calls `redactShop()` (line 247) + flips Shopify integrations to disconnected

**Merchant Resolution**
- Lookup via `Integration.findOne({ provider: "shopify", accountKey: shopDomain })` (line 161)
- May be null (shop already deleted); treated as no-op (line 231)

**Audit Trail**
- Receipt event: `action: shopify.gdpr_webhook` (line 177)
- Dispatch outcome: `action: shopify.gdpr_dispatch` (line 259)
- Hashed email in audit (not plaintext) — `hashIdentifier()` (line 278)

---

### Stripe

**Entrypoint**
- Route: `/api/webhooks/stripe`
- Raw body parser: `express.raw()` (line 109)
- Signature verification: `verifyStripeWebhook()` (line 118)

**Event Types**
- `checkout.session.completed` (mode=subscription) → `handleSubscriptionCheckoutCompleted()` (line 412)
- `checkout.session.completed` (mode=payment legacy) → `activateFromCheckoutSession()` (line 209)
- `customer.subscription.updated`, `customer.subscription.deleted` → `handleSubscriptionUpdated()` (line 464)
- `invoice.payment_succeeded` → `handleInvoicePaymentSucceeded()` (line 565)
- `invoice.payment_failed` → `handleInvoicePaymentFailed()` (line 737)

**Idempotency**
- `checkout.session.completed`: claims event via `Payment.providerEventId` unique index (line 233)
- `invoice.payment_succeeded`: upserts via `Payment.invoiceId` sparse-unique (line 649)
- Both: E11000 on duplicate treated as idempotent success (lines 244, 304)

**Side Effects**
- Writes Payment row (method=card, provider=stripe)
- Updates Merchant subscription (tier, status, currentPeriodEnd, gracePeriodEndsAt)
- Fires emails (payment_approved, payment_failed, on first-time only)
- Invalidates subscription cache via `invalidateSubscriptionCache()`
- Fire-and-forget downgrade enforcement via `enforceDowngradeIfNeeded()` (lines 276, 531, 633)

---

### Twilio (Call Status)

**Entrypoint**
- Route: `/api/webhooks/twilio/call-status`
- URL-encoded body parser: `express.urlencoded()` (line 13)
- Signature validation: `validateSignature()` (line 20) — only in production

**Processing**
- Lookup CallLog by `callSid` (line 55)
- Updates: status, duration, answered (duration > 0), recording URL/SID, price, error code
- Terminal statuses: completed, busy, failed, no-answer, canceled → set `endedAt` (line 52)
- Cache invalidation: `invalidate()` on merchantId (line 64)

---

## Ingest Pipeline: `ingestNormalizedOrder`

**Entry** (line 74 in ingest.ts)
- Input: `NormalizedOrder` (from adapter) + `IngestOptions`
- Prerequisites: phone required (line 78)

**Phone Normalization** (line 85)
- `normalizePhoneOrRaw()` → E.164 format
- Canonical form used for duplicate dedup + identity resolution

**Duplicate Guard** (line 93)
```
Order.findOne({ merchantId, "source.externalId": normalized.externalId })
```
- Returns immediately with `{ duplicate: true, orderId }` if found

**Quota Reservation** (line 117)
- Calls `reserveQuota(merchantId, plan, "ordersCreated", 1)`
- If denied: returns error + doesn't create Order
- On failure/race: released via `releaseQuota()` (line 401)

**Fraud Scoring** (line 157)
- Collects risk history via `collectRiskHistory()` (phone, IP, address hash, 30-day half-life)
- Computes risk via `computeRisk()` (COD, customer, IP, signals)
- Returns `{ level, riskScore, reasons, signals, reviewStatus, pRto, weightsVersion }`
- High-risk orders: fire alert + audit entry + notification (line 351)

**Address Intelligence v1** (line 178)
- Optional (kill-switch: `ADDRESS_QUALITY_ENABLED`)
- Computes: completeness, score, landmarks, missing hints, script mix
- Extracts thana (sub-district) via `extractThana()`
- Logged as structured single-line event (line 196)

**Order Create** (line 222)
- Race-safe: unique partial index `(merchantId, source.externalId)`
- On E11000: treated as duplicate (line 274), refunds quota, re-fetches winner
- Stamps: customer (name, phone, address, district, thana), items, order (cod, total, status: pending), fraud snapshot, source (ip, channel, externalId, provider, integrationId, email, placedAt)
- Address quality optional (line 262) — not set if absent

**Fraud Prediction Write** (line 303)
- Best-effort; failure doesn't undo order
- Unique on `orderId` for monthly retuning

**Integration Bump** (line 337)
- Increments `counts.ordersImported` (or `ordersFailed` on exception)
- Sets `lastSyncAt`, `health.ok`, `webhookStatus.lastEventAt`

**Identity Resolution** (line 372)
- Fire-and-forget in background
- Stitches prior behavioral sessions (TrackingSession) by phone/email
- Chained: Intent Intelligence v1 scores the stitched sessions (line 384)

---

## Webhook Receipt → Order: `processWebhookOnce`

**Entry** (line 499 in ingest.ts)
- Caller: worker reading from `WebhookInbox` (after `enqueueInboundWebhook` returns)
- Input: raw payload + normalized result (from adapter)

**Inbox Creation** (line 519)
- Creates `WebhookInbox` row in `processing` state
- On E11000 duplicate: looks up prior row (line 532), returns `{ duplicate: true, orderId? }`

**Normalization Outcome Branching** (line 548)
- `null` (not order event): marks `succeeded` + `lastError: "ignored"`
- `NormalizationSkip` (missing field): marks `needs_attention` + `skipReason` + fires alert + returns error
- `NormalizedOrder`: proceeds to ingest (line 591)

**Ingest Call** (line 591)
- Calls `ingestNormalizedOrder()` with channel=webhook

**Result Handling**
- Success: marks `succeeded` + stamps `resolvedOrderId` (line 600)
- Failure: marks `failed` + schedules first retry via `nextRetryDelayMs(1)` = 1m (line 624)

**Retry Policy** (line 648–668)
- Max attempts: 5
- Backoff schedule: 1m, 5m, 15m, 30m, 1h (sticky)
- Dead-lettering: after 5 attempts, merchant alerted

---

## HMAC Algorithms

| Provider | Algorithm | Encoding | Header | Key Source |
|----------|-----------|----------|--------|------------|
| Shopify | SHA256 | base64 | x-shopify-hmac-sha256 | credentials.apiSecret |
| WooCommerce | SHA256 | base64 | x-wc-webhook-signature | integration.webhookSecret |
| Custom API | SHA256 | hex | x-ecom-signature | integration.webhookSecret |
| Shopify GDPR | SHA256 | base64 | x-shopify-hmac-sha256 | SHOPIFY_APP_API_SECRET (env) |
| Stripe | HMAC-SHA256 | (timestamp.payload.signature) | stripe-signature | STRIPE_WEBHOOK_SECRET (env) |
| Steadfast/Pathao/RedX | SHA256/HMAC | (provider-specific) | x-{provider}-signature | Merchant.couriers[n].apiSecret |
| Twilio | HMAC-SHA1 | (URL+params) | x-twilio-signature | TWILIO_AUTH_TOKEN (env) |

---

## Critical Comments (Verbatim)

**Phone Normalization** (line 84):
> "E.164-normalize at the ingestion seam so identity-resolution doesn't create duplicate buyers from "+8801711…", "8801711…", "01711…" variants. Falls back to the cleaned raw form when normalization is ambiguous."

**Race-Safe Insert** (line 212):
> "Race-safe insert. Two workers can each pass the findOne dedup above (rapid-fire order.created + order.updated webhooks for the same WC order do this all the time) and reach the create in parallel. The unique partial index on `(merchantId, source.externalId)` makes the second insert throw E11000; we catch it here and treat it as a duplicate."

**Quota Refund Fix** (line 278):
> "FIX: previously called as `releaseQuota(merchantId, plan, "ordersCreated", 1)` which mis-aligned with the (merchantId, metric, amount) signature in usage.ts:133 — `plan` landed in the metric slot, "ordersCreated" in the amount slot, and the $inc silently no-op'd. Aligned with the signature now; quota refund actually applies."

**Address Quality Kill-Switch** (line 177):
> "Observation-only: no consumer reads this in v1 to make a decision. Skipped entirely when the kill-switch env flag is off so an outage of the address layer can never block order creation."

**Identity Resolution** (line 366):
> "Best-effort — never throws into the caller. The 30-day lookback keeps the scan bounded; we only stitch sessions that don't already have a resolved order."

**Phone-Required FIX** (line 154 in shopify.ts):
> "FIX: phone-required orders used to silently `return null`, which the replay path treated as "topic not relevant" and marked succeeded with no merchant visibility. Now we emit a skip envelope; the caller routes it to `needs_attention` so the merchant gets a Notification and can see exactly which orders need a storefront fix."

**SSRF Guard** (line 34 in woocommerce.ts):
> "FIX (SSRF): use safeFetch which DNS-resolves and rejects private/loopback/link-local addresses. Closes the rebinding gap left by the static URL validator at connect time. No-op in dev/test."

**OAuth State Validation** (line 474 in integrations.ts):
> "Looking up by the install nonce instead of the shop domain dodges a Shopify quirk: stores can have multiple myshopify.com hostnames (a vanity one like `devs-9807.myshopify.com` and a canonical one like `dwykhp-en.myshopify.com`). The merchant types the vanity in our connect modal, we mint the install URL pointing at the vanity, but Shopify rewrites the callback `shop` param to the canonical form."

**Webhook Auto-Registration** (line 410):
> "Default topic set: orders/create + orders/updated → real-time order sync; app/uninstalled → fired by Shopify when the merchant clicks Uninstall in their admin. Without subscribing, we'd keep showing the integration as `connected` in our dashboard until the merchant manually clicks trash. With it, the handler in webhooks/integrations.ts flips status to `disconnected` automatically."

**Downgrade Enforcement** (line 274 in stripe.ts):
> "FIX (downgrade enforcement): defensive call — no-op when prevTier is undefined (trial→paid) or when plan.tier >= prevTier."

---

## Summary Table

| Layer | Deduplication | HMAC Verification | Retry Policy | Scope |
|-------|----------------|-------------------|--------------|-------|
| Commerce (Shopify/Woo) | WebhookInbox unique index | Per-provider algorithm + key source | Exponential 1m–1h, max 5 | Order ingestion |
| Custom API | Same WebhookInbox | SHA256 hex | Same | Order ingestion |
| Courier (tracking) | WebhookInbox (content hash) | Provider-specific | Exponential, 1m first retry | Tracking event application |
| Shopify GDPR | Audit trail only | Platform app secret | None (sync) | Redaction only |
| Stripe | Payment.providerEventId unique | Timestamp + signature | None (no retry) | Subscription activation |
| Twilio | CallLog lookup | HMAC-SHA1 | None (async) | Call status update |

---

## Dependency Graph

```
Webhook Receipt (integrations.ts)
  ├─ HMAC Verify (adapter.verifyWebhookSignature)
  ├─ Freshness Check (5m window)
  ├─ enqueueInboundWebhook (WebhookInbox unique dedup)
  │  └─ ACK 202 to upstream
  └─ safeEnqueue (webhook-process worker)

Worker: processWebhookOnce (ingest.ts)
  ├─ Adapter normalizeWebhookPayload
  ├─ Route to needs_attention if NormalizationSkip
  └─ ingestNormalizedOrder
      ├─ Phone normalization
      ├─ Duplicate guard (Order.findOne)
      ├─ Quota reservation
      ├─ Fraud scoring (risk engine)
      ├─ Address intelligence v1
      ├─ Order.create (race-safe via unique index)
      ├─ FraudPrediction.create
      ├─ Identity resolution (fire-and-forget)
      └─ Intent scoring (fire-and-forget)
```
