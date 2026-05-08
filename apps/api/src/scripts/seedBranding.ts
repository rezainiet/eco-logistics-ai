/**
 * Idempotent boot-time seed for the SaaS BrandingConfig singleton.
 *
 * Behavior:
 *   - If `branding_configs` has a row with `key:"saas"` already, do nothing.
 *   - Otherwise insert an empty `{key:"saas", version: 0}` row. The
 *     resolver will fill in defaults from `@ecom/branding/defaults`; the
 *     row exists so the admin panel has something to update without
 *     racing the first writer.
 *
 * Called once at boot from `src/index.ts` after `connectDb()`. Safe to
 * re-run; safe to omit (the resolver handles a missing row).
 */
import { BrandingConfig } from "@ecom/db";

export async function seedBranding(key = "saas"): Promise<{ created: boolean }> {
  const existing = await BrandingConfig.findOne({ key }).select("_id").lean();
  if (existing) return { created: false };
  await BrandingConfig.create({ key, version: 0 });
  console.log(`[seed] branding singleton inserted for key=${key}`);
  return { created: true };
}

// Allow running directly for one-off seeding: `tsx src/scripts/seedBranding.ts`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { connectDb, disconnectDb } = await import("../lib/db.js");
  await connectDb();
  try {
    const r = await seedBranding();
    console.log(JSON.stringify(r));
  } finally {
    await disconnectDb();
  }
}
