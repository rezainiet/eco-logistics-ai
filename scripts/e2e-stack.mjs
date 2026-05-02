// @ts-check
/**
 * All-in-one e2e bootstrap.
 *
 * Spins up:
 *   1. an ephemeral MongoDB via mongodb-memory-server (the API workspace
 *      already depends on it, so we hoist the same package)
 *   2. apps/api in dev mode
 *   3. apps/web in dev mode
 *
 * Both child processes inherit the env we mint here so JWT/admin/encryption
 * keys are consistent across the stack and known to the Playwright tests
 * (they read the same constants from `e2e/fixtures.ts`).
 *
 * Lifecycle: when the parent process exits or receives SIGTERM/SIGINT we
 * tear everything down — MongoDB Memory Server cleans its tmp dir, child
 * processes get a SIGTERM and a 5s grace before SIGKILL.
 *
 * Usage (Playwright spawns this directly via `webServer.command`):
 *   node scripts/e2e-stack.mjs
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { MongoMemoryServer } from "mongodb-memory-server";

// Stable test secrets — referenced by e2e/fixtures.ts. Don't change without
// updating the fixture in lockstep.
const E2E_ENV = {
  NODE_ENV: "test",
  JWT_SECRET: "e2e-secret-at-least-sixteen-characters-please",
  // 32 base64 bytes — `openssl rand -base64 32` would produce something
  // similar. Stable so encryption matches across boot.
  COURIER_ENC_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  ADMIN_SECRET: "e2e-admin-secret-at-least-twenty-four-chars",
  CORS_ORIGIN: "http://localhost:3001",
  PUBLIC_API_URL: "http://localhost:4000",
  PUBLIC_WEB_URL: "http://localhost:3001",
  TRIAL_DAYS: "14",
  // Force dev fallbacks across third-party providers so the stack runs
  // offline. Email logs to stdout, Stripe returns mock URLs, telemetry
  // is silent.
  COURIER_MOCK: "1",
  STRIPE_USE_USD: "1",
};

const WEB_ENV = {
  NEXT_PUBLIC_API_URL: "http://localhost:4000",
  NEXTAUTH_URL: "http://localhost:3001",
  NEXTAUTH_SECRET: "e2e-nextauth-secret-at-least-32-chars",
  NEXT_TELEMETRY_DISABLED: "1",
};

/** Promise that resolves when the child process binds. We tail stdout. */
function waitForLogLine(child, marker, label) {
  return new Promise((resolve, reject) => {
    const onData = (buf) => {
      const text = buf.toString();
      process.stdout.write(`[${label}] ${text}`);
      if (text.includes(marker)) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (buf) => process.stderr.write(`[${label}] ${buf}`));
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`${label} exited with ${code}`));
    });
  });
}

async function main() {
  console.log("[e2e-stack] starting MongoDB Memory Server…");
  const mongod = await MongoMemoryServer.create();
  const mongoUri = mongod.getUri();
  console.log(`[e2e-stack] mongo uri: ${mongoUri}`);

  /** @type {NodeJS.ProcessEnv} */
  const baseEnv = {
    ...process.env,
    ...E2E_ENV,
    MONGODB_URI: mongoUri,
  };

  const onWindows = process.platform === "win32";
  const npm = onWindows ? "npm.cmd" : "npm";

  console.log("[e2e-stack] spawning API…");
  const api = spawn(
    npm,
    ["--workspace", "@ecom/api", "run", "dev"],
    { env: baseEnv, stdio: ["ignore", "pipe", "pipe"], shell: onWindows },
  );
  await waitForLogLine(api, "[api] listening", "api");

  console.log("[e2e-stack] spawning Web…");
  const web = spawn(
    npm,
    ["--workspace", "@ecom/web", "run", "dev"],
    {
      env: { ...baseEnv, ...WEB_ENV },
      stdio: ["ignore", "pipe", "pipe"],
      shell: onWindows,
    },
  );
  // Next.js prints "Ready" or "Local:" depending on version — match either.
  await Promise.race([
    waitForLogLine(web, "Ready", "web"),
    waitForLogLine(web, "started server", "web"),
    waitForLogLine(web, "Local:", "web"),
  ]);

  console.log("[e2e-stack] stack up — api+web ready, awaiting test driver");

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[e2e-stack] ${signal} — tearing down`);
    for (const child of [web, api]) {
      try {
        child.kill("SIGTERM");
      } catch (err) {
        console.error("[e2e-stack] kill", err);
      }
    }
    setTimeout(() => {
      try {
        web.kill("SIGKILL");
        api.kill("SIGKILL");
      } catch { }
    }, 5_000).unref();
    try {
      await mongod.stop();
    } catch (err) {
      console.error("[e2e-stack] mongod.stop", err);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // Keep the process alive — child processes are non-detached so we own
  // their lifecycle.
  await new Promise(() => { });
}

main().catch((err) => {
  console.error("[e2e-stack] fatal", err);
  process.exit(1);
});
