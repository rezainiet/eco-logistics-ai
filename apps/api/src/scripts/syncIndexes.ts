import mongoose from "mongoose";
import {
  AuditLog,
  CallLog,
  ImportJob,
  Integration,
  Merchant,
  MerchantStats,
  Notification,
  Order,
  Payment,
  RecoveryTask,
  TrackingEvent,
  TrackingSession,
  Usage,
  WebhookInbox,
} from "@ecom/db";
import { connectDb } from "../lib/db.js";

/**
 * Out-of-band index sync. Runs `Model.syncIndexes()` for every model so
 * production deploys can apply pending index changes without relying on
 * mongoose's autoIndex (disabled in prod — see lib/db.ts).
 *
 * Behavior: builds missing indexes, drops indexes that no longer match the
 * model definition. Safe to re-run; logs per-model output and a summary.
 *
 * Usage:
 *   npm run db:sync-indexes          # against MONGODB_URI in .env
 *   MONGODB_URI=<prod> npm run db:sync-indexes
 */

const MODELS = [
  ["AuditLog", AuditLog],
  ["CallLog", CallLog],
  ["ImportJob", ImportJob],
  ["Integration", Integration],
  ["Merchant", Merchant],
  ["MerchantStats", MerchantStats],
  ["Notification", Notification],
  ["Order", Order],
  ["Payment", Payment],
  ["RecoveryTask", RecoveryTask],
  ["TrackingEvent", TrackingEvent],
  ["TrackingSession", TrackingSession],
  ["Usage", Usage],
  ["WebhookInbox", WebhookInbox],
] as const;

async function main() {
  await connectDb();
  let dropped = 0;
  let added = 0;
  for (const [name, model] of MODELS) {
    try {
      const result = (await (model as { syncIndexes: () => Promise<unknown> }).syncIndexes()) as
        | string[]
        | { dropped: string[]; created: string[] }
        | undefined;
      // Mongoose returns an array of dropped index names in newer versions;
      // older versions return an object. Cope with both.
      let droppedNames: string[] = [];
      let createdNames: string[] = [];
      if (Array.isArray(result)) {
        droppedNames = result;
      } else if (result && typeof result === "object") {
        droppedNames = result.dropped ?? [];
        createdNames = result.created ?? [];
      }
      dropped += droppedNames.length;
      added += createdNames.length;
      console.log(
        `[sync-indexes] ${name}: dropped=${droppedNames.length} created=${createdNames.length}`,
      );
    } catch (err) {
      console.error(`[sync-indexes] ${name} failed:`, (err as Error).message);
      process.exitCode = 1;
    }
  }
  console.log(`[sync-indexes] done. total dropped=${dropped} created=${added}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[sync-indexes] fatal", err);
  process.exit(1);
});
