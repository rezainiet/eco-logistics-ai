import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import type { PlanTier } from "./plans.js";

/**
 * Thin Stripe client.
 *
 * Uses fetch + form-encoded payloads against the official REST API so we can
 * keep `npm install` graph small and not pin a major Stripe SDK version. This
 * file is the only place Stripe-specific protocol logic lives — everything
 * else (router, webhook) talks through these helpers.
 *
 * Supported call sites:
 *   1. `createCheckoutSession`         — legacy one-shot (mode: payment)
 *   2. `createSubscriptionCheckout`    — recurring subscription (mode: subscription)
 *   3. `createCustomer`                — bootstrap a Stripe customer
 *   4. `createPortalSession`           — hosted customer portal
 *   5. `verifyStripeWebhook`           — HMAC verification on raw inbound body
 *
 * In dev / test (no STRIPE_SECRET_KEY), all `create*` helpers return
 * deterministic mocks so tests can assert the surface without hitting Stripe.
 */

const API_BASE = "https://api.stripe.com/v1";

const PRICE_ENV_KEY: Record<PlanTier, keyof typeof env> = {
  starter: "STRIPE_PRICE_STARTER",
  growth: "STRIPE_PRICE_GROWTH",
  scale: "STRIPE_PRICE_SCALE",
  enterprise: "STRIPE_PRICE_ENTERPRISE",
};

/**
 * Resolve the Stripe Price id for a plan tier. Returns `null` when the
 * env var is unset — callers turn that into a user-facing 400 ("plan not
 * available for subscription yet, run `npm run stripe:seed`") rather than
 * minting a broken Checkout session.
 */
export function getPriceIdForPlan(tier: PlanTier): string | null {
  const envKey = PRICE_ENV_KEY[tier];
  const value = env[envKey];
  return typeof value === "string" && value.trim() ? value : null;
}

