"use client";

import { useEffect, useRef } from "react";
import { signOut, useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { jwtExpSeconds, refreshAccessToken } from "@/lib/auth-refresh";
import { SESSION_UNAUTHORIZED_EVENT } from "@/app/providers";
import { toast } from "@/components/ui/toast";

/**
 * Keeps the merchant signed in across access-token expiry without bouncing
 * them to /login while the silent refresh path is healthy. When silent
 * refresh fails (refresh token missing, expired, or session revoked), we
 * force a clean sign-out so the merchant lands on /login instead of a
 * dashboard whose every query is silently 401-ing.
 *
 * The access JWT lives 1 hour. NextAuth's session is 30 days. Three paths
 * try to keep them in sync:
 *
 *   1. Pre-emptive timer: refresh ~1 min before the access token would
 *      expire (silent, in the background).
 *   2. Tab-visible / window-focus: top up if we're inside the lead window.
 *   3. SESSION_UNAUTHORIZED_EVENT from the queryCache when a tRPC call
 *      returns 401 (reactive — token died between timer fires).
 *
 * In all three paths the recovery is the same:
 *   - POST /auth/refresh with credentials so the HttpOnly refresh cookie
 *     goes along; the API rotates the session and returns a new access JWT.
 *   - Push the new token into the NextAuth session via update() so the
 *     tRPC client picks it up on its next call.
 *   - Invalidate the React-Query cache so failed queries refetch.
 *   - If /auth/refresh itself fails — IMMEDIATELY sign the merchant out
 *     and bounce them to /login. Previously the proactive + visibility
 *     paths silently swallowed refresh failures, which left the dashboard
 *     mounted with a dead apiToken (every query 401-ing, no recovery
 *     surface). The launch-blocker fix is to fail loud in all three
 *     paths.
 *
 * Defensive bonus: on first mount we look at the apiToken's exp claim
 * directly. If it has already passed (laptop closed overnight, came back
 * the next morning), we don't even bother attempting a refresh; we go
 * straight to the sign-out flow. This catches the "merchant returns to a
 * stale tab" case before any tRPC query has a chance to render an empty
 * dashboard.
 */
const REFRESH_LEAD_MS = 60_000;

// Module-scoped guard against double sign-out across the keeper's three
// recovery paths. Reset on full page reload after `signOut()` navigates.
let signOutPending = false;

function forceSignOut(reason: string): void {
  if (typeof window === "undefined") return;
  if (signOutPending) return;
  signOutPending = true;
  const callbackUrl = window.location.pathname + window.location.search;
  console.log("[token-refresh] forcing sign-out", { reason });
  toast.error("Session expired", "Please sign in again to continue.");
  void signOut({
    callbackUrl: `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`,
  });
}

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

  // Defensive: on mount, if the apiToken is already past-exp, sign out
  // immediately. Catches the "merchant returns to a stale tab" case
  // before any tRPC query has a chance to render an empty dashboard.
  useEffect(() => {
    if (!apiToken) return;
    const exp = jwtExpSeconds(apiToken);
    if (!exp) return;
    if (exp * 1000 > Date.now()) return;
    // Token already expired. Try one refresh attempt; if that fails,
    // sign out cleanly.
    let cancelled = false;
    void (async () => {
      const next = await refreshAccessToken();
      if (cancelled) return;
      if (next) {
        await updateRef.current({ apiToken: next });
        await qcRef.current.invalidateQueries();
        return;
      }
      forceSignOut("apiToken_already_expired_on_mount");
    })();
    return () => {
      cancelled = true;
    };
  }, [apiToken]);

  // Pre-emptive timer: refresh just before the current token's exp.
  useEffect(() => {
    if (!apiToken) return;
    const exp = jwtExpSeconds(apiToken);
    if (!exp) return;
    const ms = exp * 1000 - Date.now() - REFRESH_LEAD_MS;
    let cancelled = false;
    const tryRefresh = async () => {
      const next = await refreshAccessToken();
      if (cancelled) return;
      if (next) {
        await updateRef.current({ apiToken: next });
        return;
      }
      // Refresh failed inside the proactive window — sign out so the
      // dashboard does not sit on a dead token. Previously this path
      // silently returned, which is exactly the broken-empty-state
      // failure mode the launch QA caught.
      forceSignOut("proactive_refresh_failed");
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
  // becomes visible again. If we are already inside the lead window we
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
      if (next) {
        await updateRef.current({ apiToken: next });
        return;
      }
      forceSignOut("visibility_refresh_failed");
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
        // Refetch every query that was sitting on a 401; the tRPC
        // client will read the fresh apiToken from the updated session.
        await qcRef.current.invalidateQueries();
        return;
      }
      forceSignOut("unauthorized_refresh_failed");
    };
    window.addEventListener(SESSION_UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      window.removeEventListener(SESSION_UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, []);

  return null;
}
