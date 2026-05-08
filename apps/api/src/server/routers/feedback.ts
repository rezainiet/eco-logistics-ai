import { z } from "zod";
import {
  FEEDBACK_KINDS,
  FEEDBACK_SEVERITIES,
  MerchantFeedback,
} from "@ecom/db";
import { merchantObjectId, protectedProcedure, router } from "../trpc.js";

/**
 * Lightweight merchant-feedback router — design-partner phase only.
 *
 * One mutation: `submit`. Anything beyond submit (list, triage, resolve)
 * is admin-side and lives in `adminObservability` so the surface visible
 * to a merchant stays minimal.
 *
 * Rate-limit posture: protectedProcedure inherits the per-merchant token
 * bucket where applicable, but a feedback submit is not on a hot path —
 * a runaway script would hit ~tens of req/min and hit the natural noise
 * floor without a dedicated limiter. Re-evaluate if abuse becomes real.
 */

export const feedbackRouter = router({
  /**
   * Submit one piece of merchant feedback. Persists to MerchantFeedback
   * and emits a structured log line for the ops feed.
   *
   * The structured log INTENTIONALLY excludes the `message` body —
   * messages may contain contact info, complaints with names, or other
   * sensitive context. The DB row is the canonical store; the log is
   * just a "feedback arrived for merchant X" trigger for ops paging.
   */
  submit: protectedProcedure
    .input(
      z.object({
        kind: z.enum(FEEDBACK_KINDS),
        severity: z.enum(FEEDBACK_SEVERITIES).default("info"),
        message: z.string().trim().min(1).max(2000),
        pagePath: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const doc = await MerchantFeedback.create({
        merchantId,
        actorEmail: ctx.user.email,
        kind: input.kind,
        severity: input.severity,
        message: input.message,
        pagePath: input.pagePath,
        userAgent: ctx.request.userAgent ?? undefined,
        status: "new",
      });

      // Single-line structured log — no message body to keep PII off the
      // ops feed. Aggregating these gives you "kind distribution by
      // merchant" + "first-feedback latency from signup" without ever
      // touching the message text.
      console.log(
        JSON.stringify({
          evt: "feedback.submitted",
          feedbackId: String(doc._id),
          merchantId: String(merchantId),
          kind: input.kind,
          severity: input.severity,
          pagePath: input.pagePath ?? null,
          messageLength: input.message.length,
        }),
      );

      return { ok: true as const, id: String(doc._id) };
    }),
});
