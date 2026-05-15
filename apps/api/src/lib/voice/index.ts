import { env } from "../../env.js";
import { StubVoiceProvider } from "./stub.js";
import { TwilioVoiceProvider } from "./twilio.js";
import type { VoiceProvider } from "./types.js";

export type {
  VoiceCallDetails,
  VoiceConfirmationCallArgs,
  VoiceInitiateArgs,
  VoiceInitiateResult,
  VoiceProvider,
  VoiceWebhookVerifyInput,
} from "./types.js";
export {
  VoiceProviderNotConfiguredError,
  VoiceProviderNotImplementedError,
} from "./types.js";

let cached: VoiceProvider | undefined;

/**
 * Resolve the active voice provider.
 *
 * Selection is driven by env.VOICE_PROVIDER. Adapter instances are cached
 * for the lifetime of the process — the underlying provider clients
 * (e.g. Twilio's HTTP client) hold connection state and should not be
 * rebuilt on every call. Test code that needs to mutate process.env
 * calls `__resetVoiceProvider()` to invalidate the cache.
 */
export function getVoiceProvider(): VoiceProvider {
  if (cached) return cached;
  switch (env.VOICE_PROVIDER) {
    case "twilio":
      cached = new TwilioVoiceProvider();
      return cached;
    case "stub":
    default:
      cached = new StubVoiceProvider();
      return cached;
  }
}

/** Test-only escape hatch. Production code never calls this. */
export function __setVoiceProvider(p: VoiceProvider | undefined): void {
  cached = p;
}

/** Reset cached provider so the next `getVoiceProvider` call rebuilds. */
export function __resetVoiceProvider(): void {
  cached = undefined;
}

/**
 * Convenience for the merchant-facing "is voice usable right now" check
 * that the existing call.isConfigured tRPC procedure surfaces. Returns
 * true only when the *active* adapter reports configured — flipping
 * VOICE_PROVIDER off twilio while Twilio creds are still set will
 * correctly report false rather than masking a misconfiguration.
 */
export function isVoiceConfigured(): boolean {
  return getVoiceProvider().isConfigured();
}
