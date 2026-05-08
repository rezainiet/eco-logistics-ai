import type { BrandingConfig } from "./types.js";

/**
 * Baked-in default Cordon branding. The "no DB, no env" fallback that
 * every render path drops to when Mongo is unreachable. Keep this file
 * boring, valid, and deployable.
 */
export const DEFAULT_BRANDING: BrandingConfig = {
  key: "saas",
  name: "Cordon",
  legalName: "Cordon Technologies Ltd.",
  tagline: "Stop bleeding RTO",
  shortTagline: "Built for Bangladesh's COD economy",
  productCategory:
    "the order operations OS for Shopify and WooCommerce stores in Bangladesh",
  defaultLocale: "en_BD",
  homeUrl: "https://cordon.app",
  statusPageUrl: "https://status.cordon.app",
  termsUrl: "/legal/terms",
  privacyUrl: "/legal/privacy",
  supportUrl: "https://cordon.app/support",
  supportEmail: "support@cordon.app",
  privacyEmail: "privacy@cordon.app",
  salesEmail: "sales@cordon.app",
  helloEmail: "hello@cordon.app",
  noReplyEmail: "no-reply@cordon.app",
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
    logo: { url: "/brand/logo.svg", alt: "Cordon" },
    logoMono: { url: "/brand/logo-mono.svg", alt: "Cordon" },
    favicon: { url: "/favicon.ico" },
    appleTouchIcon: { url: "/apple-touch-icon.png" },
    ogImage: {
      url: "/og.png",
      widthPx: 1200,
      heightPx: 630,
      alt: "Cordon — stop bleeding RTO",
    },
    emailLogo: {
      url: "https://cordon.app/brand/email-logo.png",
      alt: "Cordon",
    },
  },
  email: {
    senderName: "Cordon",
    senderAddress: "no-reply@cordon.app",
    replyTo: "support@cordon.app",
    footer: "Built for Bangladesh's COD economy",
    accentColor: "#C6F84F",
    ctaTextDefault: "Open Cordon",
    supportLine:
      "Need a hand? Reply to this email — a real person on the team will help.",
  },
  seo: {
    metaTitleTemplate: "%s · Cordon",
    metaTitleDefault: "Cordon — stop bleeding RTO",
    metaDescription:
      "The order operations OS for Shopify and WooCommerce stores in Bangladesh. Real-time fraud scoring, automated courier booking, webhook delivery you can trust.",
    keywords: [
      "Bangladesh ecommerce",
      "COD fraud prevention",
      "Shopify Bangladesh",
      "WooCommerce Bangladesh",
      "Pathao Steadfast RedX integration",
      "RTO reduction",
    ],
    twitterHandle: "@cordonhq",
    ogSiteName: "Cordon",
  },
  operational: {
    onboardingWelcomeCopy:
      "Welcome to Cordon. Connect Shopify or WooCommerce to start scoring orders.",
    dashboardWelcomeCopy:
      "Cordon scores every order before it ships. Connect your store to begin.",
    sdkGlobalName: "CordonTracker",
    sdkConsolePrefix: "[cordon]",
    smsBrand: "Cordon Ops",
    stripeProductPrefix: "Cordon",
    woocommerceWebhookPrefix: "Cordon",
  },
  version: 0,
  updatedAt: new Date(0).toISOString(),
};

/** "Cordon" -> "C", "Acme Logistics" -> "AL". */
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
