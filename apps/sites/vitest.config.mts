import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@ecom/landing/react": resolve(here, "../../packages/landing/src/react/index.ts"),
      "@ecom/landing": resolve(here, "../../packages/landing/src/index.ts"),
      "@": resolve(here, "src"),
    },
  },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
