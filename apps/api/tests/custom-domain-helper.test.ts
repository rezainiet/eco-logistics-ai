import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BIN,
  DEFAULT_PATHS,
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
// The bootstrap entry: importing it never runs main() (see isEntrypoint — argv[1] is not this file).
import { INSTALL_DIR, isEntrypoint, trustProblems, type TrustFs } from "../../../deploy/vps/custom-domains/confirmx-domains-helper.mjs";

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

  it("active backoff wins over a still-valid certificate: no certbot, no report (the API keeps its failure state), still served", async () => {
    for (const validFor of [80 * DAY, 10 * DAY]) {
      const w = world({
        desired: { enabled: true, domains: [{ hostname: "valid.example.com", action: "serve", issueAllowed: false, retryAfter: "2026-09-29T10:15:00Z" }] },
        certs: { "valid.example.com": new Date(NOW.getTime() + validFor) },
        conf: renderNginxConfig(["valid.example.com"]),
      });
      for (let tick = 0; tick < 3; tick++) await reconcile(w.deps);
      expect(w.commands.filter((c) => c.bin === BIN.certbot)).toEqual([]);
      expect(w.reports.flat()).toEqual([]); // no "live" that would reset sslFailures / retryAfter
      expect(w.files[CONF]).toContain("server_name valid.example.com;");
    }
  });

  it("after the backoff, normal evaluation resumes (valid cert → live report, no certbot)", async () => {
    const w = world({
      desired: { enabled: true, domains: [{ hostname: "valid.example.com", action: "serve", issueAllowed: true }] },
      certs: { "valid.example.com": new Date(NOW.getTime() + 10 * DAY) },
      conf: renderNginxConfig(["valid.example.com"]),
    });
    await reconcile(w.deps);
    expect(w.commands.filter((c) => c.bin === BIN.certbot)).toEqual([]);
    expect(w.reports.flat()).toEqual([expect.objectContaining({ hostname: "valid.example.com", outcome: "live" })]);
  });
});

