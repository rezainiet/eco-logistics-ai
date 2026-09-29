#!/usr/bin/env node
// ConfirmX custom-domain helper — entry point (runs as root via systemd).
// All logic and every safety rule live in helper-lib.mjs; this file only
// wires real side effects: HTTP to the local API, fixed files, execFile.
//
//   Environment (from /etc/confirmx/domains-helper.env, mode 0600):
//     CONFIRMX_API_URL            default http://127.0.0.1:4000 (must be loopback)
//     CUSTOM_DOMAIN_HELPER_TOKEN  same value as the API's env
//
//   Installed ROOT-OWNED at /usr/local/lib/confirmx/domains-helper/ (see
//   README.md) — never run from the app release tree: at start it refuses to
//   run if its own files or any parent directory are not root-owned or are
//   group/other-writable.
//
//   Flags: --dry-run  (fetch + plan + print, change nothing)
//          --allow-mass-removal  (operator override of the safety valve)

import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BIN, DEFAULT_PATHS, certName, reconcile, trustedInstallProblems } from "./helper-lib.mjs";

const argv = new Set(process.argv.slice(2));
const DRY = argv.has("--dry-run");
const api = (process.env.CONFIRMX_API_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");
const token = process.env.CUSTOM_DOMAIN_HELPER_TOKEN || "";

if (!/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/.test(api)) {
  console.error(JSON.stringify({ evt: "config_error", error: "CONFIRMX_API_URL must be a loopback http URL" }));
  process.exit(2);
}
if (token.length < 32) {
  console.error(JSON.stringify({ evt: "config_error", error: "CUSTOM_DOMAIN_HELPER_TOKEN missing" }));
  process.exit(2);
}

const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

/** Every path from this helper's files up to "/" must be root-owned and not group/other-writable. */
async function assertTrustedInstall() {
  const here = dirname(fileURLToPath(import.meta.url));
  const paths = [`${here}/confirmx-domains-helper.mjs`, `${here}/helper-lib.mjs`];
  for (let d = here; ; d = dirname(d)) {
    paths.push(d);
    if (dirname(d) === d) break;
  }
  const chain = [];
  for (const p of paths) {
    const st = await fs.stat(p);
    chain.push({ path: p, uid: st.uid, mode: st.mode, isDir: st.isDirectory() });
  }
  return trustedInstallProblems(chain);
}

async function call(path, init = {}) {
  const res = await fetch(`${api}/internal/custom-domains${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`api ${path} -> ${res.status}`);
  return res.json();
}

const run = (bin, args) =>
  new Promise((resolve) => {
    if (DRY) {
      log({ evt: "dry_run_command", bin, args });
      return resolve({ code: 0, output: "" });
    }
    execFile(bin, args, { timeout: 180_000, maxBuffer: 1 << 20, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, output: `${stdout}\n${stderr}` });
    });
  });

async function certExpiry(host) {
  try {
    const pem = await fs.readFile(`${DEFAULT_PATHS.letsencryptLive}/${certName(host)}/fullchain.pem`, "utf8");
    const cert = new X509Certificate(pem);
    const d = new Date(cert.validTo);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

const deps = {
  fetchDesired: () => call("/desired"),
  report: async (results) => {
    if (DRY) return log({ evt: "dry_run_report", results });
    await call("/report", { method: "POST", body: JSON.stringify({ results }) });
  },
  run,
  readFile: async (p) => fs.readFile(p, "utf8").catch(() => null),
  writeFile: async (p, text) => (DRY ? log({ evt: "dry_run_write", path: p, bytes: text.length }) : fs.writeFile(p, text, { mode: 0o644 })),
  rename: async (a, b) => (DRY ? undefined : fs.rename(a, b)),
  listDir: (p) => fs.readdir(p),
  certExpiry,
  log,
  now: () => new Date(),
  allowMassRemoval: argv.has("--allow-mass-removal"),
};

const problems = await assertTrustedInstall().catch((e) => [`cannot stat install: ${e?.message ?? e}`]);
if (problems.length) {
  if (!DRY) {
    console.error(JSON.stringify({ evt: "untrusted_install", problems: problems.slice(0, 10) }));
    process.exit(3);
  }
  log({ evt: "untrusted_install_ignored_for_dry_run", problems: problems.slice(0, 10) });
}

try {
  if (!DRY) await fs.mkdir(DEFAULT_PATHS.nginxDir, { recursive: true, mode: 0o755 });
  const out = await reconcile(deps);
  log({ evt: "run_complete", changed: out.changed, results: out.results.length, dryRun: DRY });
} catch (err) {
  log({ evt: "run_failed", error: String(err?.message ?? err).slice(0, 300) });
  process.exit(1);
}
