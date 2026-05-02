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
 * Steadfast Courier API (Packzy) adapter.
 *
 * Live endpoints:
 *   GET   /api/v1/get_balance                           → auth probe
 *   POST  /api/v1/create_order                          → create shipment
 *   GET   /api/v1/status_by_cid/{consignment_id}        → tracking
 *
 * Auth: two static headers — Api-Key + Secret-Key. No OAuth dance, no token
 * caching needed. Per-merchant baseUrl overrides STEADFAST_BASE_URL.
 */

const PROVIDER = "steadfast" as const;

interface SteadfastBalance {
  status: number;
  current_balance: number;
}
interface SteadfastCreateResp {
  status: number;
  message?: string;
  consignment?: {
    consignment_id: number;
    tracking_code: string;
    status?: string;
  };
}
interface SteadfastStatusResp {
  status: number;
  delivery_status: string;
  last_updated?: string;
}

export interface SteadfastTransport {
  request<T = unknown>(
    path: string,
    opts: HttpRequestOptions,
  ): Promise<{ status: number; ok: boolean; data: T }>;
}

class HttpSteadfastTransport implements SteadfastTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly secretKey: string,
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
          "api-key": this.apiKey,
          "secret-key": this.secretKey,
          ...(opts.headers ?? {}),
        },
      },
      PROVIDER,
    );
  }
}

export class MockSteadfastTransport implements SteadfastTransport {
  private static store = new Map<
    string,
    { orderId: string; createdAt: Date; status: string }
  >();
  private static counter = 1;

  static reset(): void {
    MockSteadfastTransport.store.clear();
    MockSteadfastTransport.counter = 1;
  }

