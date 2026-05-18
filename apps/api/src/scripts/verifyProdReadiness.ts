import mongoose from "mongoose";
import { DEFAULT_BRANDING, getBrandingSync } from "@ecom/branding";
import { Integration, Notification, WebhookInbox } from "@ecom/db";
import { env } from "../env.js";
import { connectDb } from "../lib/db.js";
import { getRedis } from "../lib/redis.js";
import { QUEUE_NAMES } from "../lib/queue.js";

/**
 * Production-readiness audit.
 *
 * Runs a single sweep of environment + infrastructure + schema checks so
 * an operator can answer "is this deploy safe to enable the integration
 * gates on?" without manually inspecting twelve different surfaces.
 *
 * Categorised output:
 *   - pass  ✓  the check found exactly what we expected.
 *   - warn  ▲  the check found something worth knowing but not blocking
 *              (e.g. RESEND_API_KEY missing — emails silently skip, but
 *              the API itself still functions).
 *   - fail  ✗  the check found a hard issue (missing required env var,
 *              Mongo unreachable, critical unique index absent). Script
 *              exits non-zero.
 *
 * Usage:
 *   npm --workspace apps/api run verify:prod-readiness
 *   npm --workspace apps/api run verify:prod-readiness -- --json   # machine output
 *
 * Safe to run repeatedly. Read-only — never writes to Mongo / Redis.
 */

type Status = "pass" | "warn" | "fail";

interface CheckResult {
  category: string;
  name: string;
  status: Status;
  detail: string;
}

const results: CheckResult[] = [];
const startedAt = Date.now();

function record(
  category: string,
  name: string,
  status: Status,
  detail: string,
): void {
  results.push({ category, name, status, detail });
}

function printable(s: Status): string {
  return s === "pass" ? "[PASS]" : s === "warn" ? "[WARN]" : "[FAIL]";
}

// ---------- Env var checks --------------------------------------------------