describe("custom-domain helper — trusted install (bootstrap, lstat, no symlinks)", () => {
  type Node = { type: "dir" | "file" | "link"; uid?: number; mode?: number; target?: string };
  /** A tiny fake filesystem: lstat never follows links; realpath resolves them component by component. */
  function fakeFs(nodes: Record<string, Node>): TrustFs {
    const get = (p: string) => {
      const n = nodes[p];
      if (!n) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      return n;
    };
    const realpath = (p: string, depth = 0): string => {
      if (depth > 20) throw new Error("ELOOP");
      const parts = p.split("/").filter(Boolean);
      let cur = "/";
      for (let i = 0; i < parts.length; i++) {
        const next = cur === "/" ? `/${parts[i]}` : `${cur}/${parts[i]}`;
        const n = get(next);
        if (n.type === "link") return realpath([n.target!, ...parts.slice(i + 1)].join("/").replace(/\/+/g, "/"), depth + 1);
        cur = next;
      }
      return cur;
    };
    return {
      lstat: (p) => {
        const n = get(p);
        const typeBits = n.type === "dir" ? 0o040000 : n.type === "file" ? 0o100000 : 0o120000;
        return {
          uid: n.uid ?? 0,
          mode: typeBits | (n.mode ?? (n.type === "dir" ? 0o755 : n.type === "file" ? 0o644 : 0o777)),
          isSymbolicLink: () => n.type === "link",
          isFile: () => n.type === "file",
          isDirectory: () => n.type === "dir",
        };
      },
      realpath: (p) => realpath(p),
    };
  }
  const ENTRY = `${INSTALL_DIR}/confirmx-domains-helper.mjs`;
  const LIB = `${INSTALL_DIR}/helper-lib.mjs`;
  const base = (): Record<string, Node> => ({
    "/": { type: "dir" },
    "/usr": { type: "dir" },
    "/usr/local": { type: "dir" },
    "/usr/local/lib": { type: "dir" },
    "/usr/local/lib/confirmx": { type: "dir" },
    [INSTALL_DIR]: { type: "dir" },
    [ENTRY]: { type: "file" },
    [LIB]: { type: "file" },
  });
  const problems = (nodes: Record<string, Node>, invokedAs = ENTRY) => trustProblems(fakeFs(nodes), { invokedAs });

  it("accepts the normal installation (root-owned, 0755 dirs / 0644 files, no links)", () => {
    expect(problems(base())).toEqual([]);
  });

  it("refuses a symlinked helper-lib.mjs — even to a root-owned file", () => {
    const n = base();
    n[LIB] = { type: "link", target: "/usr/local/lib/confirmx/other/helper-lib.mjs" };
    n["/usr/local/lib/confirmx/other"] = { type: "dir" };
    n["/usr/local/lib/confirmx/other/helper-lib.mjs"] = { type: "file" };
    expect(problems(n)).toEqual(expect.arrayContaining([`${LIB}: is a symlink`, `${LIB}: resolves to /usr/local/lib/confirmx/other/helper-lib.mjs`]));
  });

  it("refuses a symlinked main helper (entry file)", () => {
    const n = base();
    n[ENTRY] = { type: "link", target: "/usr/local/lib/confirmx/other/confirmx-domains-helper.mjs" };
    n["/usr/local/lib/confirmx/other"] = { type: "dir" };
    n["/usr/local/lib/confirmx/other/confirmx-domains-helper.mjs"] = { type: "file" };
    expect(problems(n)).toEqual(expect.arrayContaining([`${ENTRY}: is a symlink`]));
  });

  it("refuses a symlinked parent directory (install tree redirected into /opt/confirmx)", () => {
    const n = base();
    n["/usr/local/lib/confirmx"] = { type: "link", target: "/opt/confirmx/app/deploy" };
    delete n[INSTALL_DIR];
    delete n[ENTRY];
    delete n[LIB];
    Object.assign(n, {
      "/opt": { type: "dir" },
      "/opt/confirmx": { type: "dir", uid: 999 },
      "/opt/confirmx/app": { type: "dir", uid: 999 },
      "/opt/confirmx/app/deploy": { type: "dir", uid: 999 },
      "/opt/confirmx/app/deploy/domains-helper": { type: "dir", uid: 999 },
      "/opt/confirmx/app/deploy/domains-helper/confirmx-domains-helper.mjs": { type: "file", uid: 999 },
      "/opt/confirmx/app/deploy/domains-helper/helper-lib.mjs": { type: "file", uid: 999 },
    });
    // lstat of INSTALL_DIR itself goes through the linked parent: model it as the link's view.
    n[INSTALL_DIR] = { type: "dir", uid: 999 };
    n[ENTRY] = { type: "file", uid: 999 };
    n[LIB] = { type: "file", uid: 999 };
    const p = problems(n);
    expect(p).toEqual(expect.arrayContaining(["/usr/local/lib/confirmx: is a symlink", expect.stringMatching(/resolves to \/opt\/confirmx/)]));
  });

  it("refuses a symlink whose target is outside the install tree (/tmp)", () => {
    const n = base();
    n[LIB] = { type: "link", target: "/tmp/evil/helper-lib.mjs" };
    n["/tmp"] = { type: "dir", mode: 0o1777 };
    n["/tmp/evil"] = { type: "dir" };
    n["/tmp/evil/helper-lib.mjs"] = { type: "file" };
    expect(problems(n)).toEqual(expect.arrayContaining([`${LIB}: is a symlink`, `${LIB}: resolves to /tmp/evil/helper-lib.mjs`]));
  });

  it("refuses the Phase 3 exploit: link to a ROOT-owned file inside a CONFIRMX-owned directory", () => {
    const n = base();
    n[LIB] = { type: "link", target: "/var/lib/cx-attacker/helper-lib.mjs" };
    n["/var"] = { type: "dir" };
    n["/var/lib"] = { type: "dir" };
    n["/var/lib/cx-attacker"] = { type: "dir", uid: 999 };
    n["/var/lib/cx-attacker/helper-lib.mjs"] = { type: "file", uid: 0 };
    expect(problems(n)).toEqual(expect.arrayContaining([`${LIB}: is a symlink`, `${LIB}: resolves to /var/lib/cx-attacker/helper-lib.mjs`]));
  });

  it("refuses wrong ownership, unsafe parents, writable files and missing files", () => {
    let n = base();
    n[LIB] = { type: "file", uid: 999 };
    expect(problems(n)).toEqual([`${LIB}: not owned by root`]);
    n = base();
    n["/usr/local/lib/confirmx"] = { type: "dir", mode: 0o2775 };
    expect(problems(n)).toEqual(["/usr/local/lib/confirmx: writable by group/other"]);
    n = base();
    n[ENTRY] = { type: "file", mode: 0o666 };
    expect(problems(n)).toEqual([`${ENTRY}: writable by group/other`]);
    n = base();
    delete n[LIB];
    expect(problems(n)).toEqual([`${LIB}: missing`]);
  });

  it("refuses any other install location: the release tree, /home, /tmp, /var/tmp, a checkout", () => {
    for (const dir of ["/opt/confirmx/app/deploy/vps/custom-domains", "/home/deploy/helper", "/tmp/helper", "/var/tmp/helper", "/srv/checkout/deploy/vps/custom-domains"]) {
      const p = problems(base(), `${dir}/confirmx-domains-helper.mjs`);
      expect(p, dir).toEqual(expect.arrayContaining([`${dir}: not the trusted install directory ${INSTALL_DIR}`]));
    }
    expect(problems(base(), `${INSTALL_DIR}/something-else.mjs`)).toEqual(expect.arrayContaining([expect.stringMatching(/not the helper entry file/)]));
  });

});

