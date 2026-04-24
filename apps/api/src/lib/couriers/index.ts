import { decryptSecret, isEncryptedPayload } from "../crypto.js";
import { PathaoAdapter } from "./pathao.js";
import { RedxAdapter } from "./redx.js";
import { SteadfastAdapter } from "./steadfast.js";
import {
  CourierError,
  type CourierAdapter,
  type CourierCredentials,
  type CourierName,
} from "./types.js";

export type MerchantCourierConfig = {
  name: CourierName;
  accountId: string;
  apiKey: string;
  apiSecret?: string | null;
  baseUrl?: string | null;
  enabled?: boolean;
};

type AdapterFactory = (creds: CourierCredentials) => CourierAdapter;

const registry: Partial<Record<CourierName, AdapterFactory>> = {
  pathao: (creds) => new PathaoAdapter({ credentials: creds }),
  steadfast: (creds) => new SteadfastAdapter({ credentials: creds }),
  redx: (creds) => new RedxAdapter({ credentials: creds }),
};

/** Register/override an adapter factory — used by Day 4+ and tests. */
export function registerCourierAdapter(name: CourierName, factory: AdapterFactory): void {
  registry[name] = factory;
}

export function hasCourierAdapter(name: CourierName): boolean {
  return Boolean(registry[name]);
}

/**
 * Resolve a merchant's stored courier config into a usable adapter. Decrypts
 * secrets on the way out; never returns plaintext.
 */
export function adapterFor(config: MerchantCourierConfig): CourierAdapter {
  const factory = registry[config.name];
  if (!factory) {
    throw new CourierError("not_supported", `courier '${config.name}' is not supported yet`, {
      provider: config.name,
    });
  }
  const apiKey = isEncryptedPayload(config.apiKey)
    ? decryptSecret(config.apiKey)
    : config.apiKey;
  const apiSecret = config.apiSecret
    ? isEncryptedPayload(config.apiSecret)
      ? decryptSecret(config.apiSecret)
      : config.apiSecret
    : undefined;
  return factory({
    accountId: config.accountId,
    apiKey,
    apiSecret,
    baseUrl: config.baseUrl ?? undefined,
  });
}

export * from "./types.js";
