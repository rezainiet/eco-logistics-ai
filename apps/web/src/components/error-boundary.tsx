"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { humanizeError } from "@/lib/friendly-errors";

/**
 * Shared route-level error UI. Next.js App Router renders the nearest
 * `error.tsx` whenever a child throws or a server component fails.
 * Each route's `error.tsx` should re-export this component (passing the
 * `area` label) so merchants get a consistent, actionable screen instead
 * of the framework's stack-trace fallback.
 */
export function RouteErrorBoundary({
  error,
  reset,
  area,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  area: string;
}) {
  useEffect(() => {
    // Report to console + any installed telemetry — keeping observability
    // visible to ops without leaking the stack trace to the merchant.
    console.error(`[${area}] route error:`, error);
  }, [area, error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-stroke/12 bg-surface p-6 text-center shadow-card">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-danger-subtle text-danger">
          <AlertTriangle className="h-5 w-5" aria-hidden />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-fg">Something went wrong</h2>
          <p className="text-xs text-fg-muted">
            {humanizeError(error)}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button onClick={reset} className="bg-brand text-white hover:bg-brand-hover">
            <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard">Back to dashboard</Link>
          </Button>
        </div>
        {error.digest ? (
          <p className="font-mono text-2xs text-fg-faint">
            Reference: {error.digest}
          </p>
        ) : null}
      </div>
    </div>
  );
}
