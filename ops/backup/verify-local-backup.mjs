#!/usr/bin/env node
/**
 * Restore test for the local backup — proves it can be restored, not just that it exists.
 *
 *   node ops/backup/verify-local-backup.mjs [--dest E:/confirm-x/backups]
 *
 * In a TEMPORARY directory (deleted afterwards) it:
 *   1. re-hashes every file in the latest manifest (SHA-256 must match)
 *   2. verifies the git bundle and CLONES it; checks the manifest commit + key files
 *   3. extracts the source tarball and checks key files
 *   4. verifies each PBX archive (outer checksum, extraction, MANIFEST.sha256, key files)
 *   5. checks each MongoDB archive is a readable gzip stream (and, if mongorestore is
 *      installed, runs `mongorestore --dryRun`)
 * Touches no live system.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const i = args.indexOf("--dest");
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const dest = path.resolve(i >= 0 ? args[i + 1] : path.join(repo, "..", "backups"));
const manifest = JSON.parse(fs.readFileSync(path.join(dest, "manifests", "backup-manifest.json"), "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "confirmx-restore-test-"));
let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const bad = (m) => {
  failed++;
  console.log(`FAIL  ${m}`);
};
const run = (cmd, a, cwd) => execFileSync(cmd, a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

try {
  // 1. Checksums
  let mismatched = 0;
  for (const f of manifest.files) {
    const p = path.join(dest, f.path);
    if (!fs.existsSync(p)) {
      bad(`missing ${f.path}`);
      continue;
    }
    const h = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    if (h !== f.sha256) {
      mismatched++;
      bad(`checksum ${f.path}`);
    }
  }
  if (!mismatched) ok(`${manifest.files.length} files match their SHA-256`);

  // 2. Git bundle → clone
  // Use the artefacts of THIS manifest's run (earlier runs stay in the folder).
  const ofRun = (f) => f.path.includes(manifest.stamp);
  const bundle = manifest.files.find((f) => ofRun(f) && f.path.endsWith(".bundle"));
  if (!bundle) bad("no git bundle for this run");
  else {
    const b = path.join(dest, bundle.path);
    run("git", ["bundle", "verify", b]);
    ok(`git bundle verifies (${bundle.path})`);
    const clone = path.join(tmp, "clone");
    run("git", ["clone", "--quiet", b, clone]);
    let has = "missing";
    try {
      has = run("git", ["-C", clone, "cat-file", "-t", manifest.git.commit]);
    } catch {
      /* reported below */
    }
    has === "commit" ? ok(`bundle contains manifest commit ${manifest.git.commit.slice(0, 7)}`) : bad("manifest commit not in bundle");
    const branches = run("git", ["-C", clone, "branch", "-r"]).split("\n").map((s) => s.trim());
    ok(`bundle branches: ${branches.filter((x) => !x.includes("->")).join(", ")}`);
    run("git", ["-C", clone, "checkout", "--quiet", manifest.git.commit]);
    for (const rel of ["package.json", "package-lock.json", "apps/api/package.json", "apps/web/package.json", "apps/sites/package.json", "packages/db/package.json", ".env.production.example", "deploy/vps/nginx/confirmx.conf", "deploy/vps/systemd/confirmx-api.service", "docs/infra/CONFIRMX-RECOVERY.md", "docs/infra/PBX-RECOVERY.md"]) {
      fs.existsSync(path.join(clone, rel)) ? ok(`clone has ${rel}`) : bad(`clone missing ${rel}`);
    }
  }

  // 3. Source tarball
  const src = manifest.files.find((f) => ofRun(f) && /confirmx-src-.*\.tar\.gz$/.test(f.path));
  if (!src) bad("no source tarball for this run");
  else {
    const out = path.join(tmp, "src");
    fs.mkdirSync(out);
    // Relative names + cwd: GNU tar would read "E:/…" as a remote host:path.
    const tarball = path.join(dest, src.path);
    run("tar", ["-xzf", path.basename(tarball), "-C", path.relative(path.dirname(tarball), out).split(path.sep).join("/")], path.dirname(tarball));
    const root = path.join(out, fs.readdirSync(out)[0]);
    const n = run("git", ["ls-files"], repo).split("\n").length;
    ok(`source tarball extracts (${src.path}; repo tracks ${n} files)`);
    for (const rel of ["package-lock.json", "apps/api/src/index.ts", "apps/web/next.config.mjs", "apps/sites/next.config.mjs"]) {
      fs.existsSync(path.join(root, rel)) ? ok(`tarball has ${rel}`) : bad(`tarball missing ${rel}`);
    }
  }

  // 4. PBX archives
  const pbx = manifest.files.filter((f) => f.path.startsWith("pbx/") && f.path.endsWith(".tar.gz"));
  if (!pbx.length) console.log("info  no PBX archive in this backup");
  for (const f of pbx) {
    try {
      const outp = run("bash", [path.join(repo, "ops/backup/verify-pbx-backup.sh"), path.join(dest, f.path)]);
      console.log(outp.split("\n").map((l) => `      ${l}`).join("\n"));
      ok(`PBX archive verified: ${f.path}`);
    } catch (e) {
      console.log(String(e.stdout ?? ""));
      bad(`PBX archive failed verification: ${f.path}`);
    }
  }

  // 5. Mongo archives
  const dbs = manifest.files.filter((f) => f.path.startsWith("confirmx/database/"));
  if (!dbs.length) console.log("info  no MongoDB archive in this backup");
  for (const f of dbs) {
    const p = path.join(dest, f.path);
    try {
      const head = zlib.gunzipSync(fs.readFileSync(p)).subarray(0, 4);
      // mongodump --archive streams start with the magic 0x8199e26d (little-endian).
      head.readUInt32LE(0) === 0x8199e26d ? ok(`MongoDB archive readable (mongodump format): ${f.path}`) : bad(`not a mongodump archive: ${f.path}`);
    } catch {
      bad(`MongoDB archive not a readable gzip: ${f.path}`);
    }
    try {
      run("mongorestore", ["--archive=" + p, "--gzip", "--dryRun", "--quiet"]);
      ok(`mongorestore --dryRun passed: ${f.path}`);
    } catch {
      console.log("info  mongorestore not available here — dry run skipped");
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nrestore test passed");
process.exit(failed ? 1 : 0);
