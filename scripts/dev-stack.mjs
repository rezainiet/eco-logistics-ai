#!/usr/bin/env node
/**
 * Local development stack — `npm run dev:sites`.
 *
 * Starts everything needed to use ConfirmX end to end on one machine:
 *   MongoDB  127.0.0.1:27018  single-node replica set "rs0" (transactions), data in
 *            .dev/mongo (unless MONGODB_URI is set)
 *   API      http://localhost:4000   (tsx watch)
 *   Web      http://localhost:3001   (dashboard + landing editor)
 *   Sites    http://<slug>.localhost:3002, preview frame http://preview.localhost:3002
 *
 * Development only. Nothing here is used by production builds or deploys.
 *   - Redis is not started: the API runs without it in development (in-memory
 *     cache, queues disabled) — it is only required in production.
 *   - Secrets are generated locally once (.dev/secrets.json, git-ignored) —
 *     never copied from Railway/production.
 *   - A remote MONGODB_URI is refused unless DEV_ALLOW_REMOTE_DB=1, so a
 *     production database is never used by accident.
 *   - On a fresh local database the API's own seed runs once
 *     (owner@acme.test / password123 — local only).
 *
 * Values from a root .env (if present) take precedence over the defaults.
 * Only variable NAMES are printed, never values.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const devDir = path.join(root, ".dev");
const MONGO_PORT = Number(process.env.DEV_MONGO_PORT ?? 27018);
const log = (msg) => console.log(`[dev] ${msg}`);
const die = (msg) => {
  console.error(`[dev] ${msg}`);
  process.exit(1);
};
fs.mkdirSync(devDir, { recursive: true });

// ── Environment ──────────────────────────────────────────────────────────────
function readDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

const secretsFile = path.join(devDir, "secrets.json");
const secrets = fs.existsSync(secretsFile) ? JSON.parse(fs.readFileSync(secretsFile, "utf8")) : {};
secrets.JWT_SECRET ??= randomBytes(32).toString("hex");
secrets.COURIER_ENC_KEY ??= randomBytes(32).toString("base64");
secrets.NEXTAUTH_SECRET ??= randomBytes(32).toString("hex");
fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });

const fromFile = readDotEnv(path.join(root, ".env"));
const defaults = {
  NODE_ENV: "development",
  API_PORT: "4000",
  CORS_ORIGIN: "http://localhost:3001",
  PUBLIC_API_URL: "http://localhost:4000",
  PUBLIC_WEB_URL: "http://localhost:3001",
  NEXTAUTH_URL: "http://localhost:3001",
  NEXT_PUBLIC_API_URL: "http://localhost:4000",
  NEXT_PUBLIC_WEB_URL: "http://localhost:3001",
  NEXT_PUBLIC_LANDING_PREVIEW_URL: "http://preview.localhost:3002",
  LANDING_ROOT_DOMAIN: "localhost",
  LANDING_PREVIEW_HOST: "preview.localhost",
  LANDING_EDITOR_ORIGINS: "http://localhost:3001",
  LANDING_API_URL: "http://localhost:4000",
  ...secrets,
};
// Precedence: real environment > root .env > local defaults.
const env = { ...defaults, ...fromFile };
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
// Stale production-ish values must not leak into the local stack.
env.NODE_ENV = "development";

let startMongo = false;
if (!env.MONGODB_URI) {
  // A replica set (of one) — order placement reserves stock in a transaction.
  env.MONGODB_URI = `mongodb://127.0.0.1:${MONGO_PORT}/confirmx_dev?replicaSet=rs0&directConnection=true`;
  startMongo = true;
} else {
  const host = (() => {
    try {
      return new URL(env.MONGODB_URI.replace(/^mongodb\+srv:/, "http:").replace(/^mongodb:/, "http:")).hostname;
    } catch {
      return "";
    }
  })();
  if (!/^(localhost|127\.0\.0\.1|::1)$/.test(host) && env.DEV_ALLOW_REMOTE_DB !== "1") {
    die("MONGODB_URI points to a remote database. Refusing to use it for local development (set DEV_ALLOW_REMOTE_DB=1 to override).");
  }
}
for (const [k, remote] of [["NEXT_PUBLIC_API_URL", env.NEXT_PUBLIC_API_URL], ["LANDING_API_URL", env.LANDING_API_URL]]) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(remote)) die(`${k} is not a local URL — the local stack must not call a remote API.`);
}

// ── Ports ────────────────────────────────────────────────────────────────────
function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}
const busy = [];
for (const [name, port] of [["api", 4000], ["web", 3001], ["sites", 3002]]) if (await portInUse(port)) busy.push(`${name}:${port}`);
if (busy.length) die(`port(s) already in use: ${busy.join(", ")} — stop the other dev server first.`);

// ── MongoDB ──────────────────────────────────────────────────────────────────
let mongod = null;
let freshDb = false;
async function waitForPort(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await portInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
if (startMongo) {
  if (await portInUse(MONGO_PORT)) {
    log(`MongoDB already listening on ${MONGO_PORT} — reusing it`);
  } else {
    const { MongoBinary } = await import("mongodb-memory-server-core");
    const bin = await MongoBinary.getPath(); // cached (or downloaded once) by the test tooling
    const dbPath = path.join(devDir, "mongo");
    freshDb = !fs.existsSync(dbPath);
    fs.mkdirSync(dbPath, { recursive: true });
    mongod = spawn(bin, ["--dbpath", dbPath, "--port", String(MONGO_PORT), "--bind_ip", "127.0.0.1", "--replSet", "rs0", "--quiet"], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    mongod.on("exit", (code) => code && log(`MongoDB exited (${code})`));
    if (!(await waitForPort(MONGO_PORT, 30000))) die("MongoDB did not start");
    log(`MongoDB  mongodb://127.0.0.1:${MONGO_PORT}/confirmx_dev  replica set rs0  (data: .dev/mongo)`);
  }
  await ensureReplicaSet();
}

/** Initiates the one-member replica set once (also converts an older standalone .dev/mongo). */
async function ensureReplicaSet() {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}/?directConnection=true`, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const admin = client.db("admin");
    const hello = await admin.command({ hello: 1 });
    if (!hello.setName) {
      if (!mongod) die(`MongoDB on ${MONGO_PORT} is not a replica set — stop it and re-run (the dev stack restarts it with --replSet rs0).`);
      await admin.command({ replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: `127.0.0.1:${MONGO_PORT}` }] } });
      log("MongoDB replica set rs0 initiated");
    }
    const until = Date.now() + 30000;
    while (!(await admin.command({ hello: 1 })).isWritablePrimary) {
      if (Date.now() > until) die("MongoDB replica set did not elect a primary");
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    await client.close();
  }
}

const stopAll = () => {
  if (mongod && !mongod.killed) mongod.kill();
};
process.on("exit", stopAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stopAll(), process.exit(130)));

// ── Shared packages (apps import their dist/) ────────────────────────────────
function newestMtime(dir) {
  let t = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}
for (const pkg of ["db", "types", "branding", "landing"]) {
  const dir = path.join(root, "packages", pkg);
  const dist = path.join(dir, "dist", "index.js");
  if (!fs.existsSync(dist) || newestMtime(path.join(dir, "src")) > fs.statSync(dist).mtimeMs) {
    log(`building packages/${pkg}`);
    const r = spawnSync("npm", ["--workspace", `packages/${pkg}`, "run", "build"], { cwd: root, stdio: "ignore", shell: true, env });
    if (r.status !== 0) die(`packages/${pkg} failed to build`);
  }
}

// ── Seed a fresh local database once (the API's own seed script) ─────────────
if (freshDb) {
  log("fresh local database — running the API seed (owner@acme.test / password123, local only)");
  const r = spawnSync("npm", ["--workspace", "apps/api", "run", "seed"], { cwd: root, stdio: "inherit", shell: true, env });
  if (r.status !== 0) log("seed failed — continuing without demo data");
}

// ── Apps ─────────────────────────────────────────────────────────────────────
const shown = ["MONGODB_URI", "JWT_SECRET", "COURIER_ENC_KEY", "NEXTAUTH_SECRET", "NEXTAUTH_URL", "NEXT_PUBLIC_API_URL", "LANDING_API_URL"];
log(`env: ${shown.map((k) => `${k}=${env[k] ? "set" : "MISSING"}`).join(" ")}  (Redis: not used in development)`);
log("API    http://localhost:4000   (health: /health, /ready)");
log("Web    http://localhost:3001   (dashboard, landing editor)");
log("Sites  http://<slug>.localhost:3002   preview frame: http://preview.localhost:3002");

const apps = spawn("npx", ["npm-run-all", "--parallel", "--print-label", "dev:api", "dev:web", "dev:sites-only"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env,
});
apps.on("exit", (code) => {
  stopAll();
  process.exit(code ?? 0);
});
