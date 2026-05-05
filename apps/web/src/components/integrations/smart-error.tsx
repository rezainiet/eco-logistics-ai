"use client";

import { AlertOctagon, AlertTriangle, ExternalLink } from "lucide-react";

/**
 * Library of merchant-readable error explanations. The matchers are
 * intentionally narrow (specific → general) and case-insensitive so
 * an error string only ever matches one entry. When we can't classify
 * a string, the generic fallback at the bottom always fires.
 *
 * Each entry returns a "what happened / why / how to fix it" trio
 * plus, where possible, a `fixUrl` builder that generates a deep link
 * back to the merchant's storefront admin so the next click is fix-the-
 * cause rather than fix-the-symptom.
 *
 * Single source of truth for both the integration health card and the
 * issues page so reason copy never drifts between surfaces.
 */

export type ProviderHint = "shopify" | "woocommerce" | "custom_api" | string;

export interface ErrorExplanation {
  /** Stable code — used as the React key and as the analytics tag. */
  code: string;
  /** One-line summary, plain language. */
  what: string;
  /** Root cause in non-technical wording. */
  why: string;
  /** Concrete next step. Imperative voice ("Update checkout to require phone"). */
  how: string;
  /** Severity tone hint — drives the panel border + icon. */
  tone: "danger" | "warning";
}

interface MatchContext {
  provider?: ProviderHint;
  /** Storefront domain or site URL — used to build the "Fix in source" deep link. */
  accountKey?: string | null;
  /** Upstream order id, when known. Plumbed into the provider deep link. */
  externalId?: string | null;
}

/**
 * Resolve the explanation for an error string + skip reason. Prefers
 * the explicit `skipReason` (set by the adapter) over substring
 * matching on `lastError` — both are possible inputs because the
 * issues page surfaces needs_attention rows AND dead-lettered failed
 * rows that don't have a skipReason.
 */
export function explainError(args: {
  skipReason?: string | null;
  lastError?: string | null;
}): ErrorExplanation {
  const reason = args.skipReason?.toLowerCase().trim() ?? "";
  const raw = args.lastError?.toLowerCase().trim() ?? "";

  if (reason === "missing_phone" || raw.includes("missing customer phone")) {
    return {
      code: "missing_phone",
      what: "Customer phone is missing on the order.",
      why: "Our delivery flow requires a phone number, but the storefront's checkout made it optional.",
      how: "Open the order in your storefront, add a phone, then click Replay. To prevent it for future orders, make phone a required checkout field.",
      tone: "warning",
    };
  }
  if (reason === "missing_external_id") {
    return {
      code: "missing_external_id",
      what: "The webhook payload didn't carry an order ID.",
      why: "A storefront plugin or custom theme is sending malformed data.",
      how: "Check your storefront's webhook settings; if you're using a custom plugin, contact its author. Reach out to support if it persists.",
      tone: "danger",
    };
  }
  if (reason === "invalid_payload") {
    return {
      code: "invalid_payload",
      what: "The webhook payload didn't match the expected shape.",
      why: "Either an upstream API version change or a custom plugin is sending unexpected fields.",
      how: "Disconnect and reconnect the integration to ensure both sides agree on the schema.",
      tone: "danger",
    };
  }

  if (
    raw.includes("connection error") ||
    raw.includes("econnrefused") ||
    raw.includes("enotfound") ||
    raw.includes("timeout") ||
    raw.includes("network error")
  ) {
    return {
      code: "connection_error",
      what: "We couldn't reach your store.",
      why: "DNS didn't resolve, the port refused the connection, or the request timed out.",
      how: "Confirm the storefront URL is correct and the server is online, then click Test connection on the integration card.",
      tone: "danger",
    };
  }

  if (
    raw.includes("invalid api key") ||
    raw.includes("invalid access token") ||
    raw.includes("401") ||
    raw.includes("unauthorized")
  ) {
    return {
      code: "auth_failed",
      what: "Your store rejected our credentials.",
      why: "The access token was revoked, rotated, or never granted the right scopes.",
      how: "Click Reconnect on the integration card to re-authenticate.",
      tone: "danger",
    };
  }

  if (raw.includes("scope") || raw.includes("403") || raw.includes("forbidden")) {
    return {
      code: "missing_scopes",
      what: "Your store granted fewer permissions than we asked for.",
      why: "Some endpoints need scopes that weren't approved during the OAuth flow.",
      how: "Reconnect the integration and approve every scope when prompted.",
      tone: "warning",
    };
  }

  if (raw.includes("signature mismatch") || raw.includes("hmac")) {
    return {
      code: "hmac_mismatch",
      what: "A webhook signature didn't validate.",
      why: "Our shared secret is out of sync with the upstream platform.",
      how: "Open the integration → click Rotate webhook secret → paste the new one into your store.",
      tone: "danger",
    };
  }

  if (raw.includes("rate limit") || raw.includes("429")) {
    return {
      code: "rate_limited",
      what: "Your store rate-limited us.",
      why: "Too many requests in a short window — usually transient, sometimes a sign you need a higher API tier on your store.",
      how: "Wait a minute, then click Sync now. If it persists, check your storefront's API plan.",
      tone: "warning",
    };
  }

  return {
    code: "unknown",
    what: "Something didn't process cleanly.",
    why: "We caught an unexpected response from the upstream platform.",
    how: "Click Test connection — if it passes, the issue was transient and Replay should fix it.",
    tone: "warning",
  };
}

