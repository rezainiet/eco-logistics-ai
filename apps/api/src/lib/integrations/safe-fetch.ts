import dns from "node:dns/promises";
import { isPrivateOrLoopbackHost } from "@ecom/types";
import { IntegrationError } from "./types.js";

/**
 * SSRF guard for outbound calls to merchant-supplied URLs.
 *
 * The static validator in `isAllowedWooSiteUrl` rejects URLs whose hostname
 * is a literal private IP (127.0.0.1, 169.254.169.254, etc.) at connect
 * time. That alone is NOT enough — an attacker can register a public
 * hostname (e.g. `evil.example.com`) whose A record points at AWS IMDS
 * (169.254.169.254). The static check passes; the actual TCP connection
 * targets internal infra. This is the classic DNS-rebinding-style SSRF.
 *
 * To close that gap we resolve the hostname here and re-run the same
 * private-range predicate against EVERY resolved address. The check runs
 * in production only — local dev sandboxes (localhost, private LAN) need
 * to keep working, and the static validator already restricts dev-mode
 * URLs to a known allowlist.
 *
 * Limitations:
 *  - DNS can change between this lookup and the actual fetch. The window
 *    is small (single-digit ms) and Node's stub resolver caches per
 *    process for the address's TTL. For a tighter guarantee you'd resolve
 *    here and pass the IP literal to `fetch` with a Host: header — left
 *    as future work because it breaks SNI for HTTPS.
 *  - Some platforms route IPv6 first; we check ALL records `dns.lookup`
 *    returns with `{all: true}` so a dual-stack victim isn't bypassed
 *    via AAAA-only.
 */

/** Resolves `hostname` and throws an `IntegrationError` if any A/AAAA
 *  record falls in a private/loopback/link-local range. */
export async function assertPublicHost(hostname: string): Promise<void> {
  // Dev/test: skip the DNS check so localhost, 127.0.0.1, and private LAN
  // dev hosts keep working. The static validator (`isAllowedWooSiteUrl`)
  // already restricts what the dev-mode merchant can submit.
  if (process.env.NODE_ENV !== "production") return;

  // Static pass — handles IP literals (`http://10.0.0.1`) before we even
  // hit DNS. Cheap.
  if (isPrivateOrLoopbackHost(hostname)) {
    throw new IntegrationError(
      `ssrf: refusing to call private host ${hostname}`,
    );
  }

  let resolved: string[];
  try {
    const records = await dns.lookup(hostname, { all: true });
    resolved = records.map((r) => r.address);
  } catch (err) {
    // An unresolvable hostname is itself suspicious. Surface as an
    // IntegrationError so the caller can show the merchant a meaningful
    // failure rather than a 5xx.
    throw new IntegrationError(
      `ssrf: cannot resolve ${hostname}: ${(err as Error).message}`,
    );
  }
  if (resolved.length === 0) {
    throw new IntegrationError(`ssrf: ${hostname} has no public DNS records`);
  }
  for (const ip of resolved) {
    if (isPrivateOrLoopbackHost(ip)) {
      throw new IntegrationError(
        `ssrf: ${hostname} resolves to private ip ${ip}`,
      );
    }
  }
}

/**
 * Wrapper around `fetch` that runs the public-host assertion on the URL's
 * hostname before issuing the request. `fetchImpl` is injectable so tests
 * can mock the actual HTTP call without bypassing the SSRF check (set
 * NODE_ENV=production to exercise the assertion in tests).
 */
export async function safeFetch(
  url: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new IntegrationError(`ssrf: invalid url ${url}`);
  }
  await assertPublicHost(parsed.hostname);
  return fetchImpl(url, init);
}
