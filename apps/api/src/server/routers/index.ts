import { publicProcedure, protectedProcedure, router } from "../trpc.js";
import { merchantsRouter } from "./merchants.js";
import { ordersRouter } from "./orders.js";
import { analyticsRouter } from "./analytics.js";
import { callCenterRouter } from "./callCenter.js";
import { callRouter } from "./call.js";
import { fraudRouter } from "./fraud.js";
import { billingRouter } from "./billing.js";
import { adminBillingRouter } from "./adminBilling.js";
import { notificationsRouter } from "./notifications.js";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, ts: Date.now() })),
  me: protectedProcedure.query(({ ctx }) => ctx.user),
  merchants: merchantsRouter,
  orders: ordersRouter,
  analytics: analyticsRouter,
  callCenter: callCenterRouter,
  call: callRouter,
  fraud: fraudRouter,
  billing: billingRouter,
  adminBilling: adminBillingRouter,
  notifications: notificationsRouter,
});

export type AppRouter = typeof appRouter;
