import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import {
  AuditLog,
  CallLog,
  ImportJob,
  Integration,
  Merchant,
  MerchantStats,
  Notification,
  Order,
  Payment,
  RecoveryTask,
  SUBSCRIPTION_TIERS,
  TrackingEvent,
  TrackingSession,
  Usage,
  WebhookInbox,
} from "@ecom/db";
import { env } from "../env.js";
import { invalidateSubscriptionCache } from "./trpc.js";

export const adminRouter: Router = Router();

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function requireAdminSecret(req: Request, res: Response, next: NextFunction) {
  if (!env.ADMIN_SECRET) {
    return res.status(503).json({ error: "admin disabled" });
  }
  const header = req.headers["x-admin-secret"];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided || !safeEqual(provided, env.ADMIN_SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return next();
}

const activateSchema = z.object({
  merchantId: z.string().refine((v) => Types.ObjectId.isValid(v), "invalid merchantId"),
  tier: z.enum(SUBSCRIPTION_TIERS).optional(),
  rate: z.number().int().min(0).max(1_000_000).optional(),
  extendDays: z.number().int().min(1).max(365).optional(),
  notes: z.string().max(500).optional(),
  actor: z.string().min(1).max(120),
});

adminRouter.post("/activate", requireAdminSecret, async (req: Request, res: Response) => {
  const parsed = activateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { merchantId, tier, rate, extendDays, notes, actor } = parsed.data;

  const merchant = await Merchant.findById(merchantId);
  if (!merchant) return res.status(404).json({ error: "merchant not found" });

  const now = new Date();
  merchant.subscription = merchant.subscription ?? ({} as typeof merchant.subscription);
  merchant.subscription.status = "active";
  merchant.subscription.activatedAt = now;
  merchant.subscription.activatedBy = actor;
  if (tier) merchant.subscription.tier = tier;
  if (typeof rate === "number") merchant.subscription.rate = rate;
  if (notes) merchant.subscription.notes = notes;
  if (extendDays) {
    const base =
      merchant.subscription.trialEndsAt && merchant.subscription.trialEndsAt > now
        ? merchant.subscription.trialEndsAt
        : now;
    merchant.subscription.trialEndsAt = new Date(
      base.getTime() + extendDays * 24 * 60 * 60 * 1000,
    );
  }

  await merchant.save();
  invalidateSubscriptionCache(String(merchant._id));

  console.log(
    `[admin] activate merchant=${merchantId} tier=${merchant.subscription.tier} ` +
      `rate=${merchant.subscription.rate} actor=${actor}`,
  );

  return res.json({
    id: String(merchant._id),
    email: merchant.email,
    subscription: merchant.subscription,
  });
});

const extendSchema = z.object({
  merchantId: z.string().refine((v) => Types.ObjectId.isValid(v), "invalid merchantId"),
  days: z.number().int().min(1).max(365),
  actor: z.string().min(1).max(120),
});

adminRouter.post("/extend-trial", requireAdminSecret, async (req: Request, res: Response) => {
  const parsed = extendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { merchantId, days, actor } = parsed.data;

  const merchant = await Merchant.findById(merchantId);
  if (!merchant) return res.status(404).json({ error: "merchant not found" });

  const now = new Date();
  merchant.subscription = merchant.subscription ?? ({} as typeof merchant.subscription);
  const base =
    merchant.subscription.trialEndsAt && merchant.subscription.trialEndsAt > now
      ? merchant.subscription.trialEndsAt
      : now;
  merchant.subscription.trialEndsAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  if (merchant.subscription.status === "past_due" || merchant.subscription.status === "cancelled") {
    merchant.subscription.status = "trial";
  }
  merchant.subscription.activatedBy = actor;

  await merchant.save();
  invalidateSubscriptionCache(String(merchant._id));

  return res.json({
    id: String(merchant._id),
    trialEndsAt: merchant.subscription.trialEndsAt,
    status: merchant.subscription.status,
  });
});

adminRouter.get("/merchant/:id", requireAdminSecret, async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id || !Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "invalid id" });
  }
  const m = await Merchant.findById(id)
    .select("email businessName country subscription createdAt")
    .lean();
  if (!m) return res.status(404).json({ error: "not found" });
  return res.json(m);
});

