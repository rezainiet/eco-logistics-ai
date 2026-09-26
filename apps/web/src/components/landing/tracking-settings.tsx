"use client";

import { useEffect, useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import { normalizeMetaPixelId } from "@ecom/landing";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * Page settings → Analytics & Tracking. Each landing page has its own Meta
 * Pixel (usually the pixel of the ad account promoting that page); a
 * published page loads only its own. Only the (public) Pixel ID is
 * collected — never an access token. Changes apply without republishing.
 */
export function TrackingSettings({ pageId, className }: { pageId: string; className?: string }) {
  const utils = trpc.useUtils();
  const query = trpc.landingPages.tracking.useQuery({ id: pageId }, { refetchOnWindowFocus: false });
  const save = trpc.landingPages.setTracking.useMutation({
    onSuccess: (r) => {
      toast.success(r.enabled ? "Meta Pixel is on" : "Tracking saved", r.enabled ? "This published page now sends events to Meta." : undefined);
      void utils.landingPages.tracking.invalidate({ id: pageId });
    },
    onError: (e) => toast.error("Tracking not saved", e.message),
  });
  const [pixel, setPixel] = useState("");
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!query.data) return;
    setPixel(query.data.metaPixelId ?? "");
    setEnabled(query.data.enabled);
  }, [query.data]);

  const trimmed = pixel.trim();
  const valid = trimmed === "" || normalizeMetaPixelId(trimmed) !== null;
  const dirty = !!query.data && (trimmed !== (query.data.metaPixelId ?? "") || enabled !== query.data.enabled);

  return (
    <div className={cn("space-y-3 rounded-lg border border-stroke/10 bg-surface p-4", className)} id="tracking">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          <Activity className="h-4 w-4" /> Analytics &amp; Tracking
        </div>
        {query.data?.enabled ? (
          <span className="rounded-full bg-success/15 px-2 py-0.5 text-2xs font-medium text-success">Meta Pixel on</span>
        ) : (
          <span className="rounded-full bg-surface-raised px-2 py-0.5 text-2xs font-medium text-fg-subtle">Off</span>
        )}
      </div>
      <p className="text-xs text-fg-subtle">
        Use the Meta Pixel ID associated with the advertising account for this landing page.
      </p>
      <p className="text-2xs text-fg-faint">
        Applies to this page only. Events are sent from the live page — never from the editor preview or the dashboard. No access
        token is needed (Meta Events Manager → Data sources → Pixel ID).
      </p>
      {query.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-fg-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <label htmlFor="meta-pixel-id" className="text-xs font-medium text-fg-muted">
              Meta Pixel ID
            </label>
            <Input
              id="meta-pixel-id"
              inputMode="numeric"
              autoComplete="off"
              placeholder="e.g. 123456789012345"
              maxLength={24}
              value={pixel}
              onChange={(e) => setPixel(e.target.value)}
              aria-invalid={!valid}
              className="font-mono"
            />
            {!valid ? <p className="text-2xs text-danger">A Pixel ID is 15 or 16 digits.</p> : null}
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-stroke/10 px-3 py-2">
            <span className="text-sm text-fg-muted">Send events to Meta</span>
            <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!trimmed || !valid} aria-label="Send events to Meta" />
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!dirty || !valid || save.isLoading}
              onClick={() => save.mutate({ id: pageId, metaPixelId: trimmed === "" ? null : trimmed, enabled: enabled && trimmed !== "" })}
            >
              {save.isLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Save tracking
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
