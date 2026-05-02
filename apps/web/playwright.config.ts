import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Playwright config for the merchant-onboarding e2e suite.
 *
 * The single `webServer` runs the all-in-one e2e stack (`scripts/e2e-stack.mjs`
 * at the repo root) which spawns:
 *   1. mongodb-memory-server  (Mongo instance ephemeral to the test run)
 *   2. apps/api               (tRPC + Express on :4000)
 *   3. apps/web               (Next.js dev on :3001)
 *
 * Playwright then waits on http://localhost:3001 to come up before the
 * spec files run. `reuseExistingServer` keeps things fast in interactive
 * use (`npm run test:e2e:ui`) without bouncing the stack between reloads.
 */

const repoRoot = resolve(__dirname, "..", "..");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // single test stack — keep specs serial.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3001",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "node scripts/e2e-stack.mjs",
    url: "http://localhost:3001",
    cwd: repoRoot,
    reuseExistingServer: !process.env.CI,
    // The stack pulls in MongoDB Memory Server which downloads the
    // mongod binary on first run — generous timeout so CI cold starts
    // don't flake.
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
