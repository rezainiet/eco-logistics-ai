/**
 * Browser-side telemetry hook for Sentry.
 *
 * Mirrors the API's `apps/api/src/lib/telemetry.ts` shape (no SDK, raw
 * envelope POST). When `NEXT_PUBLIC_SENTRY_DSN` is unset this is a no-op.
 *
 * The DSN is intentionally `NEXT_PUBLIC_*` because Sentry's public DSN is
 * safe to ship to the browser — it's a write-only token bound to a single
 * project. Quota / abuse is enforced server-side by Sentry.
 */

interface ParsedDsn {
  protocol: string;
  publicKey: string;
  host: string;
  projectId: string;
}

let cachedDsn: { raw: string | null; parsed: ParsedDsn | null } = {
  raw: null,
  parsed: null,
};

function dsn(): ParsedDsn | null {
  const raw =
    typeof process !== "undefined" && process.env.NEXT_PUBLIC_SENTRY_DSN
      ? process.env.NEXT_PUBLIC_SENTRY_DSN
      : null;
  if (cachedDsn.raw === raw) return cachedDsn.parsed;
  cachedDsn = { raw, parsed: raw ? parseDsn(raw) : null };
  return cachedDsn.parsed;
}

function parseDsn(raw: string): ParsedDsn | null {
  try {
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

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  // Web Crypto fallback — sufficiently unique for event ids in IE-class browsers.
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface CaptureExtras {
  tags?: Record<string, string>;
  level?: "fatal" | "error" | "warning" | "info";
  user?: { id?: string; email?: string };
}

async function send(payload: Record<string, unknown>): Promise<void> {
  const parsed = dsn();
  if (!parsed) return;
  const header = JSON.stringify({ event_id: payload.event_id, sent_at: new Date().toISOString() });
  const itemHeader = JSON.stringify({ type: "event" });
  const body = JSON.stringify(payload);
  const envelope = `${header}\n${itemHeader}\n${body}`;
  try {
    await fetch(envelopeUrl(parsed), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7,sentry_key=${parsed.publicKey},sentry_client=ecom-logistics-web/0.1`,
      },
      body: envelope,
      keepalive: true,
    });
  } catch {
    // Telemetry failures must never break the page.
  }
}

export function captureException(err: unknown, extras?: CaptureExtras): void {
  if (!dsn()) return;
  const e = err instanceof Error ? err : new Error(String(err));
  const payload = {
    event_id: uuid(),
    timestamp: new Date().toISOString(),
    platform: "javascript",
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    level: extras?.level ?? "error",
    tags: extras?.tags,
    user: extras?.user,
    request:
      typeof window !== "undefined"
        ? { url: window.location.href, headers: { "User-Agent": navigator.userAgent } }
        : undefined,
    exception: {
      values: [
        {
          type: e.name ?? "Error",
          value: e.message ?? String(err),
          stacktrace: e.stack ? { frames: parseStack(e.stack) } : undefined,
        },
      ],
    },
  };
  void send(payload);
}

function parseStack(stack: string): Array<Record<string, unknown>> {
  return stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .map((line) => {
      const match = /at (?:(.+?) )?\(?(.+?):(\d+):(\d+)\)?$/.exec(line);
      if (!match) return null;
      return {
        function: match[1] ?? undefined,
        filename: match[2],
        lineno: Number(match[3]),
        colno: Number(match[4]),
        in_app: !match[2]?.includes("node_modules"),
      };
    })
    .filter(Boolean)
    .reverse() as Array<Record<string, unknown>>;
}

export function isTelemetryEnabled(): boolean {
  return dsn() !== null;
}
