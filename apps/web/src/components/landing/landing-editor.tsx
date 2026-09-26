"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Eye,
  Globe,
  History,
  Languages,
  Loader2,
  PenLine,
  MousePointerClick,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import {
  LOCALE_LABELS,
  type Locale,
  type LocalizedContent,
  type PageContent,
  type PreviewDevice,
  type PreviewSelectMessage,
  type TemplateSpec,
  effectiveSections,
  isLocale,
  resolveEditTarget,
  validateLocalizedContent,
} from "@ecom/landing";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { editorBnFont } from "./bn-font";
import { DevicePreview, DeviceToggle } from "./device-preview";
import { type FieldEditorEnv, FieldInput, LockedField, issuesAt } from "./field-editor";
import { LandingStatusBadge } from "./status-badge";
import { TrackingSettings } from "./tracking-settings";
import { PageProductsPanel } from "@/components/commerce/page-products-panel";

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

function assetUrlFor(base: string) {
  const b = base.replace(/\/+$/, "");
  return (id: string) => (/^[a-f0-9]{24}$/.test(id) ? `${b}/${id}` : null);
}

type Confirm = null | "publish" | "unpublish" | "slug" | { restore: number };

/** Brief highlight on the field a preview click opened. */
const FLASH = ["ring-2", "ring-brand/60", "ring-offset-2", "ring-offset-surface"];

