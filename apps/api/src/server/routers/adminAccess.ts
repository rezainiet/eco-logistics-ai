import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import {
  DEFAULT_ADMIN_ALERT_PREFS,
  Merchant,
  type AdminAlertPrefs,
} from "@ecom/db";
import {
  adminProcedure,
  invalidateRoleCache,
  merchantObjectId,
  router,
  scopedAdminProcedure,
} from "../trpc.js";
import {
  invalidateAdminProfile,
  loadAdminProfile,
  ADMIN_SCOPES,
  STEPUP_REQUIRED,
  type AdminScope,
  type Permission,
} from "../../lib/admin-rbac.js";
import {
  issueStepupToken,
  verifyAdminPassword,
} from "../../lib/admin-stepup.js";
import { writeAdminAudit } from "../../lib/audit.js";
import { deliverTestAlert } from "../../lib/admin-alerts.js";

const PERMISSION_VALUES = [
  "payment.approve",
  "payment.reject",
  "merchant.suspend",
  "fraud.override",
  "admin.grant_scope",
  "admin.revoke_scope",
] as const;

export const adminAccessRouter = router({
  /**
   * Read the current admin's own profile + scopes. Used by the admin shell
   * to render scope-aware navigation (hide sections the user can't reach).
   * Available to any admin.
   */
  whoami: adminProcedure.query(async ({ ctx }) => {
    const profile = await loadAdminProfile(ctx.user.id);
    return {
      id: ctx.user.id,
      email: ctx.user.email,
      role: profile?.role ?? "merchant",
      scopes: profile?.scopes ?? [],
      stepupRequiredFor: Array.from(STEPUP_REQUIRED),
    };
  }),

  /**
   * Issue a step-up confirmation token. The admin re-enters their password,
   * which we verify against the stored bcrypt hash; on success we mint a
   * single-use token bound to (userId, permission, 5min). The plaintext
   * token is returned to the browser; the handler stores only the SHA-256
   * hash. Subsequent calls to the gated mutation must pass the token.
   *
   * Rate limiting is the existing per-procedure rate-limit chain — this
   * endpoint is a mutation so it inherits CSRF + session checks.
   */
  issueStepup: adminProcedure
    .input(
      z.object({
        permission: z.enum(PERMISSION_VALUES),
        password: z.string().min(1).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ok = await verifyAdminPassword(ctx.user.id, input.password);
      if (!ok) {
        void writeAdminAudit({
          actorId: new Types.ObjectId(ctx.user.id),
          actorEmail: ctx.user.email,
          actorType: "admin",
          action: "admin.stepup_failed",
          subjectType: "admin",
          subjectId: new Types.ObjectId(ctx.user.id),
          meta: { permission: input.permission, reason: "bad_password" },
          ip: ctx.request.ip,
          userAgent: ctx.request.userAgent,
        });
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "password verification failed",
        });
      }
      const { token, expiresAt } = await issueStepupToken(
        ctx.user.id,
        input.permission as Permission,
      );
      void writeAdminAudit({
        actorId: new Types.ObjectId(ctx.user.id),
        actorEmail: ctx.user.email,
        actorType: "admin",
        action: "admin.stepup_issued",
        subjectType: "admin",
        subjectId: new Types.ObjectId(ctx.user.id),
        meta: { permission: input.permission, expiresAt },
        ip: ctx.request.ip,
        userAgent: ctx.request.userAgent,
      });
      return { token, expiresAt };
    }),

  /**
   * Grant or replace admin scopes on a merchant. super_admin only — the
   * caller's scope is checked by `scopedAdminProcedure("admin.grant_scope")`,
   * which has an empty allowlist so only super_admin (the implicit default)
   * passes. Granting also flips the role to "admin" if it wasn't already.
   */
  grantScopes: scopedAdminProcedure("admin.grant_scope")
    .input(
      z.object({
        targetMerchantId: z.string().min(1),
        scopes: z.array(z.enum(ADMIN_SCOPES)).min(0).max(3),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!Types.ObjectId.isValid(input.targetMerchantId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid merchant id" });
      }
      if (input.targetMerchantId === ctx.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "cannot modify your own scopes — ask another super_admin",
        });
      }
      const target = await Merchant.findById(input.targetMerchantId).select(
        "role adminScopes email",
      );
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "merchant not found" });
      }
      const prevScopes = ((target as unknown as { adminScopes?: AdminScope[] })
        .adminScopes ?? []) as AdminScope[];
      const prevRole = target.role;
      const nextScopes = [...new Set(input.scopes)] as AdminScope[];
      const nextRole = nextScopes.length > 0 ? "admin" : "merchant";
      target.role = nextRole;
      (target as unknown as { adminScopes: AdminScope[] }).adminScopes = nextScopes;
      await target.save();
      invalidateAdminProfile(input.targetMerchantId);
      invalidateRoleCache(input.targetMerchantId);

      const action: "admin.scope_granted" | "admin.scope_revoked" =
        nextScopes.length >= prevScopes.length
          ? "admin.scope_granted"
          : "admin.scope_revoked";
      void writeAdminAudit({
        merchantId: target._id,
        actorId: new Types.ObjectId(ctx.user.id),
        actorEmail: ctx.user.email,
        actorScope: ctx.adminScope,
        action,
        subjectType: "merchant",
        subjectId: target._id,
        prevState: { role: prevRole, scopes: prevScopes },
        nextState: { role: nextRole, scopes: nextScopes },
        meta: { targetEmail: target.email },
        ip: ctx.request.ip,
        userAgent: ctx.request.userAgent,
      });
      if ((prevRole === "admin") !== (nextRole === "admin")) {
        void writeAdminAudit({
          merchantId: target._id,
          actorId: new Types.ObjectId(ctx.user.id),
          actorEmail: ctx.user.email,
          actorScope: ctx.adminScope,
          action: nextRole === "admin" ? "admin.role_granted" : "admin.role_revoked",
          subjectType: "merchant",
          subjectId: target._id,
          prevState: { role: prevRole },
          nextState: { role: nextRole },
          meta: { targetEmail: target.email },
          ip: ctx.request.ip,
          userAgent: ctx.request.userAgent,
        });
      }
      return {
        merchantId: String(target._id),
        role: nextRole,
        scopes: nextScopes,
      };
    }),

  /**
   * Read the caller's own alert preferences. Defaults are returned when
   * the merchant doc has no explicit `adminAlertPrefs` set — the UI uses
   * this to render initial toggle states.
   */
  getAlertPrefs: adminProcedure.query(async ({ ctx }) => {
    const merchantId = merchantObjectId(ctx);
    const m = await Merchant.findById(merchantId)
      .select("adminAlertPrefs phone email")
      .lean();
    const stored = (m as { adminAlertPrefs?: AdminAlertPrefs } | null)
      ?.adminAlertPrefs;
    return {
      prefs: stored ?? DEFAULT_ADMIN_ALERT_PREFS,
      defaults: DEFAULT_ADMIN_ALERT_PREFS,
      hasPhone: !!m?.phone,
      hasEmail: !!m?.email,
    };
  }),

  /** Save the caller's alert preferences. */
  setAlertPrefs: adminProcedure
    .input(
      z.object({
        info: z.object({ email: z.boolean(), sms: z.boolean() }),
        warning: z.object({ email: z.boolean(), sms: z.boolean() }),
        critical: z.object({ email: z.boolean(), sms: z.boolean() }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      await Merchant.updateOne(
        { _id: merchantId },
        { $set: { adminAlertPrefs: input } },
      );
      void writeAdminAudit({
        actorId: merchantId,
        actorEmail: ctx.user.email,
        actorType: "admin",
        action: "admin.scope_granted", // reuse a benign action; pure config change
        subjectType: "admin",
        subjectId: merchantId,
        prevState: null,
        nextState: { adminAlertPrefs: input },
        meta: { kind: "alert_prefs_updated" },
        ip: ctx.request.ip,
        userAgent: ctx.request.userAgent,
      });
      return { ok: true, prefs: input };
    }),

  /**
   * Send a synthetic alert through the full delivery pipeline so the
   * caller can verify their configured channels. Goes only to the calling
   * admin, not the whole admin pool — lets each admin self-test without
   * paging the entire on-call team.
   */
  sendTestAlert: adminProcedure
    .input(
      z.object({
        severity: z.enum(["info", "warning", "critical"]).default("warning"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const merchantId = merchantObjectId(ctx);
      const m = await Merchant.findById(merchantId)
        .select("email phone businessName adminAlertPrefs")
        .lean();
      if (!m) {
        throw new TRPCError({ code: "NOT_FOUND", message: "merchant missing" });
      }
      const prefs =
        (m as { adminAlertPrefs?: AdminAlertPrefs }).adminAlertPrefs ??
        DEFAULT_ADMIN_ALERT_PREFS;
      const result = await deliverTestAlert({
        severity: input.severity,
        recipients: [
          {
            id: String(m._id),
            email: m.email,
            phone: m.phone ?? null,
            businessName: m.businessName,
            prefs,
          },
        ],
      });
      return result;
    }),

  /** List all admins + their scopes. super_admin only. */
  listAdmins: scopedAdminProcedure("admin.grant_scope").query(async () => {
    const admins = await Merchant.find({ role: "admin" })
      .select("email businessName adminScopes createdAt")
      .sort({ createdAt: 1 })
      .lean();
    return admins.map((a) => ({
      id: String(a._id),
      email: a.email,
      businessName: a.businessName,
      scopes: ((a as unknown as { adminScopes?: AdminScope[] }).adminScopes ?? []) as AdminScope[],
      createdAt: a.createdAt,
    }));
  }),
});
