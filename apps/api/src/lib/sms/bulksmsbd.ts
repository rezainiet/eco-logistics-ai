/**
 * BulkSMSBD provider adapter.
 *
 * BulkSMSBD is one of the practical BD-local transactional SMS gateways —
 * the senderid lands as a real Bangladesh CLI (numeric short code) so
 * delivery rates exceed Twilio/foreign masks dramatically. We use it as
 * the primary BD provider for confirmation prompts.
 *
 * Endpoint: GET|POST {base}/api/smsapi
 * Auth:     api_key query param (account-scoped, server-side only).
 * Success:  HTTP 200 + body containing `response_code: 202` (also accepted:
 *           bare "SMS Submitted Successfully" plain-text responses).
 *
 * Phone format: 13-digit `8801XXXXXXXXX` (no leading "+"). The storage
 * canonical is E.164 (with "+") — `normalizeBdPhone` strips that here.
 *
 * Message encoding: we use GET with URLSearchParams because the BulkSMSBD
 * docs explicitly support it AND because GET responses are easier to debug
 * during the BD provider onboarding window (you can paste the URL in a
 * browser and see what the gateway saw). Bodies with non-ASCII (Bangla)
 * are properly percent-encoded by URLSearchParams — do NOT hand-roll the
 * query string.
 *
 * Failure surface — the adapter returns a structured `SmsSendResult`; the
 * caller decides whether to retry. The automation SMS worker treats `ok:
 * false` as a thrown error and BullMQ retries with exponential backoff.
 */

import {
  type SmsSendInput,
  type SmsSendResult,
  type SmsTransport,
  normalizeBdPhone,
} from "./types.js";

const PROVIDER = "bulksmsbd" as const;

/** HTTP timeout — same envelope as the SSL Wireless adapter. */
const SEND_TIMEOUT_MS = 8_000;

/**
 * Response codes documented in BulkSMSBD's API reference. 202 means
 * "submitted to the operator successfully" — *not* "delivered". Delivery
 * status arrives separately via the DLR webhook handler in
 * `server/webhooks/sms-dlr.ts` (provider-agnostic, keyed on csms_id).
 */
const RESPONSE_CODE_SUBMITTED = 202;

const SUCCESS_TEXT_HINTS = [
  "sms submitted successfully",
  "submitted successfully",
  "202",
] as const;

export interface BulkSmsBdConfig {
  apiKey: string;
  /** Numeric short code / approved sender id (e.g. 8809617621489). */
  senderId: string;
  baseUrl: string;
  /** Type field on the request — defaults to "text". */
  type?: "text" | "unicode";
}

interface BulkSmsBdJsonResponse {
  response_code?: number;
  message_id?: number | string;
  success_message?: string;
  error_message?: string;
}

export class BulkSmsBdTransport implements SmsTransport {
  readonly name = PROVIDER;

  constructor(private readonly cfg: BulkSmsBdConfig) {}

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    const phone = normalizeBdPhone(input.to);
    if (!phone) {
      return {
        ok: false,
        provider: PROVIDER,
        error: `invalid phone: ${input.to}`,
        providerStatus: "client_invalid_phone",
      };
    }

    // URLSearchParams handles UTF-8 percent-encoding correctly — critical
    // for Bangla message bodies. Never concatenate the query string by hand.
    const params = new URLSearchParams({
      api_key: this.cfg.apiKey,
      type: this.cfg.type ?? "text",
      number: phone,
      senderid: input.sender ?? this.cfg.senderId,
      message: input.body,
    });
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/api/smsapi?${params.toString()}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.5" },
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      return {
        ok: false,
        provider: PROVIDER,
        error: `transport error: ${(err as Error).message}`,
        providerStatus: "transport_error",
      };
    }

    const raw = await res.text().catch(() => "");
    const parsed = tryParseJson(raw);

    if (!res.ok) {
      return {
        ok: false,
        provider: PROVIDER,
        error: `${PROVIDER} ${res.status} ${parsed?.error_message ?? truncate(raw, 200)}`,
        providerStatus: String(res.status),
      };
    }

    // JSON path: response_code === 202 is the documented success signal.
    if (parsed) {
      const code = parsed.response_code;
      const ok = code === RESPONSE_CODE_SUBMITTED;
      return {
        ok,
        provider: PROVIDER,
        providerMessageId:
          parsed.message_id !== undefined ? String(parsed.message_id) : undefined,
        providerStatus: code !== undefined ? String(code) : "unknown",
        error: ok
          ? undefined
          : parsed.error_message ??
            parsed.success_message ??
            `unexpected response_code ${code ?? "?"}`,
      };
    }

    // Plain-text path — some BulkSMSBD endpoints respond `text/plain`
    // ("SMS Submitted Successfully") even though the JSON shape is
    // documented. Accept that as success too.
    const text = raw.trim().toLowerCase();
    const ok = SUCCESS_TEXT_HINTS.some((hint) => text.includes(hint));
    return {
      ok,
      provider: PROVIDER,
      providerStatus: ok ? "202" : "text_response",
      error: ok ? undefined : `unexpected text response: ${truncate(raw, 200)}`,
    };
  }
}

function tryParseJson(raw: string): BulkSmsBdJsonResponse | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return obj as BulkSmsBdJsonResponse;
    return null;
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}
