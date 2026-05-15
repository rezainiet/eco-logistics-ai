import type { BrandingConfig } from "./types.js";

/**
 * Baked-in default ConfirmX branding. The "no DB, no env" fallback
 * that every render path drops to when Mongo is unreachable. Keep
 * this file boring, valid, and deployable.
 *
 * Positioning vocabulary (audited 2026-05-09 for Shopify-app review):
 * ConfirmX is "COD operational intelligence and order confirmation
 * infrastructure" — NOT "AI fraud detector / customer surveillance".
 * Avoid hype-AI vocabulary in any future rewrite of these strings.
 *
 * Pre-submission TODOs (search for "TODO[brand]" before flipping the
 * Shopify app from Custom to Public Distribution):
 *   - legalName needs the registered legal entity
 *   - emails should resolve to working inboxes
 *   - twitterHandle should match the actual account
 */
export const DEFAULT_BRANDING: BrandingConfig = {
  key: "saas",
  name: "ConfirmX",
  // TODO[brand]: replace with the registered legal entity before
  // Public Distribution submission. Reviewers cross-check this
  // against the privacy/terms pages and the Partner-Dashboard
  // listing — placeholder will fail review.
  legalName: "ConfirmX Technologies Ltd.",
  tagline: "Confirm every COD order before it ships",
  shortTagline: "Built for Bangladesh's COD economy",
  productCategory:
    "the COD operations infrastructure for Shopify and WooCommerce stores in Bangladesh",
  defaultLocale: "en_BD",
  homeUrl: "https://confirmx.ai",
  statusPageUrl: "https://status.confirmx.ai",
  termsUrl: "/legal/terms",
  privacyUrl: "/legal/privacy",
  supportUrl: "https://confirmx.ai/support",
  // TODO[brand]: confirm these inboxes route to a real human or
  // ticketing system before submission. Review specifically tests
  // the privacy + support emails for delivery.
  supportEmail: "support@confirmx.ai",
  privacyEmail: "privacy@confirmx.ai",
  salesEmail: "sales@confirmx.ai",
  helloEmail: "hello@confirmx.ai",
  noReplyEmail: "no-reply@email.confirmx.ai",
  colors: {
    brand: "#C6F84F",
    brandHover: "#8AE619",
    brandActive: "#7CCC15",
    brandFg: "#0A0A0B",
    accent: "#C6F84F",
    surfaceBase: "#0A0A0B",
    fg: "#FAFAFA",
  },
  assets: {
    logo: { url: "/brand/logo.svg", alt: "ConfirmX" },
    logoMono: { url: "/brand/logo-mono.svg", alt: "ConfirmX" },
    favicon: { url: "/favicon.ico" },
    appleTouchIcon: { url: "/apple-touch-icon.png" },
    ogImage: {
      url: "/og.png",
      widthPx: 1200,
      heightPx: 630,
      alt: "ConfirmX — confirm every COD order before it ships",
    },
    emailLogo: {
      url: "https://confirmx.ai/brand/email-logo.png",
      alt: "ConfirmX",
    },
  },
  email: {
    senderName: "ConfirmX",
    // Transactional sender lives on the `email.*` subdomain, which is
    // the Resend-verified domain in production. DKIM is published at
    // `resend._domainkey.email.confirmx.ai` and Resend's outbound
    // signs with it; DMARC alignment carries via DKIM (the apex
    // `_dmarc.confirmx.ai` p=none record covers the subdomain via
    // relaxed alignment). The legacy `send.*` subdomain has SPF/MX
    // but no DKIM and is NOT a valid sender — kept in DNS only as a
    // historical artifact, scheduled for cleanup.
    senderAddress: "no-reply@email.confirmx.ai",
    // Reply-To stays on the apex — that's the contact domain where
    // support@ / privacy@ inboxes (will) live.
    replyTo: "support@confirmx.ai",
    footer: "Built for Bangladesh's COD economy",
    accentColor: "#C6F84F",
    ctaTextDefault: "Open ConfirmX",
    supportLine:
      "Need a hand? Reply to this email — a real person on the team will help.",
  },
  seo: {
    metaTitleTemplate: "%s · ConfirmX",
    metaTitleDefault: "ConfirmX — confirm every COD order before it ships",
    metaDescription:
      "COD order confirmation infrastructure for Shopify and WooCommerce stores in Bangladesh. Real-time order verification, automated courier booking on Pathao, Steadfast & RedX, and idempotent webhook delivery for the operational workflows COD merchants run every day.",
    keywords: [
      "Bangladesh ecommerce",
      "COD order confirmation",
      "Shopify Bangladesh",
      "WooCommerce Bangladesh",
      "Pathao Steadfast RedX integration",
      "RTO reduction",
    ],
    twitterHandle: "@confirmxhq",
    ogSiteName: "ConfirmX",
  },
  operational: {
    onboardingWelcomeCopy:
      "Welcome to ConfirmX. Connect Shopify or WooCommerce to start confirming COD orders before they ship.",
    dashboardWelcomeCopy:
      "ConfirmX confirms every COD order before it ships. Connect your store to begin.",
    sdkGlobalName: "ConfirmXTracker",
    sdkConsolePrefix: "[confirmx]",
    smsBrand: "ConfirmX Ops",
    stripeProductPrefix: "ConfirmX",
    woocommerceWebhookPrefix: "ConfirmX",
  },
  version: 0,
  updatedAt: new Date(0).toISOString(),
};

/** "ConfirmX" -> "C", "Acme Logistics" -> "AL". */
export function defaultInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "C"
  );
}
