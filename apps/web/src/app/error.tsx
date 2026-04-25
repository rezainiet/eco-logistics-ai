"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { captureException } from "@/lib/telemetry";

/**
 * Global Next.js error boundary. Caught at the App Router root, this fires
 * for any runtime error inside a server-component render or a client-
 * component render that bubbles past local boundaries.
 *
 * We capture to telemetry first, then render a friendly retry screen — the
 * user should never see a stack trace or an unstyled `Internal Server
 * Error` page.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, {
      tags: { boundary: "app_root", digest: error.digest ?? "none" },
    });
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-stroke/10 bg-surface p-7 text-center shadow-elevated">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger-subtle text-danger">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <h1 className="text-lg font-semibold text-fg">Something went wrong</h1>
        <p className="mt-1 text-sm text-fg-subtle">
          We've logged the issue — try again, or head back to the dashboard.
        </p>
        {error.digest ? (
          <p className="mt-2 text-2xs text-fg-faint">Reference: {error.digest}</p>
        ) : null}
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-10 items-center gap-1.5 rounded-md bg-brand px-4 text-sm font-medium text-white shadow-glow transition-colors hover:bg-brand-hover"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Try again
          </button>
          <Link
            href="/dashboard"
            className="inline-flex h-10 items-center rounded-md border border-stroke/14 px-4 text-sm font-medium text-fg hover:bg-surface-raised"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