/**
 * Build a "Fix in source" deep link for an order. Returns null when we
 * can't construct one with confidence — better to omit the button than
 * point at the wrong place. Shopify orders use the admin's order page
 * URL; Woo uses the wp-admin order edit URL; custom_api gets no link.
 */
export function buildSourceFixUrl(
  ctx: MatchContext,
): { href: string; label: string } | null {
  if (!ctx.provider || !ctx.accountKey || !ctx.externalId) return null;
  if (ctx.provider === "shopify") {
    // Shopify admin URLs: https://<shop>/admin/orders/<id>
    const shop = ctx.accountKey.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return {
      href: `https://${shop}/admin/orders/${encodeURIComponent(ctx.externalId)}`,
      label: "Fix in Shopify",
    };
  }
  if (ctx.provider === "woocommerce") {
    // Woo admin URL: <site>/wp-admin/post.php?post=<id>&action=edit
    const base = ctx.accountKey.replace(/\/$/, "");
    return {
      href: `${base}/wp-admin/post.php?post=${encodeURIComponent(ctx.externalId)}&action=edit`,
      label: "Fix in WooCommerce",
    };
  }
  return null;
}

/**
 * Reusable presentational block. No fetching of its own — receives a
 * pre-classified explanation so the same component can render inside
 * the integration card (where we classify against `health.lastError`)
 * and the issues page (which classifies against the inbox row's
 * `skipReason` + `lastError`).
 *
 * Tones map to colour exactly like the existing health-card alerts so
 * the visual language stays consistent across surfaces.
 */
export function SmartError({
  explanation,
  fixUrl,
  compact,
}: {
  explanation: ErrorExplanation;
  fixUrl?: { href: string; label: string } | null;
  /**
   * `compact` shrinks the block for inline list rendering (issues
   * page) — drops the "Fix:" prefix and tightens spacing. Default is
   * the spacious card-friendly layout.
   */
  compact?: boolean;
}) {
  const Icon = explanation.tone === "danger" ? AlertOctagon : AlertTriangle;
  const toneClass =
    explanation.tone === "danger"
      ? "border-danger/30 bg-danger-subtle text-danger"
      : "border-warning/30 bg-warning-subtle text-warning";
  return (
    <div
      className={`rounded-md border p-3 text-xs ${toneClass}`}
      data-error-code={explanation.code}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className={compact ? "space-y-0.5" : "space-y-1"}>
          <p className="font-medium">{explanation.what}</p>
          <p className="text-fg-muted">{explanation.why}</p>
          <p className="text-fg">
            {!compact ? <span className="font-medium">Fix: </span> : null}
            {explanation.how}
          </p>
          {fixUrl ? (
            <a
              href={fixUrl.href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-2xs uppercase tracking-wide text-fg hover:underline"
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
              {fixUrl.label}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
