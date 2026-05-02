import "dotenv/config";
import mongoose from "mongoose";
import { Merchant } from "@ecom/db";
import { connectDb } from "../lib/db.js";

await connectDb();
const rows = await Merchant.find({})
  .select("email subscription.tier subscription.status")
  .lean();
for (const r of rows as Array<{ email: string; subscription?: { tier?: string; status?: string } }>) {
  console.log(`${r.email}\t→ tier=${r.subscription?.tier} status=${r.subscription?.status}`);
}
console.log(`\n[total] ${rows.length} merchants`);
await mongoose.disconnect();
