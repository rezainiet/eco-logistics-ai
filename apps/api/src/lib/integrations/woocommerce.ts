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
import { loadBrandingFromStore } from "../branding-store.js";

/**
 * Hard timeout for any outbound call to a merchant's Woo store. Sized to
 * cover normal latency tails (Woo on shared hosting is slow but P99
 * usually clears in <5s) without letting a stalled BullMQ job hang the
 * worker. Overridable via WOO_FETCH_TIMEOUT_MS for ops debugging.
 *
 * Mirrors Shopify's SHOPIFY_FETCH_TIMEOUT_MS; intentionally a hair
 * longer because Woo runs on merchant-controlled infra (shared hosting,
 * unoptimised WordPress, plugin overhead) and 10s is a stretch on
 * cold-cache shops.
 */
const WOO_FETCH_TIMEOUT_MS = Number(
  process.env.WOO_FETCH_TIMEOUT_MS ?? 15_000,
);

/**
 * Retry policy for outbound Woo REST calls. WooCommerce + WP behind
 * Cloudflare/LiteSpeed returns 429 with `Retry-After` for plugin rate
 * limits and 502/503/504 when WP-FPM is recycling or when the upstream
 * is paging out under load. Three attempts at 500ms/1s/2s with light
 * jitter clears the typical hiccup without compounding latency.
 *
 * 401/403 are NOT retried here — those mean credentials are bad, and
 * deleteWooWebhooks's existing per-id auth fallback handles the
 * Cloudflare-strips-Authorization case at a higher level.
 */
const WOO_RETRY_MAX_ATTEMPTS = Number(
  process.env.WOO_RETRY_MAX_ATTEMPTS ?? 3,
);
const WOO_RETRY_BASE_DELAY_MS = Number(
  process.env.WOO_RETRY_BASE_DELAY_MS ?? 500,
);
const WOO_RETRY_MAX_DELAY_MS = Number(
  process.env.WOO_RETRY_MAX_DELAY_MS ?? 8_000,
);

function isWooRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function parseWooRetryAfterMs(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.min(asNumber * 1000, WOO_RETRY_MAX_DELAY_MS);
  }
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    return Math.min(
      Math.max(asDate - Date.now(), 0),
      WOO_RETRY_MAX_DELAY_MS,
    );
  }
  return null;
}

/**
 * Wraps `safeFetch` (which already enforces the SSRF guard) with a
 * hard per-attempt timeout AND retry-on-429-and-5xx with backoff.
 * Network/timeout errors are not retried here — they bubble up so the
 * caller (or its BullMQ job retry policy) decides.
 *
 * Returns the final Response. The caller is responsible for
 * interpreting `res.ok` and surfacing 4xx errors (which we deliberately
 * don't swallow — auth/scope errors should reach the merchant).
 */
