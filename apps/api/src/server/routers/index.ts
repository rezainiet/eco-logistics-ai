import { publicProcedure, protectedProcedure, router } from "../trpc.js";
import { merchantsRouter } from "./merchants.js";
import { ordersRouter } from "./orders.js";
import { analyticsRouter } from "./analytics.js";
import { callCenterRouter } from "./callCenter.js";
import { callRouter } from "./call.js";
import { callingFoundationRouter } from "./callingFoundation.js";
import { fraudRouter } from "./fraud.js";
import { billingRouter } from "./billing.js";
import { adminBillingRouter } from "./adminBilling.js";
import { adminFraudNetworkRouter } from "./adminFraudNetwork.js";
import { adminAccessRouter } from "./adminAccess.js";
import { adminObservabilityRouter } from "./adminObservability.js";
import { adminAuditRouter } from "./adminAudit.js";
import { notificationsRouter } from "./notifications.js";
import { integrationsRouter } from "./integrations.js";
import { trackingRouter } from "./tracking.js";
import { recoveryRouter } from "./recovery.js";
import { feedbackRouter } from "./feedback.js";
import { landingPagesRouter, publicLandingRouter } from "./landingPages.js";
import { productsRouter } from "./products.js";
import { adminLandingTemplatesRouter } from "./adminLandingTemplates.js";
import {
  adminBrandingRouter,
  publicBrandingRouter,
} from "./adminBranding.js";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, ts: Date.now() })),
  me: protectedProcedure.query(({ ctx }) => ctx.user),
  merchants: merchantsRouter,
  orders: ordersRouter,
  analytics: analyticsRouter,
  callCenter: callCenterRouter,
  call: callRouter,
  callingFoundation: callingFoundationRouter,
  fraud: fraudRouter,
  billing: billingRouter,
  adminBilling: adminBillingRouter,
  adminFraudNetwork: adminFraudNetworkRouter,
  adminAccess: adminAccessRouter,
  adminObservability: adminObservabilityRouter,
  adminAudit: adminAuditRouter,
  notifications: notificationsRouter,
  integrations: integrationsRouter,
  tracking: trackingRouter,
  recovery: recoveryRouter,
  feedback: feedbackRouter,
  // Centralized SaaS branding. `branding` is public (SSR reads it from
  // every layout); `adminBranding` is super_admin only.
  branding: publicBrandingRouter,
  adminBranding: adminBrandingRouter,
  // Landing pages: merchant CRUD/draft/publish, super_admin template
  // management, and the unauthenticated host resolver used by apps/sites.
  landingPages: landingPagesRouter,
  products: productsRouter,
  adminLandingTemplates: adminLandingTemplatesRouter,
  publicLanding: publicLandingRouter,
});

export type AppRouter = typeof appRouter;
