/**
 * apps/sites — public renderer for merchant landing pages, and the editor
 * preview frame (on the preview host).
 *
 * Deliberately separate from apps/web: no NextAuth, no tRPC client, no
 * dashboard routes or dashboard CSS, and a much stricter CSP. A tenant
 * hostname can only ever reach the landing renderer, never ConfirmX's UI.
 *
 * Merchant content is data rendered by trusted components. The only
 * third-party script is the merchant's Meta Pixel on PUBLIC pages (Meta's
 * origins are allowed there and nowhere else — the preview host keeps the
 * strict policy, so a pixel can never load inside the editor preview).
 * `'unsafe-inline'` scripts remain only for Next's
 * inline bootstrap (a nonce strategy can replace it later); `'unsafe-eval'`
 * is dev-only (React Refresh).
 *
 * Header values are computed at BUILD time: set LANDING_PREVIEW_HOST,
 * LANDING_EDITOR_ORIGINS and LANDING_API_URL / LANDING_ASSET_ORIGIN in the
 * build environment.
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

// Preview host + the dashboard origins allowed to embed it (editor device preview).
const previewHost = (process.env.LANDING_PREVIEW_HOST ?? (isProd ? "" : "preview.localhost")).trim().toLowerCase();
const editorOrigins = (process.env.LANDING_EDITOR_ORIGINS ?? (isProd ? "" : "http://localhost:3001"))
  .split(",")
  .map((o) => origin(o.trim()))
  .filter(Boolean);

// Meta Pixel: fbevents.js + its config/plugins, and the /tr event endpoint
// (image beacon, sendBeacon or fetch). LANDING_ANALYTICS=off removes them.
const analyticsOn = (process.env.LANDING_ANALYTICS ?? "on").trim().toLowerCase() !== "off";
const META_SCRIPT = "https://connect.facebook.net";
const META_EVENTS = "https://www.facebook.com";

function csp(frameAncestors, { analytics = false } = {}) {
  const meta = analytics && analyticsOn;
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}${meta ? ` ${META_SCRIPT}` : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${assetOrigin ? ` ${assetOrigin}` : ""}${meta ? ` ${META_EVENTS}` : ""}`,
    "font-src 'self'",
    `connect-src 'self'${isProd ? "" : " ws: wss:"}${meta ? ` ${META_EVENTS} ${META_SCRIPT}` : ""}`,
    "frame-src 'none'",
    `frame-ancestors ${frameAncestors}`,
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

const baseHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] : []),
];

/** Public pages: never framed. */
const pageHeaders = [
  ...baseHeaders,
  { key: "Content-Security-Policy", value: csp("'none'", { analytics: true }) },
  { key: "X-Frame-Options", value: "DENY" },
];

/** Preview host: framable only by the editor origins; never indexed or cached. */
const previewHeaders = [
  ...baseHeaders,
  { key: "Content-Security-Policy", value: csp(editorOrigins.length ? editorOrigins.join(" ") : "'none'") },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "Cache-Control", value: "no-store" },
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, (m) => "\\" + m);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@ecom/landing"],
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    if (!previewHost) return [{ source: "/:path*", headers: pageHeaders }];
    const host = escapeRegex(previewHost);
    return [
      { source: "/:path*", missing: [{ type: "host", value: host }], headers: pageHeaders },
      { source: "/:path*", has: [{ type: "host", value: host }], headers: previewHeaders },
    ];
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
