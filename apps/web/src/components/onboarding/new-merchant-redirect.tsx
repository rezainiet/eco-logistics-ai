"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";

const COOKIE_NAME = "onboarded_seen";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function hasCookie(name: string): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie
    .split(";")
    .some((c) => c.trim().startsWith(`${name}=`));
}

function setCookie(name: string, value: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=${value}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax`;
}

/**
 * First-login guard. When a brand-new merchant lands on /dashboard with
 * (zero couriers + zero orders) and we have not redirected them before,
 * forward them to /dashboard/getting-started so the onboarding checklist
 * is the first thing they see.
 *
 * Once-only contract:
 *  - Cookie `onboarded_seen` is set on first redirect (30-day expiry).
 *    A merchant who navigates back to /dashboard from the bottom nav is
 *    NOT redirected again — they get the empty-state dashboard as designed.
 *  - Defense-in-depth: as soon as the merchant has ANY courier OR any
 *    order, the redirect condition fails regardless of cookie state.
 *
 * The component renders nothing — it just runs the redirect side-effect
 * once both tRPC queries resolve. Both are also fetched by the
 * <OnboardingChecklist /> component, so this guard piggybacks on the
 * existing cache and adds zero network round-trips.
 */
export function NewMerchantRedirect() {
  const router = useRouter();
  const couriers = trpc.merchants.getCouriers.useQuery(undefined, {
    staleTime: 60_000,
  });
  const orders = trpc.orders.listOrders.useQuery(
    { limit: 1 } as never,
    { staleTime: 60_000 },
  );

  useEffect(() => {
    // Wait for both queries to resolve before deciding.
    if (couriers.isLoading || orders.isLoading) return;
    // Don't redirect on error — let the merchant see the dashboard so
    // they can use the support link instead of being trapped on a
    // bare onboarding page with the same broken connection.
    if (couriers.isError || orders.isError) return;

    if (hasCookie(COOKIE_NAME)) return;

    const courierCount = (couriers.data ?? []).length;
    const orderCount = orders.data?.items?.length ?? 0;
    if (courierCount > 0 || orderCount > 0) return;

    // New merchant. Stamp the cookie BEFORE the navigation so a fast
    // back-button doesn't trigger a second redirect.
    setCookie(COOKIE_NAME, "1");
    router.replace("/dashboard/getting-started?from=auto");
  }, [
    router,
    couriers.isLoading,
    couriers.isError,
    couriers.data,
    orders.isLoading,
    orders.isError,
    orders.data,
  ]);

  return null;
}
