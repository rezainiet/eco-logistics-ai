/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@ecom/types", "@ecom/db"],
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
