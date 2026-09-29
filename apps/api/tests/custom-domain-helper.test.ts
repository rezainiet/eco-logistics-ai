import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BIN,
  DEFAULT_PATHS,
  INSTALL_DIR,
  trustedInstallProblems,
  MAX_ISSUES_PER_RUN,
  commandAllowed,
  deleteArgs,
  issueArgs,
  issueErrorMessage,
  reconcile,
  renderNginxConfig,
  validHostname,
  type HelperDeps,
  type HelperResult,
} from "../../../deploy/vps/custom-domains/helper-lib.mjs";

/**
 * The root custom-domain helper (deploy/vps/custom-domains/), exercised with
 * fake side effects only: no command, file or network is ever touched here.
 */

const NOW = new Date("2026-09-29T10:00:00Z");
const DAY = 24 * 3600_000;
const CONF = `${DEFAULT_PATHS.nginxDir}/domains.conf`;

function world(opts: {
  desired: { enabled: boolean; domains: Array<{ hostname: string; action: string; issueAllowed?: boolean; retryAfter?: string }> } | null;
  certs?: Record<string, Date>;
  conf?: string | null;
  failIssue?: string[];
  nginxTestFails?: boolean;
  certDirs?: string[];
  allowMassRemoval?: boolean;
}) {
  const certs = { ...(opts.certs ?? {}) };
  const files: Record<string, string> = opts.conf != null ? { [CONF]: opts.conf } : {};
  const commands: Array<{ bin: string; args: string[] }> = [];
  const reports: HelperResult[][] = [];
  const deps: HelperDeps = {
    fetchDesired: async () => opts.desired,
    report: async (r) => void reports.push(r),
    run: async (bin, args) => {
      commands.push({ bin, args });
      if (bin === BIN.certbot && args[0] === "certonly") {
        const host = args[6]!;
        if (opts.failIssue?.includes(host)) return { code: 1, output: "Challenge failed: DNS problem: NXDOMAIN looking up A" };
        certs[host] = new Date(NOW.getTime() + 90 * DAY);
      }
      if (bin === BIN.nginx) return { code: opts.nginxTestFails ? 1 : 0, output: "" };
      return { code: 0, output: "" };
    },
    readFile: async (p) => files[p] ?? null,
    writeFile: async (p, t) => void (files[p] = t),
    rename: async (a, b) => {
      files[b] = files[a]!;
      delete files[a];
    },
    listDir: async () => opts.certDirs ?? [],
    certExpiry: async (h) => certs[h] ?? null,
    log: () => undefined,
    now: () => NOW,
    allowMassRemoval: opts.allowMassRemoval,
  };
  return { deps, files, commands, reports, certs };
}

