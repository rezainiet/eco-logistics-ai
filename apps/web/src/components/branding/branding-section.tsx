"use client";

import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Loader2, Palette, Trash2, Upload } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { dominantColorFromImageData, hexToHsl, readableFg } from "./branding";

const MAX_LOGO_BYTES = 200 * 1024;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/svg+xml", "image/webp", "image/gif"];

/**
 * Settings → Branding tab. Lets a merchant upload a logo, auto-detects an
 * accent colour from it, and persists both via `merchants.updateBranding`.
 *
 * Local state holds the in-progress draft so the merchant can preview
 * changes (sidebar tile, primary button, active nav-row) without writing
 * to the backend until they hit Save. On save we invalidate the profile
 * query so `<BrandingProvider>` (in the dashboard layout) immediately
 * picks up the new colour and re-themes the rest of the app.
 */
export function BrandingSection() {
  const utils = trpc.useUtils();
  const profile = trpc.merchants.getProfile.useQuery();
  const mutation = trpc.merchants.updateBranding.useMutation({
    onSuccess: () => {
      void utils.merchants.getProfile.invalidate();
      toast.success("Branding saved", "The new look is now applied across your dashboard.");
    },
    onError: (err) => {
      toast.error("Couldn't save branding", err.message);
    },
  });

  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [color, setColor] = useState<string>("");
  const [touched, setTouched] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Sync local state from server. Runs once on first load and again after
  // every saved mutation (we invalidate the query so this fires).
  useEffect(() => {
    if (!profile.data) return;
    setLogoDataUrl(profile.data.branding?.logoDataUrl ?? null);
    setColor(profile.data.branding?.primaryColor ?? "");
    setTouched(false);
  }, [profile.data]);

  async function onPickFile(file: File) {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast.error("Unsupported file", "Use PNG, JPG, SVG, WebP, or GIF.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error(
        "Logo too large",
        `Keep it under ${Math.round(MAX_LOGO_BYTES / 1024)} KB. We embed it inline so smaller is faster.`,
      );
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    setLogoDataUrl(dataUrl);
    setTouched(true);
    // Try to auto-extract a colour from the new logo. SVG can't be drawn
    // through Canvas + getImageData reliably across browsers, so we skip
    // extraction for SVG and let the merchant pick a colour by hand.
    if (file.type === "image/svg+xml") return;
    try {
      setExtracting(true);
      const detected = await extractDominantColor(dataUrl);
      if (detected) {
        setColor(detected);
      }
    } catch {
      // Silent — extraction is a convenience, not required.
    } finally {
      setExtracting(false);
    }
  }

  function clearLogo() {
    setLogoDataUrl(null);
    setTouched(true);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onSave() {
    if (!touched) return;
    const payload: {
      logoDataUrl?: string | null;
      primaryColor?: string | null;
    } = {};
    const serverLogo = profile.data?.branding?.logoDataUrl ?? null;
    const serverColor = profile.data?.branding?.primaryColor ?? null;
    if ((logoDataUrl ?? null) !== serverLogo) payload.logoDataUrl = logoDataUrl;
    if ((color || null) !== serverColor) {
      payload.primaryColor = color ? color : null;
    }
    if (Object.keys(payload).length === 0) {
      setTouched(false);
      return;
    }
    await mutation.mutateAsync(payload);
  }

  const hexValid = !color || /^#[0-9a-fA-F]{6}$/.test(color);

  return (
    <Card className="border-stroke/10 bg-surface text-fg">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand/14">
            <Palette className="h-5 w-5 text-brand" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-lg font-semibold">Brand identity</CardTitle>
            <CardDescription className="text-fg-subtle">
              Upload your logo and pick an accent colour. We&apos;ll re-theme your dashboard
              automatically — sidebar, buttons, status pills, the lot.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-3">
            <Label className="text-fg-subtle">Logo</Label>
            <div className="flex items-center gap-4 rounded-lg border border-stroke/10 bg-surface-overlay p-4">
              <div
                className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-stroke/12 bg-surface-raised"
                aria-label="Logo preview"
              >
                {logoDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={logoDataUrl}
                    alt="Your logo"
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <ImageIcon className="h-7 w-7 text-fg-faint" aria-hidden />
                )}
              </div>
              <div className="flex-1 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="border-stroke/14 text-fg-muted hover:text-fg"
                    onClick={() => fileRef.current?.click()}
                    disabled={mutation.isLoading}
                  >
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    {logoDataUrl ? "Replace" : "Upload"}
                  </Button>
                  {logoDataUrl ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="border-stroke/14 text-fg-muted hover:text-danger"
                      onClick={clearLogo}
                      disabled={mutation.isLoading}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      Remove
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-fg-faint">
                  PNG, JPG, SVG, WebP, GIF · up to 200 KB · square logos read best
                </p>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPTED_TYPES.join(",")}
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onPickFile(f);
              }}
            />
          </div>

          <div className="space-y-3">
            <Label className="text-fg-subtle">Accent colour</Label>
            <div className="flex items-center gap-3 rounded-lg border border-stroke/10 bg-surface-overlay p-4">
              <input
                type="color"
                value={hexValid && color ? color : "#0084d4"}
                onChange={(e) => {
                  setColor(e.target.value);
                  setTouched(true);
                }}
                className="h-12 w-12 cursor-pointer rounded-lg border border-stroke/14 bg-transparent"
                aria-label="Pick accent colour"
              />
              <div className="flex-1 space-y-1">
                <Input
                  value={color}
                  onChange={(e) => {
                    setColor(e.target.value.trim());
                    setTouched(true);
                  }}
                  placeholder="#0084d4"
                  className={`font-mono ${hexValid ? "" : "border-danger/60"}`}
                  spellCheck={false}
                />
                {extracting ? (
                  <p className="flex items-center gap-1 text-xs text-fg-subtle">
                    <Loader2 className="h-3 w-3 animate-spin" /> Extracting from logo…
                  </p>
                ) : !hexValid ? (
                  <p className="text-xs text-danger">Use a 6-digit hex like #0084d4.</p>
                ) : (
                  <p className="text-xs text-fg-faint">
                    Auto-detected from your logo when you upload one. Edit anytime.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-fg-subtle">Live preview</Label>
          <BrandingPreview color={hexValid ? color : ""} logoDataUrl={logoDataUrl} />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-stroke/8 pt-4">
          <Button
            type="button"
            variant="outline"
            className="border-stroke/14 text-fg-muted"
            onClick={() => {
              setLogoDataUrl(profile.data?.branding?.logoDataUrl ?? null);
              setColor(profile.data?.branding?.primaryColor ?? "");
              setTouched(false);
            }}
            disabled={!touched || mutation.isLoading}
          >
            Reset
          </Button>
          <Button
            type="button"
            className="bg-brand text-white hover:bg-brand-hover"
            onClick={onSave}
            disabled={!touched || !hexValid || mutation.isLoading}
          >
            {mutation.isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Save branding"
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Tiny isolated preview so the merchant can see what their accent does to
 * the sidebar tile, a primary button, and a sample active nav row before
 * committing. Uses inline `--brand` overrides so it doesn't accidentally
 * theme the surrounding settings page.
 */
function BrandingPreview({
  color,
  logoDataUrl,
}: {
  color: string;
  logoDataUrl: string | null;
}) {
  const hsl = color ? hexToHsl(color) : null;
  const fg = color ? readableFg(color) : "white";
  const styleVars: React.CSSProperties = hsl
    ? ({
        ["--brand" as never]: `${hsl.h} ${hsl.s}% ${hsl.l}%`,
        ["--brand-hover" as never]: `${hsl.h} ${hsl.s}% ${Math.max(0, hsl.l - 6)}%`,
        ["--brand-active" as never]: `${hsl.h} ${hsl.s}% ${Math.max(0, hsl.l - 12)}%`,
        ["--brand-fg" as never]: fg === "white" ? "0 0% 100%" : "0 0% 0%",
      } as React.CSSProperties)
    : {};
  return (
    <div
      style={styleVars}
      className="flex flex-col gap-3 rounded-xl border border-stroke/10 bg-surface-base p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-center gap-3">
        <span
          className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg text-sm font-bold"
          style={{
            backgroundColor: hsl ? "hsl(var(--brand))" : "hsl(var(--brand))",
            color: hsl ? "hsl(var(--brand-fg))" : "hsl(var(--brand-fg))",
          }}
          aria-hidden
        >
          {logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoDataUrl} alt="" className="h-full w-full object-contain" />
          ) : (
            "L"
          )}
        </span>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-fg">Sidebar tile</p>
          <p className="text-xs text-fg-faint">how your logo greets you</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-xs font-medium"
          style={{
            backgroundColor: "hsl(var(--brand) / 0.14)",
            color: "hsl(var(--brand))",
          }}
        >
          Active nav row
        </span>
        <button
          type="button"
          className="inline-flex h-9 items-center rounded-md px-3 text-xs font-medium transition-colors"
          style={{
            backgroundColor: "hsl(var(--brand))",
            color: "hsl(var(--brand-fg))",
          }}
          tabIndex={-1}
        >
          Primary button
        </button>
      </div>
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

/**
 * Draw the image into a Canvas at a small thumbnail size, pull pixel data,
 * and pass it to the pure colour-binner. We keep the thumbnail small
 * (256 px on the longest side) so this stays well under 50 ms even on
 * cheap devices.
 */
async function extractDominantColor(dataUrl: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxSide = 256;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, w, h);
      try {
        const data = ctx.getImageData(0, 0, w, h).data;
        resolve(dominantColorFromImageData(data));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
