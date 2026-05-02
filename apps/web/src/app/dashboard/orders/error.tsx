"use client";

import { RouteErrorBoundary } from "@/components/error-boundary";

export default function OrdersRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorBoundary area="Orders" error={error} reset={reset} />;
}