export function LandingEditor({ pageId }: { pageId: string }) {
  const utils = trpc.useUtils();
  const query = trpc.landingPages.get.useQuery({ id: pageId }, { refetchOnWindowFocus: false });
  // Linked products (live data) — the preview shows them in catalog product grids.
  const linkedProducts = trpc.landingPages.products.useQuery({ id: pageId }, { refetchOnWindowFocus: false });
  const data = query.data;

  const [content, setContent] = useState<LocalizedContent | null>(null);
  const [locale, setLocale] = useState<Locale>("en");
  const [baseRevision, setBaseRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [slugInput, setSlugInput] = useState("");
  const [name, setName] = useState("");
  const [tab, setTab] = useState<"content" | "products" | "publish">("content");
  const [pane, setPane] = useState<"edit" | "preview">("edit");
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [langDraft, setLangDraft] = useState<{ locales: Locale[]; defaultLocale: Locale } | null>(null);
  // Click-to-edit: schema path of the selected element ("hero.headline", "products.items.2").
  const [selected, setSelected] = useState<{ path: string; label: string } | null>(null);
  const [reveal, setReveal] = useState<{ path: string; n: number } | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const localeChosen = useRef(false);

  // Adopt server state whenever a fresh copy arrives and we hold no edits.
  useEffect(() => {
    if (!data || dirty) return;
    setContent(data.draftContent as LocalizedContent);
    setBaseRevision(data.page.draftRevision);
    setSlugInput(data.page.slug ?? "");
    setName(data.page.name);
    setLangDraft({ locales: data.page.locales, defaultLocale: data.page.defaultLocale });
    // Open in the page's default language; afterwards keep the language being edited.
    // (Read the ref now — React runs the updater later, after it has been set.)
    const first = !localeChosen.current;
    localeChosen.current = true;
    setLocale((l) => (!first && data.page.locales.includes(l) ? l : data.page.defaultLocale));
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

  // Phones and small tablets start on the phone-sized preview.
  useEffect(() => {
    if (window.innerWidth < 1024) setDevice("mobile");
  }, []);

  const spec = data?.spec as TemplateSpec | undefined;
  const settings = data ? { locales: data.page.locales, defaultLocale: data.page.defaultLocale } : null;
  const sections = useMemo(() => (spec ? effectiveSections(spec, locale) : []), [spec, locale]);
  const draftCheck = useMemo(
    () => (spec && content && settings ? validateLocalizedContent(spec, content, settings, "draft") : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec, content, settings?.locales.join(","), settings?.defaultLocale],
  );
  const publishCheck = useMemo(
    () => (spec && content && settings ? validateLocalizedContent(spec, content, settings, "publish") : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec, content, settings?.locales.join(","), settings?.defaultLocale],
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
  const setLocales = trpc.landingPages.setLocales.useMutation({ onError: onError("Languages not saved") });
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
    setContent(r.content as LocalizedContent);
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

  // A click in the preview: resolve the path against the template schema
  // (never the DOM) and open exactly that field in the current language.
  const onPreviewSelect = useCallback(
    (msg: PreviewSelectMessage) => {
      if (!spec || msg.locale !== locale) return; // stale frame from another language
      const target = resolveEditTarget(spec, locale, msg.path);
      if (target.kind === "locked" || target.kind === "invalid") {
        toast.info("Template element — not editable");
        return;
      }
      setSelected({ path: target.path, label: target.label });
      setTab("content");
      setPane("edit");
      setReveal((r) => ({ path: target.path, n: (r?.n ?? 0) + 1 }));
    },
    [spec, locale],
  );

  // Open the section, scroll the field into view, flash it and focus its input.
  useEffect(() => {
    if (!reveal) return;
    const raf = requestAnimationFrame(() => {
      const root = formRef.current;
      if (!root) return;
      const parts = reveal.path.split(".");
      const details = root.querySelector<HTMLDetailsElement>(`details[data-section-id="${CSS.escape(parts[0]!)}"]`);
      if (details) details.open = true;
      let anchor: HTMLElement | null = null;
      for (let n = parts.length; n > 1 && !anchor; n--) {
        anchor = root.querySelector<HTMLElement>(`[data-field-path="${CSS.escape(parts.slice(0, n).join("."))}"]`);
      }
      const target = anchor ?? details;
      if (!target) return;
      // A field is centred; a whole section is shown from its top.
      target.scrollIntoView({ block: anchor ? "center" : "start", behavior: "smooth" });
      target.classList.add(...FLASH);
      setTimeout(() => target.classList.remove(...FLASH), 1600);
      // Keyboard focus only with a mouse/trackpad — on touch it would pop the keyboard.
      if (anchor && window.matchMedia("(pointer: fine)").matches) {
        const input =
          anchor.querySelector<HTMLElement>("input:not([type=file]):not([type=hidden]):not([type=checkbox]), textarea, select") ??
          anchor.querySelector<HTMLElement>("button");
        input?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [reveal]);

  // Form → preview: focusing a field outside the current selection selects it,
  // so the preview scrolls to and outlines what is being edited.
  const onFormFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (!spec) return;
    const path = (e.target as HTMLElement).closest<HTMLElement>("[data-field-path]")?.dataset.fieldPath;
    if (!path || (selected && (path === selected.path || path.startsWith(`${selected.path}.`)))) return;
    const target = resolveEditTarget(spec, locale, path);
    if (target.kind === "field") setSelected({ path: target.path, label: target.label });
  };

  if (query.isLoading || !data || !spec || !content || !settings) {
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
  const localePrefix = `${locale}.`;
  const issues = (draftCheck?.issues ?? [])
    .filter((i) => i.path.startsWith(localePrefix))
    .map((i) => ({ ...i, path: i.path.slice(localePrefix.length) }));
  const blockers = publishCheck?.issues ?? [];
  // "bn.order.cta" → "বাংলা · Order call to action" — merchants never see raw paths.
  const blockerWhere = (path: string): string => {
    const [loc, sectionId] = path.split(".");
    const langLabel = loc && isLocale(loc) ? LOCALE_LABELS[loc].native : null;
    const section = spec ? effectiveSections(spec, locale).find((s) => s.id === sectionId) : undefined;
    return [langLabel, section?.label ?? sectionId].filter(Boolean).join(" · ");
  };
  const localeContent: PageContent = content[locale] ?? {};
  const sectionTargets = sections.filter((s) => s.visual).map((s) => ({ id: s.id, label: s.label }));
  const env: FieldEditorEnv = {
    locale,
    assetUrl: assetUrlFor(data.assetBaseUrl),
    sectionTargets,
    upload: async (file) => {
      const r = await upload.mutateAsync({ dataUrl: await readAsDataUrl(file) });
      return { id: r.id };
    },
  };

  const updateField = (sectionId: string, key: string, value: unknown) => {
    setContent((prev) => {
      if (!prev) return prev;
      const current = prev[locale] ?? {};
      return { ...prev, [locale]: { ...current, [sectionId]: { ...(current[sectionId] ?? {}), [key]: value } } };
    });
    setDirty(true);
  };

  const localeTabs = page.locales.length > 1 && (
    <div className="flex items-center gap-1 rounded-lg bg-surface-raised p-1 text-sm" role="tablist" aria-label="Content language">
      {page.locales.map((l) => {
        const errs = (draftCheck?.issues ?? []).filter((i) => i.path.startsWith(`${l}.`)).length;
        return (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={l === locale}
            onClick={() => setLocale(l)}
            lang={l}
            className={cn("flex-1 rounded-md px-3 py-1.5 font-medium", l === locale ? "bg-surface text-fg shadow-sm" : "text-fg-subtle hover:text-fg")}
          >
            {LOCALE_LABELS[l].native}
            {l === page.defaultLocale ? <span className="ml-1 text-2xs text-fg-faint">default</span> : null}
            {errs ? <Badge variant="destructive" className="ml-1.5">{errs}</Badge> : null}
          </button>
        );
      })}
    </div>
  );

  const previewPanel = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DeviceToggle device={device} onChange={setDevice} />
        <span className="text-2xs text-fg-faint" lang={locale}>
          {LOCALE_LABELS[locale].native} · live draft
        </span>
      </div>
      <DevicePreview
        spec={spec}
        content={localeContent}
        locale={locale}
        device={device}
        edit={{ selected: selected?.path ?? null, onSelect: onPreviewSelect }}
        catalog={linkedProducts.data?.catalog}
        viewportHeight={typeof window !== "undefined" ? Math.max(420, Math.round(window.innerHeight * 0.74)) : 640}
      />
    </div>
  );

  return (
    <div className={cn("space-y-4", editorBnFont.variable)}>
      <div className="flex flex-col gap-3 border-b border-stroke/8 pb-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/dashboard/landing-pages" className="text-fg-subtle hover:text-fg" aria-label="Back to landing pages">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold text-fg">{page.name}</h1>
              <LandingStatusBadge status={page.status} />
              {page.hasUnpublishedChanges || (dirty && page.status === "published") ? (
                <Badge variant="warning">Unpublished changes</Badge>
              ) : null}
            </div>
            <p className="text-xs text-fg-subtle">
              {data.template.name} · template v{data.template.version} ·{" "}
              {page.locales.map((l) => LOCALE_LABELS[l].native).join(" / ")} · draft rev {baseRevision}
              {dirty ? " · unsaved edits" : ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/preview/landing/${pageId}?locale=${locale}`} target="_blank" rel="noopener">
              <Eye className="mr-1.5 h-4 w-4" /> Full preview
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
        <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" /> This page changed somewhere else. Reload to continue — your unsaved edits here will be discarded.
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

      {/* Below lg: one pane at a time, switchable, so the preview is never buried under the form. */}
      <div className="sticky top-0 z-10 -mx-1 flex gap-1 rounded-lg bg-surface-raised p-1 text-sm lg:hidden">
        {(["edit", "preview"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPane(p)}
            className={cn(
              "flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-md font-medium",
              pane === p ? "bg-surface text-fg shadow-sm" : "text-fg-subtle",
            )}
          >
            {p === "edit" ? <PenLine className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {p === "edit" ? "Edit" : "Preview"}
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]">
        <div className={cn("space-y-3", pane === "preview" && "hidden lg:block")}>
          <div className="flex gap-1 rounded-lg bg-surface-raised p-1 text-sm">
            {(["content", "products", "publish"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  "min-h-9 flex-1 rounded-md px-3 py-1.5 font-medium",
                  tab === t ? "bg-surface text-fg shadow-sm" : "text-fg-subtle hover:text-fg",
                )}
              >
                {t === "content" ? "Content" : t === "products" ? "Products" : "Settings & publishing"}
              </button>
            ))}
          </div>

          {tab === "content" ? (
            <div className="space-y-2" ref={formRef} onFocus={onFormFocus}>
              {localeTabs}
              {selected ? (
                <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-fg" role="status">
                  <MousePointerClick className="h-3.5 w-3.5 shrink-0 text-success" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-fg-subtle">Selected: </span>
                    {selected.label}
                  </span>
                  <button type="button" onClick={() => setSelected(null)} className="rounded p-1 text-fg-subtle hover:text-fg" aria-label="Clear selection">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <p className="px-1 text-2xs text-fg-faint">Tip: click any text, image or button in the preview to edit it.</p>
              )}
              {sections.map((section, i) => {
                const editable = section.fields.filter((f) => f.editable);
                const locked = section.fields.filter((f) => !f.editable);
                const errCount = issuesAt(issues, section.id).length;
                return (
                  <details
                    key={`${locale}:${section.id}`}
                    data-section-id={section.id}
                    className="group rounded-lg border border-stroke/10 bg-surface"
                    open={i === 3}
                  >
                    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-fg">
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
                          value={localeContent[section.id]?.[field.key]}
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
          ) : tab === "products" ? (
            <PageProductsPanel
              pageId={pageId}
              expectedRevision={baseRevision}
              disabled={archived}
              onSaved={(rev) => {
                setBaseRevision(rev);
                void linkedProducts.refetch();
              }}
            />
          ) : (
            <div className="space-y-4">
              <div className="space-y-3 rounded-lg border border-stroke/10 bg-surface p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-fg">
                  <Languages className="h-4 w-4" /> Languages
                </div>
                <p className="text-xs text-fg-subtle">
                  The default language is shown at your page address. Other languages are shown at <span className="font-mono">/en</span> or{" "}
                  <span className="font-mono">/bn</span>, with a language switch on the page.
                </p>
                {langDraft ? (
                  <div className="space-y-2">
                    {data.allowedLocales.map((l) => (
                      <label key={l} className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-stroke/10 px-3">
                        <span className="flex items-center gap-2 text-sm text-fg" lang={l}>
                          <input
                            type="checkbox"
                            checked={langDraft.locales.includes(l)}
                            onChange={(e) => {
                              const locales = e.target.checked
                                ? [...langDraft.locales, l]
                                : langDraft.locales.filter((x) => x !== l);
                              if (!locales.length) return;
                              setLangDraft({
                                locales,
                                defaultLocale: locales.includes(langDraft.defaultLocale) ? langDraft.defaultLocale : locales[0]!,
                              });
                            }}
                          />
                          {LOCALE_LABELS[l].native}
                          {LOCALE_LABELS[l].english !== LOCALE_LABELS[l].native ? <span className="text-fg-faint"> ({LOCALE_LABELS[l].english})</span> : null}
                        </span>
                        <span className="flex items-center gap-1.5 text-2xs text-fg-subtle">
                          <input
                            type="radio"
                            name="default-locale"
                            disabled={!langDraft.locales.includes(l)}
                            checked={langDraft.defaultLocale === l}
                            onChange={() => setLangDraft({ ...langDraft, defaultLocale: l })}
                          />
                          default
                        </span>
                      </label>
                    ))}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        dirty ||
                        archived ||
                        setLocales.isLoading ||
                        (langDraft.locales.join() === page.locales.join() && langDraft.defaultLocale === page.defaultLocale)
                      }
                      onClick={async () => {
                        const r = await setLocales
                          .mutateAsync({ id: pageId, ...langDraft, expectedRevision: baseRevision, seed: "template" })
                          .catch(() => null);
                        if (r) {
                          toast.success("Languages updated", "New languages start from the template's copy — review them before publishing.");
                          await refresh();
                        }
                      }}
                    >
                      Apply languages
                    </Button>
                    {dirty ? <p className="text-2xs text-fg-faint">Save your draft before changing languages.</p> : null}
                  </div>
                ) : null}
              </div>

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
                  Your page will be served at <span className="font-mono">{slugInput || "your-name"}.&lt;landing domain&gt;</span> once public
                  hosting is switched on.
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
                    <CheckCircle2 className="h-3.5 w-3.5" /> All required content is filled in for every language.
                  </p>
                ) : (
                  <ul className="space-y-1 text-xs text-danger">
                    {blockers.slice(0, 8).map((b) => (
                      <li key={`${b.path}:${b.message}`}>
                        {b.message} <span className="text-fg-faint">({blockerWhere(b.path)})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <TrackingSettings pageId={pageId} />

              <div className="space-y-2 rounded-lg border border-stroke/10 bg-surface p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-fg">
                  <History className="h-4 w-4" /> Published revisions
                </div>
                {data.revisions.length === 0 ? <p className="text-xs text-fg-faint">Nothing published yet.</p> : null}
                <ul className="divide-y divide-stroke/8">
                  {data.revisions.map((r) => (
                    <li key={r.number} className="flex items-center justify-between gap-2 py-2 text-xs">
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

        <div className={cn("lg:sticky lg:top-4 lg:self-start", pane === "edit" && "hidden lg:block")}>{previewPanel}</div>
      </div>

      <ConfirmDialog
        open={confirm === "publish"}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone="neutral"
        title={page.status === "published" ? "Publish changes?" : "Publish this page?"}
        description={
          blockers.length
            ? `${blockers.length === 1 ? "1 required field is" : `${blockers.length} required fields are`} still empty. Fill ${blockers.length === 1 ? "it" : "them"} in before publishing.`
            : "Your saved draft becomes the live version in every language. You can unpublish or restore an earlier revision at any time."
        }
        confirmLabel={blockers.length ? "Show what's missing" : "Publish"}
        loading={busy}
        onConfirm={() => {
          if (blockers.length) {
            setTab("publish");
            setPane("edit");
            setConfirm(null);
            return;
          }
          void doPublish();
        }}
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
        tone="neutral"
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
