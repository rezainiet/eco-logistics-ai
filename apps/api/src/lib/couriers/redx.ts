import { createHmac, timingSafeEqual } from "node:crypto";
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
 * RedX Open API adapter.
 *
 * Live endpoints:
 *   GET   /v1/areas                       → validate token
 *   POST  /v1/parcel                      → create parcel
 *   GET   /v1/parcel/track/{tracking_id}  → tracking events
 *   POST  /v1/delivery-charge/calculate   → price quote
 *
 * Auth: static `API-ACCESS-TOKEN: <token>` header. Per-merchant baseUrl
 * overrides REDX_BASE_URL.
 */

const PROVIDER = "redx" as const;

interface RedxAreasResp {
  data?: Array<{ id: number; name: string }>;
  message?: string;
}
interface RedxCreateResp {
  tracking_id: string;
  message?: string;
}
interface RedxTrackEvent {
  parcel_log_time?: string;
  message?: string;
  location?: string;
  status?: string;
}
interface RedxTrackResp {
  tracking: RedxTrackEvent[];
}
interface RedxPriceResp {
  data: { cash_on_delivery_fee: number; delivery_fee: number; total_fee: number };
}

export interface RedxTransport {
  request<T = unknown>(
    path: string,
    opts: HttpRequestOptions,
  ): Promise<{ status: number; ok: boolean; data: T }>;
}

class HttpRedxTransport implements RedxTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}
  async request<T>(
    path: string,
    opts: HttpRequestOptions,
  ): Promise<{ status: number; ok: boolean; data: T }> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    return httpRequest<T>(
      url,
      {
        ...opts,
        headers: {
          "api-access-token": `Bearer ${this.token}`,
          ...(opts.headers ?? {}),
        },
      },
      PROVIDER,
    );
  }
}

export class MockRedxTransport implements RedxTransport {
  private static store = new Map<string, { createdAt: Date; status: string }>();
  private static counter = 1;

  static reset(): void {
    MockRedxTransport.store.clear();
    MockRedxTransport.counter = 1;
  }

