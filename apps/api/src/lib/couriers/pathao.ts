import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { LRUCache } from "lru-cache";
import { env } from "../../env.js";
import {
  classifyHttpStatus,
  httpRequest,
  withCourierBreaker,
  withRetry,
  type HttpRequestOptions,
} from "./http.js";
import {
  CourierError,
  type AWBRequest,
  type AWBResponse,
  type CourierAdapter,
  type CourierCredentials,
  type NormalizedTrackingStatus,
  type PriceQuote,
  type TrackingInfo,
  type ValidationResult,
} from "./types.js";

/**
 * Pathao Aladdin API v1 adapter. Works against live endpoints when credentials
 * are supplied and COURIER_MOCK=0; otherwise uses a deterministic in-memory
 * mock transport so dev/CI and bookings-UI can be exercised end-to-end without
 * real sandbox keys.
 *
 * Live endpoints (per Pathao docs):
 *   POST  /aladdin/api/v1/issue-token           → access_token (24h)
 *   POST  /aladdin/api/v1/orders                → create order (AWB)
 *   GET   /aladdin/api/v1/orders/{id}/info      → tracking
 *   POST  /aladdin/api/v1/merchant/price-plan   → price quote
 *
 * Per-merchant `baseUrl` overrides the global PATHAO_BASE_URL so enterprise
 * merchants on dedicated hosts or sandbox accounts can be slotted in without
 * an env flip.
 */

const PROVIDER = "pathao" as const;
const TOKEN_TTL_MS = 50 * 60 * 1000; // Pathao issues 1h tokens; refresh a bit early.

interface PathaoTokenPayload {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

interface PathaoOrderResponse {
  consignment_id: string;
  merchant_order_id?: string;
  delivery_fee?: number;
  estimated_delivery_at?: string;
}

interface PathaoOrderInfo {
  consignment_id: string;
  order_status: string;
  updated_at?: string;
  delivery_history?: Array<{
    order_status: string;
    updated_at: string;
    location?: string;
  }>;
}

interface PathaoPriceResponse {
  price: number;
  discount?: number;
  promo_discount?: number;
  plan_id?: number;
  cod_enabled?: boolean;
  cod_percentage?: number;
  additional_charge?: number;
  final_price: number;
}

export interface PathaoTransport {
  request<T = unknown>(
    path: string,
    opts: HttpRequestOptions & { accessToken?: string },
  ): Promise<{ status: number; ok: boolean; data: T }>;
}

class HttpPathaoTransport implements PathaoTransport {
  constructor(private readonly baseUrl: string) {}
  async request<T>(
    path: string,
    opts: HttpRequestOptions & { accessToken?: string },
  ): Promise<{ status: number; ok: boolean; data: T }> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.accessToken) headers.authorization = `Bearer ${opts.accessToken}`;
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    return httpRequest<T>(url, { ...opts, headers }, PROVIDER);
  }
}

/**
 * Deterministic mock transport — stores created orders in a module-level map
 * so independent adapter instances round-trip AWB → tracking lookups (mirrors
 * Pathao's real server behaviour). Tests should call `__clearPathaoTokenCache`
 * or `MockPathaoTransport.reset()` between runs.
 */
const mockOrderStore = new Map<string, { merchantOrderId: string; createdAt: Date }>();
let mockCounter = 1;

export class MockPathaoTransport implements PathaoTransport {
  static reset(): void {
    mockOrderStore.clear();
    mockCounter = 1;
  }
  private get orders() {
    return mockOrderStore;
  }
  private get counter() {
    return mockCounter;
  }
  private set counter(v: number) {
    mockCounter = v;
  }

