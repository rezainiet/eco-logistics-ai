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
 * Landing pages → Analytics & tracking. One Meta Pixel for all of the
 * merchant's published pages. Only the (public) Pixel ID is collected —
 * never an access token. Changes apply to live pages without republishing.
 */
export function TrackingSettings({ className }: { className?: string }) {
  const utils = trpc.useUtils();
  const query = trpc.landingPages.tracking.useQuery(undefined, { refetchOnWindowFocus: false });
  const save = trpc.landingPages.setTracking.useMutation({
    onSuccess: (r) => {
      toast.success(r.enabled ? "Meta Pixel is on" : "Tracking saved", r.enabled ? "Your published pages now send events to Meta." : undefined);
      void utils.landingPages.tracking.invalidate();
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
          <Activity className="h-4 w-4" /> Analytics &amp; tracking
        </div>
        {query.data?.enabled ? (
          <span className="rounded-full bg-success/15 px-2 py-0.5 text-2xs font-medium text-success">Meta Pixel on</span>
        ) : (
          <span className="rounded-full bg-surface-raised px-2 py-0.5 text-2xs font-medium text-fg-subtle">Off</span>
        )}
      </div>
      <p className="text-xs text-fg-subtle">
        Applies to all your published landing pages. Events are sent only from the live pages — never from the editor preview. No
        access token is needed: enter only your Pixel ID (Meta Events Manager → Data sources).
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
              onClick={() => save.mutate({ metaPixelId: trimmed === "" ? null : trimmed, enabled: enabled && trimmed !== "" })}
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
