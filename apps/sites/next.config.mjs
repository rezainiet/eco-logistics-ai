/**
 * apps/sites — public renderer for merchant landing pages.
 *
 * Deliberately separate from apps/web: no NextAuth, no tRPC client, no
 * dashboard routes, and a much stricter CSP. A tenant hostname can only
 * ever reach the landing renderer, never ConfirmX's own UI.
 *
 * Merchant content is data rendered by trusted components, so pages need
 * no third-party scripts. `'unsafe-inline'` scripts remain only for Next's
 * inline bootstrap (a nonce strategy can replace it later); `'unsafe-eval'`
 * is dev-only (React Refresh).
 */
const isProd = process.env.NODE_ENV === "production";

function origin(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

// Images are served by the API's /api/landing-assets route.
const assetOrigin = origin(process.env.LANDING_ASSET_ORIGIN ?? process.env.LANDING_API_URL ?? "http://localhost:4000");

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data:${assetOrigin ? ` ${assetOrigin}` : ""}`,
  "font-src 'self'",
  `connect-src 'self'${isProd ? "" : " ws: wss:"}`,
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

const headers = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@ecom/landing"],
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [{ source: "/:path*", headers }];
  },
  webpack: (config) => {
    // @ecom/landing uses explicit `.js` specifiers (NodeNext style) that
    // resolve to `.ts`/`.tsx` sources.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
