"use client";

import Link from "next/link";
import { useShopifyAuth } from "../_components/shopify-auth-context";

/**
 * Embedded entry page — `/embedded`.
 *
 * Phase C diagnostic surface. This page has three jobs:
 *
 *   1. Be the destination Shopify Admin iframes us at once Phase D
 *      flips `embedded = true` and updates `application_url` in
 *      `shopify.app.toml` to point here. Until then it's reachable
 *      directly at https://app.confirmx.ai/embedded for manual
 *      verification by ops + during Phase D rollout.
 *
 *   2. Surface the embedded auth state visually so Phase D's smoke
 *      test (uninstall + reinstall on dev store, watch this page
 *      load) can confirm the token-exchange chain end-to-end without
 *      any other UI to interpret. The page intentionally renders
 *      raw status + a token-prefix mask + a retry button — dev-only
 *      ergonomics.
 *
 *   3. Provide a "back to direct dashboard" escape hatch. If a
 *      developer or operator opens `/embedded` outside the iframe
 *      (where App Bridge will fail), they need a clear way out.
 *      The error state surfaces this link.
 *
 * Phase D will replace this page's body with the actual embedded
 * dashboard content (most likely by importing the same shell
 * components used by `/dashboard`). Phase C's job is just to land
 * the route + verify the auth chain is correctly wired.
 *
 * Reversibility: deleting this single file removes the embedded
 * entry. The (embedded) layout still exists but renders nothing
 * because no child page is matched. Other routes are unaffected.
 */
export default function EmbeddedEntryPage() {
  const auth = useShopifyAuth();
  // The layout always mounts the provider, so `auth` is non-null
  // inside this group. The early null check is defensive against a
  // future refactor that detaches the page from the layout.
  if (!auth) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-xl font-semibold">Embedded shell not mounted</h1>
        <p className="text-sm text-fg-muted">
          The Shopify auth context is missing. This usually means you
          opened this route outside the (embedded) layout. Try{" "}
          <Link href="/dashboard" className="underline">
            the direct dashboard
          </Link>
          {" "}instead.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-xl font-semibold">ConfirmX</h1>
      <p className="text-sm text-fg-muted">
        Setting up your embedded session…
      </p>

      <div className="w-full rounded-lg border border-stroke/10 bg-surface px-5 py-4 text-left text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium uppercase tracking-wide text-fg-muted">
            Status
          </span>
          <StatusPill status={auth.status} />
        </div>
        {auth.shop ? (
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="font-medium uppercase tracking-wide text-fg-muted">
              Shop
            </span>
            <span className="font-mono text-fg">{auth.shop}</span>
          </div>
        ) : null}
        {auth.apiToken ? (
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="font-medium uppercase tracking-wide text-fg-muted">
              Session
            </span>
            <span className="font-mono text-fg">
              {auth.apiToken.slice(0, 6)}…{auth.apiToken.slice(-6)}
            </span>
          </div>
        ) : null}
        {auth.error ? (
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="font-medium uppercase tracking-wide text-danger">
              Error
            </span>
            <span className="font-mono text-danger">{auth.error}</span>
          </div>
        ) : null}
      </div>

      {auth.status === "error" ? (
        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={auth.retry}
            className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:bg-brand-hover"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="text-xs text-fg-muted underline-offset-2 hover:underline"
          >
            Open the direct dashboard instead
          </Link>
        </div>
      ) : null}

      {auth.status === "ready" ? (
        <p className="text-xs text-fg-muted">
          You can close this tab. ConfirmX is ready inside Shopify Admin.
        </p>
      ) : null}
    </main>
  );
}

function StatusPill({
  status,
}: {
  status: "idle" | "loading" | "ready" | "error";
}) {
  const tone =
    status === "ready"
      ? "bg-success-subtle text-success"
      : status === "error"
        ? "bg-danger-subtle text-danger"
        : "bg-surface-raised text-fg-muted";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider ${tone}`}
    >
      {status}
    </span>
  );
}