  async request<T>(path: string, opts: HttpRequestOptions): Promise<{ status: number; ok: boolean; data: T }> {
    const method = opts.method ?? "GET";
    if (path.endsWith("/issue-token") && method === "POST") {
      const body = opts.body as { client_id?: string; client_secret?: string; username?: string };
      if (!body?.client_id || !body?.client_secret) {
        return { status: 401, ok: false, data: { message: "invalid credentials" } as unknown as T };
      }
      return {
        status: 200,
        ok: true,
        data: {
          access_token: `mock-${createHash("sha1").update(body.client_id).digest("hex").slice(0, 24)}`,
          expires_in: 3600,
        } as unknown as T,
      };
    }
    if (path.endsWith("/orders") && method === "POST") {
      const body = opts.body as { merchant_order_id?: string };
      const consignment = `PTH-${Date.now().toString(36).toUpperCase()}-${this.counter++}`;
      this.orders.set(consignment, {
        merchantOrderId: body?.merchant_order_id ?? "unknown",
        createdAt: new Date(),
      });
      return {
        status: 200,
        ok: true,
        data: {
          consignment_id: consignment,
          merchant_order_id: body?.merchant_order_id,
          delivery_fee: 80,
          estimated_delivery_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        } as unknown as T,
      };
    }
    const infoMatch = /\/orders\/([^/]+)\/info/.exec(path);
    if (infoMatch && method === "GET") {
      const id = infoMatch[1]!;
      const rec = this.orders.get(id);
      if (!rec) return { status: 404, ok: false, data: { message: "not found" } as unknown as T };
      return {
        status: 200,
        ok: true,
        data: {
          consignment_id: id,
          order_status: "Pickup Requested",
          updated_at: new Date().toISOString(),
          delivery_history: [
            { order_status: "Order Placed", updated_at: rec.createdAt.toISOString() },
            { order_status: "Pickup Requested", updated_at: new Date().toISOString() },
          ],
        } as unknown as T,
      };
    }
    if (path.endsWith("/merchant/price-plan") && method === "POST") {
      const body = opts.body as { recipient_city?: number; item_weight?: number };
      const weight = Math.max(0.5, Number(body?.item_weight) || 1);
      const price = 60 + Math.round(weight * 20);
      return { status: 200, ok: true, data: { price, final_price: price } as unknown as T };
    }
    return {
      status: 404,
      ok: false,
      data: { message: `mock: unhandled ${method} ${path}` } as unknown as T,
    };
  }
}

function tokenCacheKey(creds: CourierCredentials, baseUrl: string): string {
  return createHash("sha256")
    .update(`${baseUrl}|${creds.accountId}|${creds.apiKey}|${creds.apiSecret ?? ""}`)
    .digest("base64url")
    .slice(0, 32);
}

const tokenCache = new LRUCache<string, string>({ max: 500, ttl: TOKEN_TTL_MS });

function normalizeStatus(raw: string): NormalizedTrackingStatus {
  const s = raw.toLowerCase();
  if (s.includes("delivered")) return "delivered";
  if (s.includes("return") || s.includes("rto")) return "rto";
  if (s.includes("out_for_delivery") || s.includes("out for delivery")) return "out_for_delivery";
  if (s.includes("pickup") && s.includes("requested")) return "pending";
  if (s.includes("picked") || s.includes("pickup")) return "picked_up";
  if (s.includes("transit") || s.includes("hub") || s.includes("sorting")) return "in_transit";
  if (s.includes("fail") || s.includes("cancel")) return "failed";
  if (s.includes("placed") || s.includes("pending")) return "pending";
  return "unknown";
}

export interface PathaoAdapterOptions {
  credentials: CourierCredentials;
  transport?: PathaoTransport;
}

export class PathaoAdapter implements CourierAdapter {
  readonly name = PROVIDER;
  private readonly baseUrl: string;
  private readonly transport: PathaoTransport;

  constructor(private readonly opts: PathaoAdapterOptions) {
    this.baseUrl = (opts.credentials.baseUrl || env.PATHAO_BASE_URL).replace(/\/$/, "");
    this.transport = opts.transport ?? (env.COURIER_MOCK || env.NODE_ENV === "test"
      ? new MockPathaoTransport()
      : new HttpPathaoTransport(this.baseUrl));
  }

  /** Stable per-account breaker key. One bad account doesn't trip the
   * breaker for other Pathao customers on the same instance. */
  private breakerKey(): string {
    return `${PROVIDER}:${this.opts.credentials.accountId}`;
  }

