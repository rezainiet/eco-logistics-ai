import { normalizeHost, validateCustomDomain } from "@ecom/landing";
import { customDomainsAllowed, landingApiUrl, landingRootDomain, nonPublicDomainsAllowed } from "@/lib/config";

/**
 * Shared same-origin proxy for the landing page's small JSON endpoints
 * (cart activity, recovery-link restore). Same rules as /api/checkout:
 * the page's own Host header is the only page identifier, other origins
 * are refused, bodies are size-capped and per-IP limited here, and the
 * customer IP reaches the API only with the shared proxy secret.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first && /^[0-9a-fA-F.:]{3,45}$/.test(first) ? first : (req.headers.get("x-real-ip") ?? "unknown");
}

export function createLimiter(maxPerMinute: number) {
  const hits = new Map<string, { n: number; until: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
    const h = hits.get(ip);
    if (!h || h.until < now) {
      hits.set(ip, { n: 1, until: now + 60_000 });
      return false;
    }
    h.n += 1;
    return h.n > maxPerMinute;
  };
}

export async function proxyLandingJson(
  req: Request,
  opts: { apiPath: string; maxBytes: number; limited: (ip: string) => boolean; pick: (body: Record<string, unknown>) => Record<string, unknown> },
): Promise<Response> {
  const host = normalizeHost(req.headers.get("host"));
  const root = landingRootDomain();
  const platformHost = !!host && !!root && host.endsWith(`.${root}`);
  const customHost = !!host && customDomainsAllowed() && validateCustomDomain(host, { rootDomain: root, allowNonPublic: nonPublicDomainsAllowed() }).ok;
  if (!host || (!platformHost && !customHost)) return json(404, { ok: false, code: "page_unavailable" });
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
  if (opts.limited(ip)) return json(429, { ok: false, code: "rate_limited" });
  const raw = await req.text();
  if (raw.length > opts.maxBytes) return json(413, { ok: false, code: "invalid_request" });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(400, { ok: false, code: "invalid_request" });
  }
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const ua = req.headers.get("user-agent");
  if (ua) headers["user-agent"] = ua.slice(0, 500);
  const secret = process.env.LANDING_PROXY_SECRET?.trim();
  if (secret && ip !== "unknown") {
    headers["x-landing-proxy-secret"] = secret;
    headers["x-landing-client-ip"] = ip;
  }
  try {
    const res = await fetch(`${landingApiUrl()}${opts.apiPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ host, ...opts.pick(body) }),
      cache: "no-store",
    });
    const out = await res.json().catch(() => ({ ok: false, code: "server_error" }));
    return json(res.status, out);
  } catch {
    return json(502, { ok: false, code: "server_error" });
  }
}
