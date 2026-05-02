"use client";

/**
 * Silent access-token refresh helpers.
 *
 * The API issues an access JWT (1 hour) at /auth/login and a refresh JWT
 * (14 days, HttpOnly cookie) at the API origin. Without help, NextAuth holds
 * the original access token forever and every dashboard call eventually
 * 401s. This module is the bridge: it asks /auth/refresh for a fresh access
 * token using the HttpOnly cookie, returns the new token to the caller, and
 * leaves it to the caller to push the value into the NextAuth session via
 * `useSession().update({ apiToken })`.
 *
 * Concurrency-safe: a flurry of 401s during a slow window triggers exactly
 * one /auth/refresh round-trip — subsequent callers ride along on the same
 * promise.
 */

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

let inflight: Promise<string | null> | null = null;

export function refreshAccessToken(): Promise<string | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(`${apiUrl}/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { token?: unknown };
      return typeof body.token === "string" ? body.token : null;
    } catch {
      return null;
    } finally {
      // Release the cache after a tick so a follow-up call gets a real
      // attempt rather than a stale "we already tried" answer.
      setTimeout(() => {
        inflight = null;
      }, 1000);
    }
  })();
  return inflight;
}

/**
 * Decode the `exp` claim from an access JWT *without* verifying. Used to
 * schedule a pre-emptive refresh ~1 minute before the token would expire.
 * Verification still happens server-side at /trpc; the web only needs the
 * deadline to know when to swap.
 */
export function jwtExpSeconds(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}
