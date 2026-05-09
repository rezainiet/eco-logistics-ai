import { z } from "zod";
import { env } from "../../../env.js";
import { boundedFetch } from "./bounded.js";
import type {
  ExternalProviderAdapter,
  ProviderFetchInput,
  ProviderFetchResult,
} from "./types.js";

/**
 * BDCourier provider adapter — real HTTP integration against
 * https://bdcourier.com/api.
 *
 * Architectural notes:
 *
 *   - BDCourier is a PLATFORM service (single API key, not merchant-
 *     credentialed). The adapter ignores `input.merchantId`; the
 *     orchestrator's per-(merchant, phoneHash) cache key still scopes
 *     storage so each merchant pays its own rate-limit / cache miss.
 *   - Adapter NEVER logs the Authorization header. boundedFetch's
 *     classifyError strips error detail to bounded codes; raw error
 *     text is sliced to 200 chars at the orchestrator boundary.
 *   - Treat ALL BDCourier data as ADVISORY operational evidence — not
 *     authoritative truth, not a fraud verdict. Provider-side
 *     cancellations may include merchant-side cancellations and
 *     buyer-side rejections lumped together.
 *
 * Mapping contract (binding):
 *
 *   BDCourier successful_parcel  →  delivered
 *   BDCourier cancelled_parcel   →  cancelled
 *   RTOs separated?              →  no — set rto = 0 honestly
 *                                   (the elevated_return_pattern
 *                                   signal in signals.ts uses
 *                                   (rto + cancelled) / total which
 *                                   captures this correctly)
 *   reports[]                    →  DISCARDED. User-generated,
 *                                   unmoderated; never persisted,
 *                                   never logged, never surfaced.
 *   Per-courier breakdown        →  DISCARDED in v1. Aggregate only.
 *   success_ratio (upstream)     →  DISCARDED. We don't trust the
 *                                   denominator; recompute locally.
 *
 * Hard rules (binding):
 *   - NEVER throws back to the orchestrator.
 *   - Bounded timeout via boundedFetch.
 *   - Pure response-parser (`parseBdCourierResponse`) is exported
 *     separately so the mapping logic is unit-testable without HTTP.
 */

/* -------------------------------------------------------------------------- */
/* Response schema — defensive                                                */
/* -------------------------------------------------------------------------- */

/**
 * BDCourier responses observed in the wild come in slightly different
 * shapes depending on endpoint version. We accept multiple variants
 * with a permissive zod schema, then normalise.
 *
 *   variant A: { courierData: { summary: {...}, courier: {...} } }
 *   variant B: { data: { summary: {...}, ... } }
 *   variant C: { summary: {...} }                  — flat shape
 *
 * Field names also vary: `successful_parcel` / `success_parcel`,
 * `cancelled_parcel` / `cancel_parcel` / `cancelled`, etc. The
 * parser tries known aliases conservatively. Unknown / malformed
 * shapes return ok=false with error="bad_payload".
 */

// Numeric coercion helper — BDCourier sometimes returns counters as
// strings ("100") instead of numbers (100).
const numericCoerce = z.preprocess((v) => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return v;
}, z.number().nonnegative().optional());

const summarySchema = z
  .object({
    total_parcel: numericCoerce.optional(),
    total: numericCoerce.optional(),
    successful_parcel: numericCoerce.optional(),
    success_parcel: numericCoerce.optional(),
    successful: numericCoerce.optional(),
    delivered: numericCoerce.optional(),
    cancelled_parcel: numericCoerce.optional(),
    cancel_parcel: numericCoerce.optional(),
    cancelled: numericCoerce.optional(),
  })
  .passthrough();

const responseSchema = z
  .object({
    courierData: z
      .object({ summary: summarySchema.optional() })
      .passthrough()
      .optional(),
    data: z
      .object({ summary: summarySchema.optional() })
      .passthrough()
      .optional(),
    summary: summarySchema.optional(),
    // Top-level fields when the API returns flat shape.
    total_parcel: numericCoerce.optional(),
    successful_parcel: numericCoerce.optional(),
    cancelled_parcel: numericCoerce.optional(),
  })
  .passthrough();

interface NormalisedCounters {
  total: number;
  delivered: number;
  rto: number;
  cancelled: number;
}

/**
 * Pure mapping function. Same input → same output. Never throws —
 * malformed input returns ok=false with stable error code.
 *
 * Exposed for unit tests so we can pin the canonical mapping
 * contract against representative BDCourier response shapes without
 * needing real HTTP.
 */
