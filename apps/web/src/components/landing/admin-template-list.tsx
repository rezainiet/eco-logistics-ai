"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, Loader2, Plus } from "lucide-react";
import { TEMPLATE_CATEGORIES } from "@ecom/landing";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";

const selectCls =
  "h-10 rounded-md border border-stroke/14 bg-surface-raised px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30";

const STATUS_VARIANT: Record<string, "success" | "secondary" | "warning" | "outline"> = {
  active: "success",
  draft: "secondary",
  disabled: "warning",
  archived: "outline",
};

export function AdminTemplateList() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const list = trpc.adminLandingTemplates.list.useQuery();
  const [form, setForm] = useState<null | { mode: "create" } | { mode: "duplicate"; sourceId: string; sourceName: string }>(null);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<(typeof TEMPLATE_CATEGORIES)[number]>("general");

  const onDone = (r: { id: string }) => {
    toast.success("Template created", "Edit its draft version, then publish it.");
    void utils.adminLandingTemplates.list.invalidate();
    router.push(`/admin/landing-templates/${r.id}`);
  };
  const create = trpc.adminLandingTemplates.create.useMutation({ onSuccess: onDone, onError: (e) => toast.error("Not created", e.message) });
  const duplicate = trpc.adminLandingTemplates.duplicate.useMutation({ onSuccess: onDone, onError: (e) => toast.error("Not duplicated", e.message) });
  const setStatus = trpc.adminLandingTemplates.setStatus.useMutation({
    onSuccess: () => void utils.adminLandingTemplates.list.invalidate(),
    onError: (e) => toast.error("Status not changed", e.message),
  });

  const open = (next: NonNullable<typeof form>) => {
    setForm(next);
    setKey("");
    setName(next.mode === "duplicate" ? `${next.sourceName} (custom)` : "");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Landing page templates"
        description="System templates ship with the platform and are read-only — duplicate one to customise it. Published template versions never change, so merchant pages are never altered by template edits."
        actions={
          <Button onClick={() => open({ mode: "create" })}>
            <Plus className="mr-1.5 h-4 w-4" /> New template
          </Button>
        }
      />

      {form ? (
        <div className="space-y-3 rounded-xl border border-stroke/12 bg-surface p-4">
          <div className="text-sm font-medium text-fg">
            {form.mode === "create" ? "New blank template" : `Duplicate “${form.sourceName}”`}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Input placeholder="key (e.g. summer-sale)" value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} className="font-mono" />
            <Input placeholder="Display name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            {form.mode === "create" ? (
              <select className={selectCls} value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
                {TEMPLATE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!key || !name || create.isLoading || duplicate.isLoading}
              onClick={() =>
                form.mode === "create"
                  ? create.mutate({ key, name, category, description: "" })
                  : duplicate.mutate({ id: form.sourceId, key, name })
              }
            >
              {create.isLoading || duplicate.isLoading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {list.isLoading ? <Loader2 className="h-5 w-5 animate-spin text-fg-subtle" /> : null}
      <div className="overflow-hidden rounded-xl border border-stroke/10 bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-stroke/8 text-left text-2xs uppercase tracking-wide text-fg-faint">
            <tr>
              <th className="px-4 py-3">Template</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Live version</th>
              <th className="px-4 py-3">Draft</th>
              <th className="px-4 py-3">Pages</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-stroke/8">
            {list.data?.map((t) => (
              <tr key={t.id}>
                <td className="px-4 py-3">
                  <Link href={`/admin/landing-templates/${t.id}`} className="font-medium text-fg hover:underline">
                    {t.name}
                  </Link>
                  <div className="flex items-center gap-2 text-2xs text-fg-faint">
                    <span className="font-mono">{t.key}</span>
                    <Badge variant={t.origin === "system" ? "info" : "outline"}>{t.origin}</Badge>
                    <span>{t.category}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <Badge variant={STATUS_VARIANT[t.status] ?? "outline"}>{t.status}</Badge>
                </td>
                <td className="px-4 py-3 text-fg-muted">{t.currentVersion ? `v${t.currentVersion}` : "—"}</td>
                <td className="px-4 py-3 text-fg-muted">{t.draftVersion ? `v${t.draftVersion}` : "—"}</td>
                <td className="px-4 py-3 text-fg-muted">{t.pageCount}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-2">
                    <select
                      aria-label="Status"
                      className={selectCls}
                      value={t.status === "draft" ? "" : t.status}
                      disabled={setStatus.isLoading}
                      onChange={(e) =>
                        e.target.value &&
                        setStatus.mutate({ id: t.id, status: e.target.value as "active" | "disabled" | "archived" })
                      }
                    >
                      {t.status === "draft" ? <option value="">draft</option> : null}
                      <option value="active">active</option>
                      <option value="disabled">disabled</option>
                      <option value="archived">archived</option>
                    </select>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Duplicate"
                      onClick={() => open({ mode: "duplicate", sourceId: t.id, sourceName: t.name })}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
