import mongoose from "mongoose";
import { env } from "../env.js";

let connected = false;

export async function connectDb(): Promise<typeof mongoose> {
  if (connected) return mongoose;
  mongoose.set("strictQuery", true);
  // In production we never let mongoose auto-build indexes on boot — index
  // builds can lock writes on hot collections. Run `npm run db:sync-indexes`
  // out-of-band as part of the deploy. Dev/test still gets autoIndex so a
  // fresh local DB lights up without a manual step.
  if (env.NODE_ENV === "production") {
    mongoose.set("autoIndex", false);
    mongoose.set("autoCreate", false);
  }
  await mongoose.connect(env.MONGODB_URI);
  connected = true;
  console.log(
    `[db] connected to MongoDB (autoIndex=${env.NODE_ENV !== "production"})`,
  );
  return mongoose;
}
