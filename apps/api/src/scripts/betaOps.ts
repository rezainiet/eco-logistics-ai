import mongoose from "mongoose";
import { Order, PendingJob, WebhookInbox } from "@ecom/db";
import { connectDb } from "../lib/db.js";
import { getQueue, QUEUE_NAMES } from "../lib/queue.js";

/**
 * Founder beta-ops triage.
 *
 * One read-only sweep that answers "is anything quietly on fire?" for a
 * 10-20 merchant private beta — without SSHing into Railway and grepping
 * logs. It surfaces the four things that actually hurt COD merchants
 * when they go unnoticed:
 *
 *   1. Dead-lettered jobs   — work BullMQ gave up on (lost unless replayed).
 *   2. Replay backlog       — the Redis-outage recovery rail growing.
 *   3. Failed webhooks      — orders that never made it in / never updated.
 *   4. Stuck orders         — sitting in confirmation/review past an SLA.
 *   5. Queue depth          — per-queue backlog + BullMQ failed counts.
 *
 * Read-only by design: it never retries or mutates. Retrying is a
 * deliberate, separately-run action (pendingJobReplay worker handles
 * automatic replay; manual replay is documented in the beta runbook) —
 * a triage tool that also mutates is exactly the kind of foot-gun a
 * tired founder hits at 2am.
 *
 * Usage:
 *   npm --workspace apps/api run ops:triage
 *   npm --workspace apps/api run ops:triage -- --stuck-hours=12
 *   npm --workspace apps/api run ops:triage -- --json
 *
 * Exit code is always 0 unless Mongo is unreachable — this is an
 * informational view, not a gate. Pipe `--json` into alerting if you
 * want thresholds.
 */

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const stuckHoursArg = argv.find((a) => a.startsWith("--stuck-hours="));
const STUCK_HOURS = stuckHoursArg
  ? Math.max(1, Number(stuckHoursArg.split("=")[1]) || 24)
  : 24;
const RECENT_LIMIT = 10;

function ageHuman(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

type Report = Record<string, unknown>;
const report: Report = {};
const lines: string[] = [];
function out(s = ""): void {
  lines.push(s);
}

async function main(): Promise<void> {
  await connectDb();

  // 1. Dead-lettered (exhausted) pending jobs — lost work.
  const exhausted = await PendingJob.find({ status: "exhausted" })
    .sort({ updatedAt: -1 })
    .limit(RECENT_LIMIT)
    .lean<
      Array<{
        queueName?: string;
        attempts?: number;
        lastError?: string;
        updatedAt?: Date;
      }>
    >();
  const exhaustedTotal = await PendingJob.countDocuments({
    status: "exhausted",
  });
  const pendingReplay = await PendingJob.countDocuments({ status: "pending" });
  const oldestPending = await PendingJob.findOne({ status: "pending" })
    .sort({ createdAt: 1 })
    .select("createdAt")
    .lean<{ createdAt?: Date } | null>();

  report.deadLetteredJobs = {
    total: exhaustedTotal,
    recent: exhausted.map((j) => ({
      queue: j.queueName,
      attempts: j.attempts,
      age: ageHuman(j.updatedAt),
      error: (j.lastError ?? "").slice(0, 160),
    })),
  };
  report.replayBacklog = {
    pending: pendingReplay,
    oldestAge: ageHuman(oldestPending?.createdAt),
  };

  // 2. Failed webhooks — orders that never ingested / never updated.
  const failedWebhooks = await WebhookInbox.countDocuments({
    status: "failed",
  });
  const needsAttention = await WebhookInbox.countDocuments({
    status: "needs_attention",
  });
  const recentBadHooks = await WebhookInbox.find({
    status: { $in: ["failed", "needs_attention"] },
  })
    .sort({ updatedAt: -1 })
    .limit(RECENT_LIMIT)
    .lean<
      Array<{
        provider?: string;
        status?: string;
        attempts?: number;
        updatedAt?: Date;
      }>
    >();
  report.webhooks = {
    failed: failedWebhooks,
    needsAttention,
    recent: recentBadHooks.map((w) => ({
      provider: w.provider,
      status: w.status,
      attempts: w.attempts,
      age: ageHuman(w.updatedAt),
    })),
  };

  // 3. Stuck orders — in confirmation/review past the SLA window.
  const cutoff = new Date(Date.now() - STUCK_HOURS * 3600_000);
  const stuckStates = ["pending_confirmation", "requires_review"];
  const stuckByState: Record<string, number> = {};
  for (const st of stuckStates) {
    stuckByState[st] = await Order.countDocuments({
      "automation.state": st,
      createdAt: { $lt: cutoff },
    });
  }
  report.stuckOrders = { olderThanHours: STUCK_HOURS, byState: stuckByState };

  // 4. Queue depth + BullMQ failed counts. Redis may be down — never let
  // that abort the rest of the triage.
  const queues: Record<string, unknown> = {};
  for (const qname of Object.values(QUEUE_NAMES)) {
    try {
      const counts = await getQueue(qname).getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
      );
      queues[qname] = counts;
    } catch (err) {
      queues[qname] = { error: (err as Error).message.slice(0, 80) };
    }
  }
  report.queues = queues;

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Human view — calm, scannable, urgent things first.
  out("=== ConfirmX beta-ops triage ===");
  out(new Date().toISOString());
  out();
  out(
    `DEAD-LETTERED JOBS (lost work): ${exhaustedTotal}` +
      (exhaustedTotal > 0 ? "  ⚠ ACTION NEEDED" : "  ok"),
  );
  for (const j of exhausted) {
    out(
      `  · ${j.queueName} attempts=${j.attempts} age=${ageHuman(
        j.updatedAt,
      )} :: ${(j.lastError ?? "").slice(0, 160)}`,
    );
  }
  out();
  out(
    `REPLAY BACKLOG: ${pendingReplay} pending (oldest ${ageHuman(
      oldestPending?.createdAt,
    )})` + (pendingReplay > 50 ? "  ⚠ growing" : "  ok"),
  );
  out();
  out(
    `WEBHOOKS: failed=${failedWebhooks} needsAttention=${needsAttention}` +
      (needsAttention > 0 ? "  ⚠ merchants alerted" : ""),
  );
  for (const w of recentBadHooks) {
    out(
      `  · ${w.provider} ${w.status} attempts=${w.attempts} age=${ageHuman(
        w.updatedAt,
      )}`,
    );
  }
  out();
  out(`STUCK ORDERS (> ${STUCK_HOURS}h, still awaiting action):`);
  for (const [st, n] of Object.entries(stuckByState)) {
    out(`  · ${st}: ${n}${n > 0 ? "  ⚠" : ""}`);
  }
  out();
  out("QUEUE DEPTH (waiting/active/delayed/failed):");
  for (const [q, c] of Object.entries(queues)) {
    const cc = c as {
      waiting?: number;
      active?: number;
      delayed?: number;
      failed?: number;
      error?: string;
    };
    if (cc.error) {
      out(`  · ${q}: (unreadable: ${cc.error})`);
    } else {
      out(
        `  · ${q}: ${cc.waiting ?? 0}/${cc.active ?? 0}/${cc.delayed ?? 0}/${
          cc.failed ?? 0
        }${(cc.failed ?? 0) > 0 ? "  ⚠" : ""}`,
      );
    }
  }
  out();
  out("Read-only. Automatic replay: pendingJobReplay worker. Manual");
  out("recovery steps: see docs/BETA_RUNBOOK.md.");

  console.log(lines.join("\n"));
}

main()
  .catch((err) => {
    console.error("[beta-ops] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void mongoose.disconnect().catch(() => {});
  });
