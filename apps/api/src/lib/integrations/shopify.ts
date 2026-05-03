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
 * Hard timeout for any outbound call to Shopify. Picked from the same place
 * Shopify themselves recommend for storefront API integrations — long enough
 * to cover normal latency tails (P99 ~3s for /admin endpoints) but short
 * enough that a stalled merchant tab doesn't sit forever. Override via
 * SHOPIFY_FETCH_TIMEOUT_MS for ops debugging.
 *
 * No exponential backoff here — the caller decides retry policy. We just
 * make sure a single attempt can't burn unbounded time.
 */
const SHOPIFY_FETCH_TIMEOUT_MS = Number(
  process.env.SHOPIFY_FETCH_TIMEOUT_MS ?? 10_000,
);

/**
 * Wrap fetch in an AbortController so we can enforce a hard ceiling without
 * leaking the timer (always cleared in finally). Throws an
 * `IntegrationError("shopify timeout: <op> after Nms")` so the caller can
 * differentiate a slow Shopify from a 5xx — both surface as different error
 * codes to the merchant.
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  opName: string,
  timeoutMs: number = SHOPIFY_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new IntegrationError(`shopify timeout: ${opName} after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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
  const res = await fetchWithTimeout(
    fetch,
    `${shopBase(creds)}${path}`,
    {
      ...init,
      headers: {
        "X-Shopify-Access-Token": creds.accessToken,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    },
    `callShopify ${init.method ?? "GET"} ${path}`,
  );
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

/**
 * Validate the HMAC Shopify appends to OAuth callback redirects (and to all
 * authenticated app requests). Spec: SHA-256 of the URL-encoded query string
 * with the `hmac` parameter removed, sorted by key, joined `k=v&k=v`.
 *
 * Returns false on any malformed input — never throws.
 */
