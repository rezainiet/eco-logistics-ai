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

// Browser analytics origins, allowed only when LANDING_ANALYTICS is on (the
// default); LANDING_ANALYTICS=off removes all of them. A page loads a
// provider only if its own settings enable it — these just permit it.
//   Meta Pixel: fbevents.js + config, /tr event endpoint.
//   Google tag (GA4 + Google Ads): gtag.js and its collect/conversion
//   endpoints, per Google's CSP guide (incl. google.com.bd for Bangladesh).
//   TikTok Pixel: events.js and its event endpoints.
const analyticsOn = (process.env.LANDING_ANALYTICS ?? "on").trim().toLowerCase() !== "off";
const META_SCRIPT = "https://connect.facebook.net";
const META_EVENTS = "https://www.facebook.com";
const GOOGLE_SCRIPT = "https://*.googletagmanager.com";
const GOOGLE_EVENTS =
  "https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://*.g.doubleclick.net https://*.google.com https://*.google.com.bd";
const GOOGLE_FRAMES = "https://td.doubleclick.net https://www.googletagmanager.com";
const TIKTOK_SCRIPT = "https://analytics.tiktok.com";
const TIKTOK_EVENTS = "https://analytics.tiktok.com https://*.tiktok.com";

function csp(frameAncestors, { analytics = false } = {}) {
  const on = analytics && analyticsOn;
  const scripts = on ? ` ${META_SCRIPT} ${GOOGLE_SCRIPT} ${TIKTOK_SCRIPT}` : "";
  const events = on ? ` ${META_EVENTS} ${GOOGLE_EVENTS} ${TIKTOK_EVENTS}` : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}${scripts}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${assetOrigin ? ` ${assetOrigin}` : ""}${events}`,
    "font-src 'self'",
    `connect-src 'self'${isProd ? "" : " ws: wss:"}${on ? ` ${META_EVENTS} ${META_SCRIPT} ${GOOGLE_EVENTS} ${TIKTOK_EVENTS}` : ""}`,
    `frame-src ${on ? GOOGLE_FRAMES : "'none'"}`,
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
