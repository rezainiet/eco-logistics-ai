#!/usr/bin/env node
// ConfirmX custom-domain helper — BOOTSTRAP entry point (runs as root via systemd).
//
// Trust boundary: this file statically imports ONLY node: built-ins. Before
// any other code is loaded it verifies the installation (see trustProblems):
// on any problem it exits 3 without contacting the API or running anything.
// Only then is helper-lib.mjs (all logic and every safety rule) imported,
// dynamically, from the verified directory.
//
//   Environment (from /etc/confirmx/domains-helper.env, mode 0600):
//     CONFIRMX_API_URL            default http://127.0.0.1:4000 (must be loopback)
//     CUSTOM_DOMAIN_HELPER_TOKEN  same value as the API's env
//
//   Installed ROOT-OWNED at /usr/local/lib/confirmx/domains-helper/ (README.md).
//
//   Flags: --dry-run  (fetch + plan + print, change nothing; still refused as
//                      root from an untrusted install)
//          --allow-mass-removal  (operator override of the safety valve)
//
//   Exit codes: 0 ok · 1 run failed · 2 configuration error · 3 untrusted install

import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const P = path.posix;

/** The only directory the helper runs from (root-owned, outside every app tree). */
export const INSTALL_DIR = "/usr/local/lib/confirmx/domains-helper";
/** The files that make up the helper; each must be a regular root-owned file in INSTALL_DIR. */
export const TRUSTED_FILES = ["confirmx-domains-helper.mjs", "helper-lib.mjs"];
/** Trees writable by the unprivileged app user: never trusted, whatever the modes say. */
export const UNTRUSTED_TREES = ["/opt/confirmx", "/home", "/tmp", "/var/tmp"];

/**
 * Every reason the installation must not be trusted (empty = trusted).
 * Uses lstat, never stat: a symlink anywhere — a helper file, the install
 * directory or any parent — is itself a problem, and every trusted path must
 * resolve (realpath) to exactly itself, so nothing can point outside the
 * install directory. Every file and every directory up to "/" must be
 * root-owned and not writable by group/other.
 *
 * @param fsi { lstat(p) → {uid, mode, isSymbolicLink(), isFile(), isDirectory()}, realpath(p) → string }
 * @param opts.invokedAs  the path the entry file was started as (process.argv[1])
 */
export function trustProblems(fsi, { invokedAs, installDir = INSTALL_DIR }) {
  const problems = [];
  const untrusted = (p) => UNTRUSTED_TREES.some((t) => p === t || p.startsWith(`${t}/`));
  const resolvesTo = (p) => {
    try {
      return fsi.realpath(p);
    } catch {
      return null;
    }
  };
  const check = (p, kind) => {
    let st;
    try {
      st = fsi.lstat(p);
    } catch {
      problems.push(`${p}: missing`);
      return;
    }
    if (st.isSymbolicLink()) problems.push(`${p}: is a symlink`);
    else if (kind === "dir" ? !st.isDirectory() : !st.isFile()) problems.push(`${p}: not a ${kind === "dir" ? "directory" : "regular file"}`);
    if (st.uid !== 0) problems.push(`${p}: not owned by root`);
    if ((st.mode & 0o022) !== 0) problems.push(`${p}: writable by group/other`);
    if (untrusted(p)) problems.push(`${p}: inside an app-writable tree`);
    const real = resolvesTo(p);
    if (real !== p) problems.push(`${p}: resolves to ${real ?? "nothing"}`);
  };

  const invoked = typeof invokedAs === "string" && invokedAs ? P.resolve(invokedAs) : "";
  const dir = invoked ? P.dirname(invoked) : "";
  if (!invoked || P.basename(invoked) !== TRUSTED_FILES[0]) problems.push(`${invoked || "(none)"}: not the helper entry file`);
  if (dir !== installDir) problems.push(`${dir || "(none)"}: not the trusted install directory ${installDir}`);
  if (!dir) return problems;

  for (let d = dir; ; d = P.dirname(d)) {
    check(d, "dir");
    if (P.dirname(d) === d) break;
  }
  for (const f of TRUSTED_FILES) check(P.join(dir, f), "file");
  return [...new Set(problems)];
}

