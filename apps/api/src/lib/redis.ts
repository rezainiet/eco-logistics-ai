import { Redis } from "ioredis";
import { env } from "../env.js";

let client: Redis | null = null;

export function getRedis(): Redis {
  if (client) return client;
  if (!env.REDIS_URL) {
    throw new Error("REDIS_URL not set");
  }
  client = new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 3 });
  client.on("error", (err: Error) => console.error("[redis]", err));
  client.on("connect", () => console.log("[redis] connected"));
  return client;
}

export async function assertRedisOrExit(): Promise<void> {
  if (env.NODE_ENV !== "production") {
    try {
      getRedis();
    } catch {
      console.warn("[redis] unavailable — caching disabled (dev only)");
    }
    return;
  }
  try {
    const c = getRedis();
    await c.ping();
    console.log("[redis] ping ok");
  } catch (err) {
    console.error("[redis] required in production:", err);
    process.exit(1);
  }
}
