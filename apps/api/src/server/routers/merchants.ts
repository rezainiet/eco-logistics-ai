import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { Merchant, MERCHANT_COUNTRIES, MERCHANT_LANGUAGES } from "@ecom/db";
import { protectedProcedure, router } from "../trpc.js";

const PHONE_RE = /^\+?[0-9]{7,15}$/;

async function findMerchantOrThrow(id: string) {
  const merchant = await Merchant.findById(id);
  if (!merchant) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
  return merchant;
}

export const merchantsRouter = router({
  getProfile: protectedProcedure.query(async ({ ctx }) => {
    const m = await findMerchantOrThrow(ctx.user.id);
    return {
      id: String(m._id),
      email: m.email,
      businessName: m.businessName,
      phone: m.phone,
      country: m.country,
      language: m.language,
      subscription: m.subscription,
      createdAt: m.createdAt,
    };
  }),

  updateProfile: protectedProcedure
    .input(
      z
        .object({
          businessName: z.string().min(1).optional(),
          phone: z.string().regex(PHONE_RE).optional(),
          country: z.enum(MERCHANT_COUNTRIES).optional(),
          language: z.enum(MERCHANT_LANGUAGES).optional(),
        })
        .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" })
    )
    .mutation(async ({ ctx, input }) => {
      const m = await Merchant.findByIdAndUpdate(
        ctx.user.id,
        { $set: input },
        { new: true, runValidators: true }
      );
      if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
      return {
        id: String(m._id),
        businessName: m.businessName,
        phone: m.phone,
        country: m.country,
        language: m.language,
      };
    }),

  getCouriers: protectedProcedure.query(async ({ ctx }) => {
    const m = await findMerchantOrThrow(ctx.user.id);
    return m.couriers.map((c) => ({
      name: c.name,
      accountId: c.accountId,
      preferredDistricts: c.preferredDistricts,
    }));
  }),
});
