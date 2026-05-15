/**
 * SSL Wireless SMS Plus provider adapter.
 *
 * SSL Wireless is one of the BD transactional-SMS gateways we support
 * (BulkSMSBD is the other; see `bulksmsbd.ts`). Shared types live in
 * `types.ts` so adapters never import each other.
 *
 * Endpoint: POST {base}/api/v3/send-sms/dynamic
 * Auth: api_token + sid + msisdn fields in the JSON body.
 */

import {
  type SmsSendInput,
  type SmsSendResult,
  type SmsTransport,
  normalizeBdPhone,
} from "./types.js";

export type { SmsSendInput, SmsSendResult, SmsTransport } from "./types.js";
export { normalizeBdPhone } from "./types.js";

const PROVIDER = "sslwireless" as const;

export interface SslWirelessConfig {
  apiToken: string;
  user: string;
  sid: string;
  baseUrl: string;
  /** Default sender mask if the caller doesn't supply one. */
  defaultSender?: string;
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
  readonly name = PROVIDER;
  constructor(private readonly cfg: SslWirelessConfig) {}

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
        provider: PROVIDER,
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
        provider: PROVIDER,
        error: `${PROVIDER} ${res.status} ${data?.error_message ?? "no body"}`,
        providerStatus: String(res.status),
      };
    }

    const first = data.smsinfo?.[0];
    const okStatus = data.status === "SUCCESS" && first?.sms_status === "SUCCESS";

    return {
      ok: okStatus,
      provider: PROVIDER,
      providerMessageId: first?.reference_id,
      providerStatus: data.status ?? first?.sms_status,
      error: okStatus
        ? undefined
        : data.error_message ?? first?.error_message ?? `unexpected status ${data.status ?? "?"}`,
    };
  }
}