  private async getAccessToken(signal?: AbortSignal): Promise<string> {
    const key = tokenCacheKey(this.opts.credentials, this.baseUrl);
    const cached = tokenCache.get(key);
    if (cached) return cached;

    const { accountId, apiKey, apiSecret } = this.opts.credentials;
    const res = await this.transport.request<PathaoTokenPayload>("/aladdin/api/v1/issue-token", {
      method: "POST",
      signal,
      body: {
        client_id: accountId,
        client_secret: apiKey,
        username: accountId,
        password: apiSecret ?? apiKey,
        grant_type: "password",
      },
    });
    if (!res.ok) {
      const { code, retryable } = classifyHttpStatus(res.status);
      throw new CourierError(code, `pathao token request failed (${res.status})`, {
        retryable,
        status: res.status,
        provider: PROVIDER,
        raw: res.data,
      });
    }
    if (!res.data?.access_token) {
      throw new CourierError("provider_error", "pathao token response missing access_token", {
        provider: PROVIDER,
        raw: res.data,
      });
    }
    tokenCache.set(key, res.data.access_token);
    return res.data.access_token;
  }

  async validateCredentials(): Promise<ValidationResult> {
    try {
      await withCourierBreaker(this.breakerKey(), (signal) =>
        withRetry(() => this.getAccessToken(signal), { attempts: 2, signal }),
      );
      return { valid: true };
    } catch (err) {
      if (err instanceof CourierError && err.code === "auth_failed") {
        return { valid: false, message: "Invalid Pathao credentials" };
      }
      if (err instanceof CourierError) {
        return { valid: false, message: err.message };
      }
      return { valid: false, message: (err as Error).message };
    }
  }

  async createAWB(order: AWBRequest): Promise<AWBResponse> {
    return withCourierBreaker(this.breakerKey(), async (signal) => {
      const token = await withRetry(() => this.getAccessToken(signal), {
        attempts: 2,
        signal,
      });
      const body = {
        store_id: this.opts.credentials.accountId,
        merchant_order_id: order.orderNumber,
        recipient_name: order.customer.name,
        recipient_phone: order.customer.phone,
        recipient_address: order.customer.address,
        recipient_city: order.customer.district,
        delivery_type: 48,
        item_type: 2,
        item_quantity: order.items.reduce((n, i) => n + i.quantity, 0),
        item_weight: order.weight ?? 0.5,
        amount_to_collect: order.cod,
        item_description:
          order.notes ?? order.items.map((i) => `${i.name} x${i.quantity}`).join(", "),
      };

      const res = await withRetry(
        () =>
          this.transport.request<PathaoOrderResponse>("/aladdin/api/v1/orders", {
            method: "POST",
            body,
            signal,
            accessToken: token,
            headers: order.idempotencyKey
              ? { "Idempotency-Key": order.idempotencyKey }
              : undefined,
          }),
        { attempts: 3, signal },
      );
      if (!res.ok) {
        const { code, retryable } = classifyHttpStatus(res.status);
        throw new CourierError(code, `pathao createAWB failed (${res.status})`, {
          retryable,
          status: res.status,
          provider: PROVIDER,
          raw: res.data,
        });
      }
      if (!res.data?.consignment_id) {
        throw new CourierError(
          "provider_error",
          "pathao order response missing consignment_id",
          {
            provider: PROVIDER,
            raw: res.data,
          },
        );
      }
      return {
        trackingNumber: res.data.consignment_id,
        providerOrderId: res.data.consignment_id,
        estimatedDeliveryAt: res.data.estimated_delivery_at
          ? new Date(res.data.estimated_delivery_at)
          : undefined,
        fee: res.data.delivery_fee,
        raw: res.data,
      };
    });
  }

  async getTracking(trackingNumber: string): Promise<TrackingInfo> {
    return withCourierBreaker(this.breakerKey(), async (signal) => {
      const token = await withRetry(() => this.getAccessToken(signal), {
        attempts: 2,
        signal,
      });
      const res = await withRetry(
        () =>
          this.transport.request<PathaoOrderInfo>(
            `/aladdin/api/v1/orders/${encodeURIComponent(trackingNumber)}/info`,
            { method: "GET", accessToken: token, signal },
          ),
        { attempts: 3, signal },
      );
      if (!res.ok) {
        const { code, retryable } = classifyHttpStatus(res.status);
        throw new CourierError(code, `pathao getTracking failed (${res.status})`, {
          retryable,
          status: res.status,
          provider: PROVIDER,
          raw: res.data,
        });
      }
      const providerStatus = res.data?.order_status ?? "unknown";
      const normalized = normalizeStatus(providerStatus);
      const events = (res.data?.delivery_history ?? []).map((h) => ({
        at: new Date(h.updated_at),
        description: h.order_status,
        location: h.location,
      }));
      return {
        trackingNumber,
        providerStatus,
        normalizedStatus: normalized,
        events,
        deliveredAt:
          normalized === "delivered" && events.length > 0
            ? events[events.length - 1]!.at
            : undefined,
        raw: res.data,
      };
    });
  }

