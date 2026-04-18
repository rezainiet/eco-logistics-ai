import mongoose from "mongoose";
import { env } from "../env.js";

let connected = false;

export async function connectDb(): Promise<typeof mongoose> {
  if (connected) return mongoose;
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.MONGODB_URI);
  connected = true;
  console.log("[db] connected to MongoDB");
  return mongoose;
}