describe("custom-domain helper — validation and allowlist", () => {
  it("accepts only strict public DNS names, never platform names", () => {
    for (const ok of ["shop.example.com", "example.com", "a-b.c-d.example.co.uk", "xn--80ak6aa92e.com", "shop.xn--p1ai"]) expect(validHostname(ok), ok).toBe(true);
    for (const bad of [
      "", "com", "Shop.example.com", "shop.example.com.", "*.example.com", "shop_example.com", "-shop.example.com",
      "127.0.0.1", "shop.localhost", "shop.test", "confirmx.ai", "api.confirmx.ai", "a.b.confirmx.ai",
      "shop.example.com; rm -rf /", "shop.example.com\nserver { }", "shop.example.com $host", "../../etc/passwd", `${"a".repeat(64)}.com`,
      null, 42,
    ]) expect(validHostname(bad), String(bad)).toBe(false);
  });

  it("allows exactly the five operations, with exact argv", () => {
    expect(commandAllowed(BIN.nginx, ["-t"])).toBe(true);
    expect(commandAllowed(BIN.systemctl, ["reload", "nginx"])).toBe(true);
    expect(commandAllowed(BIN.certbot, issueArgs("shop.example.com"))).toBe(true);
    expect(commandAllowed(BIN.certbot, deleteArgs("shop.example.com"))).toBe(true);
    for (const [bin, args] of [
      [BIN.systemctl, ["restart", "nginx"]],
      [BIN.systemctl, ["reload", "asterisk"]],
      [BIN.systemctl, ["stop", "ufw"]],
      [BIN.nginx, ["-s", "stop"]],
      [BIN.certbot, ["delete", "--cert-name", "wildcard.confirmx.ai", "--non-interactive"]],
      [BIN.certbot, ["delete", "--cert-name", "api.confirmx.ai", "--non-interactive"]],
      [BIN.certbot, ["delete", "--cert-name", "cx-api.confirmx.ai", "--non-interactive"]],
      [BIN.certbot, [...issueArgs("shop.example.com"), "--pre-hook", "sh -c id"]],
      [BIN.certbot, issueArgs("shop.example.com").map((a) => (a === "/var/www/certbot" ? "/etc" : a))],
      [BIN.certbot, ["renew"]],
      ["/bin/sh", ["-c", "id"]],
      ["/usr/sbin/asterisk", ["-rx", "core restart now"]],
      ["/usr/sbin/ufw", ["disable"]],
    ] as Array<[string, string[]]>) {
      expect(commandAllowed(bin, args), `${bin} ${args.join(" ")}`).toBe(false);
    }
  });

  it("renders one HTTP (ACME + redirect) and one HTTPS block per domain, to the sites upstream only", () => {
    const conf = renderNginxConfig(["b.example.com", "a.example.com", "a.example.com"]);
    expect(conf.match(/server_name a\.example\.com;/g)).toHaveLength(2);
    expect(conf.indexOf("a.example.com")).toBeLessThan(conf.indexOf("b.example.com")); // deterministic order
    expect(conf).toContain("ssl_certificate     /etc/letsencrypt/live/cx-a.example.com/fullchain.pem;");
    expect(conf).toContain("location /.well-known/acme-challenge/ { root /var/www/certbot; }");
    expect(conf).toContain("proxy_pass http://confirmx_sites;");
    expect(conf).not.toMatch(/Strict-Transport-Security|confirmx_api|confirmx_web|default_server/);
    expect(renderNginxConfig([])).not.toContain("server {");
    expect(() => renderNginxConfig(["x.example.com; }\nserver { listen 80"])).toThrow();
  });

  it("maps certbot output to merchant-safe messages", () => {
    expect(issueErrorMessage("DNS problem: NXDOMAIN")).toMatch(/DNS records were not found/);
    expect(issueErrorMessage("secret /etc/letsencrypt path and stack")).toBe("The certificate could not be issued. Check the DNS records and try again.");
  });
});

