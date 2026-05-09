"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";

/**
 * Client side of the public-install completion page. Runs the
 * `integrations.completeShopifyInstall` mutation once on mount, then
 * routes the merchant into /dashboard/settings/integrations.
 *
 * Errors are rendered inline. The two cases worth distinguishing for the
 * merchant:
 *   - claim_not_found_or_expired: the 15-minute window elapsed, OR the
 *     token was already used. Either way the only safe action is to
 *     restart the install from Shopify.
 *   - another_shop_already_connected: the merchant already linked a
 *     different Shopify store. Send them to the integrations panel where
 *     they can disconnect the existing one before reinstalling.
 */
export function FinalizeClient({
  token,
  shop,
}: {
  token: string;
  shop: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [conflictShop, setConflictShop] = useState<string | null>(null);
  const ranRef = useRef(false);

  const finalize = trpc.integrations.completeShopifyInstall.useMutation({
    onSuccess: () => {
      const search = new URLSearchParams({
        connected: "shopify",
        ...(shop ? { shop } : {}),
      }).toString();
      router.replace(`/dashboard/settings/integrations?${search}`);
    },
    onError: (err) => {
      const msg = err.message ?? "";
      if (msg.startsWith("another_shop_already_connected:")) {
        setConflictShop(msg.split(":")[1] ?? null);
        setError("another_shop_already_connected");
      } else if (
        msg === "claim_not_found_or_expired" ||
        msg === "claim_corrupt"
      ) {
        setError("claim_not_found_or_expired");
      } else if (msg === "claim_storage_unavailable") {
        setError("claim_storage_unavailable");
      } else {
        setError(msg || "unknown");
      }
    },
  });

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    finalize.mutate({ token });
    // We deliberately fire-once on mount; finalize.mutate is stable across
    // renders for our purposes and double-submitting would just hit the
    // single-use claim guard server-side anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!error) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-fg-muted" aria-hidden />
        <h1 className="text-lg font-semibold">Connecting your Shopify store…</h1>
        <p className="text-sm text-fg-muted">
          {shop ? `Linking ${shop} to your ConfirmX workspace.` : "Linking your store to your ConfirmX workspace."}
        </p>
      </div>
    );
  }

  if (error === "another_shop_already_connected") {
    return (
      <div className="mx-auto max-w-md space-y-3 py-12 text-center">
        <h1 className="text-xl font-semibold">Another store is already connected</h1>
        <p className="text-sm text-fg-muted">
          {conflictShop
            ? `Your ConfirmX account is currently linked to ${conflictShop}.`
            : "Your ConfirmX account is currently linked to another Shopify store."}{" "}
          Disconnect it from the integrations panel before installing a new one.
        </p>
        <button
          type="button"
          onClick={() => router.replace("/dashboard/settings/integrations")}
          className="text-sm font-medium text-brand underline"
        >
          Go to integrations
        </button>
      </div>
    );
  }

  if (error === "claim_not_found_or_expired") {
    return (
      <div className="mx-auto max-w-md space-y-3 py-12 text-center">
        <h1 className="text-xl font-semibold">This install link has expired</h1>
        <p className="text-sm text-fg-muted">
          Install links work for 15 minutes. Start the install again from
          your Shopify admin.
        </p>
      </div>
    );
  }

  if (error === "claim_storage_unavailable") {
    return (
      <div className="mx-auto max-w-md space-y-3 py-12 text-center">
        <h1 className="text-xl font-semibold">We couldn&apos;t finish the install</h1>
        <p className="text-sm text-fg-muted">
          A temporary backend issue blocked the final step. Please try the
          install again from your Shopify admin in a moment.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-3 py-12 text-center">
      <h1 className="text-xl font-semibold">We couldn&apos;t connect your store</h1>
      <p className="text-sm text-fg-muted">
        Please retry the install from your Shopify admin. If the problem
        persists, contact support and include the error code below.
      </p>
      <code className="block rounded bg-surface-raised px-2 py-1 text-xs text-fg-muted">
        {error}
      </code>
    </div>
  );
}