/**
 * Build/repair indexes on Atlas. autoIndex is intentionally OFF in
 * production (set in lib/db.ts) so deploys don't stall behind a slow
 * index build. There IS a `npm run db:sync-indexes` script, but on
 * Railway free tier we don't have an easy "run one-off command" path —
 * this endpoint is the equivalent over X-Admin-Secret. Idempotent: re-
 * running creates nothing if everything is already in place. Returns a
 * per-model summary of what was built / dropped.
 *
 * Background: a missing partial-unique index on
 * (merchantId, source.externalId) caused webhook order.created +
 * order.updated races to land twice. The ingest path was hardened to
 * catch E11000 — but it can only catch E11000 when the index is
 * actually present, so we need a way to build it without redeploying.
 */
adminRouter.post("/sync-indexes", requireAdminSecret, async (_req: Request, res: Response) => {
  const MODELS: Array<readonly [string, { syncIndexes: () => Promise<unknown> }]> = [
    ["AuditLog", AuditLog as unknown as { syncIndexes: () => Promise<unknown> }],
    ["CallLog", CallLog as unknown as { syncIndexes: () => Promise<unknown> }],
    ["ImportJob", ImportJob as unknown as { syncIndexes: () => Promise<unknown> }],
    ["Integration", Integration as unknown as { syncIndexes: () => Promise<unknown> }],
    ["Merchant", Merchant as unknown as { syncIndexes: () => Promise<unknown> }],
    ["MerchantStats", MerchantStats as unknown as { syncIndexes: () => Promise<unknown> }],
    ["Notification", Notification as unknown as { syncIndexes: () => Promise<unknown> }],
    ["Order", Order as unknown as { syncIndexes: () => Promise<unknown> }],
    ["Payment", Payment as unknown as { syncIndexes: () => Promise<unknown> }],
    ["RecoveryTask", RecoveryTask as unknown as { syncIndexes: () => Promise<unknown> }],
    ["TrackingEvent", TrackingEvent as unknown as { syncIndexes: () => Promise<unknown> }],
    ["TrackingSession", TrackingSession as unknown as { syncIndexes: () => Promise<unknown> }],
    ["Usage", Usage as unknown as { syncIndexes: () => Promise<unknown> }],
    ["WebhookInbox", WebhookInbox as unknown as { syncIndexes: () => Promise<unknown> }],
  ];
  const summary: Record<string, { created?: string[]; dropped?: string[]; error?: string }> = {};
  let created = 0;
  let dropped = 0;
  for (const [name, model] of MODELS) {
    try {
      const result = (await model.syncIndexes()) as
        | string[]
        | { created?: string[]; dropped?: string[] }
        | undefined;
      let droppedNames: string[] = [];
      let createdNames: string[] = [];
      if (Array.isArray(result)) {
        droppedNames = result;
      } else if (result && typeof result === "object") {
        droppedNames = result.dropped ?? [];
        createdNames = result.created ?? [];
      }
      created += createdNames.length;
      dropped += droppedNames.length;
      summary[name] = { created: createdNames, dropped: droppedNames };
      console.log(
        `[admin/sync-indexes] ${name}: created=${createdNames.length} dropped=${droppedNames.length}`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      summary[name] = { error: msg };
      console.error(`[admin/sync-indexes] ${name} failed:`, msg);
    }
  }
  return res.json({ ok: true, created, dropped, models: summary });
});

/**
 * Reset a merchant's password to a known value. X-Admin-Secret guarded.
 * Used to recover login when the operator has lost the original credentials,
 * or to bootstrap a clean test merchant. Mirrors the bcrypt(10) hash that
 * `auth.ts` uses on signup + password change so the login flow can validate
 * it the same way.
 *
 * Body: { email, newPassword, actor }
 *   - email: target merchant's email
 *   - newPassword: must be >= 8 chars
 *   - actor: free-text who-did-it tag (audit log)
 */
const resetPasswordSchema = z.object({
  email: z.string().email(),
  newPassword: z.string().min(8).max(200),
  actor: z.string().min(1).max(120),
});

adminRouter.post(
  "/reset-merchant-password",
  requireAdminSecret,
  async (req: Request, res: Response) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { email, newPassword, actor } = parsed.data;

    const { default: bcrypt } = await import("bcryptjs");
    const merchant = await Merchant.findOne({ email: email.toLowerCase() });
    if (!merchant) {
      return res.status(404).json({ error: "merchant not found" });
    }
    merchant.passwordHash = await bcrypt.hash(newPassword, 10);
    await merchant.save();

    console.log(
      `[admin] reset-merchant-password merchant=${merchant._id} email=${email} actor=${actor}`,
    );
    return res.json({ ok: true, id: String(merchant._id), email: merchant.email });
  },
);

