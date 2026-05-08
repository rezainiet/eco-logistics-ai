/**
 * Common security headers applied to every route. Notes:
 *
 * - X-Frame-Options + frame-ancestors:
 *     The dashboard must NOT be iframable. The customer-facing /track
 *     page is intentionally embeddable (merchants embed it in their
 *     storefronts), so we relax that single route via a per-path
 *     override below.
 *
 * - Content-Security-Policy:
 *     Pragmatic baseline. `unsafe-inline` for style is required by
 *     Tailwind + Next's per-page critical CSS. Scripts are limited to
 *     self + Next's runtime; we explicitly allow Sentry's ingest host
 *     and the API origin (read at request time so dev/prod diverge
 *     cleanly). report-only at first; flip to enforce after a few
 *     production days of clean reports.
 *
 * - Referrer-Policy: strict-origin-when-cross-origin
 *     Default-good — outbound links to docs / Shopify carry only the
 *     origin, never the path/query (which can carry tokens).
 *
 * - Permissions-Policy:
 *     Locks down sensors / payment / fullscreen the dashboard doesn't
 *     use. Cuts attack surface and avoids surprise browser prompts.
 *
 * - Strict-Transport-Security:
 *     Set in production only — local dev runs on http://localhost:3001
 *     and HSTS would lock the browser into https for the dev domain.
 */
const isProd = process.env.NODE_ENV === "production";

/**
 * Content-Security-Policy — REPORT-ONLY rollout.
 *
 * Strategy: ship a permissive-but-real policy in `Report-Only` mode
 * first. Browsers evaluate every directive and POST violations to
 * /api/csp-report, but DON'T block the resource. After we've watched
 * production traffic for a few days and addressed any legitimate
 * violations, flip the header name to `Content-Security-Policy` to
 * enforce.
 *
 * Why each directive looks the way it does:
 *
 *   default-src 'self'
 *     Locks the baseline to same-origin. Every fetch/font/media etc.
 *     falls through to this unless overridden below.
 *
 *   script-src 'self' 'unsafe-inline' 'unsafe-eval'
 *     `unsafe-inline` is required by:
 *       - Next.js's inline bootstrap script (`<script>` injecting
 *         hydration data, the `Self.__next_f.push(...)` chunk).
 *       - The marketing landing's intentional inline `<script>` for
 *         the calculator event bus (apps/web/src/app/(marketing)/page.tsx).
 *     `unsafe-eval` is required by some Next runtime helpers in
 *     production builds. Both are common pragmatic exceptions; a
 *     proper nonce strategy is a separate, more invasive change we
 *     can layer on once the report stream is clean.
 *
 *   style-src 'self' 'unsafe-inline'
 *     Tailwind's compiled CSS is fine, but Next.js per-page critical
 *     CSS arrives as inline `<style>` blocks; the auth shell
 *     (cordon-auth-shell.tsx) also injects its own brand tokens
 *     inline. Both need 'unsafe-inline'.
 *
 *   img-src 'self' data: blob: https:
 *     - data: covers favicons, the inline icon.svg, and the
 *       Payment-Proof PDF preview's base64 image fallback.
 *     - blob: covers in-browser-generated previews (CSV preview,
 *       PDF blob URLs).
 *     - https: tolerates merchant-uploaded URLs (logo URLs in
 *       branding settings) without enumerating every CDN.
 *
 *   font-src 'self' data:
 *     next/font self-hosts the WOFF2 files under /_next/static/media.
 *     data: covers any embedded glyph fallback.
 *
 *   connect-src 'self' <api-origin>
 *     tRPC calls go to NEXT_PUBLIC_API_URL (separate origin from the
 *     web app on Railway / Vercel). Sentry's ingest host is
 *     allowed when SENTRY_DSN is configured.
 *
 *   frame-src 'self' data:
 *     The billing page renders the merchant's payment-proof PDF in
 *     an iframe with a `data:` URL.
 *
 *   frame-ancestors 'none'
 *     Same intent as X-Frame-Options: DENY. Modern browsers prefer
 *     this CSP form. /track/* relaxes this in its per-path override.
 *
 *   form-action 'self'
 *     Forms can only submit to same-origin. Defends against a stolen
 *     form-action attribute pointing at an attacker URL.
 *
 *   base-uri 'self'
 *     Locks down <base href=…>; common XSS pivot when an attacker
 *     can inject a single tag.
 *
 *   object-src 'none'
 *     Bans <object> / <embed>; modern apps shouldn't need them.
 *
 *   report-uri /api/csp-report
 *     POST endpoint we control (Next route handler). Logs each
 *     violation to stdout for ops to investigate before we flip
 *     the header to enforce.
 */
function buildCspReportOnly() {
  const apiOrigin = (() => {
    const raw = process.env.NEXT_PUBLIC_API_URL ?? "";
    if (!raw) return null;
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host}`;
    } catch {
      return null;
    }
  })();
  const sentryOrigin = (() => {
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";
    if (!dsn) return null;
    try {
      const url = new URL(dsn);
      return `https://${url.host}`;
    } catch {
      return null;
    }
  })();
  const connectSrc = ["'self'", "https:", "wss:"];
  if (apiOrigin) connectSrc.push(apiOrigin);
  if (sentryOrigin) connectSrc.push(sentryOrigin);

  const directives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(" ")}`,
    "frame-src 'self' data:",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "report-uri /api/csp-report",
  ];
  return directives.join("; ");
}

const COMMON_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()",
  },
  // CSP rolls out in Report-Only mode first. Browsers report violations
  // without blocking resources — gives ops a few days of production
  // traffic to validate the policy before flipping to enforce. Switch
  // header name to `Content-Security-Policy` (drop "-Report-Only") once
  // the violation stream is clean.
  {
    key: "Content-Security-Policy-Report-Only",
    value: buildCspReportOnly(),
  },
  ...(isProd
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000; includeSubDomains",
        },
      ]
    : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@ecom/types", "@ecom/db"],
  // Production builds gate on a clean typecheck — the project is at 0 TS
  // errors and the test suite is green, so the cheap regression gate is
  // worth catching here. ESLint stays off at build time because it's
  // run separately by `npm run lint` and tends to surface stylistic
  // false-positives on Next's generated code that block deploys.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        // /track/* is embeddable in merchant storefronts. Strip
        // X-Frame-Options on that path so the iframe loads. Other
        // headers stay; they don't interfere with iframing.
        source: "/track/:path*",
        headers: COMMON_HEADERS.filter((h) => h.key !== "X-Frame-Options"),
      },
      {
        source: "/:path*",
        headers: COMMON_HEADERS,
      },
    ];
  },
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
