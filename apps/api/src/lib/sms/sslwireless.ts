/**
 * SSL Wireless SMS Plus provider adapter.
 *
 * SSL Wireless is the standard transactional-SMS gateway in Bangladesh. The
 * "SMS Plus" REST API takes a JSON POST and returns a JSON status. We
 * intentionally avoid an SDK so the API surface stays small and the build
 * stays vendor-agnostic — every provider in this folder must conform to the
 * `SmsTransport` interface defined here.
 *
 * Endpoint: POST {base}/api/v3/send-sms/dynamic
 * Auth: api_token + sid + msisdn fields in the JSON body.
 *
 * Phone format: SSL Wireless accepts Bangladesh numbers as either
 * "8801XXXXXXXXX" (13 digits, no plus) or "01XXXXXXXXX" (11 digits). We
 * normalize to the 13-digit form because it routes more reliably for
 * international fallback. Numbers from other countries are passed through
 * with the leading "+" stripped — most South-Asian carriers accept that.
 */

const PROVIDER = "sslwireless" as const;

export interface SmsSendInput {
  /** Recipient phone in international or BD-local format. */
  to: string;
  /** UTF-8 message body. SSL Wireless splits long messages internally. */
  body: string;
  /**
   * Optional sender mask override (e.g. another approved alpha SID). Falls
   * back to the configured `SSL_WIRELESS_DEFAULT_SENDER` then to `SID`.
   */
  sender?: string;
  /** Optional client-supplied id for delivery-report correlation. */
  csmsId?: string;
}

export interface SmsSendResult {
  ok: boolean;
  /** Provider message id (for DLR lookups). */
  providerMessageId?: string;
  /** Raw status code returned by the provider, useful for diagnostics. */
  providerStatus?: string;
  /** Human-readable error message when `ok === false`. */
  error?: string;
}

export interface SslWirelessConfig {
  apiToken: string;
  user: string;
  sid: string;
  baseUrl: string;
  /** Default sender mask if the caller doesn't supply one. */
  defaultSender?: string;
}

export interface SmsTransport {
  send(input: SmsSendInput): Promise<SmsSendResult>;
}

/**
 * Normalize a raw phone string to the format SSL Wireless wants. Returns
 * `null` if the input clearly isn't a phone (so the caller can fail fast
 * rather than burn an HTTP call).
 */
export function normalizeBdPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  // 11-digit local BD (01XXXXXXXXX) → prepend country code.
  if (digits.length === 11 && digits.startsWith("01")) {
    return `88${digits}`;
  }
  // Already in 13-digit form (8801XXXXXXXXX) — pass through.
  if (digits.length === 13 && digits.startsWith("880")) {
    return digits;
  }
  // Other lengths: assume already E.164-ish without the plus. SSL Wireless
  // tolerates non-BD numbers for international fallback.
  return digits;
}

interface SslWirelessApiResponse {
  status?: string;
  status_code?: number;
  error_message?: string;
  smsinfo?: Array<{
    sms_status?: string;
    reference_id?: string;
    msisdn?: string;
    error_message?: string;
  }>;
}

export class SslWirelessTransport implements SmsTransport {
  constructor(private readonly cfg: SslWirelessConfig) {}

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    const phone = normalizeBdPhone(input.to);
    if (!phone) {
      return { ok: false, error: `invalid phone: ${input.to}`, providerStatus: "client_invalid_phone" };
    }
    const sender = input.sender ?? this.cfg.defaultSender ?? this.cfg.sid;
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/api/v3/send-sms/dynamic`;

    const body = {
      api_token: this.cfg.apiToken,
      sid: this.cfg.sid,
      msisdn: phone,
      sms: input.body,
      // SSL Wireless echoes csms_id back in DLR webhooks. Default to a
      // timestamped fallback so callers that don't supply one still get
      // a useful trace identifier.
      csms_id: input.csmsId ?? `auto-${Date.now()}`,
      // Optional sender override field — provider ignores if not allowed
      // for this account.
      mask: sender,
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        // The provider is fast under normal load; cap the wait so a
        // hanging gateway can't stall the order/auth path.
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      return {
        ok: false,
        error: `transport error: ${(err as Error).message}`,
        providerStatus: "transport_error",
      };
    }

    let data: SslWirelessApiResponse | null = null;
    try {
      data = (await res.json()) as SslWirelessApiResponse;
    } catch {
      data = null;
    }

    if (!res.ok || !data) {
      return {
        ok: false,
        error: `${PROVIDER} ${res.status} ${data?.error_message ?? "no body"}`,
        providerStatus: String(res.status),
      };
    }

    const first = data.smsinfo?.[0];
    const okStatus = data.status === "SUCCESS" && first?.sms_status === "SUCCESS";

    return {
      ok: okStatus,
      providerMessageId: first?.reference_id,
      providerStatus: data.status ?? first?.sms_status,
      error: okStatus
        ? undefined
        : data.error_message ?? first?.error_message ?? `unexpected status ${data.status ?? "?"}`,
    };
  }
}
