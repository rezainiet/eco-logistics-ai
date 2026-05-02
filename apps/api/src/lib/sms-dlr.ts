/**
 * SMS Delivery Report (DLR) parser.
 *
 * Provider-agnostic — reads SSL Wireless, AdnSMS, BulkSMS BD, generic
 * SMPP-bridged providers, and the WhatsApp Business read-receipt webhook.
 * Each provider's payload is reduced to a canonical shape:
 *
 *   { status: "delivered" | "failed" | "pending" | "unknown",
 *     code:   <6-digit confirmation code, mined from csmsId>,
 *     providerRef: <opaque id from the provider for audit>,
 *     error:  <error description if status=failed>,
 *     deliveredAt: <ISO date if status=delivered, else null> }
 *
 * Returning `unknown` is the safe default — the webhook treats unknown
 * statuses as no-op so a future provider field doesn't accidentally
 * escalate orders.
 */

export type DlrCanonicalStatus = "delivered" | "failed" | "pending" | "unknown";

export interface DlrParsed {
  status: DlrCanonicalStatus;
  /** 6-digit confirmation code mined from csmsId/messageId. null if not present. */
  code: string | null;
  providerRef: string | null;
  error: string | null;
  deliveredAt: Date | null;
}

/** SSL Wireless DELIVERED variants. */
const DELIVERED_TOKENS = new Set([
  "delivered",
  "delivrd",          // SMPP shorthand sometimes leaks through
  "success",
  "sent",
  "ok",
  "200",
]);

/** Failure tokens — always escalate. */
const FAILED_TOKENS = new Set([
  "failed",
  "rejected",
  "expired",
  "undelivered",
  "undeliv",
  "undeliverable",
  "invalid_number",
  "invalid",
  "blocked",
  "blacklisted",
  "rejectd",
  "error",
]);

const PENDING_TOKENS = new Set([
  "pending",
  "submitted",
  "queued",
  "accepted",
  "enroute",
  "in_progress",
  "buffered",
]);

/**
 * Mine a 6-digit confirmation code from a csmsId. Our own
 * `sendOrderConfirmationSms` mints csmsIds like
 *   confirm-ORD-XYZ-123456
 * The code is always the trailing 6 digits; we still defensively scan with
 * a regex so malformed/legacy ids don't blow up.
 */
function extractConfirmationCode(csmsId: string | undefined | null): string | null {
  if (!csmsId || typeof csmsId !== "string") return null;
  const m = /(\d{6})\s*$/.exec(csmsId.trim());
  return m ? m[1]! : null;
}

function normalizeStatusToken(raw: string | undefined | null): DlrCanonicalStatus {
  if (!raw) return "unknown";
  const t = String(raw).trim().toLowerCase().replace(/\s+/g, "_");
  if (DELIVERED_TOKENS.has(t)) return "delivered";
  if (FAILED_TOKENS.has(t)) return "failed";
  if (PENDING_TOKENS.has(t)) return "pending";
  return "unknown";
}

/**
 * Canonical DLR parser. Accepts any of the common SSL Wireless / generic
 * BD-provider payload shapes and returns the canonical event.
 */
export function parseDlrPayload(raw: unknown): DlrParsed {
  if (!raw || typeof raw !== "object") {
    return { status: "unknown", code: null, providerRef: null, error: null, deliveredAt: null };
  }
  const p = raw as Record<string, unknown>;

  // Status field — providers don't agree on which key carries it. Includes
  // both snake_case (SSL Wireless / generic SMPP) and camelCase
  // (WhatsApp Business webhook) variants.
  const statusToken =
    (p.smsstatus as string | undefined) ??
    (p.status as string | undefined) ??
    (p.messagestatus as string | undefined) ??
    (p.messageStatus as string | undefined) ??
    (p.delivery_status as string | undefined) ??
    (p.deliveryStatus as string | undefined) ??
    (p.dlr_status as string | undefined) ??
    (p.dlrStatus as string | undefined) ??
    (p.state as string | undefined);
  const status = normalizeStatusToken(statusToken);

  // csmsId — likewise.
  const csmsId =
    (p.csms_id as string | undefined) ??
    (p.csmsId as string | undefined) ??
    (p.client_message_id as string | undefined) ??
    (p.clientMessageId as string | undefined) ??
    (p.message_id as string | undefined) ??
    (p.messageId as string | undefined) ??
    (p.ref as string | undefined) ??
    null;
  const code = extractConfirmationCode(csmsId);

  const providerRef =
    (p.reference_id as string | undefined) ??
    (p.referenceId as string | undefined) ??
    (p.ref_id as string | undefined) ??
    (p.refId as string | undefined) ??
    (p.provider_ref as string | undefined) ??
    (p.providerRef as string | undefined) ??
    (p.id as string | undefined) ??
    null;

  const errorRaw =
    (p.error_message as string | undefined) ??
    (p.errorMessage as string | undefined) ??
    (p.error as string | undefined) ??
    (p.reason as string | undefined) ??
    null;

  const deliveredAtRaw =
    (p.delivered_at as string | undefined) ??
    (p.deliveredAt as string | undefined) ??
    (p.timestamp as string | undefined) ??
    null;
  let deliveredAt: Date | null = null;
  if (status === "delivered" && deliveredAtRaw) {
    const d = new Date(String(deliveredAtRaw));
    if (!Number.isNaN(d.getTime())) deliveredAt = d;
  }
  if (status === "delivered" && !deliveredAt) {
    deliveredAt = new Date();
  }

  return {
    status,
    code,
    providerRef: providerRef ? String(providerRef).slice(0, 200) : null,
    error: errorRaw ? String(errorRaw).slice(0, 500) : null,
    deliveredAt,
  };
}

/** Convenience export for tests. */
export const __TEST = { extractConfirmationCode, normalizeStatusToken };
