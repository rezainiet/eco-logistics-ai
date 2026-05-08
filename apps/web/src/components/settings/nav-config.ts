/**
 * Settings information architecture — single source of truth.
 *
 * Order, grouping, and labels here drive:
 *   - the left-rail nav in apps/web/src/app/dashboard/settings/layout.tsx
 *   - the legacy `?tab=X` query-string redirect in
 *     apps/web/src/app/dashboard/settings/page.tsx
 *   - the audit trail in ENTERPRISE_SETTINGS_REDESIGN_REPORT.md
 *
 * Adding a new section is exactly: (1) pick the right group below, (2)
 * add the entry, (3) create the matching route page. No other file
 * needs to change. That's the structural shift this redesign exists to
 * enable — see SETTINGS_UX_AUDIT.md for the prior fragmentation.
 */
import {
  Bell,
  Bot,
  Building2,
  CreditCard,
  Lock,
  Palette,
  Plug,
  Truck,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";

export type SettingsSectionKey =
  | "workspace"
  | "branding"
  | "notifications"
  | "team"
  | "billing"
  | "couriers"
  | "integrations"
  | "automation"
  | "api"
  | "security";

export type SettingsSection = {
  key: SettingsSectionKey;
  href: string;
  label: string;
  icon: LucideIcon;
  /**
   * Short description shown under the page title. Stays terse — the
   * section's own forms communicate detail. See PageHeader for usage.
   */
  description: string;
  /**
   * Optional badge — "Soon" for placeholder sections. Keeps the IA
   * complete (so users see the roadmap) without faking functionality.
   */
  badge?: "Soon";
};

export type SettingsSectionGroup = {
  key: "account" | "workspace" | "operations";
  label: string;
  /** One-line group description shown above the nav group on desktop. */
  hint: string;
  items: SettingsSection[];
};

export const SETTINGS_NAV: SettingsSectionGroup[] = [
  {
    key: "account",
    label: "Account",
    hint: "How you sign in and what we send you.",
    items: [
      {
        key: "workspace",
        href: "/dashboard/settings/workspace",
        label: "Workspace",
        icon: Building2,
        description:
          "Business identity, contact phone, country and language preferences.",
      },
      {
        key: "notifications",
        href: "/dashboard/settings/notifications",
        label: "Notifications",
        icon: Bell,
        description:
          "Choose which operational alerts reach you, and where.",
        badge: "Soon",
      },
      {
        key: "security",
        href: "/dashboard/settings/security",
        label: "Security",
        icon: Lock,
        description:
          "Password, email verification, and account access events.",
      },
    ],
  },
  {
    key: "workspace",
    label: "Workspace",
    hint: "Shared configuration for your business.",
    items: [
      {
        key: "branding",
        href: "/dashboard/settings/branding",
        label: "Branding",
        icon: Palette,
        description:
          "Logo and accent color used across your dashboard and tracking page.",
      },
      {
        key: "team",
        href: "/dashboard/settings/team",
        label: "Team & access",
        icon: Users,
        description:
          "Invite teammates, manage roles, and review recent access events.",
        badge: "Soon",
      },
      {
        key: "billing",
        href: "/dashboard/settings/billing",
        label: "Billing",
        icon: CreditCard,
        description:
          "Plan, usage, payment methods, invoices, and trial status.",
      },
    ],
  },
  {
    key: "operations",
    label: "Operations",
    hint: "Connections that move orders end-to-end.",
    items: [
      {
        key: "couriers",
        href: "/dashboard/settings/couriers",
        label: "Couriers",
        icon: Truck,
        description:
          "Pathao, Steadfast, RedX, and other courier credentials with district preferences.",
      },
      {
        key: "integrations",
        href: "/dashboard/settings/integrations",
        label: "Integrations",
        icon: Plug,
        description:
          "Shopify, WooCommerce, custom API, and CSV connections — and their delivery health.",
      },
      {
        key: "automation",
        href: "/dashboard/settings/automation",
        label: "Automation",
        icon: Bot,
        description:
          "How aggressively to auto-confirm and auto-book orders based on risk.",
      },
      {
        key: "api",
        href: "/dashboard/settings/api",
        label: "API & webhooks",
        icon: Webhook,
        description:
          "Webhook URLs, signing secret rotation, and recent delivery attempts.",
      },
    ],
  },
];

/**
 * Flat lookup for redirects and breadcrumbs. Exported so the legacy
 * `?tab=X` redirect doesn't need to traverse the grouped tree.
 */
export const SETTINGS_BY_KEY: Record<SettingsSectionKey, SettingsSection> =
  Object.fromEntries(
    SETTINGS_NAV.flatMap((g) => g.items).map((item) => [item.key, item]),
  ) as Record<SettingsSectionKey, SettingsSection>;

/**
 * Maps the legacy `?tab=X` values from the old single-page settings to
 * the new sub-route. Old links in emails, banners, and onboarding
 * progress (`/dashboard/settings?tab=couriers`) keep working.
 */
export const LEGACY_TAB_TO_KEY: Record<string, SettingsSectionKey> = {
  profile: "workspace",
  workspace: "workspace",
  branding: "branding",
  couriers: "couriers",
  automation: "automation",
  security: "security",
  billing: "billing",
};

export const DEFAULT_SETTINGS_HREF: string = "/dashboard/settings/workspace";