describe("custom-domain helper — reconcile", () => {
  it("issues a certificate, writes the config, tests and reloads Nginx, then reports live", async () => {
    const w = world({ desired: { enabled: true, domains: [{ hostname: "shop.example.com", action: "issue" }] } });
    const out = await reconcile(w.deps);
    expect(out.changed).toBe(true);
    expect(w.commands.map((c) => [c.bin, c.args[0]])).toEqual([
      [BIN.certbot, "certonly"],
      [BIN.nginx, "-t"],
      [BIN.systemctl, "reload"],
    ]);
    expect(w.commands.every((c) => commandAllowed(c.bin, c.args))).toBe(true);
    expect(w.files[CONF]).toContain("server_name shop.example.com;");
    expect(w.reports).toEqual([[{ hostname: "shop.example.com", outcome: "live", certExpiresAt: new Date(NOW.getTime() + 90 * DAY).toISOString() }]]);
  });

  it("nothing changes when the config is already right (no reload); valid certs are not re-issued", async () => {
    const certs = { "shop.example.com": new Date(NOW.getTime() + 80 * DAY) };
    const conf = renderNginxConfig(["shop.example.com"]);
    const w = world({ desired: { enabled: true, domains: [{ hostname: "shop.example.com", action: "serve" }] }, certs, conf });
    expect((await reconcile(w.deps)).changed).toBe(false);
    expect(w.commands).toEqual([]);
  });

  it("a failed issuance is reported as failed and the domain is not routed", async () => {
    const w = world({
      desired: { enabled: true, domains: [{ hostname: "bad.example.com", action: "issue" }, { hostname: "good.example.com", action: "issue" }] },
      failIssue: ["bad.example.com"],
    });
    await reconcile(w.deps);
    expect(w.files[CONF]).not.toContain("bad.example.com");
    expect(w.files[CONF]).toContain("good.example.com");
    expect(w.reports[0]).toContainEqual({ hostname: "bad.example.com", outcome: "failed", error: "The domain's DNS records were not found. Check the A/CNAME record and try again." });
  });

  it("nginx -t failure restores the previous file and never reloads", async () => {
    const before = renderNginxConfig(["old.example.com"]);
    const w = world({
      desired: { enabled: true, domains: [{ hostname: "old.example.com", action: "serve" }, { hostname: "new.example.com", action: "issue" }] },
      certs: { "old.example.com": new Date(NOW.getTime() + 60 * DAY) },
      conf: before,
      nginxTestFails: true,
    });
    await expect(reconcile(w.deps)).rejects.toThrow(/nginx -t failed/);
    expect(w.files[CONF]).toBe(before);
    expect(w.commands.some((c) => c.bin === BIN.systemctl)).toBe(false);
    expect(w.reports.flat()).toContainEqual(expect.objectContaining({ hostname: "new.example.com", outcome: "failed" }));
  });

  it("removes routing and only its own certificates for domains that no longer exist", async () => {
    const w = world({
      desired: { enabled: true, domains: [{ hostname: "keep.example.com", action: "serve" }, { hostname: "held.example.com", action: "hold" }] },
      certs: { "keep.example.com": new Date(NOW.getTime() + 60 * DAY), "held.example.com": new Date(NOW.getTime() + 60 * DAY) },
      conf: renderNginxConfig(["keep.example.com", "gone.example.com"]),
      certDirs: ["cx-keep.example.com", "cx-gone.example.com", "cx-held.example.com", "wildcard.confirmx.ai", "api.confirmx.ai", "README", "cx-../../etc"],
    });
    await reconcile(w.deps);
    expect(w.files[CONF]).not.toContain("gone.example.com");
    expect(w.files[CONF]).not.toContain("held.example.com"); // held: not served, cert kept
    const deletes = w.commands.filter((c) => c.args[0] === "delete");
    expect(deletes.map((c) => c.args[2])).toEqual(["cx-gone.example.com"]);
  });

  it("does nothing when custom domains are disabled or the API gives no data", async () => {
    for (const desired of [null, { enabled: false, domains: [] }]) {
      const w = world({ desired, conf: renderNginxConfig(["shop.example.com"]), certDirs: ["cx-shop.example.com"] });
      expect((await reconcile(w.deps)).changed).toBe(false);
      expect(w.commands).toEqual([]);
      expect(w.files[CONF]).toContain("shop.example.com");
    }
  });

  it("refuses to drop most served domains at once unless explicitly allowed", async () => {
    const served = ["a.example.com", "b.example.com", "c.example.com", "d.example.com", "e.example.com"];
    const certs = Object.fromEntries(served.map((h) => [h, new Date(NOW.getTime() + 60 * DAY)]));
    const w = world({ desired: { enabled: true, domains: [] }, conf: renderNginxConfig(served), certs });
    await expect(reconcile(w.deps)).rejects.toThrow(/refusing to remove most/);
    expect(w.commands).toEqual([]);
    const ok = world({ desired: { enabled: true, domains: [] }, conf: renderNginxConfig(served), certs, allowMassRemoval: true });
    await reconcile(ok.deps);
    expect(ok.files[CONF]).not.toContain("server {");
  });

  it("skips invalid entries from the API and limits issuance per run", async () => {
    const many = Array.from({ length: MAX_ISSUES_PER_RUN + 3 }, (_, i) => ({ hostname: `s${i}.example.com`, action: "issue" }));
    const w = world({ desired: { enabled: true, domains: [...many, { hostname: "evil.example.com;rm", action: "issue" }, { hostname: "x.example.com", action: "exec" }] } });
    await reconcile(w.deps);
    expect(w.commands.filter((c) => c.args[0] === "certonly")).toHaveLength(MAX_ISSUES_PER_RUN);
    expect(w.commands.every((c) => commandAllowed(c.bin, c.args))).toBe(true);
    expect(w.files[CONF]).not.toContain("evil");
  });
});