  async request<T>(path: string, opts: HttpRequestOptions): Promise<{ status: number; ok: boolean; data: T }> {
    const method = opts.method ?? "GET";
    if (path.endsWith("/get_balance")) {
      return { status: 200, ok: true, data: { status: 200, current_balance: 500 } as unknown as T };
    }
    if (path.endsWith("/create_order") && method === "POST") {
      const body = opts.body as { invoice?: string } | undefined;
      const id = MockSteadfastTransport.counter++;
      const tracking = `SF${Date.now().toString(36).toUpperCase()}${id}`;
      MockSteadfastTransport.store.set(tracking, {
        orderId: body?.invoice ?? "unknown",
        createdAt: new Date(),
        status: "in_review",
      });
      return {
        status: 200,
        ok: true,
        data: {
          status: 200,
          consignment: {
            consignment_id: id,
            tracking_code: tracking,
            status: "in_review",
          },
        } as unknown as T,
      };
    }
    const m = /\/status_by_cid\/([^/?#]+)/.exec(path);
    if (m) {
      const rec = MockSteadfastTransport.store.get(m[1]!);
      if (!rec) {
        return { status: 404, ok: false, data: { status: 404, message: "not found" } as unknown as T };
      }
      return {
        status: 200,
        ok: true,
        data: {
          status: 200,
          delivery_status: rec.status,
          last_updated: new Date().toISOString(),
        } as unknown as T,
      };
    }
    return {
      status: 404,
      ok: false,
      data: { status: 404, message: `mock: unhandled ${method} ${path}` } as unknown as T,
    };
  }
}

function normalizeStatus(raw: string): NormalizedTrackingStatus {
  const s = raw.toLowerCase();
  if (s.includes("delivered")) return "delivered";
  if (s.includes("partial_delivered")) return "delivered";
  if (s.includes("hold")) return "in_transit";
  if (s.includes("return")) return "rto";
  if (s.includes("cancel")) return "failed";
  if (s.includes("unknown")) return "unknown";
  if (s.includes("in_review") || s.includes("pending")) return "pending";
  if (s.includes("delivery") || s.includes("out")) return "out_for_delivery";
  if (s.includes("transit")) return "in_transit";
  return "unknown";
}

export interface SteadfastAdapterOptions {
  credentials: CourierCredentials;
  transport?: SteadfastTransport;
}

export class SteadfastAdapter implements CourierAdapter {
  readonly name = PROVIDER;
  private readonly transport: SteadfastTransport;

  constructor(private readonly opts: SteadfastAdapterOptions) {
    const baseUrl = (opts.credentials.baseUrl || env.STEADFAST_BASE_URL).replace(/\/$/, "");
    this.transport =
      opts.transport ??
      (env.COURIER_MOCK || env.NODE_ENV === "test"
        ? new MockSteadfastTransport()
        : new HttpSteadfastTransport(
            baseUrl,
            opts.credentials.apiKey,
            opts.credentials.apiSecret ?? opts.credentials.apiKey,
          ));
  }

  private breakerKey(): string {
    return `${PROVIDER}:${this.opts.credentials.accountId}`;
  }

  async validateCredentials(): Promise<ValidationResult> {
    try {
      const res = await withCourierBreaker(this.breakerKey(), (signal) =>
        withRetry(
          () =>
            this.transport.request<SteadfastBalance>("/api/v1/get_balance", {
              method: "GET",
              signal,
            }),
          { attempts: 2, signal },
        ),
      );
      if (!res.ok) {
        return {
          valid: false,
          message: `Steadfast rejected credentials (${res.status})`,
        };
      }
      return { valid: true };
    } catch (err) {
      return { valid: false, message: (err as Error).message };
    }
  }

  async createAWB(order: AWBRequest): Promise<AWBResponse> {
    return withCourierBreaker(this.breakerKey(), async (signal) => {
      const body = {
        invoice: order.orderNumber,
        recipient_name: order.customer.name,
        recipient_phone: order.customer.phone,
        recipient_address: `${order.customer.address}, ${order.customer.district}`,
        cod_amount: order.cod,
        note: order.notes ?? order.items.map((i) => `${i.name} x${i.quantity}`).join(", "),
      };
      const res = await withRetry(
        () =>
          this.transport.request<SteadfastCreateResp>("/api/v1/create_order", {
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
        throw new CourierError(code, `steadfast createAWB failed (${res.status})`, {
          retryable,
          status: res.status,
          provider: PROVIDER,
          raw: res.data,
        });
      }
      const c = res.data?.consignment;
      if (!c?.tracking_code) {
        throw new CourierError(
          "provider_error",
          "steadfast response missing tracking_code",
          {
            provider: PROVIDER,
            raw: res.data,
          },
        );
      }
      return {
        trackingNumber: c.tracking_code,
        providerOrderId: String(c.consignment_id),
        raw: res.data,
      };
    });
  }

  async getTracking(trackingNumber: string): Promise<TrackingInfo> {
    return withCourierBreaker(this.breakerKey(), async (signal) => {
      const res = await withRetry(
        () =>
          this.transport.request<SteadfastStatusResp>(
            `/api/v1/status_by_cid/${encodeURIComponent(trackingNumber)}`,
            { method: "GET", signal },
          ),
        { attempts: 3, signal },
      );
      if (!res.ok) {
        const { code, retryable } = classifyHttpStatus(res.status);
        throw new CourierError(code, `steadfast getTracking failed (${res.status})`, {
          retryable,
          status: res.status,
          provider: PROVIDER,
          raw: res.data,
        });
      }
      const providerStatus = res.data?.delivery_status ?? "unknown";
      const normalized = normalizeStatus(providerStatus);
      const at = res.data?.last_updated ? new Date(res.data.last_updated) : new Date();
      return {
        trackingNumber,
        providerStatus,
        normalizedStatus: normalized,
        events: [{ at, description: providerStatus }],
        deliveredAt: normalized === "delivered" ? at : undefined,
        raw: res.data,
      };
    });
  }

  async priceQuote(input: { district: string; weight: number; cod?: number }): Promise<PriceQuote> {
    // Steadfast has no public price-quote endpoint — return their flat-rate
    // schedule so the UI/checkout can show an estimate. Real integrations
    // typically negotiate custom rates per merchant.
    const base = input.district.toLowerCase().includes("dhaka") ? 60 : 120;
    const extraKg = Math.max(0, Math.ceil((input.weight || 0.5) - 1));
    const codCharge = input.cod ? Math.round(input.cod * 0.01) : 0;
    return {
      amount: base + extraKg * 15 + codCharge,
      currency: "BDT",
      breakdown: { base, weight: extraKg * 15, cod: codCharge },
    };
  }
}


/* -------------------------------------------------------------------------- */
/* Webhook handling                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Steadfast push payload. Their docs describe two shapes — one used for
 * status webhooks (which we care about for the tracking pipeline) and a
 * "delivery report" used for COD reconciliation. We accept both via
 * optional fields and let the adapter normalize.
 */
export interface SteadfastWebhookPayload {
  notification_type?: string;
  consignment_id?: number | string;
  /** Steadfast invoice == our orderNumber. */
  invoice?: string;
  tracking_code?: string;
  status?: string;
  /** ISO timestamp from the courier. */
  updated_at?: string;
  cod_amount?: number;
  /** Free-form event note. */
  note?: string;
}

export interface ParsedTrackingWebhook {
  trackingCode: string;
  providerStatus: string;
  normalizedStatus: NormalizedTrackingStatus;
  at: Date;
  description?: string;
}

/**
 * Verify a Steadfast webhook HMAC. Steadfast signs the raw request body
 * with the merchant secret using HMAC-SHA256 and ships the hex digest
 * in the `x-steadfast-signature` header. Returns true on a constant-time
 * match. Returns false (never throws) on missing header, missing secret,
 * or mismatch — the caller decides the HTTP response.
 */
export function verifySteadfastWebhookSignature(
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
  // Length-safe constant-time compare.
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(computed, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Convert a Steadfast push payload into the shape our tracking pipeline
 * expects. Returns null if the payload does not name an order (e.g. a
 * test ping) — the caller should 200 those rather than 400.
 */
export function parseSteadfastWebhook(
  payload: SteadfastWebhookPayload,
): ParsedTrackingWebhook | null {
  const trackingCode = payload.tracking_code ?? (payload.consignment_id != null ? String(payload.consignment_id) : "");
  if (!trackingCode) return null;
  const providerStatus = (payload.status ?? "unknown").trim();
  const at = payload.updated_at ? new Date(payload.updated_at) : new Date();
  return {
    trackingCode,
    providerStatus,
    normalizedStatus: normalizeStatus(providerStatus),
    at: Number.isNaN(at.getTime()) ? new Date() : at,
    description: payload.note ?? providerStatus,
  };
}

export const STEADFAST_PROVIDER = PROVIDER;