const realFs = { lstat: (p) => lstatSync(p), realpath: (p) => realpathSync(p) };

/**
 * True only when this file is the script node was started with: argv[1]
 * resolves (realpath) to this very module. No environment variable is
 * involved. Started through a symlink → still true (the link resolves to this
 * file), and the trust check then refuses it with exit 3. Imported by anything
 * else (tests, another module) or argv[1] missing/unresolvable → false, so
 * main() does not run on import.
 */
export function isEntrypoint(argv1, modulePath, realpath = realpathSync) {
  if (typeof argv1 !== "string" || !argv1 || typeof modulePath !== "string" || !modulePath) return false;
  try {
    return realpath(path.resolve(argv1)) === realpath(modulePath);
  } catch {
    return false;
  }
}
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

export async function main(argvList = process.argv, env = process.env) {
  const flags = new Set(argvList.slice(2));
  const DRY = flags.has("--dry-run");
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  // 1. Trust — before ANY non-built-in code is loaded.
  const invokedAs = argvList[1] ?? "";
  let problems;
  try {
    problems = trustProblems(realFs, { invokedAs });
    // The module actually executing must be the file that was checked (no symlinked entry).
    if (fileURLToPath(import.meta.url) !== P.resolve(invokedAs)) problems.push(`${invokedAs}: running module is ${fileURLToPath(import.meta.url)}`);
  } catch (e) {
    problems = [`trust check failed: ${e?.message ?? e}`];
  }
  if (problems.length) {
    if (!DRY || isRoot) {
      console.error(JSON.stringify({ evt: "untrusted_install", problems: problems.slice(0, 10) }));
      process.exit(3);
    }
    log({ evt: "untrusted_install_ignored_for_non_root_dry_run", problems: problems.slice(0, 10) });
  }

  // 2. Configuration.
  const api = (env.CONFIRMX_API_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");
  const token = env.CUSTOM_DOMAIN_HELPER_TOKEN || "";
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/.test(api)) {
    console.error(JSON.stringify({ evt: "config_error", error: "CONFIRMX_API_URL must be a loopback http URL" }));
    process.exit(2);
  }
  if (token.length < 32) {
    console.error(JSON.stringify({ evt: "config_error", error: "CUSTOM_DOMAIN_HELPER_TOKEN missing" }));
    process.exit(2);
  }

  // 3. Only now load the logic, from the verified directory.
  const lib = await import(pathToFileURL(P.join(P.dirname(P.resolve(invokedAs)), "helper-lib.mjs")).href);
  const { DEFAULT_PATHS, certName, reconcile } = lib;

  async function call(p, init = {}) {
    const res = await fetch(`${api}/internal/custom-domains${p}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`api ${p} -> ${res.status}`);
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
      const pem = await readFile(`${DEFAULT_PATHS.letsencryptLive}/${certName(host)}/fullchain.pem`, "utf8");
      const d = new Date(new X509Certificate(pem).validTo);
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
    readFile: async (p) => readFile(p, "utf8").catch(() => null),
    writeFile: async (p, text) => (DRY ? log({ evt: "dry_run_write", path: p, bytes: text.length }) : writeFile(p, text, { mode: 0o644 })),
    rename: async (a, b) => (DRY ? undefined : rename(a, b)),
    listDir: (p) => readdir(p),
    certExpiry,
    log,
    now: () => new Date(),
    allowMassRemoval: flags.has("--allow-mass-removal"),
  };

  try {
    if (!DRY) await mkdir(DEFAULT_PATHS.nginxDir, { recursive: true, mode: 0o755 });
    const out = await reconcile(deps);
    log({ evt: "run_complete", changed: out.changed, results: out.results.length, dryRun: DRY });
  } catch (err) {
    log({ evt: "run_failed", error: String(err?.message ?? err).slice(0, 300) });
    process.exit(1);
  }
}

// Run only when started as this script (see isEntrypoint) — never on import.
if (isEntrypoint(process.argv[1], fileURLToPath(import.meta.url))) await main();
