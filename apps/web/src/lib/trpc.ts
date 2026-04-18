import { createTRPCReact, type CreateTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@ecom/types";

export const trpc: CreateTRPCReact<AppRouter, unknown, "ExperimentalSuspense"> =
  createTRPCReact<AppRouter>();
