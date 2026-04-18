import { createHash } from "node:crypto";
import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import jwt from "jsonwebtoken";
import { LRUCache } from "lru-cache";
import { env } from "../env.js";

export interface AuthUser {
  id: string;
  email: string;
  role: "merchant" | "admin" | "agent";
}

const tokenCache = new LRUCache<string, AuthUser>({ max: 10_000, ttl: 60_000 });

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("base64url").slice(0, 22);
}

export function createContext({ req }: CreateExpressContextOptions) {
  const auth = req.headers.authorization;
  let user: AuthUser | null = null;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    const key = fingerprint(token);
    const hit = tokenCache.get(key);
    if (hit) {
      user = hit;
    } else {
      try {
        user = jwt.verify(token, env.JWT_SECRET, {
          algorithms: ["HS256"],
          clockTolerance: 5,
        }) as AuthUser;
        tokenCache.set(key, user);
      } catch {
        user = null;
      }
    }
  }
  return { user };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { user: ctx.user } });
});
