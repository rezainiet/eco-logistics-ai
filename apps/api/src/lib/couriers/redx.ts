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
import { normalizeCourierStatus } from "./status-map.js";
import { secretsMatch } from "./webhook-auth.js";

/**
 * RedX Open API adapter.
 *
 * Paths follow the official RedX developer docs (redx.com.bd/developer-api):
 * production `openapi.redx.com.bd/v1.0.0-beta`, sandbox
 * `sandbox.redx.com.bd/v1.0.0-beta`.
 *   GET   /v1.0.0-beta/areas                        → validate token
 *   POST  /v1.0.0-beta/parcel                       → create parcel
 *   GET   /v1.0.0-beta/parcel/info/{tracking_id}    → current status (`parcel.status`)
 *   GET   /v1.0.0-beta/parcel/track/{tracking_id}   → timeline (`message_en`, `time`; no status)
 *   POST  /v1.0.0-beta/delivery-charge/calculate    → price quote. UNVERIFIED: the
 *         official docs list `/charge/charge_calculator` with a different
 *         request shape; left as-is pending a sandbox check.
 *
 * Auth: `API-ACCESS-TOKEN: Bearer <token>` header. Per-merchant baseUrl
 * overrides REDX_BASE_URL (host only; a trailing /v1.0.0-beta is tolerated).
 */

const PROVIDER = "redx" as const;
const API_PREFIX = "/v1.0.0-beta";