  async priceQuote(input: { district: string; weight: number; cod?: number }): Promise<PriceQuote> {
    return withCourierBreaker(this.breakerKey(), async (signal) => {
      const token = await withRetry(() => this.getAccessToken(signal), {
        attempts: 2,
        signal,
      });
      const res = await withRetry(
        () =>
          this.transport.request<PathaoPriceResponse>(
            "/aladdin/api/v1/merchant/price-plan",
            {
              method: "POST",
              accessToken: token,
              signal,
              body: {
                store_id: this.opts.credentials.accountId,
                item_type: 2,
                delivery_type: 48,
                item_weight: Math.max(0.5, input.weight || 0.5),
                recipient_city: input.district,
                amount_to_collect: input.cod ?? 0,
              },
            },
          ),
        { attempts: 2, signal },
      );
      if (!res.ok) {
        const { code, retryable } = classifyHttpStatus(res.status);
        throw new CourierError(code, `pathao priceQuote failed (${res.status})`, {
          retryable,
          status: res.status,
          provider: PROVIDER,
          raw: res.data,
        });
      }
      return {
        amount: res.data.final_price ?? res.data.price,
        currency: "BDT",
        breakdown: {
          base: res.data.price,
          discount: res.data.discount ?? 0,
          additional: res.data.additional_charge ?? 0,
        },
        raw: res.data,
      };
    });
  }
}

/** Exposed for tests — clears the in-process token cache. */
export function __clearPathaoTokenCache(): void {
  tokenCache.clear();
}


/* -------------------------------------------------------------------------- */
/* Webhook handling                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Pathao push payload. Pathao Hermes uses a flat shape with snake_case
 * keys; field names align with their merchant-portal webhook docs.
 */
export interface PathaoWebhookPayload {
  /** Pathao consignment id (== our trackingNumber). */
  consignment_id?: string;
  merchant_order_id?: string;
  /** Their human-readable status string. */
  order_status?: string;
  /** Numeric status code. */
  order_status_slug?: string;
  updated_at?: string;
  /** Optional event note / hub name. */
  reason?: string;
  delivered_at?: string;
}

export interface ParsedPathaoTracking {
  trackingCode: string;
  providerStatus: string;
  normalizedStatus: NormalizedTrackingStatus;
  at: Date;
  description?: string;
  deliveredAt?: Date;
}

/**
 * Verify a Pathao webhook signature. Pathao signs the raw request body
 * with the merchant's app secret (HMAC-SHA256, hex digest) and ships
 * it in the `X-PATHAO-Signature` header.
 */
export function verifyPathaoWebhookSignature(
  rawBody: string | Buffer,
  signature: string | string[] | undefined,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const provided = Array.isArray(signature) ? signature[0] : signature;
  if (!provided || typeof provided !== "string" || provided.length === 0) return false;
  const computed = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? rawBody : rawBody)
    .digest("hex");
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(computed, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function parsePathaoWebhook(payload: PathaoWebhookPayload): ParsedPathaoTracking | null {
  const trackingCode = payload.consignment_id ?? "";
  if (!trackingCode) return null;
  const providerStatus = (payload.order_status ?? payload.order_status_slug ?? "unknown").trim();
  const at = payload.updated_at ? new Date(payload.updated_at) : new Date();
  const safeAt = Number.isNaN(at.getTime()) ? new Date() : at;
  const deliveredRaw = payload.delivered_at ? new Date(payload.delivered_at) : undefined;
  const safeDelivered = deliveredRaw && !Number.isNaN(deliveredRaw.getTime()) ? deliveredRaw : undefined;
  return {
    trackingCode,
    providerStatus,
    normalizedStatus: normalizeStatus(providerStatus),
    at: safeAt,
    description: payload.reason ?? providerStatus,
    deliveredAt: safeDelivered,
  };
}

export const PATHAO_PROVIDER = PROVIDER;
