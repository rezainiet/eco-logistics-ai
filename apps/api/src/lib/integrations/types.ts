/**
 * Common types for the integrations layer. Each connector adapter (Shopify,
 * WooCommerce, Custom API) implements `IntegrationAdapter` and surfaces a
 * canonical `NormalizedOrder` that the ingestion pipeline turns into a real
 * `Order` document.
 */

export interface NormalizedOrder {
  /** Stable upstream id used for idempotency. */
  externalId: string;
  /** Optional human-readable order number from the source. */
  externalOrderNumber?: string;
  customer: {
    name: string;
    phone: string;
    email?: string;
    address: string;
    district: string;
  };
  items: Array<{
    name: string;
    sku?: string;
    quantity: number;
    price: number;
  }>;
  cod: number;
  total: number;
  currency?: string;
  /** Source-side timestamp; falls back to receivedAt when missing. */
  placedAt?: Date;
  /** Free-form metadata captured for audit (channel, financial_status, etc). */
  metadata?: Record<string, unknown>;
}

/**
 * Reasons an upstream order looked like a real order-create event but couldn't
 * be turned into a `NormalizedOrder` we can safely insert. These are
 * **non-retryable** — they need merchant intervention (storefront config
 * change, phone-required checkout, etc.) and must be surfaced as
 * `needs_attention` inbox rows so the merchant can see and fix them.
 */
export type NormalizationSkipReason =
  | "missing_phone"
  | "missing_external_id"
  | "invalid_payload";

/**
 * "Order-shaped event we can't process" envelope. Distinct from `null` (which
 * means "topic is not an order create — ignore"). Adapters emit this when the
 * webhook IS an order event but a required field is missing; downstream
 * (`replayWebhookInbox`) routes these to the `needs_attention` inbox bucket
 * and DOES NOT retry — the merchant has to fix the storefront for future
 * deliveries to succeed.
 */
export interface NormalizationSkip {
  __skip: true;
  reason: NormalizationSkipReason;
  /** Optional upstream id for the merchant-facing diagnostic UI. */
  externalId?: string;
}

export type NormalizationOutcome = NormalizedOrder | NormalizationSkip;

export function isNormalizationSkip(
  v: NormalizationOutcome | null | undefined,
): v is NormalizationSkip {
  return !!v && typeof v === "object" && (v as NormalizationSkip).__skip === true;
}

/**
 * Discriminated failure category for `testConnection`. The connect /
 * test handlers branch on this:
 *   - `auth_rejected` → credentials are invalid; flip the row to
 *     `disconnected` so the merchant must reconnect.
 *   - `transient` / `timeout` → network blip; keep status as-is.
 *   - `unknown` → adapter couldn't classify; treat as a soft failure.
 *
 * Adapters MAY emit a `kind` on success too (currently unused) so future
 * code can distinguish e.g. degraded-but-functional results.
 */
export type ConnectionTestKind =
  | "auth_rejected"
  | "transient"
  | "timeout"
  | "unknown";

export interface ConnectionTestResult {
  ok: boolean;
  /** Failure category for routing decisions. Optional on success. */
  kind?: ConnectionTestKind;
  detail?: string;
  /** Optional permission/scope strings to surface in the UI. */
  scopes?: string[];
  /**
   * Resolved Woo wire form ("basic" header vs "querystring" params) the
   * adapter found working during the test. Persisted on the credentials
   * blob so subsequent calls skip the Basic→querystring escalation
   * probe. Shopify ignores this — it's WooCommerce-only.
   */
  authStrategy?: "basic" | "querystring";
}

export interface FetchSampleResult {
  ok: boolean;
  count: number;
  sample: NormalizedOrder[];
  /**
   * Raw upstream order deliveries for the polling fallback worker.
   *
   * `sample` is intentionally normalized for preview/import UI. The polling
   * recovery path must feed the same payload shape as real webhooks back
   * through WebhookInbox so replay/idempotency semantics stay identical.
   */
  rawDeliveries?: Array<{
    topic: string;
    externalId: string;
    payload: unknown;
    placedAt?: Date;
  }>;
  error?: string;
}

export interface IntegrationCredentials {
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  consumerKey?: string;
  consumerSecret?: string;
  siteUrl?: string;
  /**
   * Plaintext Woo auth strategy — NOT a secret. Stored alongside the
   * encrypted creds so the worker / disconnect / retry calls can pass
   * the resolved wire form to `wooFetch` and skip the Basic → querystring
   * escalation probe on Cloudflare-fronted hosts.
   */
  authStrategy?: "basic" | "querystring";
}

export interface IntegrationAdapter {
  testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult>;
  fetchSampleOrders(
    creds: IntegrationCredentials,
    limit?: number,
    since?: Date,
  ): Promise<FetchSampleResult>;
  /**
   * Convert an upstream webhook payload into a normalized order.
   *
   * Returns:
   *  - `NormalizedOrder` — order is processable; ingest pipeline runs.
   *  - `NormalizationSkip` (`{ __skip: true, reason }`) — the event IS an
   *    order create/update we'd normally process, but a required field
   *    (e.g. customer phone) is missing. Caller routes to `needs_attention`
   *    and does NOT retry — the storefront must be fixed first.
   *  - `null` — topic is not an order event (e.g. `customers/data_request`).
   *    Caller marks the inbox row succeeded with reason "ignored".
   */
  normalizeWebhookPayload(
    topic: string,
    payload: unknown,
  ): NormalizationOutcome | null;
  /** Verify the upstream HMAC signature on a webhook delivery. */
  verifyWebhookSignature(args: {
    rawBody: string | Buffer;
    headers: Record<string, string | string[] | undefined>;
    secret?: string;
  }): boolean;
}

export class IntegrationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}
