import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { env } from "../env.js";
import { applyHelperReport, desiredDomains } from "../lib/landing/custom-domains.js";

/**
 * Internal endpoints for the custom-domain helper that runs as root on the
 * server (deploy/vps/custom-domains/). The helper PULLS the desired domain
 * list and REPORTS certificate results; the API never runs commands.
 *
 * Reachable only when ALL hold, else 404 (nothing to discover):
 *  - CUSTOM_DOMAIN_HELPER_TOKEN is configured and sent as a Bearer token;
 *  - the TCP peer is loopback (the helper calls 127.0.0.1 directly);
 *  - no proxy headers — Nginx adds X-Forwarded-For / X-Real-IP to every
 *    proxied request, so a request through api.<domain> is refused even
 *    though Nginx itself connects from loopback.
 */

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROXY_HEADERS = ["x-forwarded-for", "x-real-ip", "x-forwarded-host", "x-forwarded-proto", "forwarded"];

function tokenOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function helperRequestAllowed(req: Pick<Request, "headers" | "socket">, token: string | undefined = env.CUSTOM_DOMAIN_HELPER_TOKEN): boolean {
  if (!token) return false;
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return false;
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  return tokenOk(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined, token);
}

export const customDomainsInternalRouter = Router();

customDomainsInternalRouter.use((req, res, next) => {
  if (!helperRequestAllowed(req)) {
    res.status(404).json({ ok: false });
    return;
  }
  res.setHeader("cache-control", "no-store");
  next();
});

customDomainsInternalRouter.get("/desired", async (_req, res) => {
  try {
    res.json({ ok: true, ...(await desiredDomains()) });
  } catch (err) {
    console.error(JSON.stringify({ evt: "custom_domains.desired_failed", error: (err as Error).message?.slice(0, 200) }));
    res.status(500).json({ ok: false });
  }
});

customDomainsInternalRouter.post("/report", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { results?: unknown };
    const out = await applyHelperReport(body.results);
    console.log(JSON.stringify({ evt: "custom_domains.helper_report", ...out }));
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error(JSON.stringify({ evt: "custom_domains.report_failed", error: (err as Error).message?.slice(0, 200) }));
    res.status(500).json({ ok: false });
  }
});