function checkEnvVars(): void {
  // Hard-required: api won't actually start without these (env schema in
  // src/env.ts enforces in prod), but we double-check so a misconfigured
  // shell that bypasses the schema (e.g. a manual cron tick) surfaces
  // the issue here rather than at first request.
  const required = [
    ["MONGODB_URI", env.MONGODB_URI],
    ["JWT_SECRET", env.JWT_SECRET],
    ["COURIER_ENC_KEY", env.COURIER_ENC_KEY],
  ] as const;
  for (const [name, value] of required) {
    record(
      "env",
      name,
      value ? "pass" : "fail",
      value ? "present" : "missing — api will not function",
    );
  }

  // Required in production only.
  if (env.NODE_ENV === "production") {
    if (!env.PUBLIC_API_URL) {
      record(
        "env",
        "PUBLIC_API_URL",
        "fail",
        "missing — webhook callback URLs will be malformed in prod",
      );
    } else {
      record("env", "PUBLIC_API_URL", "pass", env.PUBLIC_API_URL);
    }
    if (!env.REDIS_URL) {
      record(
        "env",
        "REDIS_URL",
        "fail",
        "missing — BullMQ, token-refresh lock, and order tombstone all degrade",
      );
    } else {
      record("env", "REDIS_URL", "pass", "present");
    }
  } else {
    record(
      "env",
      "NODE_ENV",
      "warn",
      `${env.NODE_ENV} — some prod-only checks will not gate`,
    );
  }

  // Email transport — features degrade silently without it.
  const resendKey = process.env.RESEND_API_KEY?.trim() ?? "";
  record(
    "env",
    "RESEND_API_KEY",
    resendKey ? "pass" : "warn",
    resendKey
      ? "present"
      : "missing — reconnect-nudge + courier-cancel emails will skip with skipReason=no_api_key",
  );

  // SMS transport — courier-cancel SMS degrades to log-only without it.
  const smsKey = process.env.SSL_WIRELESS_API_KEY?.trim() ?? "";
  const smsUser = process.env.SSL_WIRELESS_USER?.trim() ?? "";
  const smsSid = process.env.SSL_WIRELESS_SID?.trim() ?? "";
  const smsConfigured = !!(smsKey && smsUser && smsSid);
  record(
    "env",
    "SSL_WIRELESS_*",
    smsConfigured ? "pass" : "warn",
    smsConfigured
      ? "all 3 keys present"
      : "incomplete — courier-cancel SMS will log to stdout instead of sending",
  );

  // Shopify app credentials — required for embedded auth + token exchange.
  const shopifyKey = process.env.SHOPIFY_APP_API_KEY?.trim() ?? "";
  const shopifySecret = process.env.SHOPIFY_APP_API_SECRET?.trim() ?? "";
  if (env.NODE_ENV === "production") {
    record(
      "env",
      "SHOPIFY_APP_API_KEY/SECRET",
      shopifyKey && shopifySecret ? "pass" : "warn",
      shopifyKey && shopifySecret
        ? "both present"
        : "missing — public Shopify install + embedded session-token exchange unavailable",
    );
  }

  // CSP enforcement flag — informational. Off by default (intentional).
  const cspEnforced = (process.env.CSP_ENFORCED ?? "").trim().toLowerCase();
  const cspOn =
    cspEnforced === "true" ||
    cspEnforced === "1" ||
    cspEnforced === "yes" ||
    cspEnforced === "on";
  record(
    "env",
    "CSP_ENFORCED",
    "warn",
    cspOn
      ? "ENFORCED — browsers will block resources that violate CSP"
      : "Report-Only (default) — browsers log violations without blocking. Flip after a clean window.",
  );

  // Reconnect-nudge tunables — informational.
  const cooldown = process.env.SHOPIFY_RECONNECT_NUDGE_COOLDOWN_DAYS;
  if (cooldown) {
    const days = Number(cooldown);
    if (!Number.isFinite(days) || days <= 0) {
      record(
        "env",
        "SHOPIFY_RECONNECT_NUDGE_COOLDOWN_DAYS",
        "warn",
        `invalid value ${cooldown} — worker will fall back to 7-day default`,
      );
    } else {
      record(
        "env",
        "SHOPIFY_RECONNECT_NUDGE_COOLDOWN_DAYS",
        "pass",
        `${days} days between nudges per integration`,
      );
    }
  }
}

// ---------- Brand / legal readiness ----------------------------------------

function checkBrandReadiness(): void {
  // The private beta runs hand-onboarded merchants on a Custom (not
  // Public Distribution) Shopify app, so a placeholder legal entity is
  // an accepted, documented limitation — failing the deploy on it would
  // wrongly block the legitimate beta. But the moment the app is flipped
  // to Public Distribution, Shopify reviewers cross-check the registered
  // entity against the privacy/terms pages and the Partner listing, and
  // a placeholder fails review. So this is a loud WARN on every deploy,
  // never silent — the gate against Public Distribution lives in
  // docs/BETA_RUNBOOK.md §1, this check keeps it from being forgotten.
  const brand = getBrandingSync();
  const placeholderEntity = brand.legalName === DEFAULT_BRANDING.legalName;
  record(
    "brand",
    "legal_entity",
    placeholderEntity ? "warn" : "pass",
    placeholderEntity
      ? `placeholder "${brand.legalName}" — private beta only. DO NOT enable Shopify Public Distribution / public listing until a registered entity is set (packages/branding/src/defaults.ts legalName, or the DB branding row).`
      : `registered entity set: "${brand.legalName}"`,
  );

  // Email-inbox routing cannot be proven from code (no SMTP probe here).
  // Surface the addresses so an operator visually confirms they are the
  // intended ones, and restate that reviewers test-mail privacy+support.
  record(
    "brand",
    "contact_inboxes",
    "warn",
    `support=${brand.supportEmail} privacy=${brand.privacyEmail} — must route to a monitored inbox before Public Distribution (reviewers send test mail to privacy + support).`,
  );
}