export function parseBdCourierResponse(
  payload: unknown,
):
  | { ok: true; counters: NormalisedCounters }
  | { ok: false; error: "bad_payload"; detail: string } {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: "bad_payload",
      detail: parsed.error.issues
        .slice(0, 3)
        .map((i) => i.path.join(".") + ":" + i.code)
        .join(";")
        .slice(0, 200),
    };
  }
  const root = parsed.data;
  // Locate the summary block, preferring the more-specific paths.
  const summary =
    root.courierData?.summary ??
    root.data?.summary ??
    root.summary ??
    {
      total_parcel: root.total_parcel,
      successful_parcel: root.successful_parcel,
      cancelled_parcel: root.cancelled_parcel,
    };

  const delivered =
    summary.delivered ??
    summary.successful ??
    summary.successful_parcel ??
    summary.success_parcel ??
    0;
  const cancelled =
    summary.cancelled ??
    summary.cancelled_parcel ??
    summary.cancel_parcel ??
    0;
  const totalExplicit = summary.total ?? summary.total_parcel;
  const total =
    totalExplicit ?? delivered + cancelled;

  // BDCourier doesn't separate RTO from cancelled. Honest under-
  // reporting: leave rto=0 here. The downstream signal classifier
  // uses (rto + cancelled) / total for elevated_return_pattern, so
  // the ambiguity is captured correctly without falsely inflating
  // either category.
  const rto = 0;

  // Sanity — total must be >= sum of components. If the upstream
  // returned a wildly inconsistent response (e.g. delivered > total),
  // reject as bad_payload rather than persist garbage.
  if (delivered + cancelled > total) {
    return {
      ok: false,
      error: "bad_payload",
      detail: `inconsistent counters: delivered=${delivered} cancelled=${cancelled} total=${total}`,
    };
  }
  if (
    !Number.isFinite(total) ||
    !Number.isFinite(delivered) ||
    !Number.isFinite(cancelled) ||
    total < 0 ||
    delivered < 0 ||
    cancelled < 0
  ) {
    return {
      ok: false,
      error: "bad_payload",
      detail: "non-finite or negative counter",
    };
  }

  return {
    ok: true,
    counters: { total, delivered, rto, cancelled },
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP error envelope                                                        */
/* -------------------------------------------------------------------------- */

class BdCourierHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class BdCourierBadPayloadError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

export const bdcourierAdapter: ExternalProviderAdapter = {
  name: "bdcourier",
  sourceVersion: "bdcourier-v1",

  isConfigured(): boolean {
    if (!env.BDCOURIER_ENABLED) return false;
    const key = env.BDCOURIER_API_KEY;
    return typeof key === "string" && key.trim().length > 0;
  },

  async fetchHistory(input: ProviderFetchInput): Promise<ProviderFetchResult> {
    const apiKey = env.BDCOURIER_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error: "stub_unconfigured",
        durationMs: 0,
        timedOut: false,
      };
    }
    const baseUrl = env.BDCOURIER_BASE_URL.replace(/\/+$/, "");
    const phone = input.normalizedPhone;

    return boundedFetch({
      input: {
        ...input,
        timeoutMs: input.timeoutMs || env.BDCOURIER_TIMEOUT_MS,
      },
      classifyError: (err) => {
        if (err instanceof BdCourierBadPayloadError) return "bad_payload";
        if (err instanceof BdCourierHttpError) return "http_error";
        if (err instanceof TypeError) return "http_error"; // fetch network errors
        return "unexpected";
      },
      work: async (signal) => {
        // Phone is sent as a path component; never embedded into a
        // querystring along with the API key. The API key is sent
        // ONLY in the Authorization header.
        const url = `${baseUrl}/courier-check/${encodeURIComponent(phone)}`;
        const res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
            "User-Agent": "ConfirmX-ExternalDelivery/1.0",
          },
          signal,
        });
        if (!res.ok) {
          // Read body but DO NOT surface raw — a 401/403 response
          // could echo Authorization back; we slice + classify only.
          let text = "";
          try {
            text = (await res.text()).slice(0, 200);
          } catch {
            /* nothing */
          }
          throw new BdCourierHttpError(
            res.status,
            `BDCourier responded ${res.status}: ${text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")}`,
          );
        }
        let json: unknown;
        try {
          json = await res.json();
        } catch (e) {
          throw new BdCourierBadPayloadError(
            `BDCourier returned non-JSON body: ${(e as Error).message?.slice(0, 100)}`,
          );
        }
        const parsed = parseBdCourierResponse(json);
        if (!parsed.ok) {
          throw new BdCourierBadPayloadError(parsed.detail);
        }
        return parsed.counters;
      },
    });
  },
};

/* -------------------------------------------------------------------------- */
/* Test surface                                                               */
/* -------------------------------------------------------------------------- */

export const __TEST = {
  responseSchema,
  BdCourierHttpError,
  BdCourierBadPayloadError,
};
