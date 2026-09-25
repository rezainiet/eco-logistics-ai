"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  LOCALE_LABELS,
  type Locale,
  type PreviewDevice,
  type TemplateSpec,
  defaultContent,
  isLocale,
  parseTemplateSpec,
  templateLocales,
} from "@ecom/landing";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { DevicePreview, DeviceToggle } from "./device-preview";

function Loading({ error }: { error?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-neutral-500">
      {error ?? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" /> Loading preview…
        </>
      )}
    </div>
  );
}

function useViewportHeight(offset: number) {
  const [h, setH] = useState(800);
  useEffect(() => {
    const update = () => setH(Math.max(400, window.innerHeight - offset));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [offset]);
  return h;
}

function PreviewShell({
  label,
  locales,
  locale,
  onLocale,
  children,
}: {
  label: ReactNode;
  locales: Locale[];
  locale: Locale;
  onLocale: (l: Locale) => void;
  children: (device: PreviewDevice, height: number) => ReactNode;
}) {
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const height = useViewportHeight(72);
  useEffect(() => {
    if (window.innerWidth < 768) setDevice("mobile");
  }, []);
  return (
    <div className="min-h-screen bg-neutral-100">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 bg-neutral-900 px-4 py-2 text-xs text-white">
        <span className="font-medium">{label}</span>
        <div className="flex flex-wrap items-center gap-2">
          {locales.length > 1 ? (
            <div className="inline-flex rounded-lg bg-white/10 p-1">
              {locales.map((l) => (
                <button
                  key={l}
                  type="button"
                  lang={l}
                  onClick={() => onLocale(l)}
                  className={cn("min-h-8 rounded-md px-3", l === locale ? "bg-white text-neutral-900" : "text-white/80")}
                >
                  {LOCALE_LABELS[l].native}
                </button>
              ))}
            </div>
          ) : null}
          <DeviceToggle device={device} onChange={setDevice} className="bg-white/10 [&_button]:text-white/80" />
        </div>
      </div>
      <div className="mx-auto max-w-[1480px] p-3">{children(device, height - 24)}</div>
    </div>
  );
}

/** Saved draft of a merchant's page, at a real device width. */
export function DraftPreview({ pageId, initialLocale }: { pageId: string; initialLocale: string | null }) {
  const q = trpc.landingPages.get.useQuery({ id: pageId }, { refetchOnWindowFocus: true });
  const [locale, setLocale] = useState<Locale | null>(isLocale(initialLocale) ? initialLocale : null);
  if (!q.data) return <Loading error={q.error?.message} />;
  const locales = q.data.page.locales;
  const current = locale && locales.includes(locale) ? locale : q.data.page.defaultLocale;
  const content = (q.data.draftContent as Record<string, unknown>)[current] ?? {};
  return (
    <PreviewShell
      label={`Draft preview · “${q.data.page.name}” · saved draft rev ${q.data.page.draftRevision} · not visible to the public`}
      locales={locales}
      locale={current}
      onLocale={setLocale}
    >
      {(device, height) => (
        <DevicePreview spec={q.data.spec as TemplateSpec} content={content} locale={current} device={device} viewportHeight={height} />
      )}
    </PreviewShell>
  );
}

/** Admin preview of a template version with its default content. */
export function TemplateVersionPreview({ templateId, version }: { templateId: string; version: number | null }) {
  const q = trpc.adminLandingTemplates.get.useQuery({ id: templateId });
  const [locale, setLocale] = useState<Locale | null>(null);
  if (!q.data) return <Loading error={q.error?.message} />;
  const v = version ? q.data.versions.find((x) => x.version === version) : q.data.versions[0];
  if (!v) return <Loading error="Version not found" />;
  const parsed = parseTemplateSpec(v.spec);
  if (!parsed.ok) return <Loading error="This version's spec is invalid" />;
  const spec = parsed.spec;
  const locales = templateLocales(spec);
  const current = locale && locales.includes(locale) ? locale : spec.defaultLocale ?? locales[0]!;
  return (
    <PreviewShell
      label={`Template preview · ${q.data.template.name} v${v.version} (${v.status}) · default content`}
      locales={locales}
      locale={current}
      onLocale={setLocale}
    >
      {(device, height) => (
        <DevicePreview spec={spec} content={defaultContent(spec, current)} locale={current} device={device} viewportHeight={height} />
      )}
    </PreviewShell>
  );
}
