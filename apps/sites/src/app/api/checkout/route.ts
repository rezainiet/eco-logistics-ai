import { normalizeHost } from "@ecom/landing";
import { landingApiUrl, landingRootDomain } from "@/lib/config";

/**
 * Same-origin checkout proxy for published landing pages.
 *
 * The browser posts its cart here (same origin — no CORS, no API URL in
 * the page). This handler forwards it to the API with the page's own Host
 * header as the only page identifier; the API re-derives page, merchant,
 * prices and stock from that, so nothing in the body is trusted.
 *
 * It adds the customer's IP for fraud scoring and per-IP limits — only
 * with the shared LANDING_PROXY_SECRET, otherwise the API ignores it.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;
const hits = new Map<string, { n: number; until: number }>();

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first && /^[0-9a-fA-F.:]{3,45}$/.test(first) ? first : (req.headers.get("x-real-ip") ?? "unknown");
}

function limited(ip: string): boolean {
  const now = Date.now();
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
  const h = hits.get(ip);
  if (!h || h.until < now) {
    hits.set(ip, { n: 1, until: now + WINDOW_MS });
    return false;
  }
  h.n += 1;
  return h.n > MAX_PER_WINDOW;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function POST(req: Request): Promise<Response> {
  const host = normalizeHost(req.headers.get("host"));
  const root = landingRootDomain();
  if (!host || !root || !host.endsWith(`.${root}`)) return json(404, { ok: false, code: "page_unavailable" });
  // Same-origin only: a form or script on another site cannot place orders here.
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (normalizeHost(new URL(origin).host) !== host) return json(403, { ok: false, code: "forbidden" });
    } catch {
      return json(403, { ok: false, code: "forbidden" });
    }
  }
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return json(415, { ok: false, code: "invalid_request" });
  const ip = clientIp(req);
  if (limited(ip)) return json(429, { ok: false, code: "rate_limited" });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { ok: false, code: "invalid_request" });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(400, { ok: false, code: "invalid_request" });
  }
  // Forward only the fields the API reads; the host is the page's own.
  const forward = {
    host,
    locale: typeof body.locale === "string" ? body.locale : null,
    idempotencyKey: body.idempotencyKey,
    items: body.items,
    customer: body.customer,
    deliveryOptionId: body.deliveryOptionId ?? null,
  };
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const ua = req.headers.get("user-agent");
  if (ua) headers["user-agent"] = ua.slice(0, 500);
  const secret = process.env.LANDING_PROXY_SECRET?.trim();
  if (secret && ip !== "unknown") {
    headers["x-landing-proxy-secret"] = secret;
    headers["x-landing-client-ip"] = ip;
  }
  try {
    const res = await fetch(`${landingApiUrl()}/api/landing/orders`, { method: "POST", headers, body: JSON.stringify(forward), cache: "no-store" });
    const out = await res.json().catch(() => ({ ok: false, code: "server_error" }));
    return json(res.status, out);
  } catch {
    return json(502, { ok: false, code: "server_error" });
  }
}
