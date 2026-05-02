"use client";

import { RouteErrorBoundary } from "@/components/error-boundary";

export default function IntegrationsRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorBoundary area="Integrations" error={error} reset={reset} />;
}
