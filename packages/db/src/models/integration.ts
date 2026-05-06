import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

/**
 * Per-merchant connector to an external commerce platform. Credentials are
 * stored encrypted (`v1:iv:tag:ct` envelope) — never returned to the client
 * in plaintext. One row per (merchantId, provider, accountKey) so a merchant
 * can connect multiple Shopify stores or WooCommerce sites in parallel.
 */
export const INTEGRATION_PROVIDERS = [
  "shopify",
  "woocommerce",
  "custom_api",
  "csv",
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_STATUSES = [
  "pending",
  "connected",
  "disconnected",
  "error",
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

const integrationSchema = new Schema(
  {
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
      index: true,
    },
    provider: { type: String, enum: INTEGRATION_PROVIDERS, required: true },
    label: { type: String, trim: true, maxlength: 120 },
    /**
     * Stable opaque identifier for this account on the remote side. For
     * Shopify this is the shop domain (`shop.myshopify.com`); for WooCommerce
     * it's the site URL; for custom API it's a slug; for CSV it's "default".
     */
    accountKey: { type: String, trim: true, maxlength: 200, required: true },
    status: {
      type: String,
      enum: INTEGRATION_STATUSES,
      default: "pending",
      index: true,
    },
    /** Encrypted credentials blob — shape varies by provider. */
    credentials: {
      apiKey: { type: String },
      apiSecret: { type: String },
      accessToken: { type: String },
      consumerKey: { type: String },
      consumerSecret: { type: String },
      siteUrl: { type: String, trim: true, maxlength: 500 },
      /** OAuth scopes / nonce used during install */
      scopes: { type: [String], default: [] },
      installNonce: { type: String, trim: true, maxlength: 128 },
      // Wall-clock when we minted the install URL. Used by the OAuth
      // callback to log "callback arrived Xs after install start" — the
      // single best signal for distinguishing "Shopify is slow" from
      // "merchant clicked away" from "our handler is slow". Without
      // this declared on the schema, Mongoose strict mode silently
      // drops the write and every callback logs `(no installStartedAt)`.
      installStartedAt: { type: Date },
    },
    /** HMAC secret used to verify inbound webhooks from this connector. */
    webhookSecret: { type: String },
    webhookStatus: {
      registered: { type: Boolean, default: false },
      lastEventAt: { type: Date },
      failures: { type: Number, default: 0 },
      lastError: { type: String, trim: true, maxlength: 500 },
      // Per-topic subscription metadata captured from the upstream
      // platform's webhook-create response. Populated on connect /
      // retryWooWebhooks; consumed by disconnect to issue DELETE
      // /webhooks/{id} symmetric uninstalls instead of re-listing the
      // remote subscriptions on every teardown.
      subscriptions: {
        type: [
          {
            topic: { type: String, trim: true, maxlength: 120 },
            id: { type: Number },
            deliveryUrl: { type: String, trim: true, maxlength: 500 },
            _id: false,
          },
        ],
        default: undefined,
      },
    },
    permissions: { type: [String], default: [] },
    health: {
      ok: { type: Boolean, default: true },
      lastError: { type: String, trim: true, maxlength: 500 },
      lastCheckedAt: { type: Date },
    },
    counts: {
      ordersImported: { type: Number, default: 0 },
      ordersFailed: { type: Number, default: 0 },
    },
    connectedAt: { type: Date },
    disconnectedAt: { type: Date },
    lastSyncAt: { type: Date },
    // Observability snapshot — surfaced on the dashboard's Connections
    // panel + Health card. Maintained by the test/sync paths so a
    // merchant sees "Healthy / Sync issue / Idle" without round-tripping
    // through webhookStatus + health every render. `lastError` here is
    // the top-level "most recent failure of any kind"; `health.lastError`
    // tracks credential-test history specifically and survives a
    // successful sync.
    lastSyncStatus: {
      type: String,
      enum: ["ok", "error", "idle"],
      default: "idle",
    },
    lastError: { type: String, trim: true, maxlength: 500 },
    errorCount: { type: Number, default: 0, min: 0 },
    lastWebhookAt: { type: Date },
    lastImportAt: { type: Date },
    /**
     * System-set "stop trying recovery" flag. The alert worker flips this
     * on after MAX_REPLAY_ATTEMPTS have been exhausted; the dashboard
     * disables retry/sync buttons on degraded rows so the merchant doesn't
     * spend clicks on a connector that needs a full reconnect.
     */
    degraded: { type: Boolean, default: false },
    /**
     * Soft pause — when set, the webhook ingestion route short-circuits
     * with `202 paused` and the polling worker skips this row. The
     * upstream connection (creds, webhook subscriptions) is left
     * intact, so resuming is a single click. Distinct from
     * `disconnected` (which tears the connection down). When `pausedAt`
     * is set, `pausedReason` carries the merchant-supplied note shown
     * in the dashboard banner ("Paused for fraud audit", etc.).
     */
    pausedAt: { type: Date },
    pausedReason: { type: String, trim: true, maxlength: 200 },
    pausedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

integrationSchema.index(
  { merchantId: 1, provider: 1, accountKey: 1 },
  { unique: true },
);
integrationSchema.index({ merchantId: 1, status: 1 });

export type Integration = InferSchemaType<typeof integrationSchema> & {
  _id: Types.ObjectId;
};

export const Integration: Model<Integration> =
  (models.Integration as Model<Integration>) ||
  model<Integration>("Integration", integrationSchema);
