"use client";

import { useEffect, useRef } from "react";
import { signOut, useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { jwtExpSeconds, refreshAccessToken } from "@/lib/auth-refresh";
import { SESSION_UNAUTHORIZED_EVENT } from "@/app/providers";
import { toast } from "@/components/ui/toast";

/**
 * Keeps the merchant signed in across access-token expiry without bouncing
 * them to /login.
 *
 * The access JWT lives 1 hour. NextAuth's session is 30 days. Without this
 * component the browser would hold a dead access token after the first hour
 * and every protected query would 401, eventually triggering a forced
 * logout. Instead, we:
 *
 *   1. Schedule a refresh ~1 minute before the access token would expire
 *      (proactive — happens silently in the background).
 *   2. On tab-visible / window-focus, top up if we're already inside the
 *      expiry window (laptop closed for 30 min, etc.).
 *   3. React to a `SESSION_UNAUTHORIZED_EVENT` dispatched by the queryCache
 *      when an in-flight tRPC call hits 401 (reactive — token died between
 *      timer fires).
 *
 * In all three paths the recovery is the same:
 *   - POST /auth/refresh with credentials so the HttpOnly refresh cookie
 *     goes along; the API rotates the session and returns a new access JWT.
 *   - Push the new token into the NextAuth session via update() so the
 *     tRPC client picks it up on its next call.
 *   - Invalidate the React-Query cache so any failed query refetches
 *     immediately with the new Authorization header.
 *   - If /auth/refresh itself fails (refresh token expired, session
 *     revoked) — only THEN sign the merchant out and bounce to /login.
 *
 * Mounted once inside the dashboard layout. Cheap — no render output, just
 * a couple of timers + listeners scoped to the session lifecycle.
 */
const REFRESH_LEAD_MS = 60_000;

let signOutPending = false;

export function TokenRefreshKeeper() {
  const { data: session, update } = useSession();
  const queryClient = useQueryClient();
  const apiToken = session?.apiToken ?? null;

  // Pin update + queryClient on a ref so the event-listener effect can
  // call them without re-subscribing every render.
  const updateRef = useRef(update);
  const qcRef = useRef(queryClient);
  updateRef.current = update;
  qcRef.current = queryClient;

  // Pre-emptive timer: refresh just before the current token's exp.
  useEffect(() => {
    if (!apiToken) return;
    const exp = jwtExpSeconds(apiToken);
    if (!exp) return;
    const ms = exp * 1000 - Date.now() - REFRESH_LEAD_MS;
    let cancelled = false;
    const tryRefresh = async () => {
      const next = await refreshAccessToken();
      if (cancelled || !next) return;
      await updateRef.current({ apiToken: next });
    };
    if (ms <= 0) {
      void tryRefresh();
      return () => {
        cancelled = true;
      };
    }
    const t = setTimeout(() => {
      void tryRefresh();
    }, ms);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [apiToken]);

  // Catch the closed-laptop case: visibilitychange fires when the tab
  // becomes visible again. If we're already inside the lead window we
  // top up immediately so the very first action after returning succeeds.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = async () => {
      if (document.visibilityState !== "visible") return;
      if (!apiToken) return;
      const exp = jwtExpSeconds(apiToken);
      if (!exp) return;
      if (exp * 1000 - Date.now() > REFRESH_LEAD_MS) return;
      const next = await refreshAccessToken();
      if (next) await updateRef.current({ apiToken: next });
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [apiToken]);

  // Reactive recovery: a tRPC call returned UNAUTHORIZED. Try a silent
  // refresh first; only if that fails do we sign the merchant out.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onUnauthorized = async () => {
      if (signOutPending) return;
      const next = await refreshAccessToken();
      if (next) {
        await updateRef.current({ apiToken: next });
        // Refetch every query that was sitting on a 401; the trpc client
        // will read the fresh apiToken from the updated session.
        await qcRef.current.invalidateQueries();
        return;
      }
      // Refresh failed — the merchant genuinely needs to sign in again.
      if (signOutPending) return;
      signOutPending = true;
      const callbackUrl =
        window.location.pathname + window.location.search;
      toast.error("Session expired", "Please sign in again to continue.");
      void signOut({
        callbackUrl: `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`,
      });
    };
    window.addEventListener(SESSION_UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      window.removeEventListener(SESSION_UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, []);

  return null;
}
