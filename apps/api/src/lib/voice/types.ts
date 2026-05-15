/**
 * Voice / IVR provider abstraction.
 *
 * Cordon's voice subsystem is provider-agnostic: the legacy Twilio adapter,
 * a dev-mode stub, and (later) a BD-local IVR adapter all conform to the
 * `VoiceProvider` contract below. Twilio is retained as a legacy adapter
 * because Bangladeshi recipients largely ignore foreign caller IDs — real
 * production traffic must terminate on a BD-local provider.
 *
 * Why an interface instead of swapping client libs:
 *   - The confirmation outcome engine (`lib/confirmation-outcome.ts`) must
 *     not know which adapter placed a call. Channels (SMS / IVR / WhatsApp /
 *     agent / AI voice) converge on one state-machine transition; the call-
 *     dispatch layer is the only thing that varies.
 *   - Each provider has a different webhook signature scheme (Twilio uses
 *     X-Twilio-Signature derived from auth token; BD providers we onboard
 *     later sign via HMAC-shared-secret). Wrapping the verifier in the
 *     adapter keeps `server/webhooks/voice.ts` provider-blind.
 *
 * Adding a new adapter:
 *   1. Implement `VoiceProvider`.
 *   2. Register in `lib/voice/index.ts` `getVoiceProvider()`.
 *   3. Add the provider's name to the `VOICE_PROVIDER` enum in `env.ts`.
 *
 * Notes on `initiateConfirmationCall`:
 *   - Optional in PR 1. The legacy Twilio adapter does NOT implement it (no
 *     TwiML for the IVR script is hosted yet). PR 2 wires the BD adapter
 *     and the hosted `/voice/script/:callId` endpoint.
 */

export interface VoiceInitiateArgs {
  /** Customer phone. Adapter normalizes to its provider-preferred shape. */
  to: string;
  /** Public HTTPS URL the provider should POST lifecycle events to. */
  statusCallbackUrl: string;
  /** Whether to record. Default false — recording disclosure must be in the IVR. */
  record?: boolean;
}

export interface VoiceConfirmationCallArgs extends VoiceInitiateArgs {
  /** Internal Cordon order id — echoed back through `callId` correlation. */
  orderId: string;
  /** 6/8-digit code from `Order.automation.confirmationCode`. */
  confirmationCode: string;
  /** Bangla default; English fallback for merchants opted out. */
  language: "bn" | "en";
  /** Public HTTPS URL the provider should POST DTMF keypresses to. */
  dtmfCallbackUrl: string;
  /** Public HTTPS URL the provider should fetch the IVR script from. */
  scriptUrl: string;
  /** Used so the customer hears the right amount in the prompt. */
  codAmountBdt?: number;
  /** For copy ("Confirm order #X for Brand Y"). */
  orderNumber: string;
  brandName?: string;
}

export interface VoiceInitiateResult {
  /** Provider-side opaque id (Twilio callSid, BD provider's UUID, etc). */
  callId: string;
  /** Provider's first-status string. Adapter-normalized — see CALL_STATUSES. */
  providerStatus: string | null;
  from?: string;
  to?: string;
  dateCreated?: Date;
}

export interface VoiceCallDetails {
  callId: string;
  providerStatus: string | null;
  /** Talk time in whole seconds. Null when the call hasn't completed. */
  duration: number | null;
  price: number | null;
  priceUnit: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  from?: string;
  to?: string;
}

export interface VoiceWebhookVerifyInput {
  /** The signature header value, if any (provider-specific name). */
  signature: string | undefined;
  /** Fully-qualified callback URL, as the provider saw it. */
  fullUrl: string;
  /** Parsed body — Twilio uses urlencoded form fields here. */
  params: Record<string, string>;
  /** Raw bytes — required by HMAC-on-raw-body providers. */
  rawBody?: Buffer;
}

export interface VoiceProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** Best-effort phone normalization (E.164 / BD-local). Pure / no I/O. */
  normalizePhone(phone: string): string;
  /** Plain outbound dial — surfaces an "agent calls customer" experience. */
  initiateOutboundCall(args: VoiceInitiateArgs): Promise<VoiceInitiateResult>;
  /**
   * IVR-confirmation call. Optional in PR 1 — adapters without an IVR
   * scripting endpoint throw `VoiceProviderNotImplementedError`. PR 2
   * wires the BD adapter (or a self-hosted Asterisk REST control plane).
   */
  initiateConfirmationCall?(
    args: VoiceConfirmationCallArgs,
  ): Promise<VoiceInitiateResult>;
  getCallDetails(callId: string): Promise<VoiceCallDetails>;
  hangup(
    callId: string,
  ): Promise<{ callId: string; providerStatus: string | null }>;
  verifyWebhookSignature(input: VoiceWebhookVerifyInput): boolean;
}

export class VoiceProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`Voice provider '${provider}' is not configured`);
    this.name = "VoiceProviderNotConfiguredError";
  }
}

export class VoiceProviderNotImplementedError extends Error {
  constructor(method: string, provider: string) {
    super(`Voice provider '${provider}' does not implement ${method}`);
    this.name = "VoiceProviderNotImplementedError";
  }
}
