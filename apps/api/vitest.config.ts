import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@ecom/db": resolve(here, "../../packages/db/src/index.ts"),
      "@ecom/types": resolve(here, "../../packages/types/src/index.ts"),
      "@ecom/branding": resolve(here, "../../packages/branding/src/index.ts"),
    },
  },
  test: {
    globals: false,
    environment: "node",
    globalSetup: ["./tests/globalSetup.ts"],
    hookTimeout: 120_000,
    testTimeout: 30_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
