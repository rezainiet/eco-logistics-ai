"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Loader2 } from "lucide-react";
import { LOCALE_LABELS, type Locale, type TemplateSpec, defaultContent } from "@ecom/landing";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { DevicePreview } from "./device-preview";

const CATEGORY_LABEL: Record<string, string> = {
  all: "All",
  ecommerce: "E-commerce",
  product: "Product",
  service: "Service",
  lead: "Lead",
  general: "General",
};

export function TemplateGallery() {
  const router = useRouter();
  const templates = trpc.landingPages.templates.useQuery();
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("all");
  const [locale, setLocale] = useState<Locale | null>(null);
  const create = trpc.landingPages.create.useMutation({
    onSuccess: (page) => router.push(`/dashboard/landing-pages/${page.id}`),
    onError: (e) => toast.error("Could not create page", e.message),
  });

  const all = templates.data ?? [];
  const categories = useMemo(() => ["all", ...new Set(all.map((t) => t.category))], [all]);
  const shown = category === "all" ? all : all.filter((t) => t.category === category);
  const chosen = all.find((t) => t.id === selected);
  const chosenLocale: Locale | null = chosen ? (locale && chosen.locales.includes(locale) ? locale : chosen.defaultLocale) : null;

  return (
    <div className={cn("space-y-6", chosen && "pb-40")}>
      <Link href="/dashboard/landing-pages" className="inline-flex min-h-9 items-center gap-1 text-sm text-fg-subtle hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> Landing pages
      </Link>
      <PageHeader
        title="Choose a template"
        description="Every template's layout is fixed; you edit the words, images, colours, prices and buttons — in Bangla, English or both."
      />

      {categories.length > 2 ? (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Template category">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={c === category}
              onClick={() => setCategory(c)}
              className={cn(
                "min-h-9 rounded-full px-4 text-sm font-medium",
                c === category ? "bg-brand text-white" : "bg-surface-raised text-fg-subtle hover:text-fg",
              )}
            >
              {CATEGORY_LABEL[c] ?? c}
            </button>
          ))}
        </div>
      ) : null}

      {templates.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-fg-subtle">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading templates…
        </div>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((t) => {
          const spec = t.spec as TemplateSpec;
          const active = t.id === selected;
          const thumbLocale = (active && chosenLocale) || t.defaultLocale;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setSelected(t.id);
                if (!name) setName(`${t.name} page`);
              }}
              className={cn(
                "group overflow-hidden rounded-xl border bg-surface text-left transition-shadow hover:shadow-md",
                active ? "border-brand ring-2 ring-brand/40" : "border-stroke/10",
              )}
            >
              <div className="border-b border-stroke/8 bg-white">
                <DevicePreview
                  spec={spec}
                  content={defaultContent(spec, thumbLocale)}
                  locale={thumbLocale}
                  device="desktop"
                  viewportHeight={250}
                  interactive={false}
                  title={`${t.name} preview`}
                />
              </div>
              <div className="space-y-1 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-fg">{t.name}</span>
                  {active ? <Check className="h-4 w-4 shrink-0 text-brand" /> : null}
                </div>
                <p className="text-xs text-fg-subtle">{t.description}</p>
                <p className="text-2xs uppercase tracking-wide text-fg-faint">
                  {CATEGORY_LABEL[t.category] ?? t.category} · {t.locales.map((l) => LOCALE_LABELS[l].native).join(" / ")}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {chosen && chosenLocale ? (
        <div className="sticky bottom-20 z-10 flex flex-col gap-3 rounded-xl border border-stroke/12 bg-surface p-4 shadow-lg sm:flex-row sm:items-end md:bottom-4">
          <div className="flex-1 space-y-1.5">
            <label htmlFor="lp-name" className="text-xs font-medium text-fg-muted">
              Page name (only you see this)
            </label>
            <Input id="lp-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-fg-muted">Page language</span>
            <div className="flex gap-1 rounded-lg bg-surface-raised p-1" role="radiogroup" aria-label="Page language">
              {chosen.locales.map((l) => (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={l === chosenLocale}
                  lang={l}
                  onClick={() => setLocale(l)}
                  className={cn(
                    "min-h-8 rounded-md px-3 text-sm font-medium",
                    l === chosenLocale ? "bg-surface text-fg shadow-sm" : "text-fg-subtle hover:text-fg",
                  )}
                >
                  {LOCALE_LABELS[l].native}
                </button>
              ))}
            </div>
          </div>
          <Button
            className="min-h-10"
            disabled={!name.trim() || create.isLoading}
            onClick={() => create.mutate({ templateId: chosen.id, name: name.trim(), locale: chosenLocale })}
          >
            {create.isLoading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Create with {chosen.name}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
