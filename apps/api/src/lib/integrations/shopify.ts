import { createHmac, timingSafeEqual } from "node:crypto";
import {
  IntegrationError,
  type ConnectionTestResult,
  type FetchSampleResult,
  type IntegrationAdapter,
  type IntegrationCredentials,
  type NormalizedOrder,
} from "./types.js";

/**
 * Shopify connector.
 *
 * `apiKey`        — App API key (public; identifies the partner app)
 * `apiSecret`     — App secret used to validate HMACs from /admin/oauth/install + webhooks
 * `accessToken`   — Per-shop offline access token issued after OAuth callback
 * `siteUrl`       — `<shop>.myshopify.com`
 *
 * The OAuth dance lives in the integrations router (install URL + callback).
 * This file is the runtime side: live connection tests, sample order fetch,
 * payload normalization, and HMAC verification for inbound webhooks.
 */

function shopBase(creds: IntegrationCredentials): string {
  const url = creds.siteUrl?.trim();
  if (!url) throw new IntegrationError("shopify: siteUrl (shop domain) required");
  const host = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${host}/admin/api/2024-04`;
}

async function callShopify<T>(
  creds: IntegrationCredentials,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!creds.accessToken) {
    throw new IntegrationError("shopify: accessToken missing — complete OAuth first");
  }
  const res = await fetch(`${shopBase(creds)}${path}`, {
    ...init,
    headers: {
      "X-Shopify-Access-Token": creds.accessToken,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new IntegrationError(`shopify ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

interface ShopifyOrderItem {
  id: number;
  name?: string;
  title?: string;
  sku?: string;
  quantity: number;
  price: string;
}

interface ShopifyOrderPayload {
  id: number;
  name?: string;
  order_number?: number;
  email?: string;
  total_price?: string;
  currency?: string;
  created_at?: string;
  financial_status?: string;
  customer?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    email?: string;
  };
  shipping_address?: {
    name?: string;
    phone?: string;
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    country?: string;
  };
  line_items?: ShopifyOrderItem[];
  payment_gateway_names?: string[];
}

function normalizeShopifyOrder(payload: ShopifyOrderPayload): NormalizedOrder | null {
  if (!payload?.id) return null;
  const ship = payload.shipping_address ?? {};
  const customer = payload.customer ?? {};
  const name = ship.name?.trim() || `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim() || "Customer";
  const phone = ship.phone || customer.phone || "";
  if (!phone) return null;
  const address = [ship.address1, ship.address2].filter(Boolean).join(", ") || "Address pending";
  const district = ship.city?.trim() || ship.province?.trim() || "Unknown";
  const items = (payload.line_items ?? []).map((li) => ({
    name: li.title || li.name || "Item",
    sku: li.sku || undefined,
    quantity: Number(li.quantity ?? 1),
    price: Number(li.price ?? 0),
  }));
  const total = Number(payload.total_price ?? items.reduce((s, i) => s + i.price * i.quantity, 0));
  const cod = (payload.payment_gateway_names ?? []).some((g) => /cash on delivery|cod/i.test(g))
    ? total
    : 0;
  return {
    externalId: String(payload.id),
    externalOrderNumber: payload.name || (payload.order_number ? `#${payload.order_number}` : undefined),
    customer: {
      name,
      phone,
      email: customer.email || payload.email || undefined,
      address,
      district,
    },
    items: items.length > 0 ? items : [{ name: "Item", quantity: 1, price: total }],
    cod,
    total,
    currency: payload.currency,
    placedAt: payload.created_at ? new Date(payload.created_at) : undefined,
    metadata: {
      financial_status: payload.financial_status,
      payment_gateway: payload.payment_gateway_names?.join(",") ?? null,
    },
  };
}

export const shopifyAdapter: IntegrationAdapter = {
  async testConnection(creds): Promise<ConnectionTestResult> {
    if (!creds.siteUrl) return { ok: false, detail: "siteUrl required" };
    if (!creds.accessToken) return { ok: false, detail: "Complete OAuth to connect" };
    try {
      const data = await callShopify<{ shop: { name: string; plan_name: string } }>(
        creds,
        "/shop.json",
      );
      return { ok: true, detail: `Connected to ${data.shop.name} (${data.shop.plan_name})` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  },

  async fetchSampleOrders(creds, limit = 5): Promise<FetchSampleResult> {
    try {
      const data = await callShopify<{ orders: ShopifyOrderPayload[] }>(
        creds,
        `/orders.json?status=any&limit=${Math.min(50, Math.max(1, limit))}`,
      );
      const sample = (data.orders ?? [])
        .map((o) => normalizeShopifyOrder(o))
        .filter((o): o is NormalizedOrder => o !== null);
      return { ok: true, count: sample.length, sample };
    } catch (err) {
      return { ok: false, count: 0, sample: [], error: (err as Error).message };
    }
  },

  normalizeWebhookPayload(topic, payload) {
    if (!/^orders\/(create|paid|updated)/.test(topic)) return null;
    return normalizeShopifyOrder(payload as ShopifyOrderPayload);
  },

  verifyWebhookSignature({ rawBody, headers, secret }) {
    if (!secret) return false;
    const hdr = headers["x-shopify-hmac-sha256"];
    const provided = Array.isArray(hdr) ? hdr[0] : hdr;
    if (!provided || typeof provided !== "string") return false;
    const computed = createHmac("sha256", secret)
      .update(typeof rawBody === "string" ? rawBody : rawBody)
      .digest("base64");
    const a = Buffer.from(provided);
    const b = Buffer.from(computed);
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  },
};

/** Build the OAuth install URL for an app credentials → shop pair. */
export function buildShopifyInstallUrl(args: {
  shopDomain: string;
  apiKey: string;
  redirectUri: string;
  scopes: string[];
  state: string;
}): string {
  const shop = args.shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const params = new URLSearchParams({
    client_id: args.apiKey,
    scope: args.scopes.join(","),
    redirect_uri: args.redirectUri,
    state: args.state,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}