describe("custom-domain helper — bootstrap load order (static analysis)", () => {
  const BOOTSTRAP_SRC = readFileSync(new URL("../../../deploy/vps/custom-domains/confirmx-domains-helper.mjs", import.meta.url), "utf8");

  /** Source with comments blanked out (string / template contents kept), so comments can't hide or fake an import. */
  function stripComments(src: string): string {
    let out = "";
    let i = 0;
    while (i < src.length) {
      const c = src[i]!;
      const n = src[i + 1];
      if (c === "/" && n === "/") {
        while (i < src.length && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && n === "*") {
        i += 2;
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        const q = c;
        out += c;
        i++;
        while (i < src.length && src[i] !== q) {
          if (src[i] === "\\") {
            out += src[i]! + (src[i + 1] ?? "");
            i += 2;
            continue;
          }
          out += src[i]!;
          i++;
        }
        out += src[i] ?? "";
        i++;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  /** Every module specifier loaded statically: import … from, bare import, export … from (either quote style). */
  function staticSpecifiers(src: string): string[] {
    const code = stripComments(src);
    const specs: string[] = [];
    const forms = [
      /(?:^|[;\n}])\s*import\s*(?:[\w$]+\s*,?\s*)?(?:\*\s*as\s+[\w$]+|\{[^}]*\})?\s*from\s*(['"])([^'"\n]+)\1/g, // import x / {a} / * as n / x, {a} from '…'
      /(?:^|[;\n}])\s*import\s*(['"])([^'"\n]+)\1/g, // import '…'  (side effect)
      /(?:^|[;\n}])\s*export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\1/g, // export * / {a} from '…'
    ];
    for (const re of forms) for (const m of code.matchAll(re)) specs.push(m[2]!);
    return specs;
  }

  /** Every dynamic import( … ) expression in code (comments stripped). */
  function dynamicImports(src: string): Array<{ at: number; text: string }> {
    const code = stripComments(src);
    const out: Array<{ at: number; text: string }> = [];
    for (const m of code.matchAll(/\bimport\s*\(/g)) {
      // Take the whole argument, balancing nested parentheses.
      let depth = 0;
      let end = code.length;
      for (let i = m.index! + m[0].length - 1; i < code.length; i++) {
        if (code[i] === "(") depth++;
        else if (code[i] === ")" && --depth === 0) {
          end = i + 1;
          break;
        }
      }
      out.push({ at: m.index!, text: code.slice(m.index!, end) });
    }
    return out;
  }

  it("the detector itself catches every static form that would load helper-lib.mjs early", () => {
    const forbidden = [
      `import x from "./helper-lib.mjs";`,
      `import "./helper-lib.mjs";`,
      `import x from './helper-lib.mjs';`,
      `import './helper-lib.mjs';`,
      `export { reconcile } from "./helper-lib.mjs";`,
      `export { reconcile } from './helper-lib.mjs';`,
      `export * from "./helper-lib.mjs";`,
      `export * as lib from './helper-lib.mjs';`,
      `import * as lib from "./helper-lib.mjs";`,
      `import { reconcile, BIN } from './helper-lib.mjs';`,
      `import def, { a } from "./helper-lib.mjs";`,
      `import{reconcile}from"./helper-lib.mjs"`,
    ];
    for (const line of forbidden) {
      const src = `import { lstatSync } from "node:fs";\n${line}\nconst a = 1;\n`;
      expect(staticSpecifiers(src), line).toContain("./helper-lib.mjs");
    }
    // …and does not flag comments or strings that merely mention it.
    const benign = `import { lstatSync } from "node:fs";\n// import "./helper-lib.mjs";\n/* export * from './helper-lib.mjs' */\nconst s = "import './helper-lib.mjs'";\n`;
    expect(staticSpecifiers(benign)).toEqual(["node:fs"]);
  });

  it("the bootstrap statically loads ONLY node: built-ins (and all of them are found)", () => {
    const specs = staticSpecifiers(BOOTSTRAP_SRC);
    expect(specs.sort()).toEqual(["node:child_process", "node:crypto", "node:fs", "node:fs/promises", "node:path", "node:url"]);
    expect(specs.every((s) => s.startsWith("node:"))).toBe(true);
  });

  it("helper-lib.mjs is loaded exactly once: one dynamic import from the verified directory, after the trust check and exit 3", () => {
    const code = stripComments(BOOTSTRAP_SRC);
    const dyn = dynamicImports(BOOTSTRAP_SRC);
    expect(dyn).toHaveLength(1);
    expect(dyn[0]!.text).toContain('P.join(P.dirname(P.resolve(invokedAs)), "helper-lib.mjs")');
    // helper-lib.mjs appears in code exactly twice: as a name in the TRUSTED_FILES list (a string the
    // trust check lstat()s — not a load) and inside that single dynamic import. Nothing else.
    const trustedListAt = code.indexOf('export const TRUSTED_FILES = ["confirmx-domains-helper.mjs", "helper-lib.mjs"];');
    expect(trustedListAt).toBeGreaterThan(0);
    const mentions = [...code.matchAll(/helper-lib\.mjs/g)].map((m) => m.index!);
    expect(mentions).toHaveLength(2);
    expect(mentions[0]!).toBeGreaterThan(trustedListAt);
    expect(mentions[0]!).toBeLessThan(trustedListAt + 90);
    expect(mentions[1]!).toBeGreaterThan(dyn[0]!.at);
    expect(mentions[1]!).toBeLessThan(dyn[0]!.at + dyn[0]!.text.length);
    // Order inside main(): trust check → exit 3 → dynamic import.
    const mainAt = code.indexOf("export async function main(");
    const checkAt = code.indexOf("trustProblems(realFs", mainAt);
    const exit3At = code.indexOf("process.exit(3)", mainAt);
    expect(mainAt).toBeGreaterThan(0);
    expect(checkAt).toBeGreaterThan(mainAt);
    expect(exit3At).toBeGreaterThan(checkAt);
    expect(dyn[0]!.at).toBeGreaterThan(exit3At);
    // main() runs only through the entrypoint check — no environment variable decides it.
    expect(code).toMatch(/if \(isEntrypoint\(process\.argv\[1\], fileURLToPath\(import\.meta\.url\)\)\) await main\(\);/);
    expect(code).not.toMatch(/process\.env\.VITEST/);
    expect([...code.matchAll(/await main\(/g)]).toHaveLength(1);
  });
});

describe("custom-domain helper — bootstrap entrypoint (real node child processes)", () => {
  const BOOTSTRAP = fileURLToPath(new URL("../../../deploy/vps/custom-domains/confirmx-domains-helper.mjs", import.meta.url));
  const cleanEnv = (extra: Record<string, string> = {}) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "VITEST" && !k.startsWith("VITEST_")) env[k] = v;
    return { ...env, ...extra };
  };
  const node = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 20_000 });

  it("isEntrypoint: true only when argv[1] resolves to the module itself (symlink too); false for imports / odd argv", () => {
    // isEntrypoint resolves argv[1] with the platform path module, so the fake is keyed by resolve().
    const real = (m: Record<string, string>) => {
      const byResolved = new Map(Object.entries(m).map(([k, v]) => [resolve(k), v]));
      return (p: string) => {
        const v = byResolved.get(resolve(p));
        if (v === undefined) throw new Error("ENOENT");
        return v;
      };
    };
    const mod = "/usr/local/lib/confirmx/domains-helper/confirmx-domains-helper.mjs";
    const fs = real({ [mod]: mod, "/usr/local/bin/cx": mod, "/x/vitest.mjs": "/x/vitest.mjs" });
    expect(isEntrypoint(mod, mod, fs)).toBe(true);
    expect(isEntrypoint("/usr/local/bin/cx", mod, fs)).toBe(true); // symlinked start → main runs → trust check exits 3
    expect(isEntrypoint("/x/vitest.mjs", mod, fs)).toBe(false); // imported by a test runner
    expect(isEntrypoint("/does/not/exist.mjs", mod, fs)).toBe(false);
    expect(isEntrypoint(undefined, mod, fs)).toBe(false);
    expect(isEntrypoint("", mod, fs)).toBe(false);
    // In this very test process the bootstrap was imported (top of file) and main() did not run.
    expect(isEntrypoint(process.argv[1], BOOTSTRAP)).toBe(false);
  });

  it("A: importing the bootstrap in a real node process does NOT run main()", () => {
    const r = node(["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(BOOTSTRAP).href)}); console.log("IMPORTED_OK");`], cleanEnv());
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("IMPORTED_OK");
    expect(r.stderr).not.toContain("untrusted_install");
  });

  it("B: executing the helper as the entrypoint DOES run main() (here: refused by the trust check, exit 3)", () => {
    const r = node([BOOTSTRAP], cleanEnv());
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('"evt":"untrusted_install"');
  });

  it("C: VITEST (or any env var) does not turn the entrypoint into a no-op", () => {
    const variants: Array<Record<string, string>> = [{ VITEST: "true" }, { VITEST: "1", VITEST_WORKER_ID: "1", NODE_ENV: "test" }];
    for (const extra of variants) {
      const r = node([BOOTSTRAP], cleanEnv(extra));
      expect(r.status, JSON.stringify(extra)).toBe(3);
      expect(r.stderr).toContain('"evt":"untrusted_install"');
    }
  });

  it("D: trust validation runs before helper-lib.mjs is evaluated (a planted helper-lib.mjs never runs when trust fails)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-bootstrap-"));
    try {
      copyFileSync(BOOTSTRAP, join(dir, "confirmx-domains-helper.mjs"));
      writeFileSync(join(dir, "helper-lib.mjs"), `process.stdout.write("HELPER_LIB_EVALUATED\\n");\nexport const DEFAULT_PATHS = {};\n`);
      const token = "t".repeat(48);
      // Untrusted location, normal run → exit 3, planted module never evaluated.
      const r = node([join(dir, "confirmx-domains-helper.mjs")], cleanEnv({ CUSTOM_DOMAIN_HELPER_TOKEN: token, CONFIRMX_API_URL: "http://127.0.0.1:9" }));
      expect(r.status).toBe(3);
      expect(r.stdout).not.toContain("HELPER_LIB_EVALUATED");
      // Positive control (POSIX, non-root only — the bootstrap builds its import path with path.posix,
      // i.e. for Linux; a root --dry-run from here is refused too): the planted module IS evaluated once
      // the check is passed/tolerated, so its absence above is meaningful. Also run in the WSL validation.
      if (process.platform !== "win32" && !(typeof process.getuid === "function" && process.getuid() === 0)) {
        const c = node([join(dir, "confirmx-domains-helper.mjs"), "--dry-run"], cleanEnv({ CUSTOM_DOMAIN_HELPER_TOKEN: token, CONFIRMX_API_URL: "http://127.0.0.1:9" }));
        expect(c.stdout).toContain("untrusted_install_ignored_for_non_root_dry_run");
        expect(c.stdout).toContain("HELPER_LIB_EVALUATED");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      // @pkey: node's V8 calls pkey_alloc at start-up; without it seccomp kills node (SIGSYS) — Phase 3 finding B1.
      ["SystemCallFilter", "@system-service @pkey"],
      ["UMask", "0022"],
    ];
    for (const [k, v] of expected) expect(get(k), k).toEqual([v]);
    const rw = get("ReadWritePaths")
      .join(" ")
      .split(/\s+/)
      .map((p) => p.replace(/^-/, ""));
    expect(new Set(rw)).toEqual(
      new Set(["/etc/nginx/confirmx-custom-domains", "/etc/letsencrypt", "/var/lib/letsencrypt", "/var/log/letsencrypt", "/var/www/certbot", "/var/log/nginx", "/var/lib/nginx"]),
    );
    // Exactly these: file-permission capabilities for certbot / nginx -t, plus CAP_NET_BIND_SERVICE because
    // `nginx -t` binds the configured :80/:443 listeners (Phase 3 finding B2). Nothing else.
    const caps = get("CapabilityBoundingSet").join(" ").split(/\s+/).sort();
    expect(caps).toEqual(["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_DAC_READ_SEARCH", "CAP_FOWNER", "CAP_NET_BIND_SERVICE"]);
    expect(get("ReadWritePaths").join(" ")).not.toMatch(/(^|\s)-?\/run(\s|$)/);
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
    // Case-insensitive regex (Phase 3 finding M2): /INTERNAL/, /Internal/ … are blocked at Nginx too.
    expect(tpl).toMatch(/server_name api\.confirmx\.ai;[\s\S]*?location ~\* \^\/internal\(\?:\/\|\$\) \{ return 404; \}/);
    expect(tpl).not.toMatch(/location \^~ \/internal\//);
    const re = /^\/internal(?:\/|$)/i; // the same pattern Nginx applies (PCRE, ~* = case-insensitive)
    for (const u of ["/internal/", "/INTERNAL/custom-domains/desired", "/Internal/x", "/iNtErNaL/custom-domains/report", "/internal"]) expect(re.test(u), u).toBe(true);
    for (const u of ["/internals", "/api/internal/x", "/", "/trpc/internal"]) expect(re.test(u), u).toBe(false);
    // The snippet the generated blocks include exists in the repo.
    const snippet = readFileSync(new URL("../../../deploy/vps/nginx/snippets/confirmx-proxy-sites.conf", import.meta.url), "utf8");
    expect(snippet).toContain("proxy_set_header Host");
  });
});
