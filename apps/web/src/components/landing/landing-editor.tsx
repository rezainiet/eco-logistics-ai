"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Eye,
  Globe,
  History,
  Loader2,
  RefreshCw,
  Save,
} from "lucide-react";
import {
  type PageContent,
  type TemplateSpec,
  effectiveSections,
  validateContent,
} from "@ecom/landing";
import { assetEnv } from "@ecom/landing/react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { type FieldEditorEnv, FieldInput, LockedField, issuesAt } from "./field-editor";
import { ScaledLandingPreview } from "./landing-preview";
import { LandingStatusBadge } from "./status-badge";

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

type Confirm = null | "publish" | "unpublish" | "slug" | { restore: number };

export function LandingEditor({ pageId }: { pageId: string }) {
  const utils = trpc.useUtils();
  const query = trpc.landingPages.get.useQuery({ id: pageId }, { refetchOnWindowFocus: false });
  const data = query.data;

  const [content, setContent] = useState<PageContent | null>(null);
  const [baseRevision, setBaseRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [slugInput, setSlugInput] = useState("");
  const [name, setName] = useState("");
  const [tab, setTab] = useState<"content" | "publish">("content");

  // Adopt server state whenever a fresh copy arrives and we hold no edits.
  useEffect(() => {
    if (!data || dirty) return;
    setContent(data.draftContent as PageContent);
    setBaseRevision(data.page.draftRevision);
    setSlugInput(data.page.slug ?? "");
    setName(data.page.name);
    setConflict(false);
  }, [data, dirty]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const spec = data?.spec as TemplateSpec | undefined;
  const sections = useMemo(() => (spec ? effectiveSections(spec) : []), [spec]);
  const draftCheck = useMemo(
    () => (spec && content ? validateContent(spec, content, "draft") : null),
    [spec, content],
  );
  const publishCheck = useMemo(
    () => (spec && content ? validateContent(spec, content, "publish") : null),
    [spec, content],
  );

  const onError = (title: string) => (err: { message: string; data?: { code?: string } | null }) => {
    if (err.data?.code === "CONFLICT") setConflict(true);
    toast.error(title, err.message);
  };

  const save = trpc.landingPages.saveDraft.useMutation({ onError: onError("Draft not saved") });
  const publish = trpc.landingPages.publish.useMutation({ onError: onError("Not published") });
  const unpublish = trpc.landingPages.unpublish.useMutation({ onError: onError("Could not unpublish") });
  const setSlug = trpc.landingPages.setSlug.useMutation({ onError: onError("Subdomain not saved") });
  const rename = trpc.landingPages.rename.useMutation({ onError: onError("Could not rename") });
  const restore = trpc.landingPages.restoreRevision.useMutation({ onError: onError("Could not restore") });
  const upgrade = trpc.landingPages.upgradeTemplate.useMutation({ onError: onError("Could not update template") });
  const upload = trpc.landingPages.uploadAsset.useMutation();

  const refresh = async () => {
    setDirty(false);
    await utils.landingPages.get.invalidate({ id: pageId });
    await utils.landingPages.list.invalidate();
  };

  const saveDraft = async (): Promise<number | null> => {
    if (!content) return null;
    if (!dirty) return baseRevision;
    const r = await save.mutateAsync({ id: pageId, content, expectedRevision: baseRevision }).catch(() => null);
    if (!r) return null;
    setBaseRevision(r.page.draftRevision);
    setContent(r.content as PageContent);
    setDirty(false);
    void utils.landingPages.get.invalidate({ id: pageId });
    toast.success("Draft saved", "Your live page is unchanged until you publish.");
    return r.page.draftRevision;
  };

  const doPublish = async () => {
    const rev = await saveDraft();
    if (rev === null) return;
    const r = await publish.mutateAsync({ id: pageId, expectedRevision: rev }).catch(() => null);
    setConfirm(null);
    if (!r) return;
    toast.success(r.unchanged ? "Already live" : `Published revision ${r.revisionNumber}`, r.page.publicUrl ?? undefined);
    await refresh();
  };

  const doSlug = async () => {
    const r = await setSlug.mutateAsync({ id: pageId, slug: slugInput }).catch(() => null);
    setConfirm(null);
    if (!r) return;
    setSlugInput(r.slug);
    toast.success("Subdomain saved", r.slug);
    await utils.landingPages.get.invalidate({ id: pageId });
  };

  if (query.isLoading || !data || !spec || !content) {
    return (
      <div className="flex items-center gap-2 py-20 text-fg-subtle">
        {query.error ? (
          <>
            <AlertTriangle className="h-4 w-4 text-danger" /> {query.error.message}
          </>
        ) : (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Loading editor…
          </>
        )}
      </div>
    );
  }

  const page = data.page;
  const archived = page.status === "archived";
  const busy = save.isLoading || publish.isLoading;
  const issues = draftCheck?.issues ?? [];
  const blockers = publishCheck?.issues ?? [];
  const sectionTargets = sections.filter((s) => s.visual).map((s) => ({ id: s.id, label: s.label }));
  const env: FieldEditorEnv = {
    assetUrl: assetEnv(data.assetBaseUrl).assetUrl,
    sectionTargets,
    upload: async (file) => {
      const r = await upload.mutateAsync({ dataUrl: await readAsDataUrl(file) });
      return { id: r.id };
    },
  };

  const updateField = (sectionId: string, key: string, value: unknown) => {
    setContent((prev) => (prev ? { ...prev, [sectionId]: { ...(prev[sectionId] ?? {}), [key]: value } } : prev));
    setDirty(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 border-b border-stroke/8 pb-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/dashboard/landing-pages" className="text-fg-subtle hover:text-fg" aria-label="Back to landing pages">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-semibold text-fg">{page.name}</h1>
              <LandingStatusBadge status={page.status} />
              {page.hasUnpublishedChanges || (dirty && page.status === "published") ? (
                <Badge variant="warning">Unpublished changes</Badge>
              ) : null}
            </div>
            <p className="text-xs text-fg-subtle">
              {data.template.name} · template v{data.template.version} · draft rev {baseRevision}
              {dirty ? " · unsaved edits" : ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/preview/landing/${pageId}`} target="_blank" rel="noopener">
              <Eye className="mr-1.5 h-4 w-4" /> Preview draft
            </Link>
          </Button>
          <Button size="sm" variant="outline" disabled={!dirty || busy || archived} onClick={() => void saveDraft()}>
            {save.isLoading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
            Save draft
          </Button>
          {page.status === "published" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("unpublish")}>
              Unpublish
            </Button>
          ) : null}
          <Button size="sm" disabled={busy || archived} onClick={() => setConfirm("publish")}>
            <Globe className="mr-1.5 h-4 w-4" />
            {page.status === "published" ? "Publish changes" : "Publish"}
          </Button>
        </div>
      </div>

      {conflict ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> This page changed somewhere else. Reload to continue — your unsaved edits here will be discarded.
          </span>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            <RefreshCw className="mr-1.5 h-4 w-4" /> Reload
          </Button>
        </div>
      ) : null}

      {data.template.upgradeAvailable && !archived ? (
        <div className="flex flex-col gap-2 rounded-lg border border-info/30 bg-info-subtle px-4 py-3 text-sm text-info sm:flex-row sm:items-center sm:justify-between">
          <span>
            A newer version of “{data.template.name}” is available (v{data.template.latestVersion}). Updating changes your draft only.
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={dirty || upgrade.isLoading}
            onClick={async () => {
              const r = await upgrade.mutateAsync({ id: pageId, expectedRevision: baseRevision }).catch(() => null);
              if (r?.upgraded) {
                toast.success("Template updated", "Review the draft, then publish.");
                await refresh();
              }
            }}
          >
            Update draft to v{data.template.latestVersion}
          </Button>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[440px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="flex gap-1 rounded-lg bg-surface-raised p-1 text-sm">
            {(["content", "publish"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 font-medium",
                  tab === t ? "bg-surface text-fg shadow-sm" : "text-fg-subtle hover:text-fg",
                )}
              >
                {t === "content" ? "Content" : "Publishing"}
              </button>
            ))}
          </div>

          {tab === "content" ? (
            <div className="space-y-2">
              {sections.map((section, i) => {
                const editable = section.fields.filter((f) => f.editable);
                const locked = section.fields.filter((f) => !f.editable);
                const errCount = issuesAt(issues, section.id).length;
                return (
                  <details key={section.id} className="group rounded-lg border border-stroke/10 bg-surface" open={i === 3}>
                    <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-fg">
                      <span>
                        {section.label}
                        {!section.visual ? <span className="ml-2 text-2xs text-fg-faint">page setting</span> : null}
                      </span>
                      {errCount ? <Badge variant="destructive">{errCount}</Badge> : null}
                    </summary>
                    <div className="space-y-4 border-t border-stroke/8 px-4 py-4">
                      {editable.length === 0 ? <p className="text-xs text-fg-faint">Nothing to edit here.</p> : null}
                      {editable.map((field) => (
                        <FieldInput
                          key={field.key}
                          field={field}
                          value={content[section.id]?.[field.key]}
                          path={`${section.id}.${field.key}`}
                          issues={issues}
                          env={env}
                          onChange={(v) => updateField(section.id, field.key, v)}
                        />
                      ))}
                      {locked.length ? (
                        <div className="space-y-1.5 pt-1">
                          {locked.map((f) => (
                            <LockedField key={f.key} field={f} />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </details>
                );
              })}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-3 rounded-lg border border-stroke/10 bg-surface p-4">
                <div className="text-sm font-medium text-fg">Page name</div>
                <div className="flex gap-2">
                  <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-10"
                    disabled={!name.trim() || name === page.name || rename.isLoading || archived}
                    onClick={async () => {
                      const r = await rename.mutateAsync({ id: pageId, name }).catch(() => null);
                      if (r) await refresh();
                    }}
                  >
                    Rename
                  </Button>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border border-stroke/10 bg-surface p-4">
                <div className="text-sm font-medium text-fg">Subdomain</div>
                <p className="text-xs text-fg-subtle">
                  Your page will be served at <span className="font-mono">{slugInput || "your-name"}.&lt;landing domain&gt;</span> once
                  public hosting is switched on.
                </p>
                <div className="flex gap-2">
                  <Input
                    value={slugInput}
                    maxLength={40}
                    placeholder="my-shop"
                    className="font-mono"
                    onChange={(e) => setSlugInput(e.target.value.toLowerCase())}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-10"
                    disabled={!slugInput || slugInput === page.slug || setSlug.isLoading || archived}
                    onClick={() => (page.status === "published" && page.slug ? setConfirm("slug") : void doSlug())}
                  >
                    Save
                  </Button>
                </div>
                {page.publicUrl ? (
                  <a href={page.publicUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
                    {page.publicUrl} <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </div>

              <div className="space-y-2 rounded-lg border border-stroke/10 bg-surface p-4">
                <div className="text-sm font-medium text-fg">Ready to publish?</div>
                {!page.slug ? (
                  <p className="flex items-center gap-2 text-xs text-warning">
                    <AlertTriangle className="h-3.5 w-3.5" /> Choose a subdomain first.
                  </p>
                ) : null}
                {blockers.length === 0 ? (
                  <p className="flex items-center gap-2 text-xs text-success">
                    <CheckCircle2 className="h-3.5 w-3.5" /> All required content is filled in.
                  </p>
                ) : (
                  <ul className="space-y-1 text-xs text-danger">
                    {blockers.slice(0, 8).map((b) => (
                      <li key={`${b.path}:${b.message}`}>
                        {b.message} <span className="font-mono text-fg-faint">({b.path})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="space-y-2 rounded-lg border border-stroke/10 bg-surface p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-fg">
                  <History className="h-4 w-4" /> Published revisions
                </div>
                {data.revisions.length === 0 ? <p className="text-xs text-fg-faint">Nothing published yet.</p> : null}
                <ul className="divide-y divide-stroke/8">
                  {data.revisions.map((r) => (
                    <li key={r.number} className="flex items-center justify-between py-2 text-xs">
                      <span className="text-fg-muted">
                        Revision {r.number} · {new Date(r.createdAt as unknown as string).toLocaleString()}
                        {r.live ? <Badge variant="success" className="ml-2">Live</Badge> : null}
                      </span>
                      <Button size="sm" variant="ghost" disabled={archived} onClick={() => setConfirm({ restore: r.number })}>
                        Restore to draft
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>

        <div className="xl:sticky xl:top-4 xl:self-start">
          <div className="overflow-hidden rounded-xl border border-stroke/12 bg-white shadow-sm">
            <div className="flex items-center gap-2 border-b border-black/5 bg-neutral-50 px-3 py-2 text-2xs text-neutral-500">
              <span className="h-2.5 w-2.5 rounded-full bg-neutral-300" />
              <span className="h-2.5 w-2.5 rounded-full bg-neutral-300" />
              <span className="h-2.5 w-2.5 rounded-full bg-neutral-300" />
              <span className="ml-2 truncate font-mono">{page.slug ? `${page.slug}.…` : "draft preview"}</span>
            </div>
            <div className="max-h-[78vh] overflow-y-auto">
              <ScaledLandingPreview spec={spec} content={content} assetBaseUrl={data.assetBaseUrl} />
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirm === "publish"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={page.status === "published" ? "Publish changes?" : "Publish this page?"}
        description={
          blockers.length
            ? `Fix ${blockers.length} required field(s) first — see the Publishing tab.`
            : "Your saved draft becomes the live version. You can unpublish or restore an earlier revision at any time."
        }
        confirmLabel="Publish"
        loading={busy}
        onConfirm={() => void doPublish()}
      />
      <ConfirmDialog
        open={confirm === "unpublish"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Unpublish this page?"
        description="Visitors will see a not-found page. Your draft and revisions are kept, and you can publish again later."
        confirmLabel="Unpublish"
        destructive
        loading={unpublish.isLoading}
        onConfirm={async () => {
          const r = await unpublish.mutateAsync({ id: pageId }).catch(() => null);
          setConfirm(null);
          if (r) {
            toast.success("Page unpublished");
            await refresh();
          }
        }}
      />
      <ConfirmDialog
        open={confirm === "slug"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Change the live subdomain?"
        description={`The page moves to "${slugInput}" immediately and "${page.slug}" stops working. The old name stays reserved for you for a while.`}
        confirmLabel="Change subdomain"
        loading={setSlug.isLoading}
        onConfirm={() => void doSlug()}
      />
      <ConfirmDialog
        open={typeof confirm === "object" && confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Restore this revision to your draft?"
        description="Your current draft is replaced with the selected revision. The live page does not change until you publish."
        confirmLabel="Restore"
        loading={restore.isLoading}
        onConfirm={async () => {
          if (typeof confirm !== "object" || !confirm) return;
          const r = await restore
            .mutateAsync({ id: pageId, revisionNumber: confirm.restore, expectedRevision: baseRevision })
            .catch(() => null);
          setConfirm(null);
          if (r) {
            toast.success("Revision restored to draft");
            await refresh();
          }
        }}
      />
    </div>
  );
}
