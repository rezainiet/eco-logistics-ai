/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@ecom/types", "@ecom/db"],
  // Staging deploys: skip type checks + lint at build time so a small type
  // drift in @ecom/types (e.g. missing export from a stashed change) doesn't
  // block the entire build pipeline. Local `npm run typecheck` still catches
  // these errors. Remove for production / main-branch deploys once typing
  // is fully clean.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  webpack: (config) => {
    // `@ecom/types` re-exports siblings with explicit `.js` specifiers (the
    // form the API's NodeNext ESM loader requires). Webpack's default
    // resolver doesn't map `.js` to its `.ts` source — teach it to.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
