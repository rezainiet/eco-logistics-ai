import type { Request } from "express";

/**
 * Read the raw request body a signed webhook router captured with its own
 * route-level `express.raw`. Signatures cover the exact bytes, so the
 * router must be mounted BEFORE the global `express.json()` (see index.ts).
 *
 *   - Buffer           → the raw bytes as a UTF-8 string (verify, then parse once)
 *   - no/empty body    → "" (signature verification then fails as usual)
 *   - a parsed object  → `misconfigured`: a body parser ran first and the
 *     signed bytes are gone. That is a server wiring fault, not a bad
 *     request, so callers answer 500 and log it instead of a misleading 401.
 */
export function readRawWebhookBody(
  req: Request,
): { ok: true; raw: string } | { ok: false; error: "webhook_misconfigured" } {
  const body: unknown = req.body;
  if (Buffer.isBuffer(body)) return { ok: true, raw: body.toString("utf8") };
  if (body && typeof body === "object" && Object.keys(body).length > 0) {
    return { ok: false, error: "webhook_misconfigured" };
  }
  return { ok: true, raw: "" };
}
