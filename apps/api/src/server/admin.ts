import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { Merchant, SUBSCRIPTION_TIERS } from "@ecom/db";
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
