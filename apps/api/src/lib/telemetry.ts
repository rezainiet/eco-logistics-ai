import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { env } from "../env.js";

/**
 * Lightweight Sentry-compatible error capture.
 *
 * Backed by Sentry's HTTP store endpoint so we don't need the @sentry/node
 * SDK on the deployment graph (the SDK ships ~400KB of code we don't use).
 * When `SENTRY_DSN` is unset, capture is a no-op so dev/test runs are
 * silent and unaffected.
 *
 * Surface mirrors the SDK API points we actually need: `captureException`,
 * `captureMessage`, `setTag`. Each call fires-and-forgets — failures inside
 * telemetry are never allowed back into the request path.
 *
 * For deeper telemetry (breadcrumbs, performance traces, releases) swap
 * this module for `@sentry/node` later. Call sites won't change.
 */

interface ParsedDsn {
  protocol: string;
  publicKey: string;
  host: string;
  projectId: string;
}

let cached: { dsn: string | null; parsed: ParsedDsn | null } = {
  dsn: null,
  parsed: null,
};

function dsn(): ParsedDsn | null {
  const current = env.SENTRY_DSN ?? null;
  if (cached.dsn === current) return cached.parsed;
  cached = { dsn: current, parsed: current ? parseDsn(current) : null };
  return cached.parsed;
}

function parseDsn(raw: string): ParsedDsn | null {
  try {
    // Sentry DSN format: https://<publicKey>@<host>/<projectId>
    const url = new URL(raw);
    const projectId = url.pathname.replace(/^\//, "");
    if (!url.username || !url.host || !projectId) return null;
    return {
      protocol: url.protocol.replace(":", ""),
      publicKey: url.username,
      host: url.host,
      projectId,
    };
  } catch {
    return null;
  }
}

function envelopeUrl(parsed: ParsedDsn): string {
  return `${parsed.protocol}://${parsed.host}/api/${parsed.projectId}/envelope/`;
}

interface CaptureExtras {
  tags?: Record<string, string>;
  user?: { id?: string; email?: string };
  contexts?: Record<string, Record<string, unknown>>;
  level?: "fatal" | "error" | "warning" | "info" | "debug";
}

function commonPayload(extras: CaptureExtras | undefined) {
  return {
    event_id: randomUUID().replace(/-/g, ""),
    timestamp: new Date().toISOString(),
    platform: "node",
    server_name: hostname(),
    environment: env.NODE_ENV,
    release: env.SENTRY_RELEASE,
    level: extras?.level ?? "error",
    tags: extras?.tags,
    user: extras?.user,
    contexts: extras?.contexts,
  };
}

async function send(payload: Record<string, unknown>): Promise<void> {
  const parsed = dsn();
  if (!parsed) return;
  const header = JSON.stringify({ event_id: payload.event_id, sent_at: new Date().toISOString() });
  const itemHeader = JSON.stringify({ type: "event" });
  const body = JSON.stringify(payload);
  // Envelope format: <header>\n<itemHeader>\n<itemBody>
  const envelope = `${header}\n${itemHeader}\n${body}`;
  try {
    await fetch(envelopeUrl(parsed), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7,sentry_key=${parsed.publicKey},sentry_client=ecom-logistics/0.1`,
      },
      body: envelope,
    });
  } catch {
    // Telemetry errors are intentionally swallowed — never break the
    // request path because Sentry happens to be down.
  }
}

export function captureException(err: unknown, extras?: CaptureExtras): void {
  const parsed = dsn();
  if (!parsed) return;
  const e = err instanceof Error ? err : new Error(String(err));
  const stack = e.stack ?? "";
  // Convert the V8 stack into Sentry's frame format. We keep the parser
  // forgiving: bad frames are dropped rather than blocking the report.
  const frames = stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .map((line) => {
      const match = /at (?:(.+?) )?\(?(.+):(\d+):(\d+)\)?$/.exec(line);
      if (!match) return null;
      return {
        function: match[1] ?? undefined,
        filename: match[2],
        lineno: Number(match[3]),
        colno: Number(match[4]),
        in_app: !match[2]?.includes("node_modules"),
      };
    })
    .filter(Boolean) as Array<Record<string, unknown>>;
  const payload = {
    ...commonPayload(extras),
    exception: {
      values: [
        {
          type: e.name ?? "Error",
          value: e.message ?? String(err),
          stacktrace: { frames: frames.reverse() },
        },
      ],
    },
  };
  void send(payload);
}

export function captureMessage(message: string, extras?: CaptureExtras): void {
  const parsed = dsn();
  if (!parsed) return;
  const payload = {
    ...commonPayload({ ...extras, level: extras?.level ?? "info" }),
    message: { formatted: message },
  };
  void send(payload);
}

/**
 * Attach process-level handlers so unhandled rejections / exceptions reach
 * Sentry before the process restarts. Idempotent — calling twice doesn't
 * stack listeners.
 */
let _processHooked = false;
export function installProcessHooks(): void {
  if (_processHooked) return;
  _processHooked = true;
  process.on("unhandledRejection", (reason) => {
    captureException(reason, { tags: { source: "unhandledRejection" } });
  });
  process.on("uncaughtException", (err) => {
    captureException(err, { tags: { source: "uncaughtException" }, level: "fatal" });
  });
}

export function isTelemetryEnabled(): boolean {
  return dsn() !== null;
}