describe("custom-domain helper — retry backoff", () => {
  it("does not call certbot while the API says the domain is in backoff; keeps serving an existing cert; reports nothing", async () => {
    const expired = new Date(NOW.getTime() - DAY);
    const w = world({
      desired: {
        enabled: true,
        domains: [
          { hostname: "expired.example.com", action: "serve", issueAllowed: false, retryAfter: "2026-09-29T10:15:00Z" },
          { hostname: "pending.example.com", action: "issue", issueAllowed: false },
        ],
      },
      certs: { "expired.example.com": expired },
      conf: renderNginxConfig(["expired.example.com"]),
    });
    await reconcile(w.deps);
    expect(w.commands.filter((c) => c.bin === BIN.certbot)).toEqual([]);
    expect(w.files[CONF]).toContain("server_name expired.example.com;"); // still routed
    expect(w.files[CONF]).not.toContain("pending.example.com");
    expect(w.reports.flat()).toEqual([]); // no false "live", no new failure
  });

  it("once allowed again, it issues exactly once and reports the outcome", async () => {
    const w = world({ desired: { enabled: true, domains: [{ hostname: "expired.example.com", action: "serve", issueAllowed: true }] }, certs: { "expired.example.com": new Date(NOW.getTime() - DAY) } });
    await reconcile(w.deps);
    expect(w.commands.filter((c) => c.args[0] === "certonly")).toHaveLength(1);
    expect(w.reports.flat()).toEqual([expect.objectContaining({ hostname: "expired.example.com", outcome: "live" })]);
  });
});

describe("custom-domain helper — trusted install (H1)", () => {
  const root = (path: string, mode = 0o40755) => ({ path, uid: 0, mode });
  const good = [
    root(`${INSTALL_DIR}/confirmx-domains-helper.mjs`, 0o100644),
    root(`${INSTALL_DIR}/helper-lib.mjs`, 0o100644),
    root(INSTALL_DIR),
    root("/usr/local/lib/confirmx"),
    root("/usr/local/lib"),
    root("/usr/local"),
    root("/usr"),
    root("/"),
  ];

  it("accepts a root-owned, non-writable install under /usr/local/lib/confirmx", () => {
    expect(trustedInstallProblems(good)).toEqual([]);
  });

  it("refuses the app release tree, non-root owners and group/other-writable files or parents", () => {
    const inRelease = [{ path: "/opt/confirmx/app/deploy/vps/custom-domains/helper-lib.mjs", uid: 0, mode: 0o100644 }];
    expect(trustedInstallProblems(inRelease)).toEqual([expect.stringMatching(/app-writable tree/)]);
    expect(trustedInstallProblems([{ ...good[0]!, uid: 999 }])).toEqual([expect.stringMatching(/not owned by root/)]);
    expect(trustedInstallProblems([{ ...good[1]!, mode: 0o100664 }])).toEqual([expect.stringMatching(/writable by group\/other/)]);
    // e.g. a setgid "staff"-writable /usr/local/lib/confirmx
    expect(trustedInstallProblems([{ ...good[3]!, mode: 0o42775 }])).toEqual([expect.stringMatching(/writable by group\/other/)]);
    expect(trustedInstallProblems([{ path: "/tmp/helper-lib.mjs", uid: 0, mode: 0o100644 }])).not.toEqual([]);
  });
});

