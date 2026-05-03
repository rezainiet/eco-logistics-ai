import "dotenv/config";
import mongoose from "mongoose";
import { Merchant } from "@ecom/db";
import { connectDb } from "../lib/db.js";

/**
 * Bootstrap / manage admin role on an existing merchant account.
 *
 * Why this exists: the runtime `adminAccess.grantScopes` tRPC mutation
 * requires `admin.grant_scope` permission, which only `super_admin`
 * holds. So the very first super_admin can never be created from
 * inside the running app — chicken-and-egg. This CLI is the only
 * sanctioned way to bootstrap that first super_admin (or to demote a
 * runaway one back to a merchant).
 *
 * Usage:
 *   npm --workspace @ecom/api run admin:promote -- <email> [scope...]
 *
 * Examples:
 *   # Make me a super_admin (full power including granting other admins)
 *   npm --workspace @ecom/api run admin:promote -- masudrezaog@gmail.com super_admin
 *
 *   # Mint a finance + support admin (typical ops user)
 *   npm --workspace @ecom/api run admin:promote -- ops@example.com finance_admin support_admin
 *
 *   # Demote back to plain merchant (omit scopes)
 *   npm --workspace @ecom/api run admin:demote -- ops@example.com
 *
 * The script is intentionally NOT exposed via HTTP — the only thing
 * gating it is local DB access, which already implies you control the
 * box. Audit log? We don't write one because there's no actor user
 * yet to attribute the change to; the operator running the CLI is
 * inherently trusted (they own the database).
 */

const VALID_SCOPES = ["super_admin", "finance_admin", "support_admin"] as const;
type Scope = (typeof VALID_SCOPES)[number];

function isScope(s: string): s is Scope {
  return (VALID_SCOPES as readonly string[]).includes(s);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: promoteAdmin <email> [scope...]");
    console.error(`Valid scopes: ${VALID_SCOPES.join(", ")}`);
    console.error("Pass no scopes to demote to plain merchant.");
    process.exit(2);
  }
  const [emailRaw, ...scopeArgs] = args;
  const email = emailRaw!.toLowerCase().trim();

  // Validate scopes BEFORE touching the DB so a typo doesn't half-apply.
  const invalid = scopeArgs.filter((s) => !isScope(s));
  if (invalid.length > 0) {
    console.error(`[promoteAdmin] unknown scope(s): ${invalid.join(", ")}`);
    console.error(`Valid scopes: ${VALID_SCOPES.join(", ")}`);
    process.exit(2);
  }
  const scopes = scopeArgs as Scope[];
  const isPromotion = scopes.length > 0;

  await connectDb();

  const merchant = await Merchant.findOne({ email });
  if (!merchant) {
    console.error(`[promoteAdmin] no merchant found with email "${email}"`);
    console.error(
      `Tip: run \`npm --workspace @ecom/api run list-merchants\` to see what exists.`,
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const before = {
    role: merchant.role,
    adminScopes: [...(merchant.adminScopes ?? [])],
  };

  if (isPromotion) {
    merchant.role = "admin";
    merchant.adminScopes = scopes;
  } else {
    merchant.role = "merchant";
    merchant.adminScopes = [];
  }
  await merchant.save();

  console.log(
    `[promoteAdmin] ${email}: role ${before.role} → ${merchant.role}, ` +
      `scopes [${before.adminScopes.join(", ")}] → [${(merchant.adminScopes ?? []).join(", ")}]`,
  );
  if (isPromotion) {
    console.log(
      `[promoteAdmin] sign in at /login then visit /admin — the admin shell ` +
        `should now be reachable.`,
    );
    console.log(
      `[promoteAdmin] NOTE: any existing session for this user must sign out + ` +
        `back in (or wait for the silent token refresh to fire) before the ` +
        `new role takes effect — the role lives in the JWT.`,
    );
  } else {
    console.log(
      `[promoteAdmin] WARNING: this user's existing session may still resolve ` +
        `as admin until the JWT expires (typically up to 1h). Force a sign-out ` +
        `to drop them immediately.`,
    );
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("[promoteAdmin] fatal:", err);
  try {
    await mongoose.disconnect();
  } catch {
    /* already disconnected */
  }
  process.exit(1);
});
