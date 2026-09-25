"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Eye, Loader2, Lock } from "lucide-react";
import {
  LOCALE_LABELS,
  type Locale,
  type PreviewDevice,
  TEMPLATE_CATEGORIES,
  defaultContent,
  parseTemplateSpec,
  templateLocales,
} from "@ecom/landing";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DevicePreview, DeviceToggle } from "./device-preview";

const selectCls =
  "h-10 rounded-md border border-stroke/14 bg-surface-raised px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30";

/**
 * Template version editor. The spec is data (sections + field overrides),
 * edited as JSON and validated live with the same `parseTemplateSpec` the
 * API enforces. It can only reference registered section types, so an
 * admin cannot introduce markup, styles or scripts either.
 */
export function AdminTemplateEditor({ templateId }: { templateId: string }) {
  const utils = trpc.useUtils();
  const q = trpc.adminLandingTemplates.get.useQuery({ id: templateId });
  const sectionTypes = trpc.adminLandingTemplates.sectionTypes.useQuery();
  const draft = q.data?.versions.find((v) => v.status === "draft");
  const isSystem = q.data?.template.origin === "system";

  const [json, setJson] = useState("");
  const [dirty, setDirty] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [previewLocale, setPreviewLocale] = useState<Locale | null>(null);
  const [meta, setMeta] = useState({ name: "", description: "", category: "general" as (typeof TEMPLATE_CATEGORIES)[number] });

  useEffect(() => {
    if (!q.data) return;
    setMeta({
      name: q.data.template.name,
      description: q.data.template.description,
      category: q.data.template.category as (typeof TEMPLATE_CATEGORIES)[number],
    });
    if (!dirty) {
      const base = draft ?? q.data.versions[0];
      setJson(base ? JSON.stringify(base.spec, null, 2) : "");
    }
  }, [q.data, draft, dirty]);

  const parsed = useMemo(() => {
    try {
      return parseTemplateSpec(JSON.parse(json || "null"));
    } catch (err) {
      return { ok: false as const, issues: [{ path: "", message: `JSON: ${(err as Error).message}` }] };
    }
  }, [json]);

  const reload = async () => {
    setDirty(false);
    await utils.adminLandingTemplates.get.invalidate({ id: templateId });
    await utils.adminLandingTemplates.list.invalidate();
  };
  const err = (title: string) => (e: { message: string }) => toast.error(title, e.message);
  const saveMeta = trpc.adminLandingTemplates.updateMeta.useMutation({ onSuccess: () => { toast.success("Saved"); void reload(); }, onError: err("Not saved") });
  const createDraft = trpc.adminLandingTemplates.createDraft.useMutation({ onSuccess: () => void reload(), onError: err("No draft created") });
  const saveDraft = trpc.adminLandingTemplates.saveDraft.useMutation({ onError: err("Draft not saved") });
  const publish = trpc.adminLandingTemplates.publishDraft.useMutation({ onError: err("Not published") });

  if (!q.data) {
    return (
      <div className="flex items-center gap-2 text-fg-subtle">
        {q.error ? q.error.message : <Loader2 className="h-5 w-5 animate-spin" />}
      </div>
    );
  }
  const { template, versions } = q.data;
  const editable = !isSystem && !!draft;

  return (
    <div className="space-y-6">
      <Link href="/admin/landing-templates" className="inline-flex items-center gap-1 text-sm text-fg-subtle hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> Templates
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold text-fg">{template.name}</h1>
        <Badge variant={isSystem ? "info" : "outline"}>{template.origin}</Badge>
        <Badge variant="secondary">{template.status}</Badge>
        <span className="font-mono text-xs text-fg-faint">{template.key}</span>
      </div>

      {isSystem ? (
        <div className="flex items-center gap-2 rounded-lg border border-stroke/10 bg-surface px-4 py-3 text-sm text-fg-subtle">
          <Lock className="h-4 w-4" /> System templates are defined in code. Duplicate this template from the list to customise it.
        </div>
      ) : (
        <div className="grid gap-3 rounded-xl border border-stroke/10 bg-surface p-4 md:grid-cols-[1fr_2fr_auto_auto]">
          <Input value={meta.name} maxLength={80} onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
          <Input value={meta.description} maxLength={400} placeholder="Description" onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
          <select className={selectCls} value={meta.category} onChange={(e) => setMeta({ ...meta, category: e.target.value as typeof meta.category })}>
            {TEMPLATE_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <Button variant="outline" disabled={saveMeta.isLoading} onClick={() => saveMeta.mutate({ id: templateId, ...meta })}>
            Save details
          </Button>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-fg">
              {draft ? `Draft v${draft.version}` : versions[0] ? `v${versions[0].version} (published — read only)` : "No versions"}
            </div>
            <div className="flex gap-2">
              {!isSystem && !draft ? (
                <Button size="sm" variant="outline" disabled={createDraft.isLoading} onClick={() => createDraft.mutate({ id: templateId })}>
                  Create new draft version
                </Button>
              ) : null}
              {editable ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!dirty || !parsed.ok || saveDraft.isLoading}
                    onClick={async () => {
                      const r = await saveDraft.mutateAsync({ id: templateId, versionId: draft!.id, spec: JSON.parse(json) }).catch(() => null);
                      if (r) {
                        toast.success("Draft saved");
                        await reload();
                      }
                    }}
                  >
                    Save draft
                  </Button>
                  <Button size="sm" disabled={dirty || !parsed.ok} onClick={() => setConfirmPublish(true)}>
                    Publish v{draft!.version}
                  </Button>
                </>
              ) : null}
            </div>
          </div>
          <textarea
            className="h-[560px] w-full rounded-md border border-stroke/14 bg-surface-raised p-3 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            spellCheck={false}
            readOnly={!editable}
            value={json}
            onChange={(e) => {
              setJson(e.target.value);
              setDirty(true);
            }}
          />
          {parsed.ok ? (
            <p className="text-xs text-success">Spec is valid.</p>
          ) : (
            <ul className="space-y-1 text-xs text-danger">
              {parsed.issues.slice(0, 10).map((i) => (
                <li key={`${i.path}${i.message}`}>
                  {i.path ? <span className="font-mono">{i.path}: </span> : null}
                  {i.message}
                </li>
              ))}
            </ul>
          )}

          <details className="rounded-lg border border-stroke/10 bg-surface p-3 text-xs text-fg-muted">
            <summary className="cursor-pointer font-medium text-fg">Section types reference</summary>
            <ul className="mt-3 space-y-2">
              {sectionTypes.data?.map((s) => (
                <li key={`${s.type}@${s.version}`}>
                  <span className="font-mono text-fg">
                    {s.type}@{s.version}
                  </span>{" "}
                  — {s.description}
                  <div className="font-mono text-2xs text-fg-faint">{s.fields.map((f) => `${f.key}:${f.type}`).join("  ")}</div>
                </li>
              ))}
            </ul>
            <p className="mt-3">
              Per-field overrides: <span className="font-mono">{"{ editable, required, default, label, help }"}</span>. Set{" "}
              <span className="font-mono">editable: false</span> to lock a value.
            </p>
          </details>

          <div className="rounded-lg border border-stroke/10 bg-surface p-3">
            <div className="mb-2 text-sm font-medium text-fg">Versions</div>
            <ul className="divide-y divide-stroke/8 text-xs">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between py-2">
                  <span className="text-fg-muted">
                    v{v.version} · {v.status}
                    {template.currentVersionId === v.id ? <Badge variant="success" className="ml-2">current</Badge> : null}
                    {v.publishedAt ? ` · ${new Date(v.publishedAt as unknown as string).toLocaleString()}` : ""}
                  </span>
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/preview/template/${templateId}?version=${v.version}`} target="_blank" rel="noopener">
                      <Eye className="mr-1 h-3.5 w-3.5" /> Preview
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="xl:sticky xl:top-4 xl:self-start">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-fg">Live preview (default content)</span>
            <div className="flex flex-wrap items-center gap-2">
              {parsed.ok && templateLocales(parsed.spec).length > 1 ? (
                <div className="inline-flex rounded-lg bg-surface-raised p-1 text-xs">
                  {templateLocales(parsed.spec).map((l) => {
                    const cur = previewLocale ?? parsed.spec.defaultLocale ?? templateLocales(parsed.spec)[0];
                    return (
                      <button
                        key={l}
                        type="button"
                        lang={l}
                        onClick={() => setPreviewLocale(l)}
                        className={`min-h-8 rounded-md px-3 ${l === cur ? "bg-surface text-fg shadow-sm" : "text-fg-subtle"}`}
                      >
                        {LOCALE_LABELS[l].native}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <DeviceToggle device={device} onChange={setDevice} />
            </div>
          </div>
          {parsed.ok ? (
            (() => {
              const locales = templateLocales(parsed.spec);
              const loc = previewLocale && locales.includes(previewLocale) ? previewLocale : parsed.spec.defaultLocale ?? locales[0]!;
              return (
                <DevicePreview
                  spec={parsed.spec}
                  content={defaultContent(parsed.spec, loc)}
                  locale={loc}
                  device={device}
                  viewportHeight={640}
                />
              );
            })()
          ) : (
            <p className="rounded-xl border border-stroke/12 p-6 text-sm text-fg-subtle">Fix the spec to see a preview.</p>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        tone="neutral"
        title={`Publish v${draft?.version ?? ""}?`}
        description="This version becomes immutable and is used for new pages. Existing pages stay on their current version until their owners choose to update."
        confirmLabel="Publish version"
        loading={publish.isLoading}
        onConfirm={async () => {
          const r = draft ? await publish.mutateAsync({ id: templateId, versionId: draft.id }).catch(() => null) : null;
          setConfirmPublish(false);
          if (r) {
            toast.success(`Published v${r.version}`);
            await reload();
          }
        }}
      />
    </div>
  );
}
