"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  PlayCircle,
  RefreshCw,
  Shield,
  Webhook,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * /dashboard/api — webhook endpoint surface.
 *
 * Backs the landing's "idempotent ingestion · 99.9% webhook delivery"
 * trust pillars with an actual page where the merchant can:
 *
 *   • copy the webhook URL Cordon expects Shopify / Woo to POST to,
 *   • reveal + regenerate the HMAC signing secret (with a confirm gate),
 *   • fire a test event into the queue and watch the result land in the
 *     delivery log,
 *   • see the last 25 deliveries with status, attempt count, and latency.
 *
 * Network calls go to the existing /webhook-config and /webhook-deliveries
 * endpoints. If the backend isn't wired yet, the page degrades gracefully:
 * the secret renders as a placeholder, the table shows an empty state, and
 * the buttons surface a friendly error rather than crashing.
 */

interface WebhookConfig {
  url: string;
  secret: string | null;
  rotatedAt: string | null;
}

interface DeliveryLogEntry {
  id: string;
  event: string;
  status: "delivered" | "failed" | "retrying";
  attempts: number;
  latencyMs: number | null;
  receivedAt: string;
  responseCode: number | null;
}

const STATUS_PILL: Record<DeliveryLogEntry["status"], { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
  delivered: {
    label: "Delivered",
    cls: "border-success-border bg-success-subtle text-success",
    Icon: CheckCircle2,
  },
  retrying: {
    label: "Retrying",
    cls: "border-warning-border bg-warning-subtle text-warning",
    Icon: Loader2,
  },
  failed: {
    label: "Failed",
    cls: "border-danger-border bg-danger-subtle text-danger",
    Icon: XCircle,
  },
};

