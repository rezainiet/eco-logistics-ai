import type { Config } from "tailwindcss";

/**
 * Public landing pages are styled entirely by the shared section
 * components in @ecom/landing; this app contributes no design tokens of
 * its own. Merchant colours arrive as validated CSS custom properties.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}", "../../packages/landing/src/react/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
};

export default config;
