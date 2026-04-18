import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });
config();

const schema = z
  .object({
    API_PORT: z.coerce.number().default(4000),
    MONGODB_URI: z.string().url().or(z.string().startsWith("mongodb")),
    REDIS_URL: z.string().optional(),
    JWT_SECRET: z.string().min(16),
    CORS_ORIGIN: z.string().default("http://localhost:3000"),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  })
  .refine((e) => e.NODE_ENV !== "production" || !!e.REDIS_URL, {
    message: "REDIS_URL is required when NODE_ENV=production",
    path: ["REDIS_URL"],
  });

type Env = z.infer<typeof schema>;
let _env: Env | undefined;
export const env: Env = new Proxy({} as Env, {
  get(_t, p) {
    if (!_env) _env = schema.parse(process.env);
    return _env[p as keyof Env];
  },
});
