import type { BrandingPatch } from "./types.js";

/**
 * Parse `BRANDING_OVERRIDES` into a `BrandingPatch`.
 *
 * Useful for staging environments that want to flag themselves visibly
 * ("Cordon · STAGING") and emergency rollbacks if a bad branding write
 * to Mongo breaks rendering.
 *
 * Bad JSON returns `{}` and warns instead of throwing — branding overrides
 * must never crash a render path.
 */
export function parseEnvOverrides(
  raw: string | undefined,
  warn: (msg: string) => void = () => {},
): BrandingPatch {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      warn("[branding] BRANDING_OVERRIDES did not parse as a JSON object; ignoring.");
      return {};
    }
    return parsed as BrandingPatch;
  } catch (err) {
    warn(
      `[branding] BRANDING_OVERRIDES could not be parsed as JSON: ${(err as Error).message}; ignoring.`,
    );
    return {};
  }
}

/**
 * Walks the patch and returns a flat list of dotted keys that were set,
 * so the admin panel can show "this field is locked by env override".
 */
export function listOverriddenFields(patch: BrandingPatch): string[] {
  const out: string[] = [];
  function walk(prefix: string, obj: unknown) {
    if (obj === null || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        walk(path, v);
      } else {
        out.push(path);
      }
    }
  }
  walk("", patch);
  return out;
}
