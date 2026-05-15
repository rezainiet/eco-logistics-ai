import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../env.js";
import {
  type VoiceCallDetails,
  type VoiceConfirmationCallArgs,
  type VoiceInitiateArgs,
  type VoiceInitiateResult,
  type VoiceProvider,
  type VoiceWebhookVerifyInput,
} from "./types.js";

/**
 * Dev / test stub voice provider.
 *
 * Mirrors the SMS module's stdout-transport posture (see `lib/sms/index.ts`
 * `loadTransport()` dev fallback): when no real adapter is configured, the
 * voice subsystem must keep the higher-level flow exercisable without a
 * paid account. Calls log to stdout with a synthetic callId; the
 * confirmation worker can be driven end-to-end against the stub by POSTing
 * a forged DTMF webhook (signature mode `stub-shared-secret`).
 *
 * In production this adapter is selected only when VOICE_PROVIDER="stub" is
 * deliberately set — the env layer treats that as opt-in, not a default
 * with a real provider. Calls still log instead of dialing, but the boot
 * flow does not refuse, so a misconfigured production deploy will fail
 * obviously (no orders ever escalate past SMS no-reply, audit logs show
 * "[voice:stub]").
 *
 * Webhook signatures use HMAC-SHA256 of the raw body keyed on
 * VOICE_WEBHOOK_SHARED_SECRET. That same scheme is what most BD providers
 * use, so adapter-swap doesn't change the webhook receiver code.
 */
export class StubVoiceProvider implements VoiceProvider {
  readonly name = "stub";

  isConfigured(): boolean {
    return true;
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
    const callId = `stub-${randomUUID()}`;
    console.log(
      `[voice:stub] dial to=${this.normalizePhone(args.to)} record=${
        args.record ?? false
      } callId=${callId} statusCallback=${args.statusCallbackUrl}`,
    );
    return {
      callId,
      providerStatus: "queued",
      from: "+8800000000000",
      to: this.normalizePhone(args.to),
      dateCreated: new Date(),
    };
  }

  async initiateConfirmationCall(
    args: VoiceConfirmationCallArgs,
  ): Promise<VoiceInitiateResult> {
    const callId = `stub-ivr-${randomUUID()}`;
    console.log(
      `[voice:stub] ivr-confirm orderId=${args.orderId} ` +
        `code=${args.confirmationCode} lang=${args.language} ` +
        `to=${this.normalizePhone(args.to)} callId=${callId} ` +
        `script=${args.scriptUrl} dtmfCallback=${args.dtmfCallbackUrl} ` +
        `cod=${args.codAmountBdt ?? "n/a"}`,
    );
    return {
      callId,
      providerStatus: "queued",
      from: "+8800000000000",
      to: this.normalizePhone(args.to),
      dateCreated: new Date(),
    };
  }

  async getCallDetails(callId: string): Promise<VoiceCallDetails> {
    return {
      callId,
      providerStatus: "completed",
      duration: 0,
      price: 0,
      priceUnit: "BDT",
      startedAt: null,
      endedAt: null,
    };
  }

  async hangup(
    callId: string,
  ): Promise<{ callId: string; providerStatus: string | null }> {
    console.log(`[voice:stub] hangup callId=${callId}`);
    return { callId, providerStatus: "completed" };
  }

  verifyWebhookSignature(input: VoiceWebhookVerifyInput): boolean {
    const secret = env.VOICE_WEBHOOK_SHARED_SECRET;
    if (!secret) {
      // Mirrors the SMS-inbound webhook posture: in dev we bypass with a
      // loud warning so localhost testing works; production gates this
      // upstream via the `env.ts` refine. The webhook receiver decides
      // whether a `false` here translates to 401 (prod) or "warn + accept"
      // (dev) — stay out of that policy here.
      return false;
    }
    if (!input.signature || !input.rawBody) return false;
    const expected = createHmac("sha256", secret)
      .update(input.rawBody)
      .digest("hex");
    const got = input.signature.trim().toLowerCase();
    if (expected.length !== got.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(got));
    } catch {
      return false;
    }
  }
}