/**
 * Dedupe Order docs by (merchantId, source.externalId). Keeps the OLDEST
 * (lowest createdAt) and deletes the rest. After cleanup, calls
 * Order.syncIndexes() so the partial-unique on
 * (merchantId, source.externalId) and the unique on
 * (merchantId, orderNumber) get rebuilt cleanly. X-Admin-Secret guarded.
 *
 * Background: rapid-fire webhook races (order.created + order.updated for
 * the same external order) can land two Order docs on a fresh DB where
 * autoIndex is OFF (lib/db.ts). Once dups exist, syncIndexes refuses to
 * build the unique index because the existing data violates it. This
 * endpoint breaks that deadlock idempotently: dedupe → rebuild indexes.
 *
 * Returns a summary {dupGroupsFound, docsDeleted, syncIndexesResult}.
 */
adminRouter.post("/dedupe-orders", requireAdminSecret, async (_req: Request, res: Response) => {
  // Find duplicate (merchantId, source.externalId) groups. Skip docs
  // missing source.externalId — those can't race-collide.
  const dupGroups = await Order.aggregate<{
    _id: { merchantId: unknown; externalId: string };
    ids: Array<unknown>;
    count: number;
  }>([
    { $match: { "source.externalId": { $exists: true, $ne: null } } },
    {
      $group: {
        _id: { merchantId: "$merchantId", externalId: "$source.externalId" },
        ids: { $push: { id: "$_id", createdAt: "$createdAt" } },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  let docsDeleted = 0;
  for (const group of dupGroups) {
    const sorted = (group.ids as Array<{ id: unknown; createdAt: Date }>).sort(
      (a, b) =>
        (a.createdAt instanceof Date ? a.createdAt.getTime() : 0) -
        (b.createdAt instanceof Date ? b.createdAt.getTime() : 0),
    );
    // keep the oldest, delete the rest
    const toDelete = sorted.slice(1).map((r) => r.id);
    if (toDelete.length === 0) continue;
    const result = await Order.deleteMany({ _id: { $in: toDelete } });
    docsDeleted += result.deletedCount ?? 0;
    console.log(
      `[admin/dedupe-orders] kept ${String(sorted[0]?.id)} deleted ${toDelete.length} extras for externalId=${
        group._id.externalId
      }`,
    );
  }

  // Now rebuild Order indexes — the previous syncIndexes attempt failed
  // because of these dups; with them gone, the unique on
  // (merchantId, orderNumber) and the partial-unique on
  // (merchantId, source.externalId) should both build cleanly.
  let syncIndexesResult: unknown = null;
  let syncIndexesError: string | null = null;
  try {
    syncIndexesResult = await (
      Order as unknown as { syncIndexes: () => Promise<unknown> }
    ).syncIndexes();
  } catch (err) {
    syncIndexesError = (err as Error).message;
    console.error("[admin/dedupe-orders] syncIndexes failed:", syncIndexesError);
  }

  return res.json({
    ok: true,
    dupGroupsFound: dupGroups.length,
    docsDeleted,
    syncIndexes: syncIndexesError ? { error: syncIndexesError } : syncIndexesResult,
  });
});