describe("custom-domain helper — systemd unit (static)", () => {
  const unit = readFileSync(new URL("../../../deploy/vps/custom-domains/confirmx-domains-helper.service", import.meta.url), "utf8");
  const directives = unit
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("["));
  const get = (k: string) => directives.filter((l) => l.startsWith(`${k}=`)).map((l) => l.slice(k.length + 1));

  it("is structurally valid: sections and Key=Value lines only", () => {
    expect(unit).toMatch(/^\[Unit\]$/m);
    expect(unit).toMatch(/^\[Service\]$/m);
    for (const l of directives) expect(l, l).toMatch(/^[A-Za-z]+=\S/);
  });

  it("executes only the root-owned install, never the app release tree", () => {
    expect(get("ExecStart")).toEqual([`/usr/bin/node ${INSTALL_DIR}/confirmx-domains-helper.mjs`]);
    expect(unit).not.toMatch(/ExecStart=.*\/opt\/confirmx/);
    expect(get("User")).toEqual(["root"]);
    expect(get("UnsetEnvironment")[0]).toContain("NODE_OPTIONS");
  });

  it("keeps the sandbox: strict read-only system, minimal writable paths (no /run, no app tree), bounded capabilities", () => {
    const expected: Array<[string, string]> = [
      ["NoNewPrivileges", "true"],
      ["ProtectSystem", "strict"],
      ["ProtectHome", "true"],
      ["PrivateTmp", "true"],
      ["PrivateDevices", "true"],
      ["RestrictSUIDSGID", "true"],
      ["ProtectKernelModules", "true"],
      ["SystemCallArchitectures", "native"],
    ];
    for (const [k, v] of expected) expect(get(k), k).toEqual([v]);
    const rw = get("ReadWritePaths")
      .join(" ")
      .split(/\s+/)
      .map((p) => p.replace(/^-/, ""));
    expect(new Set(rw)).toEqual(
      new Set(["/etc/nginx/confirmx-custom-domains", "/etc/letsencrypt", "/var/lib/letsencrypt", "/var/log/letsencrypt", "/var/www/certbot", "/var/log/nginx", "/var/lib/nginx"]),
    );
    const caps = get("CapabilityBoundingSet").join(" ").split(/\s+/);
    expect(caps.every((c) => ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_DAC_READ_SEARCH", "CAP_FOWNER"].includes(c))).toBe(true);
    expect(get("RestrictAddressFamilies")).toEqual(["AF_UNIX AF_INET AF_INET6"]);
    // Node's JIT needs W+X memory: MemoryDenyWriteExecute must stay off or the helper cannot start.
    expect(get("MemoryDenyWriteExecute")).toEqual([]);
  });
});

describe("custom-domain helper — generated Nginx config (structural)", () => {
  const ALLOWED = new Set([
    "listen", "server_name", "location", "root", "return", "ssl_certificate", "ssl_certificate_key", "ssl_protocols",
    "ssl_prefer_server_ciphers", "ssl_session_cache", "ssl_session_timeout", "ssl_session_tickets", "client_max_body_size",
    "proxy_pass", "include",
  ]);

  it("balanced blocks, only known directives, every statement terminated, includes and paths fixed", () => {
    const conf = renderNginxConfig(["shop.example.com", "example.org"]);
    let depth = 0;
    for (const raw of conf.split("\n")) {
      const line = raw.replace(/#.*$/, "").trim();
      if (!line) continue;
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      expect(depth, line).toBeGreaterThanOrEqual(0);
      expect(depth, line).toBeLessThanOrEqual(2);
      if (line === "}") continue;
      const directive = line.split(/\s+/)[0]!;
      if (directive === "server") continue;
      expect(ALLOWED.has(directive), line).toBe(true);
      expect(line, line).toMatch(/(;|\{|\})$/);
    }
    expect(depth).toBe(0);
    expect([...conf.matchAll(/include (\S+);/g)].map((m) => m[1])).toEqual([
      "/etc/nginx/snippets/confirmx-proxy-sites.conf",
      "/etc/nginx/snippets/confirmx-proxy-sites.conf",
    ]);
    for (const m of conf.matchAll(/ssl_certificate(?:_key)? +(\S+);/g)) {
      expect(m[1]).toMatch(/^\/etc\/letsencrypt\/live\/cx-(shop\.example\.com|example\.org)\/(fullchain|privkey)\.pem$/);
    }
    expect([...conf.matchAll(/proxy_pass (\S+);/g)].map((m) => m[1])).toEqual(["http://confirmx_sites", "http://confirmx_sites"]);
    expect(conf).not.toMatch(/default_server|\*\.confirmx\.ai|confirmx\.ai;/);
  });

  it("the repo Nginx template includes the helper file and hides /internal/ on the API host", () => {
    const tpl = readFileSync(new URL("../../../deploy/vps/nginx/confirmx.conf", import.meta.url), "utf8");
    expect(tpl).toContain("include /etc/nginx/confirmx-custom-domains/*.conf;");
    expect(tpl).toMatch(/server_name api\.confirmx\.ai;[\s\S]*?location \^~ \/internal\/ \{ return 404; \}/);
    // The snippet the generated blocks include exists in the repo.
    const snippet = readFileSync(new URL("../../../deploy/vps/nginx/snippets/confirmx-proxy-sites.conf", import.meta.url), "utf8");
    expect(snippet).toContain("proxy_set_header Host");
  });
});
