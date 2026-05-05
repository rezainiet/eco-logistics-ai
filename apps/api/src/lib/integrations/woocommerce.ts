import { createHmac, timingSafeEqual } from "node:crypto";
import {
  IntegrationError,
  isNormalizationSkip,
  type ConnectionTestResult,
  type FetchSampleResult,
  type IntegrationAdapter,
  type IntegrationCredentials,
  type NormalizationOutcome,
  type NormalizedOrder,
} from "./types.js";
import { safeFetch } from "./safe-fetch.js";

/**
 * WooCommerce REST API connector.
 *
 * Auth: HTTP Basic with `consumerKey:consumerSecret`. Webhooks are signed with
 * a shared secret using base64(HMAC-SHA256(rawBody)).
 */

function siteBase(creds: IntegrationCredentials): string {
  if (!creds.siteUrl) throw new IntegrationError("woo: siteUrl required");
  return creds.siteUrl.replace(/\/$/, "");
}

function authHeader(creds: IntegrationCredentials): string {
  if (!creds.consumerKey || !creds.consumerSecret) {
    throw new IntegrationError("woo: consumerKey and consumerSecret required");
  }
  return "Basic " + Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString("base64");
}

async function callWoo<T>(creds: IntegrationCredentials, path: string): Promise<T> {
  // FIX (SSRF): use safeFetch which DNS-resolves and rejects private/
  // loopback/link-local addresses. Closes the rebinding gap left by the
  // static URL validator at connect time. No-op in dev/test.
  const res = await safeFetch(`${siteBase(creds)}/wp-json/wc/v3${path}`, {
    headers: {
      Authorization: authHeader(creds),
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new IntegrationError(`woo ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

interface WooLineItem {
  id: number;
  name: string;
  sku?: string;
  quantity: number;
  price?: number;
  total?: string;
}

interface WooOrderPayload {
  id: number;
  number?: string;
  total?: string;
  currency?: string;
  status?: string;
  payment_method?: string;
  payment_method_title?: string;
  date_created?: string;
  billing?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    email?: string;
    address_1?: string;
    address_2?: string;
    city?: string;
    state?: string;
  };
  shipping?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    address_1?: string;
    address_2?: string;
    city?: string;
    state?: string;
  };
  line_items?: WooLineItem[];
}

function normalizeWooOrder(
  payload: WooOrderPayload,
): NormalizationOutcome | null {
  // Missing upstream id → cannot dedupe or correlate. Surface as a
  // needs_attention skip so the merchant sees something happened.
  if (!payload?.id) {
    return { __skip: true, reason: "missing_external_id" };
  }
  const ship = payload.shipping ?? {};
  const billing = payload.billing ?? {};
  const name =
    `${ship.first_name ?? billing.first_name ?? ""} ${ship.last_name ?? billing.last_name ?? ""}`.trim() ||
    "Customer";
  const phone = ship.phone || billing.phone || "";
  // FIX: previously dropped to `null` (silent ignore). Now emits a skip
  // envelope that the inbox replay path routes to `needs_attention`,
  // notifying the merchant rather than disappearing the order.
  if (!phone) {
    return {
      __skip: true,
      reason: "missing_phone",
      externalId: String(payload.id),
    };
  }
  const address =
    [ship.address_1 || billing.address_1, ship.address_2 || billing.address_2]
      .filter(Boolean)
      .join(", ") || "Address pending";
  const district = ship.city || billing.city || ship.state || billing.state || "Unknown";
  const items: NormalizedOrder["items"] = (payload.line_items ?? []).map((li) => ({
    name: li.name || "Item",
    sku: li.sku || undefined,
    quantity: Number(li.quantity ?? 1),
    price: Number(li.total ?? li.price ?? 0) / Math.max(1, Number(li.quantity ?? 1)),
  }));
  const total = Number(payload.total ?? items.reduce((s, i) => s + i.price * i.quantity, 0));
  const cod = /cod|cash[_-]?on/i.test(payload.payment_method ?? "") ? total : 0;
  return {
    externalId: String(payload.id),
    externalOrderNumber: payload.number ?? undefined,
    customer: {
      name,
      phone,
      email: billing.email || undefined,
      address,
      district,
    },
    items: items.length > 0 ? items : [{ name: "Item", quantity: 1, price: total }],
    cod,
    total,
    currency: payload.currency,
    placedAt: payload.date_created ? new Date(payload.date_created) : undefined,
    metadata: {
      status: payload.status,
      payment_method: payload.payment_method,
    },
  };
}

/**
 * Auto-register inbound order webhooks with WooCommerce. Uses the WC REST
 * API's `/webhooks` endpoint with the integration's stored consumer key
 * pair. We subscribe to `order.created` and `order.updated` and use the
 * merchant's per-integration HMAC secret so deliveries verify against our
 * existing collector. Idempotent — existing matching subscriptions are
 * detected and skipped.
 */
export async function registerWooWebhooks(args: {
  siteUrl: string;
  consumerKey: string;
  consumerSecret: string;
  callbackUrl: string;
  webhookSecret: string;
  topics?: string[];
  fetchImpl?: typeof fetch;
}): Promise<{ registered: string[]; errors: string[] }> {
  const fetcher = args.fetchImpl ?? fetch;
  const base = args.siteUrl.replace(/\/$/, "");
  const auth = "Basic " +
    Buffer.from(`${args.consumerKey}:${args.consumerSecret}`).toString("base64");
  const topics = args.topics ?? ["order.created", "order.updated"];
  const registered: string[] = [];
  const errors: string[] = [];

  let existing: Map<string, string> = new Map();
  try {
    // FIX (SSRF): route the listing through safeFetch so a merchant-
    // supplied site URL whose hostname resolves into a private range is
    // rejected before any request fires. The injected `fetcher` is the
    // transport used INSIDE safeFetch (so test mocks still work).
    const listRes = await safeFetch(
      `${base}/wp-json/wc/v3/webhooks?per_page=100`,
      { headers: { Authorization: auth, Accept: "application/json" } },
      fetcher,
    );
    if (listRes.ok) {
      const body = (await listRes.json()) as Array<{ topic?: string; delivery_url?: string; status?: string }>;
      for (const w of body) {
        if (w.delivery_url === args.callbackUrl && w.topic && w.status === "active") {
          existing.set(w.topic, w.delivery_url);
        }
      }
    }
  } catch {
    // Best-effort listing.
  }

  for (const topic of topics) {
    if (existing.has(topic)) {
      registered.push(topic);
      continue;
    }
    try {
      // FIX (SSRF): see safeFetch comment above. Same guard applied to
      // the create-webhook call.
      const res = await safeFetch(
        `${base}/wp-json/wc/v3/webhooks`,
        {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            name: `Logistics ${topic}`,
            topic,
            delivery_url: args.callbackUrl,
            secret: args.webhookSecret,
            status: "active",
          }),
        },
        fetcher,
      );
      if (res.ok) {
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

export const wooAdapter: IntegrationAdapter = {
  async testConnection(creds): Promise<ConnectionTestResult> {
    if (!creds.siteUrl || !creds.consumerKey || !creds.consumerSecret) {
      return { ok: false, detail: "siteUrl, consumerKey, consumerSecret required" };
    }
    try {
      const data = await callWoo<{ environment?: { version?: string } }>(creds, "/system_status");
      return { ok: true, detail: `Connected (WC ${data.environment?.version ?? "?"})` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  },

  async fetchSampleOrders(creds, limit = 5): Promise<FetchSampleResult> {
    try {
      const orders = await callWoo<WooOrderPayload[]>(
        creds,
        `/orders?per_page=${Math.min(50, Math.max(1, limit))}`,
      );
      // Sample preview: drop null (irrelevant topics) AND skip envelopes
      // (orders that need merchant attention). The webhook path will
      // surface the skip envelopes via the inbox; here we just want a
      // clean preview of orders that would actually ingest cleanly.
      const sample = (orders ?? [])
        .map((o) => normalizeWooOrder(o))
        .filter((o): o is NormalizedOrder =>
          o !== null && !isNormalizationSkip(o),
        );
      return { ok: true, count: sample.length, sample };
    } catch (err) {
      return { ok: false, count: 0, sample: [], error: (err as Error).message };
    }
  },

  normalizeWebhookPayload(topic, payload) {
    if (!/order\.(created|updated)/i.test(topic)) return null;
    return normalizeWooOrder(payload as WooOrderPayload);
  },

  verifyWebhookSignature({ rawBody, headers, secret }) {
    if (!secret) return false;
    const hdr = headers["x-wc-webhook-signature"];
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

/**
 * Delete a list of webhook subscription IDs from a WooCommerce store.
 * Called from the integration disconnect flow so the merchant doesn't
 * keep getting deliveries to an endpoint we no longer accept.
 *
 * Per-id outcome:
 *   - 200/204 → counted as `deleted`
 *   - 404      → counted as `alreadyGone` (subscription already removed
 *                upstream — equivalent for our purposes)
 *   - other    → recorded as an error string
 *
 * Auth: Basic by default; falls through to querystring for stores that
 * sit behind reverse proxies which strip the Authorization header
 * (Cloudflare, some WAF rules). The persisted strategy is passed in so
 * we don't re-discover it on every call.
 */
export async function deleteWooWebhooks(args: {
  siteUrl: string;
  consumerKey: string;
  consumerSecret: string;
  webhookIds: number[];
  authStrategy?: "basic" | "querystring";
  fetchImpl?: typeof fetch;
}): Promise<
  | { ok: true; deleted: number; alreadyGone: number }
  | { ok: false; kind: string; detail: string }
> {
  const fetcher = args.fetchImpl ?? fetch;
  const base = args.siteUrl.replace(/\/$/, "");
  const useQuerystring = args.authStrategy === "querystring";
  const basicAuth =
    "Basic " +
    Buffer.from(`${args.consumerKey}:${args.consumerSecret}`).toString(
      "base64",
    );
  const qs = useQuerystring
    ? `&consumer_key=${encodeURIComponent(args.consumerKey)}&consumer_secret=${encodeURIComponent(args.consumerSecret)}`
    : "";

  let deleted = 0;
  let alreadyGone = 0;
  const errors: string[] = [];

  for (const id of args.webhookIds) {
    if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) {
      errors.push(`invalid id: ${String(id)}`);
      continue;
    }
    const url = `${base}/wp-json/wc/v3/webhooks/${id}?force=true${qs}`;
    try {
      // FIX (SSRF): same guard for DELETE — a malicious site URL must
      // not be able to talk to internal infra even on disconnect.
      const res = await safeFetch(
        url,
        {
          method: "DELETE",
          headers: useQuerystring
            ? { Accept: "application/json" }
            : {
                Authorization: basicAuth,
                Accept: "application/json",
              },
        },
        fetcher,
      );
      if (res.ok || res.status === 204) {
        deleted += 1;
      } else if (res.status === 404) {
        alreadyGone += 1;
      } else if (!useQuerystring && (res.status === 401 || res.status === 403)) {
        // Auth header was stripped by an upstream proxy. Retry once with
        // querystring auth — same behaviour registerWooWebhooks uses on
        // first contact.
        const retryUrl = `${base}/wp-json/wc/v3/webhooks/${id}?force=true&consumer_key=${encodeURIComponent(args.consumerKey)}&consumer_secret=${encodeURIComponent(args.consumerSecret)}`;
        const retry = await safeFetch(
          retryUrl,
          {
            method: "DELETE",
            headers: { Accept: "application/json" },
          },
          fetcher,
        );
        if (retry.ok || retry.status === 204) {
          deleted += 1;
        } else if (retry.status === 404) {
          alreadyGone += 1;
        } else {
          const detail = await retry.text().catch(() => "");
          errors.push(`${id}: ${retry.status} ${detail.slice(0, 120)}`);
        }
      } else {
        const detail = await res.text().catch(() => "");
        errors.push(`${id}: ${res.status} ${detail.slice(0, 120)}`);
      }
    } catch (err) {
      errors.push(`${id}: ${(err as Error).message.slice(0, 120)}`);
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      kind: "remote_error",
      detail: errors.slice(0, 5).join("; ").slice(0, 200),
    };
  }
  return { ok: true, deleted, alreadyGone };
}
