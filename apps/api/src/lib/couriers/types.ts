import type { CourierProvider } from "@ecom/db";

export type CourierName = CourierProvider;

export type CourierErrorCode =
  | "auth_failed"
  | "network"
  | "timeout"
  | "rate_limited"
  | "invalid_input"
  | "provider_error"
  | "not_supported"
  | "unknown";

export class CourierError extends Error {
  readonly code: CourierErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly provider?: CourierName;
  readonly raw?: unknown;

  constructor(
    code: CourierErrorCode,
    message: string,
    opts: { retryable?: boolean; status?: number; provider?: CourierName; raw?: unknown } = {},
  ) {
    super(message);
    this.name = "CourierError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.provider = opts.provider;
    this.raw = opts.raw;
  }
}

export interface CourierCredentials {
  accountId: string;
  apiKey: string;
  apiSecret?: string;
  baseUrl?: string;
}

export interface AWBCustomer {
  name: string;
  phone: string;
  address: string;
  district: string;
}

export interface AWBItem {
  name: string;
  quantity: number;
  price: number;
}

export interface AWBRequest {
  orderNumber: string;
  customer: AWBCustomer;
  items: AWBItem[];
  cod: number;
  weight?: number;
  notes?: string;
}

export interface AWBResponse {
  trackingNumber: string;
  providerOrderId: string;
  estimatedDeliveryAt?: Date;
  fee?: number;
  raw?: unknown;
}

export type NormalizedTrackingStatus =
  | "pending"
  | "picked_up"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "failed"
  | "rto"
  | "unknown";

export interface TrackingEvent {
  at: Date;
  description: string;
  location?: string;
}

export interface TrackingInfo {
  trackingNumber: string;
  providerStatus: string;
  normalizedStatus: NormalizedTrackingStatus;
  events: TrackingEvent[];
  deliveredAt?: Date;
  raw?: unknown;
}

export interface PriceQuote {
  amount: number;
  currency: string;
  breakdown?: Record<string, number>;
  raw?: unknown;
}

export interface ValidationResult {
  valid: boolean;
  message?: string;
}

export interface CourierAdapter {
  readonly name: CourierName;
  validateCredentials(): Promise<ValidationResult>;
  createAWB(order: AWBRequest): Promise<AWBResponse>;
  getTracking(trackingNumber: string): Promise<TrackingInfo>;
  priceQuote(input: { district: string; weight: number; cod?: number }): Promise<PriceQuote>;
}
