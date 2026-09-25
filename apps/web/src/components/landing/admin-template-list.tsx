"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, Eye, Loader2, Pencil, Plus } from "lucide-react";
import { LOCALE_LABELS, TEMPLATE_CATEGORIES, type TemplateSpec, defaultContent } from "@ecom/landing";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { DevicePreview } from "./device-preview";

const selectCls =
  "h-10 rounded-md border border-stroke/14 bg-surface-raised px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30";

const STATUS_VARIANT: Record<string, "success" | "secondary" | "warning" | "outline"> = {
  active: "success",
  draft: "secondary",
  disabled: "warning",
  archived: "outline",
};

const CATEGORY_LABEL: Record<string, string> = {
  ecommerce: "E-commerce",
  product: "Product",
  service: "Service",
  lead: "Lead",
  general: "General",
};

export function AdminTemplateList() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const list = trpc.adminLandingTemplates.list.useQuery();
  const [form, setForm] = useState<null | { mode: "create" } | { mode: "duplicate"; sourceId: string; sourceName: string }>(null);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<(typeof TEMPLATE_CATEGORIES)[number]>("general");
  const [filter, setFilter] = useState("all");

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

  const templates = list.data ?? [];
  const categories = useMemo(() => ["all", ...new Set(templates.map((t) => t.category))], [templates]);
  const shown = filter === "all" ? templates : templates.filter((t) => t.category === filter);

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
                    {CATEGORY_LABEL[c] ?? c}
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

      {categories.length > 2 ? (
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setFilter(c)}
              className={cn(
                "min-h-9 rounded-full px-4 text-sm font-medium",
                c === filter ? "bg-brand text-white" : "bg-surface-raised text-fg-subtle hover:text-fg",
              )}
            >
              {c === "all" ? "All" : CATEGORY_LABEL[c] ?? c}
            </button>
          ))}
        </div>
      ) : null}

      {list.isLoading ? <Loader2 className="h-5 w-5 animate-spin text-fg-subtle" /> : null}

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((t) => {
          const spec = t.previewSpec as TemplateSpec | null;
          const locale = t.defaultLocale ?? "en";
          return (
            <div key={t.id} className="flex flex-col overflow-hidden rounded-xl border border-stroke/10 bg-surface">
              <div className="border-b border-stroke/8 bg-white">
                {spec ? (
                  <DevicePreview
                    spec={spec}
                    content={defaultContent(spec, locale)}
                    locale={locale}
                    device="desktop"
                    viewportHeight={220}
                    interactive={false}
                    title={`${t.name} thumbnail`}
                  />
                ) : (
                  <div className="flex h-[220px] items-center justify-center text-xs text-neutral-400">No version yet</div>
                )}
              </div>
              <div className="flex flex-1 flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/admin/landing-templates/${t.id}`} className="font-semibold text-fg hover:underline">
                    {t.name}
                  </Link>
                  <Badge variant={t.origin === "system" ? "info" : "outline"}>{t.origin}</Badge>
                  <Badge variant={STATUS_VARIANT[t.status] ?? "outline"}>{t.status}</Badge>
                </div>
                <p className="line-clamp-2 text-xs text-fg-subtle">{t.description}</p>
                <p className="text-2xs text-fg-faint">
                  <span className="font-mono">{t.key}</span> · {CATEGORY_LABEL[t.category] ?? t.category}
                  {t.locales.length ? ` · ${t.locales.map((l) => LOCALE_LABELS[l].native).join(" / ")}` : ""} · live{" "}
                  {t.currentVersion ? `v${t.currentVersion}` : "—"}
                  {t.draftVersion ? ` · draft v${t.draftVersion}` : ""} · {t.pageCount} page(s)
                </p>
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
                  <select
                    aria-label="Status"
                    className={selectCls}
                    value={t.status === "draft" ? "" : t.status}
                    disabled={setStatus.isLoading}
                    onChange={(e) =>
                      e.target.value && setStatus.mutate({ id: t.id, status: e.target.value as "active" | "disabled" | "archived" })
                    }
                  >
                    {t.status === "draft" ? <option value="">draft</option> : null}
                    <option value="active">active</option>
                    <option value="disabled">disabled</option>
                    <option value="archived">archived</option>
                  </select>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/admin/landing-templates/${t.id}`}>
                      <Pencil className="mr-1 h-3.5 w-3.5" /> {t.origin === "system" ? "View" : "Edit"}
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/preview/template/${t.id}`} target="_blank" rel="noopener">
                      <Eye className="mr-1 h-3.5 w-3.5" /> Preview
                    </Link>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => open({ mode: "duplicate", sourceId: t.id, sourceName: t.name })}>
                    <Copy className="mr-1 h-3.5 w-3.5" /> Duplicate
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
