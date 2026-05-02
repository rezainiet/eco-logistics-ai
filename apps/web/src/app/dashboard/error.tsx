"use client";

import { RouteErrorBoundary } from "@/components/error-boundary";

export default function DashboardRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorBoundary area="Dashboard" error={error} reset={reset} />;
}
