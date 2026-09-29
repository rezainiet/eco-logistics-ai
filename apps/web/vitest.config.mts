import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Unit tests for pure dashboard logic and presentational components
 * (rendered with react-dom/server — no DOM, no tRPC, no network).
 * End-to-end flows stay in Playwright (`e2e/`).
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@ecom/landing/react": resolve(here, "../../packages/landing/src/react/index.ts"),
      "@ecom/landing": resolve(here, "../../packages/landing/src/index.ts"),
      "@": resolve(here, "src"),
    },
  },
  test: { environment: "node", include: ["src/**/*.test.{ts,tsx}"] },
});
