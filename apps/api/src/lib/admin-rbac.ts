import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { LRUCache } from "lru-cache";
import { Merchant } from "@ecom/db";

/**
 * Admin RBAC. Three scopes layered on top of the existing `role: "admin"`
 * flag. The role flag remains the door to /admin entirely; the scopes gate
 * what an admin can DO once inside.
 *
 *   super_admin     — anything any other admin can do, plus grant/revoke
 *                     scopes on other admins, plus chain-verification of
 *                     the audit log.
 *   finance_admin   — payment approval / rejection, manual subscription
 *                     extension + plan changes.
 *   support_admin   — merchant suspension / unsuspension, fraud-review
 *                     override on flagged orders.
 *
 * The scopes are additive. A super_admin holds all three. The shape is
 * deliberately small — when a fourth scope is needed it lands here, the
 * Merchant.adminScopes enum picks it up via the same string union, and
 * existing admins are backfilled in a one-off migration.
 */
export const ADMIN_SCOPES = [
  "super_admin",
  "finance_admin",
  "support_admin",
] as const;
export type AdminScope = (typeof ADMIN_SCOPES)[number];

export const SCOPE_LABELS: Record<AdminScope, string> = {
  super_admin: "Super admin",
  finance_admin: "Finance admin",
  support_admin: "Support admin",
};

/**
 * Permission keys used by routers. Each maps to the minimum scope set that
 * may exercise the permission. super_admin always passes.
 */
export const PERMISSIONS = {
  "payment.review": ["finance_admin"],
  "payment.approve": ["finance_admin"],
  "payment.reject": ["finance_admin"],
  "subscription.extend": ["finance_admin"],
  "subscription.change_plan": ["finance_admin"],
  "merchant.suspend": ["support_admin"],
  "merchant.unsuspend": ["support_admin"],
  "fraud.override": ["support_admin"],
  "admin.grant_scope": [] as AdminScope[], // super_admin only
  "admin.revoke_scope": [] as AdminScope[], // super_admin only
  "audit.verify_chain": [] as AdminScope[], // super_admin only
  // Centralized SaaS branding edits — super_admin only. The brand reaches
  // every public surface (marketing, auth, dashboard, emails, Stripe
  // receipts, WC webhooks). Limit the blast radius to the highest-trust
  // role until/unless we ship a granular `branding_admin` scope.
  "branding.update": [] as AdminScope[], // super_admin only
  "branding.reset": [] as AdminScope[], // super_admin only
} as const;

export type Permission = keyof typeof PERMISSIONS;

/**
 * Critical actions that require step-up confirmation in addition to scope.
 * Listed here so the frontend can enumerate them and the backend can enforce
 * uniformly.
 */
export const STEPUP_REQUIRED: ReadonlySet<Permission> = new Set<Permission>([
  "payment.approve",
  "payment.reject",
  "merchant.suspend",
  "fraud.override",
  "admin.grant_scope",
  "admin.revoke_scope",
  // Branding edits change every public-facing surface. The friction is
  // worth it.
  "branding.update",
  "branding.reset",
]);

interface AdminProfile {
  role: "merchant" | "admin" | "agent";
  scopes: AdminScope[];
}

const profileCache = new LRUCache<string, AdminProfile>({
  max: 5_000,
  ttl: 30_000, // short TTL — scope demotion must take effect quickly
});

export function invalidateAdminProfile(userId: string): void {
  profileCache.delete(userId);
}

/** Test helper — clears the entire profile cache between specs. */
export function __resetForTests(): void {
  profileCache.clear();
}

export async function loadAdminProfile(
  userId: string,
): Promise<AdminProfile | null> {
  const cached = profileCache.get(userId);
  if (cached) return cached;
  if (!Types.ObjectId.isValid(userId)) return null;
  const m = await Merchant.findById(userId).select("role adminScopes").lean();
  if (!m) return null;
  const profile: AdminProfile = {
    role: (m.role ?? "merchant") as AdminProfile["role"],
    scopes: ((m as { adminScopes?: AdminScope[] }).adminScopes ?? []) as AdminScope[],
  };
  profileCache.set(userId, profile);
  return profile;
}

export function hasScope(scopes: AdminScope[], needed: AdminScope): boolean {
  if (scopes.includes("super_admin")) return true;
  return scopes.includes(needed);
}

export function canPerform(
  scopes: AdminScope[],
  permission: Permission,
): boolean {
  if (scopes.includes("super_admin")) return true;
  const required = PERMISSIONS[permission];
  if (required.length === 0) return false; // super_admin-only perms
  return required.some((s) => scopes.includes(s));
}

/**
 * Throws TRPCError(FORBIDDEN) when the loaded profile lacks the required
 * permission. Returns the resolved scope (the one that authorized the call)
 * so the caller can stamp it into the audit row.
 */
export function assertPermission(
  profile: AdminProfile | null,
  permission: Permission,
): AdminScope {
  if (!profile || profile.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "admin role required",
    });
  }
  if (!canPerform(profile.scopes, permission)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `missing scope for ${permission}`,
    });
  }
  if (profile.scopes.includes("super_admin")) return "super_admin";
  const required = PERMISSIONS[permission] as readonly AdminScope[];
  return (
    profile.scopes.find((s) => required.includes(s)) ??
    profile.scopes[0] ??
    "super_admin"
  );
}
