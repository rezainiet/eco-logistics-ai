"use client";

/**
 * Legacy-install migration banner — Phase A placeholder.
 *
 * Mounted in Phase E to nudge merchants whose Shopify integration
 * was created before the embedded-app cutover (i.e. their
 * Integration row is missing `credentials.refreshToken` /
 * `credentials.accessTokenExpiresAt`). Those installs sit on
 * Shopify's legacy non-expiring access tokens which the Admin API
 * has begun rejecting; the banner tells them to reconnect, which
 * routes them through the new Token Exchange path.
 *
 * Phase A behaviour: renders nothing. The component is wired up
 * ahead of time so Phase C can drop it into the dashboard shell
 * without a follow-up structural change. Phase E swaps the body in
 * one focused PR.
 *
 * Phase A consumers MUST NOT import this from any production code
 * path — keeping it un-imported guarantees zero bundle impact.
 *
 * Why a `null`-rendering placeholder instead of waiting until
 * Phase E to create the file? Two reasons:
 *
 *   1. Reserves the import path. Future PRs that touch the shell
 *      can mount `<EmbeddedBanner />` without anyone wondering
 *      whether the import will land before or after Phase E.
 *
 *   2. Forces the directory and naming conventions to settle now,
 *      while Phase A risk is still zero. Phase E becomes a pure
 *      content fill-in, not a structural decision.
 */
export function EmbeddedBanner(): null {
  return null;
}
