// ConfirmX custom-domain helper — logic (pure + injected side effects).
//
// Runs as root on the VPS from a systemd timer (see README.md). It is the
// ONLY component that touches certificates or Nginx for merchant custom
// domains, and it can do exactly five things:
//
//   1. certbot certonly --webroot   (issue a cert named cx-<domain>)
//   2. certbot delete               (only certs named cx-<domain>)
//   3. write ONE file:  <nginxDir>/domains.conf   (+ its .bak)
//   4. nginx -t
//   5. systemctl reload nginx       (graceful)
//
// Every command is an exact argv checked against an allowlist and run
// without a shell. Hostnames come from the ConfirmX API but are validated
// again here, strictly, before they reach a command line or a config file.
// It never touches Asterisk, the firewall, SSH, DNS, other Nginx files or
// certificates it does not manage (the platform's own certificates are
// never named cx-*).

export const CERT_PREFIX = "cx-";
export const MAX_ISSUES_PER_RUN = 5;
export const RENEW_BEFORE_MS = 30 * 24 * 3600_000;

export const BIN = Object.freeze({
  certbot: "/usr/bin/certbot",
  nginx: "/usr/sbin/nginx",
  systemctl: "/usr/bin/systemctl",
});

// The installation trust check lives in the bootstrap (confirmx-domains-helper.mjs),
// which runs it BEFORE this module is loaded at all.

export const DEFAULT_PATHS = Object.freeze({
  nginxDir: "/etc/nginx/confirmx-custom-domains",
  webroot: "/var/www/certbot",
  letsencryptLive: "/etc/letsencrypt/live",
});

const PLATFORM_DOMAINS = ["confirmx.ai"];
const NON_PUBLIC_TLDS = new Set(["localhost", "local", "internal", "intranet", "lan", "home", "corp", "arpa", "invalid", "onion", "test", "example"]);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Strict hostname check: lowercase ASCII DNS name, ≥2 labels, public TLD, not a platform name. */
export function validHostname(h, { extraPlatformDomains = [] } = {}) {
  if (typeof h !== "string" || h.length < 4 || h.length > 253) return false;
  if (h !== h.toLowerCase() || h.endsWith(".")) return false;
  const labels = h.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  const tld = labels[labels.length - 1];
  if (!TLD.test(tld) || NON_PUBLIC_TLDS.has(tld)) return false;
  if (/^[0-9.]+$/.test(h)) return false;
  for (const d of [...PLATFORM_DOMAINS, ...extraPlatformDomains]) if (h === d || h.endsWith(`.${d}`)) return false;
  return true;
}

export const certName = (host) => `${CERT_PREFIX}${host}`;

/** The exact commands this helper may run. Anything else is refused. */
export function commandAllowed(bin, args) {
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (bin === BIN.nginx) return same(args, ["-t"]);
  if (bin === BIN.systemctl) return same(args, ["reload", "nginx"]);
  if (bin === BIN.certbot) {
    if (args[0] === "certonly") {
      const host = args[6];
      return validHostname(host) && same(args, ["certonly", "--webroot", "-w", args[3], "--non-interactive", "-d", host, "--cert-name", certName(host), "--agree-tos", "--keep-until-expiring"]) && args[3] === DEFAULT_PATHS.webroot;
    }
    if (args[0] === "delete") {
      const name = args[2] ?? "";
      return name.startsWith(CERT_PREFIX) && validHostname(name.slice(CERT_PREFIX.length)) && same(args, ["delete", "--cert-name", name, "--non-interactive"]);
    }
  }
  return false;
}

export const issueArgs = (host) => ["certonly", "--webroot", "-w", DEFAULT_PATHS.webroot, "--non-interactive", "-d", host, "--cert-name", certName(host), "--agree-tos", "--keep-until-expiring"];
export const deleteArgs = (host) => ["delete", "--cert-name", certName(host), "--non-interactive"];