export function verifyShopifyOAuthHmac(
  query: Record<string, string | string[] | undefined>,
  appSecret: string,
): boolean {
  const provided = typeof query.hmac === "string" ? query.hmac : null;
  if (!provided || !appSecret) return false;
  const entries: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(query)) {
    if (k === "hmac" || k === "signature") continue;
    if (Array.isArray(v)) {
      for (const item of v) entries.push([k, String(item)]);
    } else if (v !== undefined) {
      entries.push([k, String(v)]);
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const message = entries
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const computed = createHmac("sha256", appSecret).update(message).digest("hex");
  const a = Buffer.from(provided);
  const b = Buffer.from(computed);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export interface ShopifyOAuthExchangeResult {
  accessToken: string;
  scope: string;
}

/**
 * Exchange an authorization code for a permanent offline access token.
 *
 * `fetchImpl` defaults to global fetch — overridable so tests can stub the
 * network without touching the real Shopify endpoint.
 */
export async function exchangeShopifyCode(args: {
  shopDomain: string;
  apiKey: string;
  apiSecret: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<ShopifyOAuthExchangeResult> {
  const shop = args.shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const fetcher = args.fetchImpl ?? fetch;
  const res = await fetchWithTimeout(
    fetcher,
    `https://${shop}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: args.apiKey,
        client_secret: args.apiSecret,
        code: args.code,
      }),
    },
    "exchangeShopifyCode",
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new IntegrationError(`shopify oauth ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; scope?: string };
  if (!json.access_token) {
    throw new IntegrationError("shopify oauth: response missing access_token");
  }
  return { accessToken: json.access_token, scope: json.scope ?? "" };
}

/**
 * Compare what we ASKED for at install start with what Shopify actually
 * granted. Pure helper — does no IO, safe to call from anywhere. Returns
 * the missing scopes (requested - granted), normalized + deduplicated.
 *
 * Use case: after exchangeShopifyCode, the integration's `permissions`
 * array holds the scopes we requested. If any are missing from
 * `exchange.scope`, the merchant approved a subset (or our deployed app
 * doesn't actually declare them) and the integration is "degraded" — some
 * downstream calls will 403 even though the OAuth itself completed.
 */
export function diffShopifyScopes(
  requested: string[] | undefined | null,
  grantedRaw: string | undefined | null,
): { missing: string[]; granted: string[] } {
  const norm = (s: string) => s.trim().toLowerCase();
  const granted = new Set(
    (grantedRaw ?? "").split(",").map(norm).filter(Boolean),
  );
  const missing = (requested ?? [])
    .map(norm)
    .filter(Boolean)
    .filter((s) => !granted.has(s));
  // Dedup while preserving the requested order so error messages read like
  // "Missing: read_products, read_fulfillments" not "read_products,
  // read_products, read_fulfillments".
  return {
    missing: Array.from(new Set(missing)),
    granted: Array.from(granted),
  };
}

/**
 * Auto-register the order webhooks we care about with Shopify so the
 * merchant doesn't have to copy/paste the URL into the admin panel. We
 * subscribe to `orders/create` and `orders/updated` — that's enough to
 * cover both the new-order flow and downstream financial-status changes
 * (paid/refunded). Failures are reported back to the caller so the OAuth
 * callback can audit-log them, but never throw — the merchant can still
 * register manually if our auto-registration is rejected.
 */
export async function registerShopifyWebhooks(args: {
  shopDomain: string;
  accessToken: string;
  callbackUrl: string;
  topics?: string[];
  fetchImpl?: typeof fetch;
}): Promise<{ registered: string[]; errors: string[] }> {
  const fetcher = args.fetchImpl ?? fetch;
  const shop = args.shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  // Default topic set:
  //   - orders/create + orders/updated → real-time order sync
  //   - app/uninstalled → fired by Shopify when the merchant clicks
  //     Uninstall in their admin. Without subscribing, we'd keep
  //     showing the integration as `connected` in our dashboard
  //     until the merchant manually clicks trash. With it, the
  //     handler in webhooks/integrations.ts flips status to
  //     `disconnected` automatically.
  const topics = args.topics ?? [
    "orders/create",
    "orders/updated",
    "app/uninstalled",
  ];
  const registered: string[] = [];
  const errors: string[] = [];

  // List existing subscriptions first so re-runs don't pile up duplicates.
  // Listing is best-effort: if it fails we still attempt to register and
  // accept that a transient list failure may cause a duplicate-topic 422
  // on the POST below — handled gracefully there.
  let existing: Set<string> = new Set();
  try {
    const listRes = await fetchWithTimeout(
      fetcher,
      `https://${shop}/admin/api/2024-04/webhooks.json?address=${encodeURIComponent(args.callbackUrl)}`,
      {
        headers: {
          "X-Shopify-Access-Token": args.accessToken,
          Accept: "application/json",
        },
      },
      "registerShopifyWebhooks.list",
    );
    if (listRes.ok) {
      const body = (await listRes.json()) as { webhooks?: Array<{ topic?: string }> };
      existing = new Set((body.webhooks ?? []).map((w) => w.topic ?? "").filter(Boolean));
    }
  } catch {
    // Best-effort — fall through.
  }

  for (const topic of topics) {
    if (existing.has(topic)) {
      registered.push(topic);
      continue;
    }
    try {
      const res = await fetchWithTimeout(
        fetcher,
        `https://${shop}/admin/api/2024-04/webhooks.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": args.accessToken,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            webhook: { topic, address: args.callbackUrl, format: "json" },
          }),
        },
        `registerShopifyWebhooks.create:${topic}`,
      );
      if (res.ok) {
        registered.push(topic);
      } else if (res.status === 422) {
        // Shopify returns 422 when the topic+address pair already exists.
        // Treat that as success — the list-call earlier may have missed it
        // (eventual consistency on the listings endpoint).
        registered.push(topic);
      } else {
        const detail = await res.text().catch(() => "");
        errors.push(`${topic}: ${res.status} ${detail.slice(0, 120)}`);
      }
    } catch (err) {
      errors.push(`${topic}: ${(err as Error).message}`);
    }
  }
  return { registered, errors };
}

export type ShopifyShopInfo = {
  name: string;
  planName: string | null;
  email: string | null;
};

/**
 * Discriminated result for fetchShopifyShopInfo. The OAuth callback uses
 * this to decide whether a failed shop-info call indicates a real
 * problem with the freshly-issued token (auth) or a transient blip
 * (network/timeout/5xx). Auth failures degrade integration health;
 * transient failures are tolerated.
 */
export type ShopifyShopInfoResult =
  | { ok: true; shop: ShopifyShopInfo }
  | { ok: false; kind: "auth"; status: number; detail: string }
  | { ok: false; kind: "missing"; detail: string }
  | { ok: false; kind: "transient"; detail: string };

/**
 * Shop-info read. Doubles as a smoke-test of the freshly-issued access
 * token — if it returns 401/403 the token is bad even though the OAuth
 * exchange itself reported success (often a sign that scopes were
 * partially granted). Caller should set integration health.degraded on
 * `kind: "auth"` and tolerate `kind: "transient"`.
 */
export async function fetchShopifyShopInfo(args: {
  shopDomain: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<ShopifyShopInfoResult> {
  const fetcher = args.fetchImpl ?? fetch;
  const shop = args.shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetchWithTimeout(
      fetcher,
      `https://${shop}/admin/api/2024-04/shop.json`,
      {
        headers: {
          "X-Shopify-Access-Token": args.accessToken,
          Accept: "application/json",
        },
      },
      "fetchShopifyShopInfo",
    );
  } catch (err) {
    return { ok: false, kind: "transient", detail: (err as Error).message };
  }

  if (res.status === 401 || res.status === 403) {
    const detail = await res.text().catch(() => "");
    return { ok: false, kind: "auth", status: res.status, detail: detail.slice(0, 200) };
  }
  if (!res.ok) {
    return { ok: false, kind: "transient", detail: `HTTP ${res.status}` };
  }
  let json: { shop?: { name?: string; plan_name?: string; email?: string } };
  try {
    json = (await res.json()) as typeof json;
  } catch (err) {
    return { ok: false, kind: "transient", detail: (err as Error).message };
  }
  if (!json.shop?.name) {
    return { ok: false, kind: "missing", detail: "shop info response had no name" };
  }
  return {
    ok: true,
    shop: {
      name: json.shop.name,
      planName: json.shop.plan_name ?? null,
      email: json.shop.email ?? null,
    },
  };
}

/**
 * Discriminated result for revokeShopifyAccessToken. Callers
 * typically don't BLOCK the merchant-facing disconnect on a remote
 * revoke failure — the merchant should always be able to disconnect
 * locally — but they DO want the outcome on the audit row so a
 * stranded Shopify-side install (app still listed in the merchant's
 * Shopify admin) is debuggable from the audit log.
 */
export type ShopifyRevokeResult =
  | { ok: true }
  // Already revoked / never installed: 401/403/404 from Shopify all
  // mean "we have nothing to do here". Treat as success on our side.
  | { ok: true; alreadyRevoked: true; status: number }
  | { ok: false; kind: "transient"; detail: string }
  | { ok: false; kind: "remote_error"; status: number; detail: string };

/**
 * Revoke the merchant's access token on Shopify's side. Triggers
 * Shopify to:
 *   1. Remove the app from the merchant's Shopify admin (Apps section)
 *   2. Cancel every webhook subscription tied to this token
 *   3. Fire `app/uninstalled` back to our handler (which idempotently
 *      no-ops since we already disconnected locally)
 *
 * Endpoint: DELETE /admin/api/2024-04/api_permissions/current.json
 * Documented at:
 * https://shopify.dev/docs/api/admin-rest/2024-04/resources/accesstoken#delete-api-permissions-current
 *
 * Behaviour notes worth knowing:
 *   - 200 / 204     → token revoked.
 *   - 401 / 403     → token was already invalid (merchant uninstalled
 *                     from Shopify side, or token is stale). We treat
 *                     this as success — there's nothing left to revoke.
 *   - 404           → endpoint not found for this access token (also
 *                     "already revoked").
 *   - 5xx / network → transient. Caller should still soft-disconnect
 *                     locally and surface a "couldn't reach Shopify"
 *                     audit entry so the merchant can manually
 *                     uninstall from Shopify if they care to.
 */
export async function revokeShopifyAccessToken(args: {
  shopDomain: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<ShopifyRevokeResult> {
  const fetcher = args.fetchImpl ?? fetch;
  const shop = args.shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetchWithTimeout(
      fetcher,
      `https://${shop}/admin/api/2024-04/api_permissions/current.json`,
      {
        method: "DELETE",
        headers: {
          "X-Shopify-Access-Token": args.accessToken,
          Accept: "application/json",
        },
      },
      "revokeShopifyAccessToken",
    );
  } catch (err) {
    return { ok: false, kind: "transient", detail: (err as Error).message };
  }
  if (res.ok || res.status === 204) {
    return { ok: true };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return { ok: true, alreadyRevoked: true, status: res.status };
  }
  const detail = await res.text().catch(() => "");
  return {
    ok: false,
    kind: "remote_error",
    status: res.status,
    detail: detail.slice(0, 200),
  };
}