interface RedxAreasResp {
  data?: Array<{ id: number; name: string }>;
  message?: string;
}
interface RedxCreateResp {
  tracking_id: string;
  message?: string;
}
/** `/parcel/track` entry. Official fields: message_en, message_bn, time. */
interface RedxTrackEvent {
  message_en?: string;
  message_bn?: string;
  time?: string;
  /** Legacy/undocumented shape, still read if present. */
  parcel_log_time?: string;
  message?: string;
  location?: string;
}
interface RedxTrackResp {
  tracking: RedxTrackEvent[];
}
/** `/parcel/info` — the documented source of the parcel's current status. */
interface RedxInfoResp {
  parcel?: { tracking_id?: string; status?: string };
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
    const info = /\/parcel\/info\/([^/?#]+)/.exec(path);
    if (info && method === "GET") {
      const rec = MockRedxTransport.store.get(info[1]!);
      if (!rec) return { status: 404, ok: false, data: {} as unknown as T };
      return { status: 200, ok: true, data: { parcel: { tracking_id: info[1], status: rec.status } } as unknown as T };
    }
    const m = /\/parcel\/track\/([^/?#]+)/.exec(path);
    if (m && method === "GET") {
      const rec = MockRedxTransport.store.get(m[1]!);
      if (!rec) {
        return { status: 404, ok: false, data: { tracking: [] } as unknown as T };
      }
      // Official shape: message_en / message_bn / time — no status field.
      return {
        status: 200,
        ok: true,
        data: {
          tracking: [
            { message_en: "Package is created successfully", message_bn: "", time: rec.createdAt.toISOString() },
            { message_en: "Package is picked up", message_bn: "", time: new Date().toISOString() },
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

/** Exact table in status-map.ts — no substring matching. */
function normalizeStatus(raw: string): NormalizedTrackingStatus {
  return normalizeCourierStatus("redx", raw);
}

export interface RedxAdapterOptions {
  credentials: CourierCredentials;
  transport?: RedxTransport;
}

export class RedxAdapter implements CourierAdapter {
  readonly name = PROVIDER;
  private readonly transport: RedxTransport;

  constructor(private readonly opts: RedxAdapterOptions) {
    const baseUrl = (opts.credentials.baseUrl || env.REDX_BASE_URL)
      .replace(/\/+$/, "")
      .replace(new RegExp(`${API_PREFIX.replace(/\./g, "\\.")}$`), "");
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
            this.transport.request<RedxAreasResp>(`${API_PREFIX}/areas`, {
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
          this.transport.request<RedxCreateResp>(`${API_PREFIX}/parcel`, {
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
      const id = encodeURIComponent(trackingNumber);
      // Status: /parcel/info is the documented source (`parcel.status`);
      // /parcel/track entries carry only message_en / message_bn / time.
      const info = await withRetry(
        () => this.transport.request<RedxInfoResp>(`${API_PREFIX}/parcel/info/${id}`, { method: "GET", signal }),
        { attempts: 3, signal },
      );
      if (!info.ok) {
        const { code, retryable } = classifyHttpStatus(info.status);
        throw new CourierError(code, `redx getTracking failed (${info.status})`, {
          retryable,
          status: info.status,
          provider: PROVIDER,
          raw: info.data,
        });
      }
      // Timeline is best-effort: a failed /track never blocks the status.
      let raw: RedxTrackEvent[] = [];
      try {
        const track = await withRetry(
          () => this.transport.request<RedxTrackResp>(`${API_PREFIX}/parcel/track/${id}`, { method: "GET", signal }),
          { attempts: 2, signal },
        );
        if (track.ok) raw = track.data?.tracking ?? [];
      } catch {
        raw = [];
      }
      const events = raw.map((e) => {
        const at = new Date(e.time ?? e.parcel_log_time ?? Date.now());
        return {
          at: Number.isNaN(at.getTime()) ? new Date() : at,
          description: e.message_en ?? e.message ?? "update",
          location: e.location,
        };
      });
      const providerStatus = info.data?.parcel?.status?.trim() || "unknown";
      const normalized = normalizeStatus(providerStatus);
      return {
        trackingNumber,
        providerStatus,
        normalizedStatus: normalized,
        events,
        deliveredAt:
          normalized === "delivered" && events.length > 0
            ? events[events.length - 1]!.at
            : undefined,
        raw: info.data,
      };
    });
  }

  async priceQuote(input: { district: string; weight: number; cod?: number }): Promise<PriceQuote> {
    return withCourierBreaker(this.breakerKey(), async (signal) => {
      const res = await withRetry(
        () =>
          this.transport.request<RedxPriceResp>(`${API_PREFIX}/delivery-charge/calculate`, {
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
 * RedX webhook payload. Official format (redx.com.bd/developer-api):
 *   { tracking_number, timestamp, status, message_en, message_bn,
 *     invoice_number, delivery_type }
 * The older aliases below stay accepted. The handler treats unknown shapes
 * as "ignored" (200 OK) so RedX does not keep retrying.
 */
export interface RedxWebhookPayload {
  /** Official: RedX tracking id (== our trackingNumber). */
  tracking_number?: string;
  /** Official: time of the status change. */
  timestamp?: string;
  /** Official: RedX status (e.g. "delivery-in-progress"). */
  status?: string;
  /** Official: human-readable update. */
  message_en?: string;
  message_bn?: string;
  invoice_number?: string;
  delivery_type?: string;
  /** Legacy aliases. */
  tracking_id?: string;
  parcel_tracking_id?: string;
  customer_order_id?: string;
  status_change_time?: string;
  delivered_at?: string;
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
 * Authenticate a RedX webhook. RedX does not sign requests: per the
 * official docs the credential travels in the callback URL's query string
 * (`…/redx/<merchantId>?token=<token>`). The token must equal the courier
 * config's secret; compared in constant time, never logged.
 */
export function verifyRedxWebhookToken(token: unknown, secret: string | undefined): boolean {
  return secretsMatch(Array.isArray(token) ? token[0] : token, secret);
}

export function parseRedxWebhook(payload: RedxWebhookPayload): ParsedRedxTracking | null {
  const trackingCode = payload.tracking_number ?? payload.tracking_id ?? payload.parcel_tracking_id ?? "";
  if (!trackingCode) return null;
  const providerStatus = (payload.status ?? "unknown").trim();
  const when = payload.timestamp ?? payload.status_change_time;
  const at = when ? new Date(when) : new Date();
  const safeAt = Number.isNaN(at.getTime()) ? new Date() : at;
  const deliveredRaw = payload.delivered_at ? new Date(payload.delivered_at) : undefined;
  const safeDelivered = deliveredRaw && !Number.isNaN(deliveredRaw.getTime()) ? deliveredRaw : undefined;
  return {
    trackingCode,
    providerStatus,
    normalizedStatus: normalizeStatus(providerStatus),
    at: safeAt,
    description: payload.message_en ?? payload.status_message ?? providerStatus,
    location: payload.hub,
    deliveredAt: safeDelivered,
  };
}

export const REDX_PROVIDER = PROVIDER;