/** Nginx server blocks for the served domains (sorted, deterministic). */
export function renderNginxConfig(hosts, paths = DEFAULT_PATHS) {
  const list = [...new Set(hosts)].sort();
  for (const h of list) if (!validHostname(h)) throw new Error(`refusing to render invalid hostname`);
  const blocks = list.map(
    (h) => `# ${h}
server {
    listen 80;
    listen [::]:80;
    server_name ${h};
    location /.well-known/acme-challenge/ { root ${paths.webroot}; }
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${h};

    ssl_certificate     ${paths.letsencryptLive}/${certName(h)}/fullchain.pem;
    ssl_certificate_key ${paths.letsencryptLive}/${certName(h)}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:confirmx_tls:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    # No HSTS here: the merchant's domain policy is theirs, not the platform's.

    client_max_body_size 64k;                      # checkout JSON only

    location / {
        proxy_pass http://confirmx_sites;
        include /etc/nginx/snippets/confirmx-proxy-sites.conf;
    }
}
`,
  );
  return `# Managed by confirmx-domains-helper — DO NOT EDIT (rewritten on every change).
# Merchant custom domains routed to the landing renderer (confirmx_sites).
${blocks.join("\n")}`;
}

/** Merchant-safe message for a failed issuance (never raw command output). */
export function issueErrorMessage(output) {
  const o = String(output ?? "");
  if (/NXDOMAIN|DNS problem/i.test(o)) return "The domain's DNS records were not found. Check the A/CNAME record and try again.";
  if (/unauthorized|Invalid response|404/i.test(o)) return "The certificate authority could not reach your domain here. Check that the domain points to ConfirmX.";
  if (/too many|rate limit/i.test(o)) return "Certificate limit reached for this domain. Try again later.";
  if (/timeout|timed out|connection/i.test(o)) return "The certificate authority could not connect to your domain. Try again in a few minutes.";
  return "The certificate could not be issued. Check the DNS records and try again.";
}

/**
 * One reconciliation run.
 *
 * deps: {
 *   fetchDesired(): Promise<{ enabled: boolean, domains: [{hostname, action, issueAllowed?, retryAfter?}] }>,
 *   report(results): Promise<void>,
 *   run(bin, args): Promise<{ code: number, output: string }>,   // never a shell
 *   readFile(path): Promise<string|null>, writeFile(path, text), rename(from, to), listDir(path): Promise<string[]>,
 *   certExpiry(host): Promise<Date|null>,
 *   log(obj), now(): Date,
 *   allowMassRemoval?: boolean,
 * }
 */
