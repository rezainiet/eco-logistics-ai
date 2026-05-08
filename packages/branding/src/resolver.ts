import type { BrandingConfig, BrandingPatch } from "./types.js";
import { DEFAULT_BRANDING } from "./defaults.js";
import { mergeBranding } from "./merge.js";
import { parseEnvOverrides } from "./env.js";

/**
 * The cross-runtime branding resolver.
 *
 * `getBranding()` is the one function every consumer (SSR, RSC, client,
 * email worker, script) calls. It composes:
 *
 *   1. Baked-in defaults (`DEFAULT_BRANDING`)
 *   2. Optional store-backed overrides (passed in by `apps/api` via the
 *      Mongo-backed `BrandingConfig` model — `@ecom/db` knows how)
 *   3. ENV overrides (`BRANDING_OVERRIDES` JSON)
 *
 * No I/O is built into this function. The store lookup is injected so the
 * package stays runtime-agnostic — both Node (api) and Edge (Next.js
 * middleware, in theory) can host it.
 */

export interface BrandingResolverOptions {
  /** Optional async fetcher for the persisted patch. Should NEVER throw —
   * resolve to `null` on any failure. */
  fetch?: (key: string) => Promise<BrandingPatch | null>;
  /** Branding key. Defaults to "saas". Reserved for future multi-brand. */
  key?: string;
  /** Override the env reader. Defaults to `process.env.BRANDING_OVERRIDES`. */
  envOverrideRaw?: string | undefined;
  /** Logger for ENV-parse warnings. Defaults to `console.warn`. */
  warn?: (msg: string) => void;
}

let memoizedFor: { key: string; until: number; value: BrandingConfig } | null =
  null;

/** TTL for the in-process resolver cache. 60s matches the architecture doc. */
export const BRANDING_CACHE_TTL_MS = 60_000;

/** Force the next `getBranding()` call to re-fetch (used by the admin
 * panel's mutation success handler and tests). */
export function invalidateBranding(): void {
  memoizedFor = null;
}

export async function getBranding(
  options: BrandingResolverOptions = {},
): Promise<BrandingConfig> {
  const key = options.key ?? "saas";
  const now = Date.now();
  if (memoizedFor && memoizedFor.key === key && memoizedFor.until > now) {
    return memoizedFor.value;
  }

  // Always start from defaults so a complete BrandingConfig is guaranteed.
  let resolved: BrandingConfig = { ...DEFAULT_BRANDING, key };

  // 1) Store-backed patch (DB). Fail-safe: any error → log + skip.
  if (options.fetch) {
    try {
      const patch = await options.fetch(key);
      if (patch) {
        resolved = mergeBranding(resolved, patch);
      }
    } catch (err) {
      (options.warn ?? console.warn)(
        `[branding] store fetcher failed; using defaults + env: ${(err as Error).message}`,
      );
    }
  }

  // 2) ENV override. Highest precedence so a deploy can pin/recover.
  const envRaw =
    options.envOverrideRaw ??
    (typeof process !== "undefined" ? process.env.BRANDING_OVERRIDES : undefined);
  const envPatch = parseEnvOverrides(envRaw, options.warn);
  resolved = mergeBranding(resolved, envPatch);

  memoizedFor = { key, until: now + BRANDING_CACHE_TTL_MS, value: resolved };
  return resolved;
}

/**
 * Synchronous variant for code paths that absolutely cannot await
 * (e.g. React error boundary). Returns defaults plus ENV overrides only —
 * no DB lookup. NEVER throws.
 */
export function getBrandingSync(
  options: { envOverrideRaw?: string; warn?: (msg: string) => void; key?: string } = {},
): BrandingConfig {
  const envRaw =
    options.envOverrideRaw ??
    (typeof process !== "undefined" ? process.env.BRANDING_OVERRIDES : undefined);
  const envPatch = parseEnvOverrides(envRaw, options.warn);
  return mergeBranding(
    { ...DEFAULT_BRANDING, key: options.key ?? "saas" },
    envPatch,
  );
}