async function stripeRequest<T>(
  path: string,
  opts: { method: "GET" | "POST"; body?: Record<string, string | number | undefined> } = {
    method: "GET",
  },
): Promise<T> {
  const apiKey = env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    throw new Error("stripe: STRIPE_SECRET_KEY missing — call sites should mock-branch first");
  }
  const init: RequestInit = {
    method: opts.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (opts.body) init.body = form(opts.body);
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`stripe ${res.status} ${path}: ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export interface StripeCheckoutLineItemPrice {
  /** Stripe Price ID — preferred, lets pricing live in Stripe dashboard. */
  priceId?: string;
  /**
   * Inline price (BDT smallest unit = paisa, USD/INR cents). When neither
   * `priceId` nor inline price is provided, the call throws.
   */
  amountSmallestUnit?: number;
  currency?: string;
  productName?: string;
}

export interface CreateCheckoutSessionInput {
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  plan: StripeCheckoutLineItemPrice;
  /** Persisted on the session as `metadata` so the webhook can resolve us. */
  metadata: Record<string, string>;
  /** Stripe expects a string-typed mode. We only use one-time `payment` today. */
  mode?: "payment" | "subscription";
}

export interface CreateCheckoutSessionResult {
  id: string;
  url: string;
  /** True when no STRIPE_SECRET_KEY is configured and we minted a stub. */
  mocked: boolean;
}

function form(body: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    params.append(k, String(v));
  }
  return params.toString();
}

export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
): Promise<CreateCheckoutSessionResult> {
  const apiKey = env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    // Dev/test stub — gives the UI something usable without leaking real
    // calls. The deterministic id makes test assertions trivial.
    const stubId = `cs_mock_${Buffer.from(input.customerEmail).toString("base64url").slice(0, 12)}`;
    const url = `${input.successUrl}${input.successUrl.includes("?") ? "&" : "?"}stripe_mock=1&session_id=${stubId}`;
    return { id: stubId, url, mocked: true };
  }

  const params: Record<string, string | number | undefined> = {
    mode: input.mode ?? "payment",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    customer_email: input.customerEmail,
    "payment_method_types[0]": "card",
    "line_items[0][quantity]": 1,
  };
  if (input.plan.priceId) {
    params["line_items[0][price]"] = input.plan.priceId;
  } else if (input.plan.amountSmallestUnit && input.plan.currency) {
    params["line_items[0][price_data][currency]"] = input.plan.currency.toLowerCase();
    params["line_items[0][price_data][unit_amount]"] = input.plan.amountSmallestUnit;
    params["line_items[0][price_data][product_data][name]"] =
      input.plan.productName ?? "Subscription";
  } else {
    throw new Error("createCheckoutSession: priceId or inline amount required");
  }
  for (const [k, v] of Object.entries(input.metadata)) {
    params[`metadata[${k}]`] = v;
    // Mirror onto payment_intent so the charge object also has it.
    params[`payment_intent_data[metadata][${k}]`] = v;
  }

  const res = await fetch(`${API_BASE}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form(params),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`stripe ${res.status}: ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as { id: string; url: string };
  if (!body?.id || !body?.url) {
    throw new Error("stripe: malformed checkout session response");
  }
  return { id: body.id, url: body.url, mocked: false };
}

/**
 * Stripe-compatible HMAC verification — reads the leftmost `t=` and `v1=`
 * fields from the `Stripe-Signature` header, recomputes the signature over
 * `${t}.${rawBody}`, and constant-time-compares. Allows a 5-minute clock
 * drift by default (Stripe's recommendation).
 */
export function verifyStripeWebhook(args: {
  rawBody: string;
  signatureHeader: string | string[] | undefined;
  secret: string;
  toleranceSeconds?: number;
}): { ok: true; timestampMs: number } | { ok: false; reason: string } {
  const tolerance = args.toleranceSeconds ?? 300;
  const header = Array.isArray(args.signatureHeader)
    ? args.signatureHeader[0]
    : args.signatureHeader;
  if (!header) return { ok: false, reason: "missing_signature" };

  const fields = header.split(",").map((p) => p.trim());
  let t: number | null = null;
  const v1: string[] = [];
  for (const f of fields) {
    const eq = f.indexOf("=");
    if (eq < 0) continue;
    const k = f.slice(0, eq);
    const v = f.slice(eq + 1);
    if (k === "t") {
      const num = Number(v);
      if (Number.isFinite(num)) t = num;
    } else if (k === "v1") {
      v1.push(v);
    }
  }
  if (t === null) return { ok: false, reason: "missing_timestamp" };
  if (v1.length === 0) return { ok: false, reason: "missing_v1" };

  const ageSeconds = Math.abs(Date.now() / 1000 - t);
  if (ageSeconds > tolerance) return { ok: false, reason: "timestamp_out_of_tolerance" };

  const expected = createHmac("sha256", args.secret)
    .update(`${t}.${args.rawBody}`)
    .digest("hex");

  // Stripe ships >=1 v1 sigs (in case of secret rotation). Match any of them.
  for (const sig of v1) {
    if (sig.length !== expected.length) continue;
    if (timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return { ok: true, timestampMs: t * 1000 };
    }
  }
  return { ok: false, reason: "signature_mismatch" };
}

/* ─────────────────────────── Subscription helpers ─────────────────────────── */

export interface CreateCustomerInput {
  email: string;
  name?: string;
  metadata: Record<string, string>;
}

export interface CreateCustomerResult {
  id: string;
  mocked: boolean;
}

/** Create a Stripe customer — used on the merchant's first subscription checkout. */
export async function createCustomer(
  input: CreateCustomerInput,
): Promise<CreateCustomerResult> {
  if (!env.STRIPE_SECRET_KEY) {
    const id = `cus_mock_${Buffer.from(input.email).toString("base64url").slice(0, 12)}`;
    return { id, mocked: true };
  }
  const params: Record<string, string | number | undefined> = {
    email: input.email,
  };
  if (input.name) params.name = input.name;
  for (const [k, v] of Object.entries(input.metadata)) {
    params[`metadata[${k}]`] = v;
  }
  const body = await stripeRequest<{ id?: string }>("/customers", {
    method: "POST",
    body: params,
  });
  if (!body.id) throw new Error("stripe: customer create returned no id");
  return { id: body.id, mocked: false };
}

export interface CreateSubscriptionCheckoutInput {
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  /** Persisted on Session, Subscription, *and* the first Invoice. */
  metadata: Record<string, string>;
  /** Default-on so the merchant gets the receipt email automatically. */
  allowPromotionCodes?: boolean;
}

export interface CreateSubscriptionCheckoutResult {
  id: string;
  url: string;
  mocked: boolean;
}

/**
 * Mint a recurring `mode=subscription` Checkout Session. Returns the
 * hosted URL — caller redirects the merchant to it. Subscription IDs
 * land via webhook (`checkout.session.completed`).
 */
export async function createSubscriptionCheckout(
  input: CreateSubscriptionCheckoutInput,
): Promise<CreateSubscriptionCheckoutResult> {
  if (!env.STRIPE_SECRET_KEY) {
    const stubId = `cs_sub_mock_${Buffer.from(input.customerId).toString("base64url").slice(0, 10)}`;
    const url = `${input.successUrl}${input.successUrl.includes("?") ? "&" : "?"}stripe_mock=1&session_id=${stubId}`;
    return { id: stubId, url, mocked: true };
  }
  const params: Record<string, string | number | undefined> = {
    mode: "subscription",
    customer: input.customerId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    "line_items[0][price]": input.priceId,
    "line_items[0][quantity]": 1,
    "payment_method_types[0]": "card",
    allow_promotion_codes: input.allowPromotionCodes ? "true" : "false",
  };
  // We push the merchantId / plan onto:
  //   - the Session metadata (read by checkout.session.completed)
  //   - the Subscription metadata (read by every later subscription/invoice event)
  // so any single webhook event resolves back to our merchant in O(1).
  for (const [k, v] of Object.entries(input.metadata)) {
    params[`metadata[${k}]`] = v;
    params[`subscription_data[metadata][${k}]`] = v;
  }
  const body = await stripeRequest<{ id?: string; url?: string }>(
    "/checkout/sessions",
    { method: "POST", body: params },
  );
  if (!body.id || !body.url) {
    throw new Error("stripe: subscription session response malformed");
  }
  return { id: body.id, url: body.url, mocked: false };
}

export interface CreatePortalSessionInput {
  customerId: string;
  returnUrl: string;
}

export interface CreatePortalSessionResult {
  id: string;
  url: string;
  mocked: boolean;
}

/**
 * Hosted customer portal — Stripe handles card updates, plan switches, and
 * cancellation. Behavior is configured in the Stripe dashboard (see
 * docs/operations.md).
 */
export async function createPortalSession(
  input: CreatePortalSessionInput,
): Promise<CreatePortalSessionResult> {
  if (!env.STRIPE_SECRET_KEY) {
    const id = `ps_mock_${Buffer.from(input.customerId).toString("base64url").slice(0, 10)}`;
    const url = `${input.returnUrl}${input.returnUrl.includes("?") ? "&" : "?"}stripe_portal_mock=1`;
    return { id, url, mocked: true };
  }
  const body = await stripeRequest<{ id?: string; url?: string }>(
    "/billing_portal/sessions",
    {
      method: "POST",
      body: {
        customer: input.customerId,
        return_url: input.returnUrl,
      },
    },
  );
  if (!body.id || !body.url) {
    throw new Error("stripe: portal session response malformed");
  }
  return { id: body.id, url: body.url, mocked: false };
}

export interface CreateProductInput {
  name: string;
  description?: string;
  metadata: Record<string, string>;
}

/** Used by `seedStripe` to bootstrap products idempotently. */
export async function createProduct(input: CreateProductInput): Promise<{ id: string }> {
  const params: Record<string, string | number | undefined> = { name: input.name };
  if (input.description) params.description = input.description;
  for (const [k, v] of Object.entries(input.metadata)) {
    params[`metadata[${k}]`] = v;
  }
  const body = await stripeRequest<{ id?: string }>("/products", {
    method: "POST",
    body: params,
  });
  if (!body.id) throw new Error("stripe: product create returned no id");
  return { id: body.id };
}

export interface CreatePriceInput {
  productId: string;
  /** Smallest unit (cents/paisa). */
  unitAmount: number;
  currency: string;
  /** Recurring billing — we only mint monthly today. */
  interval: "month" | "year";
  metadata: Record<string, string>;
}

export async function createPrice(input: CreatePriceInput): Promise<{ id: string }> {
  const params: Record<string, string | number | undefined> = {
    product: input.productId,
    unit_amount: input.unitAmount,
    currency: input.currency.toLowerCase(),
    "recurring[interval]": input.interval,
  };
  for (const [k, v] of Object.entries(input.metadata)) {
    params[`metadata[${k}]`] = v;
  }
  const body = await stripeRequest<{ id?: string }>("/prices", {
    method: "POST",
    body: params,
  });
  if (!body.id) throw new Error("stripe: price create returned no id");
  return { id: body.id };
}

/** List existing prices for a product — used by seed script for idempotency. */
export async function listPricesForProduct(productId: string): Promise<Array<{ id: string; recurring?: { interval?: string } | null; unit_amount?: number; currency?: string; active?: boolean }>> {
  const body = await stripeRequest<{
    data?: Array<{
      id: string;
      active?: boolean;
      unit_amount?: number;
      currency?: string;
      recurring?: { interval?: string } | null;
    }>;
  }>(`/prices?product=${encodeURIComponent(productId)}&limit=100`, { method: "GET" });
  return body.data ?? [];
}

/** Search for an existing product by metadata.tier — keeps seedStripe idempotent. */
export async function findProductByTier(tier: PlanTier): Promise<{ id: string } | null> {
  const query = encodeURIComponent(`metadata['tier']:'${tier}' AND active:'true'`);
  const body = await stripeRequest<{ data?: Array<{ id: string }> }>(
    `/products/search?query=${query}&limit=1`,
    { method: "GET" },
  );
  const first = body.data?.[0];
  return first ? { id: first.id } : null;
}
