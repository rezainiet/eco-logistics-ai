"use client";

import { useEffect, useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import { normalizeGa4Id, normalizeGoogleAdsId, normalizeGoogleAdsLabel, normalizeMetaPixelId, normalizeTiktokPixelId } from "@ecom/landing";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * Page settings → Analytics & Tracking. Each landing page has its own
 * tracking IDs (usually those of the ad accounts promoting that page):
 * Meta Pixel, Google (GA4 and/or Google Ads) and TikTok Pixel, each with its
 * own switch. A published page loads only what is switched on for it. Only
 * public IDs are collected — never access tokens or API secrets. Changes
 * apply without republishing.
 */

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  valid,
  error,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  valid: boolean;
  error: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-fg-muted">
        {label}
      </label>
      <Input
        id={id}
        autoComplete="off"
        placeholder={placeholder}
        maxLength={48}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!valid}
        className="font-mono"
      />
      {!valid ? <p className="text-2xs text-danger">{error}</p> : hint ? <p className="text-2xs text-fg-faint">{hint}</p> : null}
    </div>
  );
}

function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-stroke/10 px-3 py-2">
      <span className="text-sm text-fg-muted">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
    </div>
  );
}

const ok = (v: string, normalize: (x: unknown) => string | null) => v.trim() === "" || normalize(v) !== null;
const orNull = (v: string) => (v.trim() === "" ? null : v.trim());

