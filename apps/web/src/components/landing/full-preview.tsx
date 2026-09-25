"use client";

import { Loader2 } from "lucide-react";
import type { TemplateSpec } from "@ecom/landing";
import { defaultContent } from "@ecom/landing";
import { trpc } from "@/lib/trpc";
import { LandingPreview } from "./landing-preview";

function PreviewBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-neutral-900 px-4 py-2 text-xs font-medium text-white">
      {children}
    </div>
  );
}

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

/** Saved draft of a merchant's page, full width. */
export function DraftPreview({ pageId }: { pageId: string }) {
  const q = trpc.landingPages.get.useQuery({ id: pageId }, { refetchOnWindowFocus: true });
  if (!q.data) return <Loading error={q.error?.message} />;
  return (
    <div className="min-h-screen bg-white">
      <PreviewBar>
        Draft preview of “{q.data.page.name}” — saved draft (rev {q.data.page.draftRevision}). Not visible to the public.
      </PreviewBar>
      <LandingPreview spec={q.data.spec as TemplateSpec} content={q.data.draftContent} assetBaseUrl={q.data.assetBaseUrl} />
    </div>
  );
}

/** Admin preview of a template version with its default content. */
export function TemplateVersionPreview({ templateId, version }: { templateId: string; version: number | null }) {
  const q = trpc.adminLandingTemplates.get.useQuery({ id: templateId });
  if (!q.data) return <Loading error={q.error?.message} />;
  const v = version ? q.data.versions.find((x) => x.version === version) : q.data.versions[0];
  if (!v) return <Loading error="Version not found" />;
  const spec = v.spec as TemplateSpec;
  let content: unknown = {};
  try {
    content = defaultContent(spec);
  } catch {
    return <Loading error="This version's spec is invalid" />;
  }
  return (
    <div className="min-h-screen bg-white">
      <PreviewBar>
        Template preview · {q.data.template.name} v{v.version} ({v.status}) — default content
      </PreviewBar>
      <LandingPreview spec={spec} content={content} assetBaseUrl={null} />
    </div>
  );
}