  async request<T>(path: string, opts: HttpRequestOptions): Promise<{ status: number; ok: boolean; data: T }> {
    const method = opts.method ?? "GET";
    if (path.endsWith("/areas") && method === "GET") {
      return {
        status: 200,
        ok: true,
        data: { data: [{ id: 1, name: "Dhaka" }] } as unknown as T,
      };
    }
    if (path.endsWith("/parcel") && method === "POST") {
      const id = MockRedxTransport.counter++;
      const tracking = `RDX-${Date.now().toString(36).toUpperCase()}-${id}`;
      MockRedxTransport.store.set(tracking, { createdAt: new Date(), status: "pickup-pending" });
      return { status: 200, ok: true, data: { tracking_id: tracking } as unknown as T };
    }
    const m = /\/parcel\/track\/([^/?#]+)/.exec(path);
    if (m && method === "GET") {
      const rec = MockRedxTransport.store.get(m[1]!);
      if (!rec) {
        return { status: 404, ok: false, data: { tracking: [] } as unknown as T };
      }
      return {
        status: 200,
        ok: true,
        data: {
          tracking: [
            {
              parcel_log_time: rec.createdAt.toISOString(),
              message: "Parcel created",
              location: "Dhaka",
              status: "pickup-pending",
            },
            {
              parcel_log_time: new Date().toISOString(),
              message: "Picked up from merchant",
              location: "Dhaka Hub",
              status: "picked-up",
            },
          ],
        } as unknown as T,
      };
    }
    if (path.endsWith("/delivery-charge/calculate") && method === "POST") {
      const body = opts.body as { weight?: number; cash_collection_amount?: number } | undefined;
      const weight = Math.max(0.5, Number(body?.weight) || 1);
      const delivery = 60 + Math.round(weight * 15);
      const cod = body?.cash_collection_amount ? Math.round(body.cash_collection_amount * 0.01) : 0;
      return {
        status: 200,
        ok: true,
        data: {
          data: { cash_on_delivery_fee: cod, delivery_fee: delivery, total_fee: delivery + cod },
        } as unknown as T,
      };
    }
    return {
      status: 404,
      ok: false,
      data: { message: `mock: unhandled ${method} ${path}` } as unknown as T,
    };
  }
}

function normalizeStatus(raw: string): NormalizedTrackingStatus {
  const s = raw.toLowerCase();
  if (s.includes("delivered") && !s.includes("partial")) return "delivered";
  if (s.includes("return")) return "rto";
  if (s.includes("cancel") || s.includes("fail")) return "failed";
  if (s.includes("out-for-delivery") || s.includes("out_for_delivery")) return "out_for_delivery";
  if (s.includes("picked-up") || s.includes("picked_up") || s.includes("pickup-success")) return "picked_up";
  if (s.includes("pickup-pending") || s.includes("pending") || s.includes("created")) return "pending";
  if (s.includes("hub") || s.includes("transit") || s.includes("received")) return "in_transit";
  return "unknown";
}

export interface RedxAdapterOptions {
  credentials: CourierCredentials;
  transport?: RedxTransport;
}

export class RedxAdapter implements CourierAdapter {
  readonly name = PROVIDER;
  private readonly transport: RedxTransport;

  constructor(private readonly opts: RedxAdapterOptions) {
    const baseUrl = (opts.credentials.baseUrl || env.REDX_BASE_URL).replace(/\/$/, "");
    this.transport =
      opts.transport ??
      (env.COURIER_MOCK || env.NODE_ENV === "test"
        ? new MockRedxTransport()
        : new HttpRedxTransport(baseUrl, opts.credentials.apiKey));
  }

  private breakerKey(): string {
    return `${PROVIDER}:${this.opts.credentials.accountId}`;
  }

  async validateCredentials(): Promise<ValidationResult> {
    try {
      const res = await withCourierBreaker(this.breakerKey(), (signal) =>
        withRetry(
          () =>
            this.transport.request<RedxAreasResp>("/v1/areas", {
              method: "GET",
              signal,
            }),
          { attempts: 2, signal },
        ),
      );
      if (!res.ok) {
        return { valid: false, message: `RedX rejected token (${res.status})` };
      }
      return { valid: true };
    } catch (err) {
      return { valid: false, message: (err as Error).message };
    }
  }

  async createAWB(order: AWBRequest): Promise<AWBResponse> {
    return withCourierBreaker(this.breakerKey(), async (signal) => {
      const body = {
        customer_name: order.customer.name,
        customer_phone: order.customer.phone,
        delivery_area: order.customer.district,
        delivery_area_id: undefined as number | undefined,
        customer_address: order.customer.address,
        merchant_invoice_id: order.orderNumber,
        cash_collection_amount: order.cod,
        parcel_weight: order.weight ?? 0.5,
        value: order.items.reduce((s, i) => s + i.price * i.quantity, 0),
        is_closed_box: true,
        parcel_details_json: order.items.map((i) => ({
          name: i.name,
          category: "general",
          value: i.price,
        })),
      };
      const res = await withRetry(
        () =>
          this.transport.request<RedxCreateResp>("/v1/parcel", {
            method: "POST",
            body,
            signal,
            headers: order.idempotencyKey
              ? { "Idempotency-Key": order.idempotencyKey }
              : undefined,
          }),
        { attempts: 3, signal },
      );
      if (!res.ok) {
        const { code, retryable } = classifyHttpStatus(res.status);
        throw new CourierError(code, `redx createAWB failed (${res.status})`, {
          retryable,
          status: res.status,
          provider: PROVIDER,
          raw: res.data,
        });
      }
      if (!res.data?.tracking_id) {
        throw new CourierError("provider_error", "redx response missing tracking_id", {
          provider: PROVIDER,
          raw: res.data,
        });
      }
      return {
        trackingNumber: res.data.tracking_id,
        providerOrderId: res.data.tracking_id,
        raw: res.data,
      };
    });
  }

  async getTracking(trackingNumber: string): Promise<TrackingInfo> {
    return withCourierBreaker(this.breakerKey(), async (signal) => {
      const res = await withRetry(
        () =>
          this.transport.request<RedxTrackResp>(
            `/v1/parcel/track/${encodeURIComponent(trackingNumber)}`,
            { method: "GET", signal },
          ),
        { attempts: 3, signal },
      );
      if (!res.ok) {
        const { code, retryable } = classifyHttpStatus(res.status);
        throw new CourierError(code, `redx getTracking failed (${res.status})`, {
          retryable,
          status: res.status,
          provider: PROVIDER,
          raw: res.data,
        });
      }
      const raw = res.data?.tracking ?? [];
      const events = raw.map((e) => ({
        at: e.parcel_log_time ? new Date(e.parcel_log_time) : new Date(),
        description: e.message ?? e.status ?? "update",
        location: e.location,
      }));
      const latest = raw[raw.length - 1]?.status ?? "unknown";
      const normalized = normalizeStatus(latest);
      return {
        trackingNumber,
        providerStatus: latest,
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
      const res = await withRetry(
        () =>
          this.transport.request<RedxPriceResp>("/v1/delivery-charge/calculate", {
            method: "POST",
            signal,
            body: {
              delivery_area: input.district,
              weight: Math.max(0.5, input.weight || 0.5),
              cash_collection_amount: input.cod ?? 0,
            },
          }),
        { attempts: 2, signal },
      );
      if (!res.ok) {
        const { code, retryable } = classifyHttpStatus(res.status);
        throw new CourierError(code, `redx priceQuote failed (${res.status})`, {
          retryable,
          status: res.status,
          provider: PROVIDER,
          raw: res.data,
        });
      }
      return {
        amount: res.data.data.total_fee,
        currency: "BDT",
        breakdown: {
          delivery: res.data.data.delivery_fee,
          cod: res.data.data.cash_on_delivery_fee,
        },
      };
    });
  }
}


/* -------------------------------------------------------------------------- */
/* Webhook handling                                                            */
/* -------------------------------------------------------------------------- */

/**
 * RedX webhook payload. RedX webhooks are opt-in per merchant — most
 * merchants do not have them enabled, so this adapter is intentionally
 * defensive about field shapes. The handler treats unknown shapes as
 * "ignored" (200 OK) so RedX does not keep retrying.
 */
export interface RedxWebhookPayload {
  /** RedX tracking id (== our trackingNumber). */
  tracking_id?: string;
  parcel_tracking_id?: string;
  customer_order_id?: string;
  /** RedX status name (e.g. "delivery-in-progress"). */
  status?: string;
  /** ISO timestamp. */
  status_change_time?: string;
  delivered_at?: string;
  /** Free-form human note from the rider/hub. */
  status_message?: string;
  hub?: string;
}

export interface ParsedRedxTracking {
  trackingCode: string;
  providerStatus: string;
  normalizedStatus: NormalizedTrackingStatus;
  at: Date;
  description?: string;
  location?: string;
  deliveredAt?: Date;
}

/**
 * Verify a RedX webhook. RedX signs the raw body with HMAC-SHA256 over
 * the merchant secret and ships it in `X-Redx-Signature`. Behavior is
 * identical to the Steadfast/Pathao verifiers — constant-time, never
 * throws, returns false on any malformed input.
 */
export function verifyRedxWebhookSignature(
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

export function parseRedxWebhook(payload: RedxWebhookPayload): ParsedRedxTracking | null {
  const trackingCode = payload.tracking_id ?? payload.parcel_tracking_id ?? "";
  if (!trackingCode) return null;
  const providerStatus = (payload.status ?? "unknown").trim();
  const at = payload.status_change_time ? new Date(payload.status_change_time) : new Date();
  const safeAt = Number.isNaN(at.getTime()) ? new Date() : at;
  const deliveredRaw = payload.delivered_at ? new Date(payload.delivered_at) : undefined;
  const safeDelivered = deliveredRaw && !Number.isNaN(deliveredRaw.getTime()) ? deliveredRaw : undefined;
  return {
    trackingCode,
    providerStatus,
    normalizedStatus: normalizeStatus(providerStatus),
    at: safeAt,
    description: payload.status_message ?? providerStatus,
    location: payload.hub,
    deliveredAt: safeDelivered,
  };
}

export const REDX_PROVIDER = PROVIDER;
