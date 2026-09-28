import { z } from "zod";
import { LandingPage } from "@ecom/db";
import { dhakaMidnight, resolvePeriod } from "../../lib/finance/period.js";
import { type StoredTrackingDoc, trackingView } from "../../lib/landing/tracking.js";
import { marketingBreakdown, marketingOverview } from "../../lib/marketing/report.js";
import { merchantObjectId, protectedProcedure, router } from "../trpc.js";

/**
 * Merchant marketing reports and tracking overview (read-only). Tenant =
 * the authenticated merchant: merchantId always comes from ctx and every
 * query filters on it. Tracking settings themselves are edited per landing
 * page (landingPages.setTracking).
 */

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    try {
      dhakaMidnight(d);
      return true;
    } catch {
      return false;
    }
  }, "Invalid date");

const period = z.discriminatedUnion("preset", [
  z.object({ preset: z.literal("today") }),
  z.object({ preset: z.literal("month") }),
  z.object({ preset: z.literal("year") }),
  z.object({ preset: z.literal("custom"), from: day, to: day }),
]);
const touch = z.enum(["first", "last"]).default("last");

export const marketingRouter = router({
  overview: protectedProcedure.input(z.object({ period, touch })).query(({ ctx, input }) =>
    marketingOverview(merchantObjectId(ctx), resolvePeriod(input.period), input.touch),
  ),

  breakdown: protectedProcedure
    .input(z.object({ period, touch, dimension: z.enum(["source", "medium", "campaign"]).default("campaign") }))
    .query(({ ctx, input }) => marketingBreakdown(merchantObjectId(ctx), resolvePeriod(input.period), input.touch, input.dimension)),

  /** Which of this merchant's landing pages send to Meta / Google / TikTok. */
  trackingStatus: protectedProcedure.query(async ({ ctx }) => {
    const pages = await LandingPage.find({ merchantId: merchantObjectId(ctx), status: { $ne: "archived" } })
      .select("name slug status tracking updatedAt")
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();
    return pages.map((p) => {
      const t = trackingView(p.tracking as StoredTrackingDoc);
      return {
        id: String(p._id),
        name: p.name,
        slug: p.slug ?? null,
        status: p.status,
        meta: { enabled: t.enabled, id: t.metaPixelId },
        google: { enabled: t.google.enabled, ga4: t.google.ga4MeasurementId, ads: t.google.googleAdsId, purchaseLabel: !!t.google.googleAdsPurchaseLabel },
        tiktok: { enabled: t.tiktok.enabled, id: t.tiktok.pixelId },
      };
    });
  }),
});