async function fetchWooWithBackoff(
  url: string,
  init: RequestInit,
  opName: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = WOO_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const maxAttempts = Math.max(1, WOO_RETRY_MAX_ATTEMPTS);
  let lastRes: Response | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await safeFetch(
        url,
        { ...init, signal: controller.signal },
        fetchImpl,
      );
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error)?.name === "AbortError") {
        throw new IntegrationError(
          `woo timeout: ${opName} after ${timeoutMs}ms`,
        );
      }
      throw err;
    }
    clearTimeout(timer);
    if (res.ok || !isWooRetryableStatus(res.status)) {
      return res;
    }
    lastRes = res;
    // Drain the body so the underlying socket can be released for reuse.
    await res.text().catch(() => undefined);
    if (attempt >= maxAttempts) break;
    const retryAfterMs = parseWooRetryAfterMs(res.headers.get("retry-after"));
    const backoffMs =
      retryAfterMs ??
      Math.min(
        WOO_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        WOO_RETRY_MAX_DELAY_MS,
      );
    const jitter = Math.floor(Math.random() * 100);
    await new Promise((r) => setTimeout(r, backoffMs + jitter));
  }
  return lastRes!;
}

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
  // Honor the persisted auth wire form. When the merchant's site is
  // behind a proxy that strips the Authorization header (Cloudflare,
  // some WAF rules), connect-time probing flips the strategy to
  // "querystring" so every subsequent call appends consumer_key /
  // consumer_secret on the URL instead.
  const useQuerystring = creds.authStrategy === "querystring";
  if (!creds.consumerKey || !creds.consumerSecret) {
    throw new IntegrationError("woo: consumerKey and consumerSecret required");
  }
  const base = `${siteBase(creds)}/wp-json/wc/v3${path}`;
  const url = useQuerystring
    ? base +
      (base.includes("?") ? "&" : "?") +
      `consumer_key=${encodeURIComponent(creds.consumerKey)}` +
      `&consumer_secret=${encodeURIComponent(creds.consumerSecret)}`
    : base;
  const headers: Record<string, string> = useQuerystring
    ? { Accept: "application/json" }
    : {
        Authorization: authHeader(creds),
        Accept: "application/json",
      };

  // safeFetch + retry-on-429-and-5xx + per-attempt timeout. The
  // backoff helper still routes through safeFetch internally so the
  // SSRF guard fires on every retry attempt (an attacker can't bait
  // the first call into a public IP and the retry into a private one).
  const res = await fetchWooWithBackoff(
    url,
    { headers },
    `callWoo GET ${path}`,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429) {
      throw new IntegrationError(
        `woo rate limit (429) — exhausted retries: ${body.slice(0, 200)}`,
      );
    }
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
 * Probe the Woo store to determine whether HTTP Basic auth survives the
 * merchant's reverse-proxy stack. Some Cloudflare / WAF / mod_security
 * configurations strip the `Authorization` header entirely (or replace
 * it with the proxy's own bearer), so any Basic-auth call returns 401.
 * WooCommerce accepts the same credentials as `?consumer_key=…&
 * consumer_secret=…` querystring, which proxies don't touch.
 *
 * Strategy:
 *   1. Try `GET /wp-json/wc/v3` with Basic. 200 → "basic" wins.
 *   2. On 401/403, retry with querystring. 200 → "querystring" wins.
 *   3. Any other outcome (404, network, 5xx-after-retries) → return
 *      `null` and let the caller decide. Returning Basic by default
 *      would be wrong because the very next call (webhook create) would
 *      fail the same way.
 *
 * The persisted strategy is consumed by `registerWooWebhooks` +
 * `deleteWooWebhooks` so connect-time webhook subscription succeeds
 * on stores where Basic is stripped.
 */
export async function probeWooAuthStrategy(args: {
  siteUrl: string;
  consumerKey: string;
  consumerSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  strategy: "basic" | "querystring" | null;
  detail: string;
}> {
  const fetcher = args.fetchImpl ?? fetch;
  const base = args.siteUrl.replace(/\/$/, "");
  const auth =
    "Basic " +
    Buffer.from(`${args.consumerKey}:${args.consumerSecret}`).toString("base64");
  // Cheap discovery endpoint that requires authenticated access but is
  // not capability-gated (admin or shop_manager both see it). Avoids
  // /orders which can be an expensive query on large stores.
  const basicUrl = `${base}/wp-json/wc/v3`;
  try {
    const res = await fetchWooWithBackoff(
      basicUrl,
      {
        headers: {
          Authorization: auth,
          Accept: "application/json",
        },
      },
      "probeWooAuthStrategy.basic",
      fetcher,
    );
    if (res.ok) return { strategy: "basic", detail: `basic:${res.status}` };
    if (res.status !== 401 && res.status !== 403) {
      // Not an auth-stripping signature — surface the status so the
      // caller can show a meaningful error (404 wrong URL, 5xx outage).
      const detail = await res.text().catch(() => "");
      return {
        strategy: null,
        detail: `basic:${res.status} ${detail.slice(0, 120)}`,
      };
    }
  } catch (err) {
    return {
      strategy: null,
      detail: `basic:${(err as Error).message.slice(0, 120)}`,
    };
  }
  // Fall through: Basic returned 401/403. Try querystring.
  const qsUrl =
    `${base}/wp-json/wc/v3` +
    `?consumer_key=${encodeURIComponent(args.consumerKey)}` +
    `&consumer_secret=${encodeURIComponent(args.consumerSecret)}`;
  try {
    const res = await fetchWooWithBackoff(
      qsUrl,
      { headers: { Accept: "application/json" } },
      "probeWooAuthStrategy.querystring",
      fetcher,
    );
    if (res.ok) {
      return { strategy: "querystring", detail: `querystring:${res.status}` };
    }
    const detail = await res.text().catch(() => "");
    return {
      strategy: null,
      detail: `querystring:${res.status} ${detail.slice(0, 120)}`,
    };
  } catch (err) {
    return {
      strategy: null,
      detail: `querystring:${(err as Error).message.slice(0, 120)}`,
    };
  }
}

/**
 * Auto-register inbound order webhooks with WooCommerce. Uses the WC REST
 * API's `/webhooks` endpoint with the integration's stored consumer key
 * pair. We subscribe to `order.created`, `order.updated`, and
 * `order.deleted` (so trashed orders flip to removed) and use the
 * merchant's per-integration HMAC secret so deliveries verify against
 * our existing collector. Idempotent — existing matching subscriptions
 * are detected and skipped.
 */
export interface WooWebhookSubscription {
  topic: string;
  id: number;
  deliveryUrl: string;
}

export interface RegisterWooWebhooksResult {
  registered: WooWebhookSubscription[];
  errors: string[];
  /**
   * Resolved Woo auth wire form. Reflects the input `authStrategy` so
   * callers can persist the value once and round-trip it on retries
   * without re-running the probe.
   */
  authStrategy?: "basic" | "querystring";
}

export async function registerWooWebhooks(args: {
  siteUrl: string;
  consumerKey: string;
  consumerSecret: string;
  callbackUrl: string;
  webhookSecret: string;
  topics?: string[];
  fetchImpl?: typeof fetch;
  /**
   * Resolved Woo auth wire form. When "querystring", credentials are
   * passed as `?consumer_key=…&consumer_secret=…` instead of an
   * Authorization header — required for stores behind proxies that
   * strip Authorization (Cloudflare, some WAF rules). When omitted or
   * "basic", we use the Authorization header form. The persisted
   * strategy is round-tripped via the return value so callers can
   * skip re-probing on retries.
   */
  authStrategy?: "basic" | "querystring";
}): Promise<RegisterWooWebhooksResult> {
  const fetcher = args.fetchImpl ?? fetch;
  const base = args.siteUrl.replace(/\/$/, "");
  const useQuerystring = args.authStrategy === "querystring";
  const auth = "Basic " +
    Buffer.from(`${args.consumerKey}:${args.consumerSecret}`).toString("base64");
  const credsQs =
    `consumer_key=${encodeURIComponent(args.consumerKey)}` +
    `&consumer_secret=${encodeURIComponent(args.consumerSecret)}`;
  const authHeaders: Record<string, string> = useQuerystring
    ? { Accept: "application/json" }
    : { Authorization: auth, Accept: "application/json" };
  const topics = args.topics ?? [
    "order.created",
    "order.updated",
    // FIX: trashed orders in Woo now flip to "removed" in our system
    // rather than leaving stale rows that look still-active in
    // dashboards. The handler in webhooks/integrations.ts treats
    // order.deleted as a tombstone marker.
    "order.deleted",
  ];
  const registered: WooWebhookSubscription[] = [];
  const errors: string[] = [];

  // Map topic → (id, deliveryUrl) for already-registered subscriptions
  // so re-runs can adopt the existing id rather than create a duplicate.
  const existing = new Map<string, { id: number; deliveryUrl: string }>();
  try {
    // SSRF guard + retry-on-429-and-5xx + timeout. safeFetch is invoked
    // internally on every attempt so the DNS-rebind protection fires
    // for retries too. Auth wire form (header vs querystring) follows
    // the persisted strategy so first-install on Cloudflare-fronted
    // shops succeeds.
    const listUrl =
      `${base}/wp-json/wc/v3/webhooks?per_page=100` +
      (useQuerystring ? `&${credsQs}` : "");
    const listRes = await fetchWooWithBackoff(
      listUrl,
      { headers: authHeaders },
      "registerWooWebhooks.list",
      fetcher,
    );
    if (listRes.ok) {
      const body = (await listRes.json()) as Array<{
        id?: number;
        topic?: string;
        delivery_url?: string;
        status?: string;
      }>;
      for (const w of body) {
        if (
          w.delivery_url === args.callbackUrl &&
          w.topic &&
          w.status === "active" &&
          typeof w.id === "number"
        ) {
          existing.set(w.topic, { id: w.id, deliveryUrl: w.delivery_url });
        }
      }
    }
  } catch {
    // Best-effort listing.
  }

  for (const topic of topics) {
    const seen = existing.get(topic);
    if (seen) {
      registered.push({ topic, id: seen.id, deliveryUrl: seen.deliveryUrl });
      continue;
    }
    try {
      // SSRF guard + retry-on-429-and-5xx + timeout on the create call too.
      // Auth wire form follows the persisted strategy (Basic header vs
      // querystring) so first-install on Cloudflare-fronted shops works.
      const createUrl =
        `${base}/wp-json/wc/v3/webhooks` +
        (useQuerystring ? `?${credsQs}` : "");
      const createHeaders: Record<string, string> = useQuerystring
        ? {
            "Content-Type": "application/json",
            Accept: "application/json",
          }
        : {
            Authorization: auth,
            "Content-Type": "application/json",
            Accept: "application/json",
          };
      const res = await fetchWooWithBackoff(
        createUrl,
        {
          method: "POST",
          headers: createHeaders,
          body: JSON.stringify({
            // Webhook display name — visible to merchants in
            // WooCommerce → Settings → Advanced → Webhooks. Reads from
            // centralized branding so a rebrand only touches one place.
            // Existing webhooks keep their old name until the dedicated
            // migration runs (see BRANDING_ARCHITECTURE.md § 4.5); the
            // delivery_url + secret are unchanged so events never miss.
            name: `${(await loadBrandingFromStore()).operational.woocommerceWebhookPrefix} ${topic}`,
            topic,
            delivery_url: args.callbackUrl,
            secret: args.webhookSecret,
            status: "active",
          }),
        },
        `registerWooWebhooks.create:${topic}`,
        fetcher,
      );
      if (res.ok) {
        // Capture the upstream id so disconnect can DELETE /webhooks/{id}
        // symmetrically. Falls back to id=0 if the response body is
        // missing the field — the disconnect path filters those out.
        let id = 0;
        try {
          const body = (await res.json()) as { id?: number };
          if (typeof body.id === "number") id = body.id;
        } catch {
          /* non-JSON body — leave id at 0 */
        }
        registered.push({ topic, id, deliveryUrl: args.callbackUrl });
      } else {
        const detail = await res.text().catch(() => "");
        errors.push(`${topic}: ${res.status} ${detail.slice(0, 120)}`);
      }
    } catch (err) {
      errors.push(`${topic}: ${(err as Error).message}`);
    }
  }
  return {
    registered,
    errors,
    ...(args.authStrategy ? { authStrategy: args.authStrategy } : {}),
  };
}

export const wooAdapter: IntegrationAdapter = {
  async testConnection(creds): Promise<ConnectionTestResult> {
    if (!creds.siteUrl || !creds.consumerKey || !creds.consumerSecret) {
      return { ok: false, detail: "siteUrl, consumerKey, consumerSecret required" };
    }
    // Probe auth wire form first when the stored credentials don't
    // already pin a strategy. This handles the Cloudflare-strips-
    // Authorization case at the first call instead of leaving a
    // freshly-connected integration in "401" limbo until the merchant
    // hits Test connection manually.
    let resolvedStrategy: "basic" | "querystring" | undefined =
      creds.authStrategy;
    if (!resolvedStrategy) {
      const probe = await probeWooAuthStrategy({
        siteUrl: creds.siteUrl,
        consumerKey: creds.consumerKey,
        consumerSecret: creds.consumerSecret,
      });
      if (!probe.strategy) {
        return {
          ok: false,
          kind: "auth",
          detail: `woo auth probe failed: ${probe.detail}`,
        };
      }
      resolvedStrategy = probe.strategy;
    }
    const credsWithStrategy: IntegrationCredentials = {
      ...creds,
      authStrategy: resolvedStrategy,
    };
    try {
      // /system_status returns version + plugin metadata. Cheap and
      // requires authenticated access (admin/shop_manager).
      const data = await callWoo<{ environment?: { version?: string } }>(
        credsWithStrategy,
        "/system_status",
      );
      // Scope verification: ping /orders?per_page=1 so an integration
      // configured with write-only keys (no `read:orders` permission)
      // surfaces a meaningful 401/403 inline rather than at first
      // order delivery. Failure here flips the result to ok=false with
      // kind=scope so the dashboard can prompt for re-issued keys.
      try {
        await callWoo<unknown[]>(credsWithStrategy, "/orders?per_page=1");
      } catch (scopeErr) {
        const msg = (scopeErr as Error).message;
        // Treat 401/403 as scope problems; anything else (network,
        // 5xx after retries) is surfaced as the original error.
        if (/\b40[13]\b/.test(msg)) {
          return {
            ok: false,
            kind: "scope",
            detail: `woo /orders rejected (${msg.slice(0, 120)}) — verify read:orders permission`,
            authStrategy: resolvedStrategy,
          };
        }
        return {
          ok: false,
          detail: `woo /orders failed: ${msg.slice(0, 200)}`,
          authStrategy: resolvedStrategy,
        };
      }
      return {
        ok: true,
        detail: `Connected (WC ${data.environment?.version ?? "?"})`,
        authStrategy: resolvedStrategy,
      };
    } catch (err) {
      return {
        ok: false,
        detail: (err as Error).message,
        authStrategy: resolvedStrategy,
      };
    }
  },

  async fetchSampleOrders(creds, limit = 5, since?: Date): Promise<FetchSampleResult> {
    try {
      const params = new URLSearchParams({
        per_page: String(Math.min(50, Math.max(1, limit))),
        orderby: "date",
        order: "asc",
        status: "any",
      });
      if (since) params.set("after", since.toISOString());
      const orders = await callWoo<WooOrderPayload[]>(
        creds,
        `/orders?${params.toString()}`,
      );
      // Sample preview: drop null (irrelevant topics) AND skip envelopes
      // (orders that need merchant attention). The webhook path will
      // surface the skip envelopes via the inbox; here we just want a
      // clean preview of orders that would actually ingest cleanly.
      const rawOrders = orders ?? [];
      const sample = rawOrders
        .map((o) => normalizeWooOrder(o))
        .filter((o): o is NormalizedOrder =>
          o !== null && !isNormalizationSkip(o),
        );
      return {
        ok: true,
        count: sample.length,
        sample,
        rawDeliveries: rawOrders
          .filter((o) => o?.id)
          .map((o) => ({
            topic: "order.created",
            externalId: String(o.id),
            payload: o,
            placedAt: o.date_created ? new Date(o.date_created) : undefined,
          })),
      };
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
      // SSRF guard + retry-on-429-and-5xx + timeout. 401/403 are
      // surfaced (not retried) so the Cloudflare-strips-Authorization
      // fallback below can swap auth strategies.
      const res = await fetchWooWithBackoff(
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
        `deleteWooWebhooks:${id}`,
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
        const retry = await fetchWooWithBackoff(
          retryUrl,
          {
            method: "DELETE",
            headers: { Accept: "application/json" },
          },
          `deleteWooWebhooks:${id}:querystring`,
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
