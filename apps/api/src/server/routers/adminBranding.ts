import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import {
  brandingPatchSchema,
  DEFAULT_BRANDING,
  listOverriddenFields,
  parseEnvOverrides,
  type BrandingConfig,
  type BrandingPatch,
} from "@ecom/branding";
import { BrandingConfig as BrandingConfigModel } from "@ecom/db";
import { publicProcedure, router, scopedAdminProcedure } from "../trpc.js";
import { writeAdminAudit } from "../../lib/audit.js";
import {
  invalidateBrandingStore,
  loadBrandingFromStore,
} from "../../lib/branding-store.js";

/**
 * Admin Branding Panel — tRPC router. All procedures gated by super_admin.
 * `branding.update` and `branding.reset` require step-up confirmation.
 */

function diffFields(
  before: BrandingConfig,
  after: BrandingConfig,
  prefix = "",
): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (k === "version" || k === "updatedAt" || k === "key") continue;
    const path = prefix ? `${prefix}.${k}` : k;
    const a = (before as unknown as Record<string, unknown>)[k];
    const b = (after as unknown as Record<string, unknown>)[k];
    if (
      a && b &&
      typeof a === "object" && typeof b === "object" &&
      !Array.isArray(a) && !Array.isArray(b)
    ) {
      out.push(...diffFields(a as BrandingConfig, b as BrandingConfig, path));
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push(path);
    }
  }
  return out;
}

export const adminBrandingRouter = router({
  get: scopedAdminProcedure("branding.update").query(async () => {
    const branding = await loadBrandingFromStore();
    const envOverrides = parseEnvOverrides(process.env.BRANDING_OVERRIDES);
    return {
      branding,
      defaults: DEFAULT_BRANDING,
      envOverriddenFields: listOverriddenFields(envOverrides),
    };
  }),

  update: scopedAdminProcedure("branding.update")
    .input(
      z.object({
        patch: brandingPatchSchema,
        expectedVersion: z.number().int().nonnegative(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const before = await loadBrandingFromStore();
      const existing = await BrandingConfigModel.findOne({ key: "saas" })
        .select("version")
        .lean();
      const onDiskVersion = existing?.version ?? 0;
      if (onDiskVersion !== input.expectedVersion) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `branding was edited by another admin (expected v${input.expectedVersion}, on disk v${onDiskVersion}). Refresh and try again.`,
        });
      }

      const patch: BrandingPatch = input.patch;
      const updateDoc: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        updateDoc[k] = v;
      }
      updateDoc["version"] = onDiskVersion + 1;
      updateDoc["updatedBy"] = new Types.ObjectId(ctx.user.id);

      await BrandingConfigModel.findOneAndUpdate(
        { key: "saas" },
        { $set: updateDoc, $setOnInsert: { key: "saas" } },
        { upsert: true, new: true },
      );

      invalidateBrandingStore("saas");
      const after = await loadBrandingFromStore();
      const changedFields = diffFields(before, after);

      await writeAdminAudit({
        actorId: new Types.ObjectId(ctx.user.id),
        actorEmail: ctx.user.email,
        actorType: "admin",
        action: "branding.updated",
        subjectType: "system",
        subjectId: new Types.ObjectId(ctx.user.id),
        meta: {
          adminScope: ctx.adminScope,
          previousVersion: onDiskVersion,
          nextVersion: onDiskVersion + 1,
          changedFields,
        },
        ip: ctx.request.ip,
        userAgent: ctx.request.userAgent,
      });

      return {
        branding: after,
        version: onDiskVersion + 1,
        changedFields,
      };
    }),

  reset: scopedAdminProcedure("branding.reset").mutation(async ({ ctx }) => {
    const before = await loadBrandingFromStore();
    await BrandingConfigModel.deleteOne({ key: "saas" });
    invalidateBrandingStore("saas");
    const after = await loadBrandingFromStore();
    const changedFields = diffFields(before, after);

    await writeAdminAudit({
      actorId: new Types.ObjectId(ctx.user.id),
      actorEmail: ctx.user.email,
      actorType: "admin",
      action: "branding.reset",
      subjectType: "system",
      subjectId: new Types.ObjectId(ctx.user.id),
      meta: {
        adminScope: ctx.adminScope,
        previousVersion: before.version,
        nextVersion: 0,
        changedFields,
      },
      ip: ctx.request.ip,
      userAgent: ctx.request.userAgent,
    });

    return { branding: after, version: 0 };
  }),
});

/**
 * Public, unauthenticated read of the resolved SaaS branding. Used by
 * apps/web SSR so every layout can paint the right wordmark + tokens
 * on the first frame. Branding is public-facing identity — the values
 * appear on the marketing landing for any visitor — so publicProcedure
 * is the right gate.
 */
export const publicBrandingRouter = router({
  current: publicProcedure.query(async () => {
    return loadBrandingFromStore();
  }),
});