// ---------- Mongo connectivity + ping --------------------------------------

async function checkMongo(): Promise<void> {
  try {
    await connectDb();
    record("mongo", "connect", "pass", "connected");
  } catch (err) {
    record(
      "mongo",
      "connect",
      "fail",
      `connect failed: ${(err as Error).message.slice(0, 200)}`,
    );
    return;
  }
  try {
    const admin = mongoose.connection.db?.admin();
    if (!admin) throw new Error("no admin handle");
    const pong = await admin.ping();
    record(
      "mongo",
      "ping",
      pong?.ok === 1 ? "pass" : "fail",
      `ping = ${JSON.stringify(pong)}`,
    );
  } catch (err) {
    record(
      "mongo",
      "ping",
      "fail",
      `ping failed: ${(err as Error).message.slice(0, 200)}`,
    );
  }
}

// ---------- Critical indexes -----------------------------------------------

interface IndexExpectation {
  model: { collection: { indexes(): Promise<Array<{ name?: string; key: Record<string, number>; unique?: boolean; partialFilterExpression?: unknown }>> } };
  collection: string;
  expectedKey: Record<string, number>;
  requireUnique?: boolean;
  description: string;
}

async function checkIndexes(): Promise<void> {
  const expectations: IndexExpectation[] = [
    {
      model: WebhookInbox as unknown as IndexExpectation["model"],
      collection: "WebhookInbox",
      // Dedupe key for inbound webhooks — without this, retries double-ingest.
      expectedKey: { merchantId: 1, provider: 1, externalId: 1 },
      requireUnique: true,
      description: "inbound webhook dedupe (merchantId+provider+externalId)",
    },
    {
      model: Integration as unknown as IndexExpectation["model"],
      collection: "Integration",
      // Routes multi-store: same merchant can have N integrations across
      // (provider, accountKey) pairs but no duplicates of the same triple.
      expectedKey: { merchantId: 1, provider: 1, accountKey: 1 },
      requireUnique: true,
      description: "integration uniqueness (merchantId+provider+accountKey)",
    },
    {
      model: Notification as unknown as IndexExpectation["model"],
      collection: "Notification",
      // Partial unique on dedupeKey — collapses retry-fired courier-cancel /
      // gdpr-data-request / fraud alerts that share the same logical
      // identity.
      expectedKey: { merchantId: 1, dedupeKey: 1 },
      requireUnique: true,
      description: "notification dedupe partial unique (merchantId+dedupeKey)",
    },
  ];

  for (const exp of expectations) {
    try {
      const indexes = await exp.model.collection.indexes();
      const expectedKeys = JSON.stringify(exp.expectedKey);
      const match = indexes.find(
        (idx) => JSON.stringify(idx.key) === expectedKeys,
      );
      if (!match) {
        record(
          "indexes",
          exp.collection,
          "fail",
          `missing index ${expectedKeys} — ${exp.description}`,
        );
        continue;
      }
      if (exp.requireUnique && !match.unique) {
        record(
          "indexes",
          exp.collection,
          "fail",
          `index ${expectedKeys} exists but is NOT unique — ${exp.description}`,
        );
        continue;
      }
      record(
        "indexes",
        exp.collection,
        "pass",
        `${expectedKeys}${match.unique ? " unique" : ""}${match.partialFilterExpression ? " partial" : ""}`,
      );
    } catch (err) {
      record(
        "indexes",
        exp.collection,
        "fail",
        `index list failed: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }
}

// ---------- Schema-additive fields wired correctly --------------------------

function checkSchemaFields(): void {
  // The reconnect-nudge sweep reads + writes `lastReconnectNudgeAt`.
  // If the schema build is stale the field is silently dropped by
  // Mongoose strict mode and the cooldown never lands → spam.
  const integrationPaths = Integration.schema?.paths ?? {};
  if ("lastReconnectNudgeAt" in integrationPaths) {
    record(
      "schema",
      "Integration.lastReconnectNudgeAt",
      "pass",
      "field present — reconnect-nudge cooldown is honoured",
    );
  } else {
    record(
      "schema",
      "Integration.lastReconnectNudgeAt",
      "fail",
      "field absent on Integration schema — every nudge sweep will re-email the same merchant",
    );
  }

  // Notification kind enum must include the courier-cancel marker.
  const kindPath = Notification.schema?.paths?.kind;
  const kindEnum =
    (kindPath as { enumValues?: string[] } | undefined)?.enumValues ?? [];
  if (kindEnum.includes("order.courier_cancel_required")) {
    record(
      "schema",
      "Notification.kind",
      "pass",
      "order.courier_cancel_required is in the enum",
    );
  } else {
    record(
      "schema",
      "Notification.kind",
      "fail",
      `enum missing order.courier_cancel_required (current: ${kindEnum.length} values)`,
    );
  }
}

// ---------- Redis connectivity ---------------------------------------------

async function checkRedis(): Promise<void> {
  let client;
  try {
    client = getRedis();
  } catch (err) {
    record(
      "redis",
      "connect",
      env.NODE_ENV === "production" ? "fail" : "warn",
      `getRedis() threw: ${(err as Error).message.slice(0, 200)}`,
    );
    return;
  }
  try {
    const pong = await client.ping();
    record(
      "redis",
      "ping",
      pong === "PONG" ? "pass" : "fail",
      `ping = ${pong}`,
    );
  } catch (err) {
    record(
      "redis",
      "ping",
      "fail",
      `ping failed: ${(err as Error).message.slice(0, 200)}`,
    );
  }
}

// ---------- BullMQ queue catalogue -----------------------------------------

function checkQueueCatalogue(): void {
  // The new email + shopifyReconnectNudge queues are additive on top of
  // the existing catalogue. Surface the full list so operators can
  // cross-check against their BullMQ dashboard.
  const names = Object.values(QUEUE_NAMES);
  const expectedNew = ["email", "shopify-reconnect-nudge"];
  for (const exp of expectedNew) {
    if (names.includes(exp as (typeof names)[number])) {
      record("queues", exp, "pass", "queue declared");
    } else {
      record(
        "queues",
        exp,
        "fail",
        `queue ${exp} missing from QUEUE_NAMES — worker boot will fail`,
      );
    }
  }
  record("queues", "catalogue", "warn", `${names.length} queues declared`);
}

// ---------- Operational snapshots ------------------------------------------

async function checkLegacyShopifyPopulation(): Promise<void> {
  try {
    const count = await Integration.countDocuments({
      provider: "shopify",
      status: { $in: ["connected", "error"] },
      $or: [
        { "credentials.refreshToken": { $in: [null, undefined, ""] } },
        { "credentials.accessTokenExpiresAt": { $in: [null, undefined] } },
      ],
    });
    // Surface the number so operators can size the support load BEFORE
    // the daily nudge worker first fires.
    if (count === 0) {
      record(
        "ops",
        "legacy_shopify_tokens",
        "pass",
        "0 legacy Shopify integrations — nudge worker will be a no-op",
      );
    } else if (count <= 50) {
      record(
        "ops",
        "legacy_shopify_tokens",
        "warn",
        `${count} legacy Shopify integrations — first sweep will email up to 200 of them`,
      );
    } else {
      record(
        "ops",
        "legacy_shopify_tokens",
        "warn",
        `${count} legacy Shopify integrations — consider raising SHOPIFY_RECONNECT_NUDGE_COOLDOWN_DAYS or pausing the worker until support is prepped`,
      );
    }
  } catch (err) {
    record(
      "ops",
      "legacy_shopify_tokens",
      "warn",
      `count query failed: ${(err as Error).message.slice(0, 200)}`,
    );
  }
}

async function checkRecentWebhookFailures(): Promise<void> {
  // Informational — count failed inbox rows in the last hour. Sustained
  // non-zero numbers correlate with merchant-side breakage; spike =
  // deploy regression.
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const failed = await WebhookInbox.countDocuments({
      status: "failed",
      createdAt: { $gte: oneHourAgo },
    });
    const needsAttention = await WebhookInbox.countDocuments({
      status: "needs_attention",
      createdAt: { $gte: oneHourAgo },
    });
    record(
      "ops",
      "recent_webhook_failures",
      "warn",
      `last 1h: failed=${failed} needs_attention=${needsAttention}`,
    );
  } catch (err) {
    record(
      "ops",
      "recent_webhook_failures",
      "warn",
      `count failed: ${(err as Error).message.slice(0, 200)}`,
    );
  }
}

async function checkStuckPendingIntegrations(): Promise<void> {
  // Shopify OAuth installs sit in `pending` while the merchant approves
  // on the Shopify side. >24h in pending = the merchant abandoned the
  // grant OR our OAuth callback never landed. Either is worth knowing.
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stuck = await Integration.countDocuments({
      provider: "shopify",
      status: "pending",
      "credentials.installStartedAt": { $lt: cutoff },
    });
    if (stuck === 0) {
      record(
        "ops",
        "stuck_pending_shopify",
        "pass",
        "no shopify installs stuck in pending >24h",
      );
    } else {
      record(
        "ops",
        "stuck_pending_shopify",
        "warn",
        `${stuck} shopify installs in pending >24h — merchant likely abandoned, or callback never landed`,
      );
    }
  } catch (err) {
    record(
      "ops",
      "stuck_pending_shopify",
      "warn",
      `count failed: ${(err as Error).message.slice(0, 200)}`,
    );
  }
}

// ---------- Main ------------------------------------------------------------

async function main(): Promise<void> {
  const jsonOutput = process.argv.includes("--json");

  checkEnvVars();
  checkBrandReadiness();
  await checkMongo();
  if (mongoose.connection.readyState === 1) {
    await checkIndexes();
    checkSchemaFields();
    await checkLegacyShopifyPopulation();
    await checkRecentWebhookFailures();
    await checkStuckPendingIntegrations();
  }
  await checkRedis();
  checkQueueCatalogue();

  const passCount = results.filter((r) => r.status === "pass").length;
  const warnCount = results.filter((r) => r.status === "warn").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  const elapsedMs = Date.now() - startedAt;

  if (jsonOutput) {
    process.stdout.write(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          nodeEnv: env.NODE_ENV,
          elapsedMs,
          summary: { pass: passCount, warn: warnCount, fail: failCount },
          results,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    // Group results by category for readable output.
    const byCategory = new Map<string, CheckResult[]>();
    for (const r of results) {
      const list = byCategory.get(r.category) ?? [];
      list.push(r);
      byCategory.set(r.category, list);
    }
    const headerLine = "═".repeat(72);
    console.log(headerLine);
    console.log(
      `  PROD-READINESS AUDIT · NODE_ENV=${env.NODE_ENV} · ${new Date().toISOString()}`,
    );
    console.log(headerLine);
    for (const [category, items] of byCategory) {
      console.log(`\n  [${category}]`);
      for (const item of items) {
        const pad = item.name.padEnd(38, " ");
        console.log(`    ${printable(item.status)} ${pad} ${item.detail}`);
      }
    }
    console.log("\n" + headerLine);
    console.log(
      `  Summary: pass=${passCount} warn=${warnCount} fail=${failCount} · ${elapsedMs}ms`,
    );
    console.log(headerLine);
  }

  // Clean up connections so the script exits promptly.
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  try {
    const redis = getRedis();
    redis.disconnect();
  } catch {
    /* ignore */
  }

  // Exit non-zero on any failure so CI / deploy pipelines can gate on
  // this. Warnings are intentional and never fail the run.
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[verify-prod-readiness] fatal", err);
  process.exit(2);
});