export default function ApiPage() {
  const apiUrl = useMemo(
    () => process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
    [],
  );

  const [config, setConfig] = useState<WebhookConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);

  const [secretRevealed, setSecretRevealed] = useState(false);
  const [rotateState, setRotateState] = useState<"idle" | "confirming" | "rotating">("idle");
  const [rotateError, setRotateError] = useState<string | null>(null);

  const [testState, setTestState] = useState<"idle" | "firing" | "fired" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  const [deliveries, setDeliveries] = useState<DeliveryLogEntry[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(true);

  const [copyFeedback, setCopyFeedback] = useState<"url" | "secret" | null>(null);

  // ───────────────────────── data loaders ─────────────────────────

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const res = await fetch(`${apiUrl}/webhook-config`, {
        credentials: "include",
      });
      if (!res.ok) {
        setConfigError(
          res.status === 401
            ? "Your session expired. Refresh the page."
            : "We couldn't load your webhook config. Try again in a moment.",
        );
        setConfigLoading(false);
        return;
      }
      const data = (await res.json()) as Partial<WebhookConfig>;
      setConfig({
        url: data.url ?? `${apiUrl}/webhooks/ingest`,
        secret: data.secret ?? null,
        rotatedAt: data.rotatedAt ?? null,
      });
    } catch {
      setConfigError("Network hiccup. Try again in a moment.");
    } finally {
      setConfigLoading(false);
    }
  }, [apiUrl]);

  const loadDeliveries = useCallback(async () => {
    setDeliveriesLoading(true);
    try {
      const res = await fetch(`${apiUrl}/webhook-deliveries?limit=25`, {
        credentials: "include",
      });
      if (!res.ok) {
        setDeliveries([]);
        return;
      }
      const data = (await res.json()) as { deliveries?: DeliveryLogEntry[] };
      setDeliveries(data.deliveries ?? []);
    } catch {
      setDeliveries([]);
    } finally {
      setDeliveriesLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    void loadConfig();
    void loadDeliveries();
  }, [loadConfig, loadDeliveries]);

  // ───────────────────────── actions ──────────────────────────────

  const handleCopy = useCallback(async (kind: "url" | "secret", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyFeedback(kind);
      setTimeout(() => setCopyFeedback(null), 1500);
    } catch {
      // Clipboard access denied — silently no-op. The user can still
      // select-and-copy the visible string.
    }
  }, []);

  const handleRotate = useCallback(async () => {
    setRotateState("rotating");
    setRotateError(null);
    try {
      const res = await fetch(`${apiUrl}/webhook-config/rotate-secret`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        const detail =
          typeof body.error === "string"
            ? body.error
            : "Rotation failed. Try again in a moment.";
        setRotateError(detail);
        setRotateState("idle");
        return;
      }
      const data = (await res.json()) as Partial<WebhookConfig>;
      setConfig((prev) =>
        prev
          ? {
              ...prev,
              secret: data.secret ?? prev.secret,
              rotatedAt: data.rotatedAt ?? new Date().toISOString(),
            }
          : prev,
      );
      setSecretRevealed(true);
      setRotateState("idle");
    } catch {
      setRotateError("Network hiccup. Try again in a moment.");
      setRotateState("idle");
    }
  }, [apiUrl]);

  const handleTestFire = useCallback(async () => {
    setTestState("firing");
    setTestError(null);
    try {
      const res = await fetch(`${apiUrl}/webhook-deliveries/test`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        const detail =
          typeof body.error === "string"
            ? body.error
            : "Test fire failed. Try again in a moment.";
        setTestError(detail);
        setTestState("error");
        return;
      }
      setTestState("fired");
      // Refresh the log so the test event appears at the top.
      setTimeout(() => {
        void loadDeliveries();
      }, 600);
      setTimeout(() => setTestState("idle"), 2400);
    } catch {
      setTestError("Network hiccup. Try again in a moment.");
      setTestState("error");
    }
  }, [apiUrl, loadDeliveries]);

  // ───────────────────────── render ───────────────────────────────

  return (
    <main className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg md:text-3xl">
          API &amp; webhooks
        </h1>
        <p className="text-sm text-fg-muted">
          Where to point Shopify / Woo, and how to verify the events that
          arrive. Cordon validates every request with HMAC-SHA256 and
          rejects anything that doesn&apos;t match.
        </p>
      </header>

      {/* Endpoint card */}
      <section className="space-y-4 rounded-2xl border border-stroke/30 bg-surface p-6 shadow-elevated">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-raised text-brand">
            <Webhook className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-fg">Webhook URL</h2>
            <p className="text-xs text-fg-faint">
              Paste this into your store&apos;s webhook settings. POST + JSON.
            </p>
          </div>
        </div>

        {configLoading ? (
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : configError ? (
          <div className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{configError}</span>
          </div>
        ) : config ? (
          <div className="flex items-stretch gap-2">
            <code className="flex flex-1 items-center overflow-x-auto rounded-md border border-stroke/30 bg-surface-raised px-3 py-2 font-mono text-xs text-fg">
              {config.url}
            </code>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleCopy("url", config.url)}
              className="h-auto shrink-0 border-stroke/30 bg-transparent px-3 text-fg-muted hover:bg-surface-raised hover:text-fg"
              aria-label="Copy webhook URL"
            >
              {copyFeedback === "url" ? (
                <CheckCircle2 className="h-4 w-4 text-success" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
        ) : null}
      </section>

      {/* Signing secret */}
      <section className="space-y-4 rounded-2xl border border-stroke/30 bg-surface p-6 shadow-elevated">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-raised text-brand">
            <KeyRound className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-fg">Signing secret</h2>
            <p className="text-xs text-fg-faint">
              Compute <code className="font-mono">HMAC-SHA256(rawBody, secret)</code> and
              send the hex digest in the <code className="font-mono">x-cordon-signature</code> header.
            </p>
          </div>
        </div>

        {config ? (
          <>
            <div className="flex items-stretch gap-2">
              <code className="flex flex-1 items-center overflow-x-auto rounded-md border border-stroke/30 bg-surface-raised px-3 py-2 font-mono text-xs text-fg">
                {config.secret
                  ? secretRevealed
                    ? config.secret
                    : maskSecret(config.secret)
                  : "(no secret yet — click rotate to generate one)"}
              </code>
              {config.secret ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setSecretRevealed((v) => !v)}
                    className="h-auto shrink-0 border-stroke/30 bg-transparent px-3 text-fg-muted hover:bg-surface-raised hover:text-fg"
                    aria-label={secretRevealed ? "Hide secret" : "Reveal secret"}
                    aria-pressed={secretRevealed}
                  >
                    {secretRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleCopy("secret", config.secret ?? "")}
                    disabled={!secretRevealed}
                    className="h-auto shrink-0 border-stroke/30 bg-transparent px-3 text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-50"
                    aria-label="Copy secret"
                  >
                    {copyFeedback === "secret" ? (
                      <CheckCircle2 className="h-4 w-4 text-success" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stroke/20 pt-4">
              <div className="text-xs text-fg-faint">
                {config.rotatedAt ? (
                  <>Last rotated {new Date(config.rotatedAt).toLocaleString()}</>
                ) : (
                  <>Never rotated</>
                )}
              </div>
              {rotateState === "confirming" ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-fg-muted">
                    This invalidates the old secret immediately. Continue?
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setRotateState("idle")}
                    className="h-9 border-stroke/30 bg-transparent text-fg-muted hover:bg-surface-raised hover:text-fg"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={handleRotate}
                    className="h-9 gap-1 bg-danger font-semibold text-white hover:bg-danger/90"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Yes, rotate
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  onClick={() => setRotateState("confirming")}
                  className="h-9 gap-1 bg-brand font-semibold text-brand-fg hover:bg-brand-hover"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {config.secret ? "Rotate secret" : "Generate secret"}
                </Button>
              )}
            </div>

            {rotateState === "rotating" ? (
              <div className="flex items-center gap-2 text-sm text-fg-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Rotating…
              </div>
            ) : null}

            {rotateError ? (
              <div className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{rotateError}</span>
              </div>
            ) : null}
          </>
        ) : null}

        <div className="flex items-start gap-2 rounded-md border border-brand/20 bg-brand/5 px-3 py-2 text-xs text-fg-muted">
          <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
          <span>
            We never log the secret in plaintext. Rotating doesn&apos;t
            cancel in-flight retries — events queued under the previous
            secret keep going through their backoff schedule.
          </span>
        </div>
      </section>

      {/* Test fire */}
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-stroke/30 bg-surface p-6 shadow-elevated">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold text-fg">Fire a test event</h2>
          <p className="text-xs text-fg-muted">
            Sends an <code className="font-mono">order.test</code> event through the same pipeline as a real
            Shopify webhook. Useful for validating downstream consumers
            without waiting for a real order.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {testState === "fired" ? (
            <span className="inline-flex items-center gap-1 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" /> Test event queued
            </span>
          ) : null}
          {testError ? (
            <span className="inline-flex items-center gap-1 text-sm text-danger">
              <AlertCircle className="h-4 w-4" /> {testError}
            </span>
          ) : null}
          <Button
            type="button"
            onClick={handleTestFire}
            disabled={testState === "firing"}
            className="h-10 gap-2 bg-brand font-semibold text-brand-fg hover:bg-brand-hover disabled:opacity-60"
          >
            {testState === "firing" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Firing…
              </>
            ) : (
              <>
                <PlayCircle className="h-4 w-4" /> Fire test webhook
              </>
            )}
          </Button>
        </div>
      </section>

      {/* Delivery log */}
      <section className="space-y-4 rounded-2xl border border-stroke/30 bg-surface p-6 shadow-elevated">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-fg">Recent deliveries</h2>
            <p className="text-xs text-fg-muted">
              Last 25 webhook events. Cordon retries failures with
              exponential backoff before dead-lettering — see the attempts
              column.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadDeliveries()}
            className="h-9 gap-1 border-stroke/30 bg-transparent text-fg-muted hover:bg-surface-raised hover:text-fg"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>

        {deliveriesLoading ? (
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : deliveries.length === 0 ? (
          <div className="rounded-xl border border-stroke/20 bg-surface-raised/40 p-8 text-center text-sm text-fg-muted">
            <p>No webhook deliveries yet.</p>
            <p className="mt-1 text-xs text-fg-faint">
              Connect a store or fire a test event above to see entries here.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-stroke/30">
            <table className="w-full text-sm">
              <thead className="bg-surface-raised text-xs uppercase tracking-[0.08em] text-fg-faint">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Event</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Attempts</th>
                  <th className="px-3 py-2 text-right font-medium">Latency</th>
                  <th className="px-3 py-2 text-right font-medium">Code</th>
                  <th className="px-3 py-2 text-right font-medium">Received</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => {
                  const pill = STATUS_PILL[d.status];
                  const Icon = pill.Icon;
                  return (
                    <tr
                      key={d.id}
                      className="border-t border-stroke/20 text-fg-muted hover:bg-surface-raised/60"
                    >
                      <td className="px-3 py-2 font-mono text-xs text-fg">{d.event}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${pill.cls}`}>
                          <Icon className={`h-3 w-3 ${d.status === "retrying" ? "animate-spin" : ""}`} />
                          {pill.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {d.attempts}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {d.latencyMs != null ? `${d.latencyMs} ms` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {d.responseCode ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-xs">
                        {new Date(d.receivedAt).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

/** Mask the secret as `••••••••cd34` so the user can see "is there a value?"
 *  without exposing the bytes. The last 4 chars are kept so the merchant
 *  can visually verify a rotation took effect even before clicking reveal. */
function maskSecret(secret: string): string {
  if (secret.length <= 4) return "••••";
  return `••••••••${secret.slice(-4)}`;
}
