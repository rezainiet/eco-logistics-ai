import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * CSP violation receiver.
 *
 * The browser POSTs a JSON body to this endpoint when a Content-
 * Security-Policy directive (in Report-Only or enforce mode) is
 * violated. We log a structured single line — easy to pick up from a
 * Railway / Vercel log stream and feed into ops review without paying
 * for a third-party CSP-report aggregator.
 *
 * Two body shapes are sent depending on the browser version:
 *
 *   { "csp-report": { "document-uri": ..., "violated-directive": ... } }
 *      — legacy `report-uri` (we use this in next.config.mjs)
 *
 *   [{ "type": "csp-violation", "body": { ... } }]
 *      — modern `Reporting-Endpoints` / `report-to`
 *
 * Both shapes get logged. The endpoint never reads cookies, never
 * touches Mongo, and always returns 204 — the browser doesn't care
 * about the response body, and we never want a malformed report to
 * surface as a user-visible error.
 *
 * Rate-limiting: not applied here. Browsers self-throttle CSP reports
 * per origin/document, so a flood-attack via this endpoint isn't a
 * realistic vector. If volumes ever look concerning, add a per-IP
 * limiter at the edge (Vercel Edge Config / Cloudflare).
 */
export async function POST(req: NextRequest) {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const ua = req.headers.get("user-agent") ?? "unknown";
  const referer = req.headers.get("referer") ?? null;

  const reports = Array.isArray(body) ? body : [body];
  for (const report of reports) {
    if (!report || typeof report !== "object") continue;
    // Normalise across the two shapes browsers send.
    const r = report as Record<string, unknown>;
    const cspReport =
      (r["csp-report"] as Record<string, unknown> | undefined) ??
      ((r.body as Record<string, unknown> | undefined) ?? r);
    const violated =
      (cspReport["violated-directive"] as string | undefined) ??
      (cspReport.violatedDirective as string | undefined) ??
      "unknown-directive";
    const blocked =
      (cspReport["blocked-uri"] as string | undefined) ??
      (cspReport.blockedURL as string | undefined) ??
      null;
    const docUri =
      (cspReport["document-uri"] as string | undefined) ??
      (cspReport.documentURL as string | undefined) ??
      referer;
    const sample =
      (cspReport["script-sample"] as string | undefined) ??
      (cspReport.sample as string | undefined) ??
      null;

    // Single structured line per violation. JSON so log shippers can
    // index by `evt`. Keep cardinality bounded by truncating samples
    // (CSP reports occasionally include large inlined scripts).
    console.warn(
      JSON.stringify({
        evt: "csp.violation",
        directive: violated,
        blocked,
        docUri,
        sample: sample ? String(sample).slice(0, 200) : null,
        ua: ua.slice(0, 120),
      }),
    );
  }

  // 204 No Content — browsers don't expect or use a body.
  return new NextResponse(null, { status: 204 });
}
