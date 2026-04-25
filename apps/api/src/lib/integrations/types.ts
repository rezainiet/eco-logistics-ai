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

export interface ConnectionTestResult {
  ok: boolean;
  detail?: string;
  /** Optional permission/scope strings to surface in the UI. */
  scopes?: string[];
}

export interface FetchSampleResult {
  ok: boolean;
  count: number;
  sample: NormalizedOrder[];
  error?: string;
}

export interface IntegrationCredentials {
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  consumerKey?: string;
  consumerSecret?: string;
  siteUrl?: string;
}

export interface IntegrationAdapter {
  testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult>;
  fetchSampleOrders(creds: IntegrationCredentials, limit?: number): Promise<FetchSampleResult>;
  /**
   * Convert an upstream webhook payload into a normalized order. Returns null
   * when the topic is not order-creation and should be ignored.
   */
  normalizeWebhookPayload(topic: string, payload: unknown): NormalizedOrder | null;
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
