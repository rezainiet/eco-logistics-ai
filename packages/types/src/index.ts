import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "./router.js";

export type { AppRouter } from "./router.js";

/** All-router output map — handy on the web client for type-safe selectors. */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export type UserRole = "merchant" | "admin" | "agent";

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
  role: UserRole;
}

export * from "./plans";
