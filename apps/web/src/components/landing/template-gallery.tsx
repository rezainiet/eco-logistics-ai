"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Loader2 } from "lucide-react";
import { type TemplateSpec, defaultContent } from "@ecom/landing";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { ScaledLandingPreview } from "./landing-preview";

export function TemplateGallery() {
  const router = useRouter();
  const templates = trpc.landingPages.templates.useQuery();
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const create = trpc.landingPages.create.useMutation({
    onSuccess: (page) => router.push(`/dashboard/landing-pages/${page.id}`),
    onError: (e) => toast.error("Could not create page", e.message),
  });

  const chosen = templates.data?.find((t) => t.id === selected);

  return (
    <div className="space-y-6">
      <Link href="/dashboard/landing-pages" className="inline-flex items-center gap-1 text-sm text-fg-subtle hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> Landing pages
      </Link>
      <PageHeader title="Choose a template" description="Every template's layout is fixed; you edit the words, images, colours and buttons." />

      {templates.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-fg-subtle">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading templates…
        </div>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {templates.data?.map((t) => {
          const spec = t.spec as TemplateSpec;
          const active = t.id === selected;
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
              <div className="pointer-events-none border-b border-stroke/8 bg-white" aria-hidden="true">
                <ScaledLandingPreview spec={spec} content={defaultContent(spec)} assetBaseUrl={null} maxHeight={260} />
              </div>
              <div className="space-y-1 p-4">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-fg">{t.name}</span>
                  {active ? <Check className="h-4 w-4 text-brand" /> : null}
                </div>
                <p className="text-xs text-fg-subtle">{t.description}</p>
                <p className="text-2xs uppercase tracking-wide text-fg-faint">{t.category}</p>
              </div>
            </button>
          );
        })}
      </div>

      {chosen ? (
        <div className="sticky bottom-4 flex flex-col gap-3 rounded-xl border border-stroke/12 bg-surface p-4 shadow-lg sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <label htmlFor="lp-name" className="text-xs font-medium text-fg-muted">
              Page name (only you see this)
            </label>
            <Input id="lp-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button
            disabled={!name.trim() || create.isLoading}
            onClick={() => create.mutate({ templateId: chosen.id, name: name.trim() })}
          >
            {create.isLoading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Create with {chosen.name}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