export async function reconcile(deps, paths = DEFAULT_PATHS) {
  const run = async (bin, args) => {
    if (!commandAllowed(bin, args)) throw new Error(`command not allowed: ${bin} ${args[0] ?? ""}`);
    return deps.run(bin, args);
  };
  const desired = await deps.fetchDesired();
  if (!desired || desired.enabled !== true || !Array.isArray(desired.domains)) {
    deps.log({ evt: "skip", reason: "custom domains disabled or no data" });
    return { changed: false, results: [] };
  }

  const entries = desired.domains.filter((d) => {
    const ok = d && validHostname(d.hostname) && ["issue", "serve", "hold"].includes(d.action);
    if (!ok) deps.log({ evt: "invalid_entry_skipped" });
    return ok;
  });
  const known = new Set(entries.map((d) => d.hostname));
  const confPath = `${paths.nginxDir}/domains.conf`;
  const current = (await deps.readFile(confPath)) ?? "";
  const currentlyServed = [...current.matchAll(/^# ([a-z0-9.-]+)$/gm)].map((m) => m[1]).filter((h) => validHostname(h));

  const results = [];
  const serve = [];
  let issued = 0;
  for (const d of entries) {
    if (d.action === "hold") continue;
    const expiry = await deps.certExpiry(d.hostname);
    if (d.issueAllowed === false) {
      // Active retry backoff after a failed issuance — checked FIRST, whatever
      // the certificate's state: never call certbot (Let's Encrypt
      // failed-validation limits) and report NOTHING, so the API keeps its
      // failure count and retryAfter (a "live" report would reset them just
      // because an old certificate is still valid). An existing certificate
      // keeps being served.
      if (expiry) serve.push(d.hostname);
      deps.log({ evt: "issue_backoff", hostname: d.hostname, retryAfter: d.retryAfter ?? null });
      continue;
    }
    const fresh = expiry && expiry.getTime() - deps.now().getTime() > RENEW_BEFORE_MS;
    if (!fresh && d.action === "serve" && expiry && expiry.getTime() > deps.now().getTime()) {
      // Serving with a still-valid cert: certbot.timer renews it; keep serving.
      serve.push(d.hostname);
      results.push({ hostname: d.hostname, outcome: "live", certExpiresAt: expiry.toISOString() });
      continue;
    }
    if (!fresh) {
      if (issued >= MAX_ISSUES_PER_RUN) continue; // next run
      issued++;
      const r = await run(BIN.certbot, issueArgs(d.hostname));
      if (r.code !== 0) {
        deps.log({ evt: "issue_failed", hostname: d.hostname });
        results.push({ hostname: d.hostname, outcome: "failed", error: issueErrorMessage(r.output) });
        continue;
      }
    }
    const exp = await deps.certExpiry(d.hostname);
    if (!exp) {
      results.push({ hostname: d.hostname, outcome: "failed", error: "The certificate could not be issued. Check the DNS records and try again." });
      continue;
    }
    serve.push(d.hostname);
    results.push({ hostname: d.hostname, outcome: "live", certExpiresAt: exp.toISOString() });
  }

  // Safety valve: never drop most served domains in one run by accident.
  const dropping = currentlyServed.filter((h) => !serve.includes(h));
  if (!deps.allowMassRemoval && dropping.length > 3 && dropping.length > currentlyServed.length / 2) {
    deps.log({ evt: "mass_removal_refused", dropping: dropping.length, served: currentlyServed.length });
    throw new Error("refusing to remove most custom domains in one run (re-run with --allow-mass-removal after checking)");
  }

  const next = renderNginxConfig(serve, paths);
  let changed = false;
  if (next !== current) {
    const bak = `${confPath}.bak`;
    const tmp = `${confPath}.tmp`;
    if (current) await deps.writeFile(bak, current);
    await deps.writeFile(tmp, next);
    await deps.rename(tmp, confPath);
    const test = await run(BIN.nginx, ["-t"]);
    if (test.code !== 0) {
      // Roll back to the previous file (or an empty one) and leave Nginx as it was.
      await deps.writeFile(tmp, current);
      await deps.rename(tmp, confPath);
      deps.log({ evt: "nginx_test_failed_rolled_back" });
      const failed = results.map((r) => (r.outcome === "live" && !currentlyServed.includes(r.hostname) ? { hostname: r.hostname, outcome: "failed", error: "Server configuration error — ConfirmX has been notified." } : r));
      await deps.report(failed.filter((r) => r.outcome === "failed"));
      throw new Error("nginx -t failed; previous configuration restored");
    }
    const reload = await run(BIN.systemctl, ["reload", "nginx"]);
    if (reload.code !== 0) throw new Error("nginx reload failed");
    changed = true;
  }

  // Certificates of domains that no longer exist at all (removed/archived).
  let certDirs = [];
  try {
    certDirs = await deps.listDir(paths.letsencryptLive);
  } catch {
    certDirs = [];
  }
  for (const dir of certDirs) {
    if (!dir.startsWith(CERT_PREFIX)) continue;
    const host = dir.slice(CERT_PREFIX.length);
    if (!validHostname(host) || known.has(host) || serve.includes(host)) continue;
    const r = await run(BIN.certbot, deleteArgs(host));
    deps.log({ evt: r.code === 0 ? "cert_deleted" : "cert_delete_failed", hostname: host });
  }

  if (results.length) await deps.report(results);
  deps.log({ evt: "done", served: serve.length, issued, changed });
  return { changed, results };
}
