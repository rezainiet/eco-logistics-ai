import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type ConnectionTestResult,
  type FetchSampleResult,
  type IntegrationAdapter,
  type IntegrationCredentials,
  type NormalizedOrder,
} from "./types.js";

/**
 * Custom-API connector. The merchant pushes orders to our `/api/integrations/
 * webhook/custom_api/:integrationId` endpoint with a flexible payload shape:
 *
 * {
 *   externalId: string,
 *   orderNumber?: string,
 *   customer: { name, phone, address, district, email? },
 *   items?: [{ name, sku?, quantity, price }],
 *   cod?: number,
 *   total?: number,
 *   placedAt?: ISO string
 * }
 *
 * The HMAC header `x-ecom-signature: sha256=<hex>` is required when a
 * webhookSecret is set on the integration row. `testConnection` is a
 * no-op (the merchant just confirms a key roundtrip) and `fetchSampleOrders`
 * returns an empty list — there's no remote endpoint to query in pull mode.
 */

interface CustomPayload {
  externalId: string;
  orderNumber?: string;
  customer: {
    name?: string;
    phone: string;
    email?: string;
    address?: string;
    district?: string;
  };
  items?: Array<{ name?: string; sku?: string; quantity?: number; price?: number }>;
  cod?: number;
  total?: number;
  currency?: string;
  placedAt?: string;
  metadata?: Record<string, unknown>;
}

function normalizeCustom(payload: CustomPayload): NormalizedOrder | null {
  if (!payload?.externalId || !payload.customer?.phone) return null;
  const items = (payload.items ?? []).map((it) => ({
    name: it.name || "Item",
    sku: it.sku || undefined,
    quantity: Math.max(1, Number(it.quantity ?? 1)),
    price: Number(it.price ?? 0),
  }));
  const computedTotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const total = Number(payload.total ?? computedTotal);
  const cod = Number(payload.cod ?? total);
  return {
    externalId: String(payload.externalId),
    externalOrderNumber: payload.orderNumber,
    customer: {
      name: payload.customer.name?.trim() || "Customer",
      phone: payload.customer.phone,
      email: payload.customer.email,
      address: payload.customer.address?.trim() || "Address pending",
      district: payload.customer.district?.trim() || "Unknown",
    },
    items: items.length > 0 ? items : [{ name: "Item", quantity: 1, price: total }],
    cod,
    total,
    currency: payload.currency,
    placedAt: payload.placedAt ? new Date(payload.placedAt) : undefined,
    metadata: payload.metadata,
  };
}

export const customApiAdapter: IntegrationAdapter = {
  async testConnection(creds): Promise<ConnectionTestResult> {
    return {
      ok: !!creds.apiKey,
      detail: creds.apiKey
        ? "Custom API key registered — POST orders to /api/integrations/webhook/custom_api/:id"
        : "apiKey required",
    };
  },
  async fetchSampleOrders(): Promise<FetchSampleResult> {
    return { ok: true, count: 0, sample: [] };
  },
  normalizeWebhookPayload(_topic, payload) {
    return normalizeCustom(payload as CustomPayload);
  },
  verifyWebhookSignature({ rawBody, headers, secret }) {
    if (!secret) return true; // optional — only enforced when a secret is configured
    const hdr = headers["x-ecom-signature"];
    const provided = Array.isArray(hdr) ? hdr[0] : hdr;
    if (!provided || typeof provided !== "string") return false;
    const stripped = provided.startsWith("sha256=") ? provided.slice(7) : provided;
    const computed = createHmac("sha256", secret)
      .update(typeof rawBody === "string" ? rawBody : rawBody)
      .digest("hex");
    const a = Buffer.from(stripped);
    const b = Buffer.from(computed);
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  },
};
