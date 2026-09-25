#!/usr/bin/env node
/**
 * Local disaster-recovery backup (runs on an operator machine, e.g. Windows + Git Bash).
 *
 *   node ops/backup/local-backup.mjs [--dest E:/confirm-x/backups] [--mongo-archive <file>] [--pbx-archive <file>]...
 *
 * Writes, OUTSIDE the git repo:
 *   <dest>/confirmx/source/    git bundle (every branch, full history) + source tarball of HEAD
 *   <dest>/confirmx/config/    env TEMPLATE + deploy templates (no secret values)
 *   <dest>/confirmx/database/  MongoDB archive(s) passed with --mongo-archive (mongodump --archive --gzip)
 *   <dest>/confirmx/secrets/   README only — real env files are placed here by hand, encrypted
 *   <dest>/pbx/                PBX archives passed with --pbx-archive (from ops/backup/pbx-backup.sh) — SENSITIVE
 *   <dest>/recovery-docs/      CONFIRMX-RECOVERY.md, PBX-RECOVERY.md, MIGRATION-PLAN.md, ENVIRONMENT.md
 *   <dest>/manifests/backup-manifest-<stamp>.json (+ backup-manifest.json = latest)
 *
 * Every file gets a SHA-256 in the manifest. Nothing is uploaded anywhere.
 * Verify with: node ops/backup/verify-local-backup.mjs [--dest …]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const many = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : [])).filter(Boolean);

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const dest = path.resolve(opt("--dest", path.join(repo, "..", "backups")));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
const tryRun = (cmd, a, cwd) => {
  try {
    return execFileSync(cmd, a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });

const dirs = {
  source: path.join(dest, "confirmx", "source"),
  config: path.join(dest, "confirmx", "config"),
  database: path.join(dest, "confirmx", "database"),
  secrets: path.join(dest, "confirmx", "secrets"),
  pbx: path.join(dest, "pbx"),
  docs: path.join(dest, "recovery-docs"),
  manifests: path.join(dest, "manifests"),
};
Object.values(dirs).forEach(mkdir);

if (git("status", "--porcelain")) {
  console.warn("[backup] WARNING: working tree has uncommitted changes — the source archive is HEAD only.");
}
const commit = git("rev-parse", "HEAD");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const short = commit.slice(0, 7);

// 1. Source: full-history bundle + HEAD tarball.
const bundle = path.join(dirs.source, `confirmx-${stamp}-${short}.bundle`);
git("bundle", "create", bundle, "--all");
git("bundle", "verify", bundle);
const tarball = path.join(dirs.source, `confirmx-src-${stamp}-${short}.tar.gz`);
git("archive", "--format=tar.gz", `--prefix=confirmx-${short}/`, "-o", tarball, "HEAD");

// 2. Config templates (no values).
for (const rel of [".env.example", ".env.production.example", "deploy", "ops/backup"]) {
  const src = path.join(repo, rel);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(dirs.config, rel), { recursive: true });
}

// 3. Database archives supplied by the operator.
for (const file of many("--mongo-archive")) {
  fs.copyFileSync(file, path.join(dirs.database, path.basename(file)));
}

// 4. PBX archives supplied by the operator (+ their .sha256).
const pbxInfo = [];
for (const file of many("--pbx-archive")) {
  fs.copyFileSync(file, path.join(dirs.pbx, path.basename(file)));
  if (fs.existsSync(`${file}.sha256`)) fs.copyFileSync(`${file}.sha256`, path.join(dirs.pbx, `${path.basename(file)}.sha256`));
}
for (const f of fs.readdirSync(dirs.pbx).filter((f) => f.endsWith(".tar.gz"))) {
  const name = f.replace(/\.tar\.gz$/, "");
  // Relative name + cwd: GNU tar would read "E:/…" as a remote host:path.
  const info = tryRun("tar", ["-xzOf", f, `${name}/BACKUP-INFO.txt`], dirs.pbx);
  pbxInfo.push({ file: f, info: Object.fromEntries((info ?? "").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2))) });
}

// 5. Recovery docs.
for (const rel of ["docs/infra/CONFIRMX-RECOVERY.md", "docs/infra/PBX-RECOVERY.md", "docs/infra/MIGRATION-PLAN.md", "docs/infra/ENVIRONMENT.md", "docs/infra/INFRA-AUDIT.md"]) {
  const src = path.join(repo, rel);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dirs.docs, path.basename(rel)));
}

const secretsReadme = path.join(dirs.secrets, "README.txt");
if (!fs.existsSync(secretsReadme)) {
  fs.writeFileSync(
    secretsReadme,
    [
      "SENSITIVE — production secrets for ConfirmX (never commit, never upload unencrypted).",
      "",
      "Place here, ENCRYPTED (e.g. 7-Zip AES-256 or age):",
      "  api.env, web.env, sites.env   — exported from Railway (Variables → Raw editor) or /etc/confirmx/*.env",
      "Variable names and purposes: ../../recovery-docs/ENVIRONMENT.md",
      "Critical values that must be carried over EXACTLY: COURIER_ENC_KEY, JWT_SECRET, NEXTAUTH_SECRET,",
      "ADMIN_SECRET, STRIPE_WEBHOOK_SECRET, SHOPIFY_APP_API_SECRET, RESEND_WEBHOOK_SECRET, SMS_WEBHOOK_SHARED_SECRET.",
      "",
    ].join("\n"),
  );
}

// 6. Manifest with SHA-256 of every file.
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (!p.startsWith(dirs.manifests)) files.push({ path: path.relative(dest, p).split(path.sep).join("/"), bytes: fs.statSync(p).size, sha256: sha256(p) });
  }
};
walk(dest);

const firstLine = (s) => (s ? s.split("\n")[0] : null);
const manifest = {
  schema: 1,
  createdAt: new Date().toISOString(),
  stamp,
  git: { commit, branch, branches: git("for-each-ref", "--format=%(refname:short) %(objectname:short)", "refs/heads").split("\n") },
  operator: { os: `${os.type()} ${os.release()} ${os.arch()}`, hostname: os.hostname() },
  toolchain: {
    node: process.version,
    // Windows: npm is a .cmd shim, which Node 22 will not execFile directly.
    npm: process.platform === "win32" ? tryRun("cmd", ["/d", "/c", "npm", "-v"]) : tryRun("npm", ["-v"]),
    packageManager: "npm workspaces (package-lock.json) — pnpm is not used",
    nodeEngine: JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).engines?.node ?? null,
    mongodump: firstLine(tryRun("mongodump", ["--version"])),
  },
  runtimeRequirements: { mongodb: "7.x (dev/CI); production per MONGODB_URI", redis: "7.x (required in production for BullMQ)", nginx: ">= 1.25 (http2 on)" },
  ports: {
    public: { http: 80, https: 443, ssh: 22, sip: "5060/udp (+5061/tcp if TLS)", rtp: "see PBX rtp.conf (state/rtp-settings.txt)" },
    internal: { web: 3001, api: 4000, sites: 3002, redis: 6379, mongodb: 27017, asteriskAmi: "5038 (127.0.0.1 only)" },
  },
  pbx: pbxInfo,
  database: fs.readdirSync(dirs.database),
  files,
};
const manifestFile = path.join(dirs.manifests, `backup-manifest-${stamp}.json`);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
fs.copyFileSync(manifestFile, path.join(dirs.manifests, "backup-manifest.json"));

console.log(`[backup] ${files.length} files → ${dest}`);
console.log(`[backup] manifest ${manifestFile}`);
console.log(`[backup] commit ${commit} (${branch}); pbx archives: ${pbxInfo.length}; db archives: ${manifest.database.length}`);
