import twilio from "twilio";
import type { Twilio } from "twilio";
import { env } from "../../env.js";
import {
  type VoiceCallDetails,
  type VoiceInitiateArgs,
  type VoiceInitiateResult,
  type VoiceProvider,
  type VoiceWebhookVerifyInput,
  VoiceProviderNotConfiguredError,
  VoiceProviderNotImplementedError,
} from "./types.js";

/**
 * Legacy Twilio adapter.
 *
 * Kept so existing dev / sandbox flows keep working while the BD-local
 * adapter is being onboarded. NOT intended for Bangladesh production
 * traffic — Twilio's US/UK origin caller IDs are routinely rejected by
 * BD recipients, which is the entire reason for this abstraction.
 *
 * Notable gaps vs. a real IVR:
 *   - `initiateOutboundCall` uses Twilio's demo TwiML
 *     (`http://demo.twilio.com/docs/voice.xml`). It dials and plays a
 *     stock prompt. No DTMF, no order-confirmation logic.
 *   - `initiateConfirmationCall` is intentionally NOT implemented. The IVR
 *     script generator (`server/webhooks/voice.ts:GET /script/:callId`)
 *     lands in PR 2 alongside the BD adapter, and Twilio will get the
 *     same hosted script when we eventually point a sandbox Twilio number
 *     back at it for end-to-end testing.
 */
export class TwilioVoiceProvider implements VoiceProvider {
  readonly name = "twilio";
  private _client: Twilio | null = null;

  isConfigured(): boolean {
    return !!(
      env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_AUTH_TOKEN &&
      env.TWILIO_PHONE_NUMBER
    );
  }

  normalizePhone(phone: string): string {
    const trimmed = phone.trim();
    if (trimmed.startsWith("+")) return trimmed;
    if (/^8801\d{9}$/.test(trimmed)) return `+${trimmed}`;
    if (/^01\d{9}$/.test(trimmed)) return `+88${trimmed}`;
    return trimmed;
  }

  async initiateOutboundCall(
    args: VoiceInitiateArgs,
  ): Promise<VoiceInitiateResult> {
    if (!env.TWILIO_PHONE_NUMBER) {
      throw new VoiceProviderNotConfiguredError(this.name);
    }
    const client = this.getClient();
    const call = await client.calls.create({
      to: this.normalizePhone(args.to),
      from: env.TWILIO_PHONE_NUMBER,
      url: "http://demo.twilio.com/docs/voice.xml",
      statusCallback: args.statusCallbackUrl,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
      record: args.record ?? false,
    });
    return {
      callId: call.sid,
      providerStatus: call.status ?? null,
      from: call.from,
      to: call.to,
      dateCreated: call.dateCreated ?? undefined,
    };
  }

  initiateConfirmationCall(): Promise<VoiceInitiateResult> {
    return Promise.reject(
      new VoiceProviderNotImplementedError("initiateConfirmationCall", this.name),
    );
  }

  async getCallDetails(callId: string): Promise<VoiceCallDetails> {
    const client = this.getClient();
    const call = await client.calls(callId).fetch();
    return {
      callId: call.sid,
      providerStatus: call.status ?? null,
      duration: call.duration ? Number(call.duration) : null,
      price: call.price ? Number(call.price) : null,
      priceUnit: call.priceUnit ?? null,
      startedAt: call.startTime ?? null,
      endedAt: call.endTime ?? null,
      from: call.from,
      to: call.to,
    };
  }

  async hangup(
    callId: string,
  ): Promise<{ callId: string; providerStatus: string | null }> {
    const client = this.getClient();
    const call = await client.calls(callId).update({ status: "completed" });
    return { callId: call.sid, providerStatus: call.status ?? null };
  }

  verifyWebhookSignature(input: VoiceWebhookVerifyInput): boolean {
    if (!env.TWILIO_AUTH_TOKEN || !input.signature) return false;
    return twilio.validateRequest(
      env.TWILIO_AUTH_TOKEN,
      input.signature,
      input.fullUrl,
      input.params,
    );
  }

  private getClient(): Twilio {
    if (!this._client) {
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
        throw new VoiceProviderNotConfiguredError(this.name);
      }
      this._client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    }
    return this._client;
  }
}
