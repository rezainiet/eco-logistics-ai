import { publicProcedure, protectedProcedure, router } from "../trpc.js";
import { merchantsRouter } from "./merchants.js";
import { ordersRouter } from "./orders.js";
import { analyticsRouter } from "./analytics.js";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, ts: Date.now() })),
  me: protectedProcedure.query(({ ctx }) => ctx.user),
  merchants: merchantsRouter,
  orders: ordersRouter,
  analytics: analyticsRouter,
});

export type AppRouter = typeof appRouter;