export function TrackingSettings({ pageId, className }: { pageId: string; className?: string }) {
  const utils = trpc.useUtils();
  const query = trpc.landingPages.tracking.useQuery({ id: pageId }, { refetchOnWindowFocus: false });
  const save = trpc.landingPages.setTracking.useMutation({
    onSuccess: () => {
      toast.success("Tracking saved", "Changes apply to the live page right away.");
      void utils.landingPages.tracking.invalidate({ id: pageId });
      void utils.marketing.trackingStatus.invalidate();
    },
    onError: (e) => toast.error("Tracking not saved", e.message),
  });
  const [pixel, setPixel] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [ga4, setGa4] = useState("");
  const [ads, setAds] = useState("");
  const [label, setLabel] = useState("");
  const [googleOn, setGoogleOn] = useState(false);
  const [tiktok, setTiktok] = useState("");
  const [tiktokOn, setTiktokOn] = useState(false);

  useEffect(() => {
    const d = query.data;
    if (!d) return;
    setPixel(d.metaPixelId ?? "");
    setEnabled(d.enabled);
    setGa4(d.google.ga4MeasurementId ?? "");
    setAds(d.google.googleAdsId ?? "");
    setLabel(d.google.googleAdsPurchaseLabel ?? "");
    setGoogleOn(d.google.enabled);
    setTiktok(d.tiktok.pixelId ?? "");
    setTiktokOn(d.tiktok.enabled);
  }, [query.data]);

  const valid = {
    meta: ok(pixel, normalizeMetaPixelId),
    ga4: ok(ga4, normalizeGa4Id),
    ads: ok(ads, normalizeGoogleAdsId),
    label: ok(label, normalizeGoogleAdsLabel) && !(label.trim() && !ads.trim()),
    tiktok: ok(tiktok, normalizeTiktokPixelId),
  };
  const allValid = Object.values(valid).every(Boolean);
  const hasGoogle = !!(ga4.trim() || ads.trim());
  const d = query.data;
  const dirty =
    !!d &&
    (pixel.trim() !== (d.metaPixelId ?? "") ||
      enabled !== d.enabled ||
      ga4.trim() !== (d.google.ga4MeasurementId ?? "") ||
      ads.trim() !== (d.google.googleAdsId ?? "") ||
      label.trim() !== (d.google.googleAdsPurchaseLabel ?? "") ||
      googleOn !== d.google.enabled ||
      tiktok.trim() !== (d.tiktok.pixelId ?? "") ||
      tiktokOn !== d.tiktok.enabled);
  const onCount = d ? [d.enabled, d.google.enabled, d.tiktok.enabled].filter(Boolean).length : 0;

  return (
    <div className={cn("space-y-4 rounded-lg border border-stroke/10 bg-surface p-4", className)} id="tracking">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          <Activity className="h-4 w-4" /> Analytics &amp; Tracking
        </div>
        {onCount > 0 ? (
          <span className="rounded-full bg-success/15 px-2 py-0.5 text-2xs font-medium text-success">
            {[d?.enabled && "Meta", d?.google.enabled && "Google", d?.tiktok.enabled && "TikTok"].filter(Boolean).join(" · ")} on
          </span>
        ) : (
          <span className="rounded-full bg-surface-raised px-2 py-0.5 text-2xs font-medium text-fg-subtle">Off</span>
        )}
      </div>
      <p className="text-2xs text-fg-faint">
        Applies to this page only. Events are sent from the live page — never from the editor preview or the dashboard. Only public IDs are
        needed; never paste an access token or API key here.
      </p>
      {query.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-fg-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <section className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Meta</h4>
            <p className="text-xs text-fg-subtle">Use the Meta Pixel ID associated with the advertising account for this landing page.</p>
            <Field
              id="meta-pixel-id"
              label="Meta Pixel ID"
              value={pixel}
              onChange={setPixel}
              placeholder="e.g. 123456789012345"
              valid={valid.meta}
              error="A Pixel ID is 15 or 16 digits."
              hint="Meta Events Manager → Data sources → Pixel ID."
            />
            <Toggle label="Send events to Meta" checked={enabled} onChange={setEnabled} disabled={!pixel.trim() || !valid.meta} />
          </section>

          <section className="space-y-2 border-t border-stroke/8 pt-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Google</h4>
            <Field
              id="ga4-id"
              label="Google Analytics 4 measurement ID"
              value={ga4}
              onChange={setGa4}
              placeholder="e.g. G-ABC123XYZ9"
              valid={valid.ga4}
              error="A GA4 measurement ID looks like G-ABC123XYZ9."
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <Field
                id="google-ads-id"
                label="Google Ads tag ID"
                value={ads}
                onChange={setAds}
                placeholder="e.g. AW-123456789"
                valid={valid.ads}
                error="A Google Ads tag ID looks like AW-123456789."
              />
              <Field
                id="google-ads-label"
                label="Purchase conversion label"
                value={label}
                onChange={setLabel}
                placeholder="e.g. AbC-D_efG-h12"
                valid={valid.label}
                error={label.trim() && !ads.trim() ? "Add the Google Ads tag ID first." : "The label is the part after the slash."}
                hint="Optional. Without it, no purchase conversion is sent to Google Ads."
              />
            </div>
            <Toggle label="Send events to Google" checked={googleOn} onChange={setGoogleOn} disabled={!hasGoogle || !valid.ga4 || !valid.ads} />
          </section>

          <section className="space-y-2 border-t border-stroke/8 pt-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">TikTok</h4>
            <Field
              id="tiktok-pixel-id"
              label="TikTok Pixel ID"
              value={tiktok}
              onChange={setTiktok}
              placeholder="e.g. C4ABCDEF1234567890GH"
              valid={valid.tiktok}
              error="A TikTok Pixel ID is about 20 letters and digits."
              hint="TikTok Ads Manager → Assets → Events → Web events."
            />
            <Toggle label="Send events to TikTok" checked={tiktokOn} onChange={setTiktokOn} disabled={!tiktok.trim() || !valid.tiktok} />
          </section>

          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!dirty || !allValid || save.isLoading}
              onClick={() =>
                save.mutate({
                  id: pageId,
                  metaPixelId: orNull(pixel),
                  enabled: enabled && !!pixel.trim(),
                  google: { ga4MeasurementId: orNull(ga4), googleAdsId: orNull(ads), googleAdsPurchaseLabel: orNull(label), enabled: googleOn && hasGoogle },
                  tiktok: { pixelId: orNull(tiktok), enabled: tiktokOn && !!tiktok.trim() },
                })
              }
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
